/**
 * Dorothy MVP Phase 5D — Run Mode router.
 *
 * Inspects free-form text (Kanban title/description, Plan summary, Task
 * descriptions, ad-hoc user prompts) and decides which `RunMode` the Run
 * should use. The router is *advisory* — the caller is free to override.
 *
 * Crucial properties:
 *   - Side-effect free / pure → unit testable
 *   - Conservative when in doubt: returns `team` (sane default) with a
 *     `reason` that names whatever keyword tipped the decision, or
 *     `manual` when explicitly requested
 *   - `autopilot` is intentionally not its own mode — we deg-rade to
 *     `persistent` (or `team` when nothing else matched) and stamp
 *     `modeReason: "autopilot deferred"` so the UI can surface it
 *   - High-risk keywords (production / secret / auth / deploy / merge /
 *     drop / truncate / `delete from` / cost) **do not** auto-elevate
 *     the mode; they're passed through `riskKeywords` so callers can
 *     keep the ApprovalRequest gate independently of mode selection.
 */

import type { RunMode, RunModeSource } from '../../types/dorothy';

export type RunModeConfidence = 'high' | 'medium' | 'low';

export interface RunModeDecision {
  mode: RunMode;
  source: RunModeSource;
  reason: string;
  confidence: RunModeConfidence;
  matchedKeywords: string[];
  /** Risk-gate keywords found in the same text. Empty when none. */
  riskKeywords: string[];
}

/**
 * The default mode when no keyword matches. Kept as `team` per the spec's
 * recommendation; callers can override via the `defaultMode` option.
 */
export const DEFAULT_RUN_MODE: RunMode = 'team';

/* ============================================================================
 * Keyword tables
 *
 * Each mode has a list of regex patterns. We test them in `MODE_ORDER`, so
 * stricter modes (manual / pipeline / ultraqa / persistent) win over the
 * generic `team` fallback when multiple categories match.
 *
 * Patterns are case-insensitive. For Korean phrases we match substrings;
 * for English single words we use word boundaries to avoid partial matches
 * like "deployment" triggering on "deploy".
 * ========================================================================== */

interface ModePattern {
  mode: RunMode;
  patterns: RegExp[];
  /** Friendly label shown in the decision reason. */
  label: string;
}

const MODE_PATTERNS: ModePattern[] = [
  {
    mode: 'manual',
    label: 'manual',
    patterns: [
      /\bmanual\b/i,
      /수동/u,
      /계획만/u,
      /승인\s*후\s*진행/u,
      /확인\s*후\s*진행/u,
      /\bplan\s*only\b/i,
    ],
  },
  {
    mode: 'pipeline',
    label: 'pipeline',
    patterns: [
      /\bpipeline\b/i,
      /순차\s*실행/u,
      /안전하게\s*순서대로/u,
      /순서대로/u,
      /\bsequential\b/i,
      /\bstrict\s*order\b/i,
    ],
  },
  {
    mode: 'ultraqa',
    label: 'ultra-QA',
    patterns: [
      /\bultraqa\b/i,
      /\bultra[-_\s]?qa\b/i,
      /qa\s*집중/u,
      /테스트\s*통과할\s*때까지/u,
      /검증\s*강화/u,
      /\bqa\s*focused\b/i,
      /\bverify\s*heavy\b/i,
    ],
  },
  {
    mode: 'persistent',
    label: 'persistent',
    patterns: [
      /\bpersistent\b/i,
      /계속\s*고쳐/u,
      /끝까지\s*고쳐/u,
      /통과할\s*때까지/u,   // less strict than ultraqa's "테스트 통과"
      /\bkeep\s*fixing\b/i,
      /\bfix\s*until\s*(green|pass|success)/i,
    ],
  },
  {
    mode: 'team',
    label: 'team',
    patterns: [
      /\bteam\b/i,
      /팀으로/u,
      /팀\s*실행/u,
      /병렬\s*개발/u,
      /\bparallel\b/i,
    ],
  },
];

const MODE_ORDER: RunMode[] = ['manual', 'pipeline', 'ultraqa', 'persistent', 'team'];

/**
 * Risk keywords that should never auto-bypass the approval gate. We surface
 * them on the decision so the caller (plan-validator, orchestrator) can keep
 * the ApprovalRequest in place regardless of which mode the router picked.
 */
const RISK_KEYWORD_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'production',  re: /\bproduction\b|\bprod\b/i },
  { name: 'secret',      re: /\bsecret\b|\bsecrets\b/i },
  { name: 'auth',        re: /\bauth\b|\bauthentication\b|\blogin\b/i },
  { name: 'deploy',      re: /\bdeploy\b|\bdeployment\b/i },
  { name: 'merge',       re: /\bmerge\b|\bmerging\b/i },
  { name: 'drop',        re: /\bdrop\b/i },
  { name: 'truncate',    re: /\btruncate\b/i },
  { name: 'delete from', re: /delete\s+from/i },
  { name: 'cost',        re: /\bcost\b|\bbilling\b|\bpayment\b/i },
  { name: 'SEC-',        re: /\bSEC-/i },
  { name: 'token',       re: /\btoken\b|\baccess[_-]?token\b/i },
];

