'use client';

/**
 * AutomationPolicySection — Phase 5C-C read-only feature-flag overview.
 *
 * This section is intentionally read-only: changing these flags has
 * production-level blast radius (auto-spawning workers, auto-transitioning
 * Run state, dispatching live agents after a cooldown). The guarded editor
 * lands in Phase 5D; for now we surface "current / default / recommended /
 * risk" so the operator can spot drift and edit `app-settings.json` by hand.
 *
 * No secrets, tokens, or webhook bodies are shown. Each row only renders
 * the active mode + a textual description.
 */

import {
  ShieldCheck,
  AlertTriangle,
  Info,
  Activity,
  GitPullRequest,
  Hourglass,
  PlayCircle,
  Workflow,
  History as HistoryIcon,
  Stethoscope,
  Workflow as WorkflowIcon,
  Layers,
  Bot,
} from 'lucide-react';
import Link from 'next/link';
import type { AppSettings } from './types';
import { useDorothyClaudeLaunchReadiness, useDorothyCodexRuntimeReadiness } from '@/hooks/useDorothyRuns';

interface PhaseFlags {
  dorothyOrchestratorAutoSpawn?: boolean;
  dorothyAutoResumeRateLimitedSessions?: boolean | string;
  dorothyPrCiAutoTransition?: boolean;
  dorothyDevAllowUnsignedWebhook?: boolean;
  githubWebhookSecret?: string;
}

type Risk = 'low' | 'medium' | 'high';

interface FlagRowDef {
  key: keyof PhaseFlags;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  current: string;
  defaultValue: string;
  recommended: string;
  risk: Risk;
  description: React.ReactNode;
  liveWarning?: React.ReactNode;
}

interface Props {
  appSettings: AppSettings;
}

export function AutomationPolicySection({ appSettings }: Props) {
  const flags = appSettings as AppSettings & PhaseFlags;

  // Normalize each flag to a display string.
  const autoResumeRaw = flags.dorothyAutoResumeRateLimitedSessions;
  const autoResumeMode: 'live' | 'dry-run' | 'off' =
    autoResumeRaw === true || autoResumeRaw === 'true' || autoResumeRaw === 'on' || autoResumeRaw === 'live' ? 'live'
    : autoResumeRaw === false || autoResumeRaw === 'false' || autoResumeRaw === 'off' ? 'off'
    : 'dry-run';

  const rows: FlagRowDef[] = [
    {
      key: 'dorothyOrchestratorAutoSpawn',
      title: 'Orchestrator auto-spawn',
      icon: Activity,
      current: flags.dorothyOrchestratorAutoSpawn ? 'enabled' : 'disabled (default)',
      defaultValue: 'disabled',
      recommended: 'disabled',
      risk: 'medium',
      description: (
        <>
          When enabled, the orchestrator calls{' '}
          <code className="font-mono">/api/agents/:id/start</code>{' '}
          itself to dispatch the next worker step. When disabled (default), the
          legacy Kanban auto-spawn / hooks path stays in charge.
        </>
      ),
      liveWarning: (
        <>Live dispatch reuses the same PTY plumbing as a manual start. Flip on only after
        confirming Plan task / forbidden-paths metadata is correct for each role.</>
      ),
    },
    {
      key: 'dorothyAutoResumeRateLimitedSessions',
      title: 'Auto Resume rate-limited sessions',
      icon: Hourglass,
      current: autoResumeMode === 'live' ? 'live'
             : autoResumeMode === 'off' ? 'disabled'
             : 'dry-run (default)',
      defaultValue: 'dry-run',
      recommended: 'dry-run',
      risk: 'medium',
      description: (
        <>
          When set to <code className="font-mono">true</code> /{' '}
          <code className="font-mono">&quot;live&quot;</code>, the scheduler dispatches a worker via{' '}
          <code className="font-mono">/api/agents/:id/start</code> after{' '}
          <code className="font-mono">resumeAt</code>. The resume prompt always reads the latest
          Handoff and continues only pending / blocked steps. Manual{' '}
          <em>Resume Now</em> on <code className="font-mono">/sessions</code> works regardless of
          this mode.
        </>
      ),
      liveWarning: (
        <>The resume prompt forces the worker to <strong>not repeat completed RunSteps</strong>{' '}
        — completed work is never re-run. Low-confidence reset times are still skipped.</>
      ),
    },
    {
      key: 'dorothyPrCiAutoTransition',
      title: 'PR / CI auto Run transition',
      icon: GitPullRequest,
      current: flags.dorothyPrCiAutoTransition ? 'enabled' : 'disabled (default)',
      defaultValue: 'disabled',
      recommended: 'disabled',
      risk: 'medium',
      description: (
        <>
          When enabled, a <code className="font-mono">merged</code> PR can advance a linked Run from{' '}
          <code className="font-mono">reporting</code> → <code className="font-mono">completed</code>,
          and a failed CI run can move it from <code className="font-mono">reporting</code> →{' '}
          <code className="font-mono">needs_fix</code>. No other transitions are automatic.
        </>
      ),
    },
    {
      key: 'dorothyDevAllowUnsignedWebhook',
      title: 'Dev: allow unsigned GitHub webhooks',
      icon: AlertTriangle,
      current: flags.dorothyDevAllowUnsignedWebhook ? 'enabled' : 'disabled (default)',
      defaultValue: 'disabled',
      recommended: 'disabled',
      risk: 'high',
      description: (
        <>
          Bypasses the HMAC-SHA256 signature check so a local{' '}
          <code className="font-mono">curl</code> can POST to{' '}
          <code className="font-mono">/api/github/webhook</code>. Production must keep this off.
        </>
      ),
      liveWarning: (
        <>Anyone who can reach <code className="font-mono">127.0.0.1:31415</code> on this machine
        could forge webhook payloads while this is on.</>
      ),
    },
  ];

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-5 h-5 text-foreground" />
        <h2 className="text-lg font-semibold text-foreground">Automation Policy</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Read-only summary of the feature flags that govern Dorothy's automation surface.
        Editing happens by hand in <code className="font-mono">~/.dorothy/app-settings.json</code>{' '}
        followed by an app restart. A guarded editor lands in Phase 5D; until then changes are
        deliberately deferred so a typo here cannot start agents or mutate Run state.
      </p>

      <ul className="space-y-3">
        {rows.map(row => <FlagRow key={row.key} row={row} />)}
      </ul>

      {/* Phase 5D — Run Mode policy summary. Read-only; editing arrives in Phase 5E. */}
      <RunModeSection />

      {/* Phase 5F — Hook Event Bus disclosure. Read-only. */}
      <HookEventBusSection />

      {/* Phase 6-A — Diagnostics disclosure. Read-only. */}
      <DiagnosticsSection />

      {/* Phase 6-B — Agent workflow progress disclosure. Read-only. */}
      <AgentWorkflowProgressSection />

      {/* Phase 6-D — SkillCandidate disclosure. Read-only. */}
      <SkillCandidatesSection />

      {/* Phase 6-K — Claude runtime / launch readiness. Read-only. */}
      <ClaudeRuntimeSection />

      {/* Phase 6-M — Codex runtime readiness. Read-only. */}
      <CodexRuntimeSection />

      {/* Phase 6-E — Agent Registry / Idle Reason / Communication disclosure. Read-only. */}
      <AgentRegistrySection />

      <div className="p-3 border border-border bg-muted/30 text-xs text-muted-foreground">
        <Info className="w-3 h-3 inline mr-1" />
        Webhook secret and GitHub tokens are never displayed here — see{' '}
        <em>Settings → GitHub Webhook</em> for the configured / not-configured status only. Manual{' '}
        <em>Resume Now</em> on <code className="font-mono">/sessions</code> remains available even
        when Auto Resume is off.
      </div>
    </div>
  );
}

