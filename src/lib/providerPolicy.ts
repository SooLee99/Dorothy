/**
 * Phase 6-AH — agent provider policy (pure, testable).
 *
 *  - Development agents (backend, frontend) → Claude (file-editing, tests).
 *  - All other baseline process agents + security-reviewer → Codex
 *    (analysis/plan/verify/report).
 *  - Codex agents must NEVER carry a Claude-family model (opus/sonnet/haiku/
 *    claude-*). We blank the model so Codex uses its own provider default.
 *
 * This only rewrites provider/model fields; it never adds/removes agents, never
 * touches runtime fields, and is idempotent.
 */

export const CLAUDE_DEV_AGENTS: readonly string[] = ['backend', 'frontend'];

export const CODEX_PROCESS_AGENTS: readonly string[] = [
  'intake-planner', 'architect-plan', 'orchestrator', 'plan-validator',
  'contract-agent', 'database-agent', 'qa-reviewer', 'devops-reporter',
  // security-reviewer is a verification (not development) agent → Codex.
  'security-reviewer',
];

const CLAUDE_MODEL_RE = /opus|sonnet|haiku|claude/i;

export interface ProviderAgentLike {
  id?: string;
  provider?: string;
  model?: string;
  [k: string]: unknown;
}

/** Desired provider for an agent id, or null if not a managed baseline agent. */
export function desiredProvider(id: string | undefined): 'claude' | 'codex' | null {
  if (!id) return null;
  if (CLAUDE_DEV_AGENTS.includes(id)) return 'claude';
  if (CODEX_PROCESS_AGENTS.includes(id)) return 'codex';
  return null;
}

/**
 * Apply the provider policy to one agent record (returns a NEW object). Codex
 * agents get a blanked Claude-family model. Non-baseline agents are returned
 * unchanged. Pure — does not mutate the input.
 */
export function applyPolicyToAgent<T extends ProviderAgentLike>(agent: T): T {
  const want = desiredProvider(agent.id);
  if (!want) return agent;
  const next: T = { ...agent, provider: want };
  if (want === 'codex' && typeof next.model === 'string' && CLAUDE_MODEL_RE.test(next.model)) {
    next.model = ''; // fall back to Codex provider default (e.g. gpt-5.5)
  }
  return next;
}

export interface PolicyAuditEntry { id: string; provider: string; model: string; }
export interface PolicyAudit {
  count: number;
  claude: string[];
  codex: string[];
  codexClaudeModelMismatch: PolicyAuditEntry[];
  legacyUuid: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** Audit a full agent list against the policy (post-apply verification). */
export function auditProviders(agents: ProviderAgentLike[]): PolicyAudit {
  const audit: PolicyAudit = { count: agents.length, claude: [], codex: [], codexClaudeModelMismatch: [], legacyUuid: [] };
  for (const a of agents) {
    const id = a.id ?? '';
    const provider = a.provider ?? '';
    const model = a.model ?? '';
    if (provider === 'claude') audit.claude.push(id);
    if (provider === 'codex') audit.codex.push(id);
    if (provider === 'codex' && CLAUDE_MODEL_RE.test(model)) audit.codexClaudeModelMismatch.push({ id, provider, model });
    if (UUID_RE.test(id)) audit.legacyUuid.push(id);
  }
  return audit;
}