const AUTOPILOT_RE = /\bautopilot\b|\bauto[\s_-]*pilot\b/i;

/* ============================================================================
 * Public API
 * ========================================================================== */

export interface DecideRunModeOptions {
  /** When set, used as the fallback instead of DEFAULT_RUN_MODE. */
  defaultMode?: RunMode;
  /** Mark caller's source so the persisted row records "manual" vs "policy". */
  sourceWhenDefault?: RunModeSource;
}

export function decideRunMode(
  rawText: string | null | undefined,
  options: DecideRunModeOptions = {},
): RunModeDecision {
  const text = (rawText ?? '').trim();
  const defaultMode = options.defaultMode ?? DEFAULT_RUN_MODE;
  const sourceWhenDefault = options.sourceWhenDefault ?? 'default';

  if (!text) {
    return {
      mode: defaultMode,
      source: sourceWhenDefault,
      reason: `no signal text — falling back to ${defaultMode}`,
      confidence: 'low',
      matchedKeywords: [],
      riskKeywords: [],
    };
  }

  const riskKeywords = collectRiskKeywords(text);
  const autopilotDetected = AUTOPILOT_RE.test(text);

  // Look for explicit mode hints in priority order.
  let matched: { mode: RunMode; label: string; keyword: string } | null = null;
  for (const family of MODE_PATTERNS) {
    for (const re of family.patterns) {
      const m = re.exec(text);
      if (m) {
        matched = { mode: family.mode, label: family.label, keyword: m[0] };
        break;
      }
    }
    if (matched) break;
  }

  // Autopilot handling: never returns an `'autopilot'` mode (no such mode).
  // Degrade to `persistent` when nothing else matched, or keep whatever the
  // user explicitly asked for. The reason field records that we deferred it
  // so the UI can flag the intent.
  if (autopilotDetected) {
    const deferred = matched
      ? {
          mode: matched.mode,
          source: 'keyword' as RunModeSource,
          reason: `autopilot deferred — using ${matched.label} (matched "${matched.keyword}")`,
          confidence: 'medium' as RunModeConfidence,
          matchedKeywords: [matched.keyword, 'autopilot'],
          riskKeywords,
        }
      : {
          mode: 'persistent' as RunMode,
          source: 'keyword' as RunModeSource,
          reason: 'autopilot deferred — running as persistent (limited fix loop)',
          confidence: 'medium' as RunModeConfidence,
          matchedKeywords: ['autopilot'],
          riskKeywords,
        };
    return deferred;
  }

  if (matched) {
    return {
      mode: matched.mode,
      source: 'keyword',
      reason: `matched ${matched.label} keyword "${matched.keyword}"`,
      confidence: 'high',
      matchedKeywords: [matched.keyword],
      riskKeywords,
    };
  }

  // No keyword hit. If risk keywords are present, fall back to the safest
  // mode (manual when risk is high, otherwise the default). Risk keywords
  // alone do NOT promote a Run to manual unless the caller asked for it; the
  // gate happens via ApprovalRequest, not RunMode.
  return {
    mode: defaultMode,
    source: sourceWhenDefault,
    reason: riskKeywords.length > 0
      ? `no mode keyword — defaulting to ${defaultMode} (risk keywords still gate via ApprovalRequest)`
      : `no mode keyword — defaulting to ${defaultMode}`,
    confidence: 'low',
    matchedKeywords: [],
    riskKeywords,
  };
}

function collectRiskKeywords(text: string): string[] {
  const hits = new Set<string>();
  for (const k of RISK_KEYWORD_PATTERNS) {
    if (k.re.test(text)) hits.add(k.name);
  }
  return Array.from(hits);
}

/* ============================================================================
 * Convenience: pull every relevant text field off a freshly created Run /
 * KanbanTask / Plan so callers don't have to assemble it manually.
 * ========================================================================== */

export interface RunModeRouterInput {
  title?: string | null;
  description?: string | null;
  prompt?: string | null;
  taskDescriptions?: string[];
}

export function compositeSignalText(input: RunModeRouterInput): string {
  const parts: string[] = [];
  if (input.title) parts.push(input.title);
  if (input.description) parts.push(input.description);
  if (input.prompt) parts.push(input.prompt);
  if (input.taskDescriptions) parts.push(...input.taskDescriptions.filter(Boolean));
  return parts.join('\n');
}

export function decideRunModeFor(input: RunModeRouterInput, options: DecideRunModeOptions = {}): RunModeDecision {
  return decideRunMode(compositeSignalText(input), options);
}