/* ============================================================================
 * Phase 5D — Run Mode policy block
 *
 * Static description per mode so the operator can see the rules the
 * orchestrator follows. The text mirrors `electron/services/dorothy/
 * run-mode-policy.ts`; keeping it in sync is enforced by the shared `RunMode`
 * type at build time.
 * ========================================================================== */

interface ModeCardDef {
  mode: 'manual' | 'team' | 'persistent' | 'ultraqa' | 'pipeline';
  title: string;
  purpose: string;
  bullets: string[];
  recommended?: string;
}

const MODE_CARDS: ModeCardDef[] = [
  {
    mode: 'team', title: 'team (default)',
    purpose: 'Planner → Architect → Orchestrator → FE/BE → QA → Reporter.',
    bullets: [
      'FE and BE may run in parallel when worktrees differ',
      'Limited QA retry on flaky failures',
      'Handoff required between roles',
    ],
    recommended: 'Default RunMode when no keyword matches',
  },
  {
    mode: 'manual', title: 'manual',
    purpose: 'Human-driven, no auto-retry, approval-heavy.',
    bullets: [
      'No automatic retry on step failure',
      'No live auto-resume after rate limits',
      'Approval gate stays strong',
    ],
  },
  {
    mode: 'persistent', title: 'persistent',
    purpose: 'Limited verify/fix loop until QA / CI passes.',
    bullets: [
      'Persistent max fix attempts: 3',
      'CI / QA failed → needs_fix → orchestrator re-dispatch',
      'Repeated failures spawn ImprovementSignal',
    ],
  },
  {
    mode: 'ultraqa', title: 'ultraqa',
    purpose: 'Verification-heavy. QA / Reviewer + tests over code volume.',
    bullets: [
      'Plan Validator rejects plans without validation commands',
      'QA + Reviewer prioritized over implementation parallelism',
      'CI failures emit higher-severity ImprovementSignals',
    ],
  },
  {
    mode: 'pipeline', title: 'pipeline',
    purpose: 'Strict sequential. Plan → Approval → FE → BE → QA → Reporter.',
    bullets: [
      'Pipeline strict handoff policy: each step blocks until prior Handoff completes',
      'No FE/BE parallel dispatch',
      'maxFixAttempts capped at 1',
    ],
  },
];

function RunModeSection() {
  return (
    <div className="bg-card border border-border p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Workflow className="w-4 h-4 text-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Run Modes</h3>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>Default: <code className="font-mono">team</code></span>
          <span>·</span>
          <span>Enabled: <code className="font-mono">manual / team / persistent / ultraqa / pipeline</code></span>
          <span>·</span>
          <span title="Autopilot keyword degrades to persistent or team with a deferred note.">
            Autopilot: <strong>deferred</strong>
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Mode is decided when a Run is created — either by an explicit keyword in the request /
        Kanban title (e.g. <code className="font-mono">팀으로</code>,{' '}
        <code className="font-mono">계속 고쳐</code>,{' '}
        <code className="font-mono">순서대로</code>) or by the safe default. Risk keywords
        (<code className="font-mono">production</code>, <code className="font-mono">secret</code>,
        <code className="font-mono">auth</code>, <code className="font-mono">deploy</code>,
        <code className="font-mono">drop</code>) still gate via ApprovalRequest regardless of mode.
      </p>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {MODE_CARDS.map(card => (
          <li key={card.mode} className="p-3 bg-background border border-border">
            <div className="text-sm font-semibold text-foreground mb-1">{card.title}</div>
            <div className="text-xs text-muted-foreground mb-2">{card.purpose}</div>
            <ul className="list-disc pl-4 text-[11px] text-muted-foreground space-y-0.5">
              {card.bullets.map(b => <li key={b}>{b}</li>)}
            </ul>
            {card.recommended && (
              <div className="mt-2 text-[10px] text-emerald-600 italic">{card.recommended}</div>
            )}
          </li>
        ))}
      </ul>

      {/* Phase 5E — at-a-glance policy matrix so the operator can compare
          modes without reading each card. Mirrors run-mode-policy.ts. */}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[11px] border border-border">
          <thead className="bg-muted/40 text-muted-foreground uppercase tracking-wider">
            <tr>
              <th className="text-left px-2 py-1.5">Mode</th>
              <th className="text-center px-2 py-1.5">maxFix</th>
              <th className="text-center px-2 py-1.5">parallel</th>
              <th className="text-center px-2 py-1.5">requireValidation</th>
              <th className="text-center px-2 py-1.5">qaHeavy</th>
              <th className="text-center px-2 py-1.5">approvalGate</th>
            </tr>
          </thead>
          <tbody className="text-foreground">
            {MODE_POLICY_MATRIX.map(p => (
              <tr key={p.mode} className="border-t border-border">
                <td className="px-2 py-1.5"><code className="font-mono">{p.mode}</code></td>
                <td className="text-center tabular-nums">{p.maxFixAttempts}</td>
                <td className="text-center">{p.parallel ? '✓' : '—'}</td>
                <td className="text-center">{p.requireValidation ? '✓' : '—'}</td>
                <td className="text-center">{p.qaHeavy ? '✓' : '—'}</td>
                <td className="text-center">{p.approvalGate ? '✓' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 text-[10px] text-muted-foreground italic">
        OMC-inspired concept, Dorothy-native runtime. Mode rules live in{' '}
        <code className="font-mono">electron/services/dorothy/run-mode-policy.ts</code>.
        Per-Run override happens on Run Detail (mode dropdown); per-task hint
        comes from the request keyword. <strong>defaultRunMode</strong> /
        <strong>enabledRunModes</strong> remain read-only this phase — the
        guarded editor lands in Phase 5F.
      </div>
    </div>
  );
}

const MODE_POLICY_MATRIX: Array<{
  mode: string;
  maxFixAttempts: number;
  parallel: boolean;
  requireValidation: boolean;
  qaHeavy: boolean;
  approvalGate: boolean;
}> = [
  { mode: 'manual',     maxFixAttempts: 0, parallel: false, requireValidation: false, qaHeavy: false, approvalGate: true },
  { mode: 'team',       maxFixAttempts: 2, parallel: true,  requireValidation: false, qaHeavy: false, approvalGate: false },
  { mode: 'persistent', maxFixAttempts: 3, parallel: true,  requireValidation: false, qaHeavy: false, approvalGate: false },
  { mode: 'ultraqa',    maxFixAttempts: 2, parallel: false, requireValidation: true,  qaHeavy: true,  approvalGate: false },
  { mode: 'pipeline',   maxFixAttempts: 1, parallel: false, requireValidation: false, qaHeavy: false, approvalGate: false },
];

/* ============================================================================
 * Phase 5F — Hook Event Bus disclosure
 *
 * Lists the runtime events Dorothy now mirrors into `hook_events`. Strict
 * read-only — masking + raw-body suppression are policy, not user-editable.
 * ========================================================================== */

const CAPTURED_EVENT_TYPES: ReadonlyArray<{ tag: string; what: string }> = [
  { tag: 'Run',          what: 'created · state_changed · mode_changed' },
  { tag: 'RunStep',      what: 'created · started · completed · failed' },
  { tag: 'AgentSession', what: 'started · output (throttled) · waiting · completed · failed' },
  { tag: 'Artifact',     what: 'created (type / path / contentRef excerpt / producedByAgentId)' },
  { tag: 'Handoff',      what: 'created (summary excerpt + attached count)' },
  { tag: 'Approval',     what: 'required · resolved (topic / decidedBy)' },
  { tag: 'RateLimit',    what: 'detected · scheduled' },
  { tag: 'Resume',       what: 'scheduled · started · completed · failed' },
  { tag: 'GitHub',       what: 'pr_event · ci_event · review_event · comment_gate (no body)' },
  { tag: 'CI',           what: 'ci_failed · ci_passed' },
  { tag: 'Improvement',  what: 'signal_created · signal_updated · kanban_task_created' },
];

function HookEventBusSection() {
  return (
    <div className="bg-card border border-border p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <HistoryIcon className="w-4 h-4 text-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Hook Event Bus</h3>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium border bg-emerald-500/10 text-emerald-500 border-emerald-500/30">
            enabled
          </span>
          <span>·</span>
          <span title="Future Diagnostics agent depends on this event stream.">
            Future Diagnostics: <strong>yes</strong>
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Phase 5F mirrors every notable runtime occurrence into a unified
        timeline (<code className="font-mono">hook_events</code> table). The
        Run Detail Timeline tab reads from this feed; the Command Center
        surfaces a recent strip below Active Runs. Failures to write a
        hook-event row never break the originating flow — observability is a
        soft dependency.
      </p>

      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
        {CAPTURED_EVENT_TYPES.map(row => (
          <li key={row.tag} className="p-2 bg-background border border-border">
            <div className="text-foreground font-medium">{row.tag}</div>
            <div className="text-muted-foreground mt-0.5 break-words">{row.what}</div>
          </li>
        ))}
      </ul>

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Sensitive data masking</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <ShieldCheck className="w-3 h-3 text-emerald-500" /> enabled
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            <code className="font-mono">secret / token / password / api_key / private_key / bearer / client_secret / access_token</code> values
            are stripped before persistence.
          </div>
        </div>
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Raw output storage</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-emerald-500" /> disabled
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Output rows are stored as ≤500-char excerpts. Full transcripts
            stay in the PTY log only.
          </div>
        </div>
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Raw GitHub body storage</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-emerald-500" /> disabled
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            PR / review / comment bodies, x-hub-signature, and webhook secrets
            are never written to the timeline.
          </div>
        </div>
      </div>

      <div className="mt-3 text-[10px] text-muted-foreground italic">
        OMC-inspired concept, Dorothy-native runtime. HookEvent rows live in
        <code className="font-mono mx-1">~/.dorothy/dorothy.db.hook_events</code>;
        the renderer never receives raw outputs or webhook bodies.
      </div>
    </div>
  );
}

/* ============================================================================
 * Phase 6-A — Diagnostics disclosure
 *
 * Strict read-only. All policy toggles for "auto root-cause analysis" and
 * "auto-convert to ImprovementSignal" are pinned OFF in this Phase and the
 * UI exists to make that pinning visible.
 * ========================================================================== */

const DIAGNOSTIC_SOURCES_DISPLAY: ReadonlyArray<{ tag: string; what: string }> = [
  { tag: 'CI failure',       what: 'github_webhook → ci_failed → high severity Diagnostic' },
  { tag: 'Resume failure',   what: 'auto_resume → resume_failed → medium/high (>=3 retries)' },
  { tag: 'RunStep failure',  what: 'orchestrator → run_step_failed → high (qa role → qa_failure)' },
  { tag: 'Agent session',    what: 'hook → agent_session_failed → medium' },
  { tag: 'GitHub review',    what: 'github_webhook → changes_requested only → medium' },
  { tag: 'Approval block',   what: 'plan_validator → approval_required (high/critical risk only)' },
  { tag: 'Rate limit',       what: 'rate_limit_detected → low (high severity on low parseConfidence)' },
];

function DiagnosticsSection() {
  return (
    <div className="bg-card border border-border p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Stethoscope className="w-4 h-4 text-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Diagnostics</h3>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium border bg-emerald-500/10 text-emerald-500 border-emerald-500/30">
            enabled
          </span>
          <span>·</span>
          <span title="HookEvent → Diagnostic detector runs synchronously after each event.">
            Diagnostic source: <strong>HookEvent</strong>
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Phase 6-A converts HookEvent triggers into actionable Diagnostics with a
        24h fingerprint-based dedupe window. Open
        <Link href="/diagnostics" className="mx-1 underline hover:text-foreground">/diagnostics</Link>
        for triage; the same surface is mirrored under each Run Detail&apos;s
        Diagnostics tab. Conversion to <em>ImprovementSignal</em> is an
        operator-only action — no auto-promotion.
      </p>

      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
        {DIAGNOSTIC_SOURCES_DISPLAY.map(row => (
          <li key={row.tag} className="p-2 bg-background border border-border">
            <div className="text-foreground font-medium">{row.tag}</div>
            <div className="text-muted-foreground mt-0.5 break-words">{row.what}</div>
          </li>
        ))}
      </ul>

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Auto root-cause AI analysis</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-emerald-500" /> disabled
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Phase 6-A is rule-based only. No LLM call for cause analysis.
          </div>
        </div>
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Auto conversion to Improvement</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-emerald-500" /> disabled
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Operator clicks <em>Convert to Improvement</em> on /diagnostics.
          </div>
        </div>
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Sensitive masking</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <ShieldCheck className="w-3 h-3 text-emerald-500" /> enabled
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Diagnostic summary / rootCause / impact / suggestedFix reuse the
            HookEvent masking util (secret / token / bearer / sha256= …).
          </div>
        </div>
      </div>

      <div className="mt-3 text-[10px] text-muted-foreground italic">
        Diagnostic rows live in
        <code className="font-mono mx-1">~/.dorothy/dorothy.db.diagnostics</code>;
        dedupe window 24h via fingerprint. Future Phase 6-B
        <em>(AgentWorkflowProgress)</em> reads the same evidence chain.
      </div>
    </div>
  );
}

/* ============================================================================
 * Phase 6-B — Agent Workflow Progress disclosure
 *
 * Strict read-only. Raw output keyword inference is pinned OFF; stalled
 * auto-diagnostic is "conservative" — the marker can flag a workflow as
 * stalled, but auto-Diagnostic creation is deferred.
 * ========================================================================== */

const WORKFLOW_TEMPLATES_DISPLAY: ReadonlyArray<{ tag: string; what: string }> = [
  { tag: 'Frontend',            what: 'spec_read · ui_flow_check · api_contract_check · implementation · frontend_validation · handoff' },
  { tag: 'Backend',             what: 'spec_read · api_design_check · db_impact_check · implementation · backend_validation · handoff' },
  // Phase 6-C — Contract / Database agents own the API surface and DB
  // impact respectively, surfaced before FE/BE in pipeline mode.
  { tag: 'Contract Agent',      what: 'requirements_read · api_surface_identified · request_response_schema · error_code_policy · frontend_backend_contract · contract_artifact' },
  { tag: 'Database Agent',      what: 'db_impact_read · schema_impact_analysis · migration_plan · rollback_plan · risk_check · db_artifact' },
  { tag: 'QA / Reviewer',       what: 'handoff_read · acceptance_criteria_check · test_execution · review · qa_report' },
  { tag: 'DevOps / Reporter',   what: 'qa_result_read · report_draft · pr_body_prepare · ci_summary_check · final_report' },
  { tag: 'Architect / Plan',    what: 'requirements_read · design_draft · task_breakdown · agent_assignment · validation_plan' },
  { tag: 'Intake / Planner',    what: 'request_read · requirements_summary · scope_definition · acceptance_criteria · task_draft' },
  { tag: 'Orchestrator',        what: 'plan_read · run_created · runstep_created · dispatch · monitor · handoff_route' },
  { tag: 'Approval Validator',  what: 'plan_read · risk_check · path_check · validation_check · approval_decision' },
  { tag: 'Generic',             what: 'session_started · work · completed' },
];

function AgentWorkflowProgressSection() {
  return (
    <div className="bg-card border border-border p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <WorkflowIcon className="w-4 h-4 text-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Agent workflow progress</h3>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium border bg-emerald-500/10 text-emerald-500 border-emerald-500/30">
            enabled
          </span>
          <span>·</span>
          <span title="Future Phase 6-C splits Contract / Database agents on top of this surface.">
            Future dependency: <strong>Contract / Database Agent split</strong>
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Phase 6-B materialises one progress row per
        <code className="font-mono mx-1">(Run, RunStep, Session, Agent)</code>
        quartet from the workflow template registry. HookEvent
        + RunStep + Handoff + Artifact ids feed the step transitions; the
        Recompute action on Run Detail rebuilds a Run&apos;s workflow rows from
        scratch using the same rules.
      </p>

      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
        {WORKFLOW_TEMPLATES_DISPLAY.map(row => (
          <li key={row.tag} className="p-2 bg-background border border-border">
            <div className="text-foreground font-medium">{row.tag}</div>
            <div className="text-muted-foreground mt-0.5 break-words">{row.what}</div>
          </li>
        ))}
      </ul>

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Workflow templates</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <ShieldCheck className="w-3 h-3 text-emerald-500" /> enabled
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            9 canonical templates + generic fallback.
          </div>
        </div>
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Raw output keyword inference</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-emerald-500" /> disabled
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Steps move only on structural events — never on agent transcript content.
          </div>
        </div>
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Stalled auto-Diagnostic</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-amber-500" /> conservative
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Stalled flagging is allowed; auto-creating a Diagnostic from stalled rows is deferred.
          </div>
        </div>
      </div>

      <div className="mt-3 text-[10px] text-muted-foreground italic">
        Progress rows live in
        <code className="font-mono mx-1">~/.dorothy/dorothy.db.agent_workflow_progress</code>;
        Recompute walks <code className="font-mono">hook_events</code> chronologically.
      </div>
    </div>
  );
}

/* ============================================================================
 * Phase 6-D — SkillCandidate disclosure
 *
 * Strict read-only. accepted / ready_for_registry only flags the candidate
 * ready for a human; actual skill files are *never* generated or modified
 * from this Phase.
 * ========================================================================== */

const SKILL_CANDIDATE_SOURCES_DISPLAY: ReadonlyArray<{ tag: string; what: string }> = [
  { tag: 'ImprovementSignal', what: 'Manual operator convert from /improvements (recurring patterns rolled up by fingerprint)' },
  { tag: 'Diagnostic',        what: 'Manual operator convert from /diagnostics or Run Detail' },
  { tag: 'Workflow progress', what: 'Reserved for Phase 6-D2: recurring stalled / blocked workflows' },
  { tag: 'Contract drift',    what: 'Reserved for Phase 6-D2: Plan changed without contract artifact refresh' },
  { tag: 'DB risk',           what: 'Reserved for Phase 6-D2: destructive ops without rollback-plan' },
  { tag: 'QA / CI failure',   what: 'Reserved for Phase 6-D2: same fingerprint failure ≥3 times' },
  { tag: 'Manual',            what: 'Operator-filed candidate via API' },
];

function SkillCandidatesSection() {
  return (
    <div className="bg-card border border-border p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Skill candidates</h3>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium border bg-emerald-500/10 text-emerald-500 border-emerald-500/30">
            enabled
          </span>
          <span>·</span>
          <span title="Phase 6-E (Evolution Agent) will be the only path that writes skill files, with explicit approval.">
            Future dependency: <strong>Evolution Agent</strong>
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Phase 6-D collects candidate skills derived from ImprovementSignal and
        Diagnostic via manual operator convert. Open
        <Link href="/skill-candidates" className="mx-1 underline hover:text-foreground">/skill-candidates</Link>
        for triage. Even <em>accepted</em> and <em>ready_for_registry</em>
        candidates do not create or modify skill files — registry registration
        is a Phase 6-E concern.
      </p>

      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
        {SKILL_CANDIDATE_SOURCES_DISPLAY.map(row => (
          <li key={row.tag} className="p-2 bg-background border border-border">
            <div className="text-foreground font-medium">{row.tag}</div>
            <div className="text-muted-foreground mt-0.5 break-words">{row.what}</div>
          </li>
        ))}
      </ul>

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Auto skill file generation</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-emerald-500" /> disabled
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Even <strong>accepted</strong> / <strong>ready_for_registry</strong> rows
            never write files. Phase 6-E is the only path that may.
          </div>
        </div>
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Auto skill file modification</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-emerald-500" /> disabled
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Existing skill files in <code className="font-mono">~/.claude/skills/**</code>
            are never edited by Dorothy.
          </div>
        </div>
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Admin approval required</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <ShieldCheck className="w-3 h-3 text-emerald-500" /> yes
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Status transitions require an operator click (triaged / accepted /
            dismissed / ready_for_registry / convert to task).
          </div>
        </div>
      </div>

      <div className="mt-3 text-[10px] text-muted-foreground italic">
        Candidates live in
        <code className="font-mono mx-1">~/.dorothy/dorothy.db.skill_candidates</code>;
        24h fingerprint dedupe. Convert-to-Task lands in <code className="font-mono">kanban-tasks.json</code>
        under the <code className="font-mono">backlog</code> column.
      </div>
    </div>
  );
}

function FlagRow({ row }: { row: FlagRowDef }) {
  const Icon = row.icon;
  const isLive = row.current.startsWith('enabled') || row.current.startsWith('live');
  const isDefault = row.current.toLowerCase().includes('default') || row.current === row.defaultValue;
  const riskTone = row.risk === 'high'   ? 'bg-rose-500/10 text-rose-500 border-rose-500/30'
                 : row.risk === 'medium' ? 'bg-amber-500/10 text-amber-500 border-amber-500/30'
                 : 'bg-muted text-muted-foreground border-border';
  const statusTone = isLive    ? 'bg-amber-500/10 text-amber-500 border-amber-500/30'
                   : isDefault ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
                   : 'bg-muted text-muted-foreground border-border';
  return (
    <li className="bg-card border border-border p-4">
      <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="w-4 h-4 text-foreground shrink-0" />
          <h3 className="text-sm font-semibold text-foreground break-words">{row.title}</h3>
          <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border ${statusTone}`}>
            {row.current}
          </span>
          <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium border ${riskTone}`}>
            risk: {row.risk}
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed mb-2">{row.description}</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Default</div>
          <div className="text-foreground mt-0.5">{row.defaultValue}</div>
        </div>
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Recommended</div>
          <div className="text-foreground mt-0.5">{row.recommended}</div>
        </div>
        <div className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Manual override</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <PlayCircle className="w-3 h-3" /> Resume Now (always available)
          </div>
        </div>
      </div>
      {isLive && row.liveWarning && (
        <div className="mt-2 p-2 border border-amber-500/30 bg-amber-500/5 text-amber-500 text-[11px] flex items-start gap-2">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{row.liveWarning}</span>
        </div>
      )}
    </li>
  );
}

/* ============================================================================
 * Phase 6-E — Agent Registry / Idle Reason / Communication disclosure
 *
 * Read-only. This Phase deliberately surfaces file-based agent definitions and
 * inter-agent communication WITHOUT auto-registering anything into agents.json.
 * ========================================================================== */

const AGENT_REGISTRY_POLICY: { label: string; enabled: boolean; note: string }[] = [
  { label: '에이전트 정의 레지스트리', enabled: true,  note: 'Scans .claude/agents/*.md + agents.json + live sessions (read-only merge).' },
  { label: '에이전트 통신 타임라인', enabled: true, note: 'Synthesized from Handoff / Artifact / HookEvent / Diagnostic / ApprovalRequest.' },
  { label: '대기 사유 감지', enabled: true, note: 'Rule-based; explains active / waiting / blocked / rate-limited states.' },
  { label: '에이전트 정의 자동 등록', enabled: false, note: 'Definition files are shown but never written into agents.json.' },
  { label: 'agents.json 자동 수정', enabled: false, note: 'agents.json is never mutated by the registry.' },
  // Phase 6-I
  { label: '에이전트 라이브 재로드', enabled: true, note: 'Re-reads agents.json into the live map (read-only) without restart or killing sessions.' },
  { label: '재로드 동시성 가드', enabled: true, note: 'Concurrent reloads coalesce onto one file read/merge; later callers get alreadyInProgress.' },
  { label: '기존 에이전트 메타데이터 병합', enabled: false, note: 'Manual / disabled by default. When enabled, only safe metadata is refreshed; runtime state is always preserved.' },
  { label: '파일 감시 자동 재로드', enabled: false, note: 'Disabled — reload is manual (button) or after a confirmed registration.' },
  { label: '사라진 에이전트 자동 제거', enabled: false, note: 'Agents absent from disk are reported as warnings only; never killed or removed.' },
  // Phase 6-J
  { label: '대시보드 에이전트 운영 현황', enabled: true, note: 'Always-visible Command Center strip: registered / live / spawnable / running / blocked / dispatch readiness.' },
  { label: '자동 실행 준비 검사', enabled: true, note: 'Dry-run diagnosis only — never spawns an agent / PTY / Claude token.' },
  { label: '터미널 전용 모드 경고', enabled: true, note: 'Terminals view shows a banner pointing to Agent Operation summary and other views.' },
  { label: 'AgentWorld 레지스트리 데이터', enabled: false, note: '3D world node badges deferred (Phase 6-K); status is shown in Command Center + /agents instead.' },
  { label: '실제 자동 실행', enabled: true, note: 'Controlled by dorothyOrchestratorAutoSpawn (currently on). This view never forces a dispatch.' },
  // Phase 6-L
  { label: 'Provider/Model 호환성 가드', enabled: true, note: 'Validates (provider, model) before launch; surfaces provider_model_mismatch as a dispatch blocker.' },
  { label: 'Codex + opus 실행 차단', enabled: false, note: 'Blocked — the codex command builder omits Claude-family models (e.g. opus); Codex falls back to its default.' },
  { label: '자동 모델 재작성', enabled: false, note: 'Disabled — agents.json model is never auto-rewritten; only suggestions are shown.' },
  { label: 'Provider 기본값', enabled: true, note: 'Read-only. Set defaultClaudeModel / defaultCodexModel / claudeBinaryPath in app-settings.json to override.' },
];

function AgentRegistrySection() {
  return (
    <div className="bg-card border border-border p-4">
      <div className="flex items-center gap-2 mb-3">
        <Bot className="w-4 h-4 text-foreground" />
        <h3 className="text-sm font-semibold text-foreground">Agent Registry &amp; Communication</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Phase 6-E reconciles configured agents, <code className="font-mono">.claude/agents/*.md</code>{' '}
        definition files, and live <code className="font-mono">AgentSession</code> rows into a single
        registry on <code className="font-mono">/agents</code>. New role files become visible without
        being auto-registered — registration stays a manual, human action.
      </p>
      <ul className="space-y-2">
        {AGENT_REGISTRY_POLICY.map(row => (
          <li key={row.label} className="flex items-start justify-between gap-3 p-2 bg-background border border-border">
            <div>
              <div className="text-foreground text-sm">{row.label}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">{row.note}</div>
            </div>
            <span
              className={`shrink-0 inline-flex items-center px-2 py-0.5 text-[10px] font-medium border ${
                row.enabled
                  ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
                  : 'bg-muted text-muted-foreground border-border'
              }`}
            >
              {row.enabled ? 'enabled' : 'disabled'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ============================================================================
 * Phase 6-K — Claude Runtime / Launch Readiness (read-only)
 *
 * Surfaces the resolved claude binary path + per-agent launch path validation
 * so "bash: claude: command not found" / bad projectPath is diagnosable from
 * Settings. Nothing here edits paths or spawns anything.
 * ========================================================================== */

function ClaudeRuntimeSection() {
  const { runtime } = useDorothyClaudeLaunchReadiness();
  const blocked = runtime.agents.filter(a => !a.ready);
  return (
    <div className="bg-card border border-border p-4">
      <div className="flex items-center gap-2 mb-3">
        <PlayCircle className="w-4 h-4 text-foreground" />
        <h3 className="text-sm font-semibold text-foreground">Claude Runtime &amp; Launch Readiness</h3>
        <span
          className={`ml-auto inline-flex items-center px-2 py-0.5 text-[10px] font-medium border ${
            runtime.binary.found
              ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
              : 'bg-rose-500/10 text-rose-500 border-rose-500/30'
          }`}
        >
          claude binary: {runtime.binary.found ? 'found' : 'missing'}
        </span>
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
        <li className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Resolved Claude path</div>
          <div className="text-foreground mt-0.5 font-mono break-all">
            {runtime.binary.path ?? '(not resolved)'}
            {runtime.binary.source ? ` · ${runtime.binary.source}` : ''}
          </div>
        </li>
        <li className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Dashboard PATH includes claude</div>
          <div className="text-foreground mt-0.5">{runtime.pathIncludesClaude ? 'yes' : 'resolved via well-known dir'}</div>
        </li>
        <li className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">MCP config path</div>
          <div className="text-foreground mt-0.5 font-mono break-all">{runtime.mcpConfigPath ?? '(none)'}</div>
        </li>
        <li className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Dorothy add-dir</div>
          <div className="text-foreground mt-0.5 font-mono break-all">{runtime.addDir}</div>
        </li>
      </ul>
      {blocked.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] text-amber-500 mb-1 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> {blocked.length} configured Claude agent(s) cannot launch:
          </div>
          <ul className="space-y-1">
            {blocked.slice(0, 20).map(a => (
              <li key={a.agentId} className="text-[11px] text-muted-foreground">
                <span className="font-mono text-foreground">{a.agentId?.slice(0, 8)}</span>{' '}
                <span className="text-amber-500">{a.launchBlockReason}</span> — {a.summary}
                {a.projectPath.suggestion && (
                  <span className="text-muted-foreground"> (suggestion: <code className="font-mono">{a.projectPath.suggestion}</code>)</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground mt-2">
        Read-only. Paths are never auto-corrected; suggestions are advisory. Set{' '}
        <code className="font-mono">claudeBinaryPath</code> or <code className="font-mono">cliPaths.claude</code> in
        app-settings.json to override resolution.
      </p>
    </div>
  );
}

/* ============================================================================
 * Phase 6-M — Codex Runtime Readiness (read-only)
 *
 * Surfaces the codex binary, whether the Codex persistent config pins an
 * incompatible (Claude-family) model, the configured default, and which
 * configured Codex agents carry an incompatible model (e.g. opus). Never edits
 * ~/.codex or agents.json.
 * ========================================================================== */

function CodexRuntimeSection() {
  const { runtime } = useDorothyCodexRuntimeReadiness();
  return (
    <div className="bg-card border border-border p-4">
      <div className="flex items-center gap-2 mb-3">
        <PlayCircle className="w-4 h-4 text-foreground" />
        <h3 className="text-sm font-semibold text-foreground">Codex Runtime Readiness</h3>
        <span
          className={`ml-auto inline-flex items-center px-2 py-0.5 text-[10px] font-medium border ${
            runtime.binaryFound
              ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
              : 'bg-rose-500/10 text-rose-500 border-rose-500/30'
          }`}
        >
          codex binary: {runtime.binaryFound ? 'found' : 'missing'}
        </span>
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
        <li className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Codex binary path</div>
          <div className="text-foreground mt-0.5 font-mono break-all">{runtime.binaryPath ?? '(not resolved)'}</div>
        </li>
        <li className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Persistent config model</div>
          <div className={`mt-0.5 ${runtime.persistentModelOpus ? 'text-rose-500' : 'text-foreground'}`}>
            {runtime.configTomlModel ?? '(none — uses Codex default)'}
            {runtime.persistentModelOpus ? ' · incompatible (opus)' : ''}
          </div>
        </li>
        <li className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">defaultCodexModel (app-settings)</div>
          <div className="text-foreground mt-0.5">
            {runtime.defaultCodexModel ?? '(unset — --model flag omitted)'}
            {runtime.defaultCodexModel ? (runtime.defaultCodexModelOk ? ' · ok' : ' · incompatible') : ''}
          </div>
        </li>
        <li className="p-2 bg-background border border-border">
          <div className="text-muted-foreground uppercase tracking-wider">Codex with opus</div>
          <div className="text-foreground mt-0.5 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-emerald-500" /> blocked
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">Automatic model rewrite: disabled. agents.json / ~/.codex are never edited.</div>
        </li>
      </ul>
      {runtime.incompatibleConfiguredAgents.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] text-amber-500 mb-1 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> {runtime.incompatibleConfiguredAgents.length} Codex agent(s) carry an incompatible model:
          </div>
          <ul className="space-y-1">
            {runtime.incompatibleConfiguredAgents.slice(0, 20).map(a => (
              <li key={a.agentId} className="text-[11px] text-muted-foreground">
                <span className="font-mono text-foreground">{a.agentId.slice(0, 8)}</span>{' '}
                <span className="text-rose-500">{a.model}</span> — {a.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground mt-2">
        To test a Codex model manually, run <code className="font-mono">codex --model &lt;codex-compatible-model&gt;</code> in a
        shell, or use the <code className="font-mono">/model</code> slash command <strong>inside the Codex TUI</strong>{' '}
        — <code className="font-mono">/model</code> typed at a bash prompt is not a Codex command and will fail.
      </p>
    </div>
  );
}
