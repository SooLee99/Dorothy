/**
 * Dorothy MVP Phase 3 — Plan-aware agent routing + Run-context prompt builder.
 *
 * This module is the safe wedge between the legacy Kanban auto-spawn flow
 * (`electron/handlers/kanban-handlers.ts:259-333`) and the new Run/Plan model.
 *
 * Rules we intentionally bake in:
 *   1. Do NOT replace `findMatchingAgent`. It still runs first; we only add
 *      a `selectAgentForRunStep()` that callers can use *when a Plan exists*.
 *      Pages that don't know about Run/Plan keep working unchanged.
 *   2. The Run-context prompt is built from already-persisted dorothy.db rows
 *      so the orchestrator service can call us without re-reading the Plan.
 *   3. We never read or write triplan/.claude/agents/*.md — those files are
 *      authority for behavior, not for routing. Routing is decided here from
 *      the `ownerAgentId` the planner wrote.
 */

import type { Plan, TaskDraft, RunStep } from '../../types/dorothy';

/**
 * MVP-canonical worker roles. The planner is expected to use these strings
 * for `tasks[*].ownerAgentId`. Anything else is treated as "no MVP routing"
 * and falls back to the legacy kanban-automation logic.
 */
export const MVP_WORKER_ROLES = new Set([
  'frontend',
  'backend',
  'qa-reviewer',
  'devops-reporter',
  // Phase-3 coordinator agents — orchestrator may dispatch back to these
  // before / after worker phases.
  'intake-planner',
  'architect-plan',
  'orchestrator',
  'plan-validator',
]);

/**
 * Map a planner-assigned ownerAgentId to a live Dorothy AgentStatus id, when
 * possible. We deliberately keep this string-comparison only (no fuzzy
 * matching, no Plan rewrites) so two callers staring at the same Plan agree
 * on the worker every time.
 *
 * Returns the AgentStatus.id (uuid) when found, or null when:
 *   - the ownerAgentId is not an MVP role
 *   - no live agent has `roleId === ownerAgentId`
 *   - the call site has no Plan / no current task
 *
 * On null, the caller MUST fall back to `findMatchingAgent` (legacy path).
 */
export interface LiveAgentSlim {
  id: string;
  status: string;
  roleId?: string;
  /** Matches one of the MVP role strings above when the agent represents a
   * Dorothy-canonical role (read from `agents.json` `roleId` field if present,
   * otherwise heuristically from the agent's `name`). */
  name?: string;
  projectPath?: string;
  skills?: string[];
}

export function selectAgentForOwnerRole(
  ownerAgentId: string,
  liveAgents: Iterable<LiveAgentSlim>
): string | null {
  if (!MVP_WORKER_ROLES.has(ownerAgentId)) return null;

  const wanted = ownerAgentId.toLowerCase();
  let bestIdle: LiveAgentSlim | null = null;
  let bestAny: LiveAgentSlim | null = null;

  for (const a of liveAgents) {
    const role = (a.roleId ?? '').toLowerCase();
    const nameMatch = (a.name ?? '').toLowerCase().includes(wanted);
    if (role !== wanted && !nameMatch) continue;
    if (!bestAny) bestAny = a;
    if (a.status === 'idle' && !bestIdle) bestIdle = a;
  }

  return (bestIdle ?? bestAny)?.id ?? null;
}

/* ============================================================================
 * Run-context prompt
 *
 * Every dispatch from the orchestrator should go through this builder so each
 * worker gets the same nine fields the orchestrator.md contract promises.
 * ========================================================================== */

export interface RunContextPromptParams {
  runId: string;
  runStepId: string;
  planId: string | null;
  /** The Plan.tasks[] entry being dispatched. */
  task: TaskDraft;
  /** Worker's allowed write paths (typically the agent's projectPath + extras). */
  allowedWritePaths: string[];
  /** Paths the worker MUST NOT touch (e.g. secrets, .git, agents.json). */
  forbiddenPaths: string[];
  /** Commands the worker must run before declaring completion. */
  validationCommands: string[];
  /** Where the worker should leave its handoff/report markdown. */
  handoffOutputPath: string;
  /** Optional: content of the previous step's handoff so the worker has
   * carry-over context (file path or inline body). */
  previousHandoff?: string | null;
  /** Failure policy in plain text the worker can quote back. */
  failureHandlingRule: string;
  /** Original task description plus acceptance criteria, rendered for the LLM. */
  taskSummary: string;
  /** Optional ADR reference path. */
  adrRef?: string | null;
}

/**
 * Default forbidden paths every MVP worker inherits. The planner / orchestrator
 * may extend (but not shrink) this list.
 */
export const DEFAULT_FORBIDDEN_PATHS: string[] = [
  '.git/**',
  '~/.dorothy/agents.json',           // schema is fixed; only hooks/runtime may touch it
  '~/.dorothy/kanban-tasks.json',     // schema is fixed
  '~/.dorothy/vault.db',              // never touched by workers
  'triplan/.claude/agents/**',        // role definitions are authority — workers may not rewrite
  'triplan/approvals/approval-policy.md', // policy file edited only by user
];

export const DEFAULT_FAILURE_RULE =
  'On test failure, do NOT bypass; emit a change-request.md in handoffOutputPath and exit. ' +
  'On rate-limit, wait through cooldown — do not retry by switching engines. ' +
  'On user-gated content (SEC-1, auth, push, secret), STOP and surface to plan-validator.';

/**
 * Builds a deterministic, copy-pasteable prompt the orchestrator can hand to
 * any worker. We keep it as plain text (no JSON envelope) because the live
 * agent's claude/codex CLI consumes plain text.
 *
 * The structure is stable — additions go at the END so older parsers keep
 * working.
 */
export function buildRunContextPrompt(params: RunContextPromptParams): string {
  const {
    runId, runStepId, planId,
    task, allowedWritePaths, forbiddenPaths,
    validationCommands, handoffOutputPath, previousHandoff,
    failureHandlingRule, taskSummary, adrRef,
  } = params;

  const lines: string[] = [];
  lines.push(`# Dorothy MVP Run Dispatch — task: ${task.title}`);
  lines.push('');
  lines.push('## Identifiers');
  lines.push(`- runId: \`${runId}\``);
  lines.push(`- runStepId: \`${runStepId}\``);
  lines.push(`- planId: \`${planId ?? '(none)'}\``);
  lines.push(`- taskId: \`${task.taskId}\``);
  if (adrRef) lines.push(`- adr: \`${adrRef}\``);
  lines.push('');

  lines.push('## Task');
  lines.push(taskSummary);
  lines.push('');

  if (task.acceptanceCriteria?.length) {
    lines.push('## Acceptance Criteria');
    for (const ac of task.acceptanceCriteria) lines.push(`- ${ac}`);
    lines.push('');
  }

  lines.push('## Allowed write paths');
  for (const p of allowedWritePaths) lines.push(`- ${p}`);
  lines.push('');

  lines.push('## Forbidden paths');
  for (const p of forbiddenPaths) lines.push(`- ${p}`);
  lines.push('');

  if (validationCommands.length) {
    lines.push('## Validation commands (run before declaring completion)');
    for (const c of validationCommands) lines.push(`- \`${c}\``);
    lines.push('');
  }

  lines.push('## Handoff output');
  lines.push(`Write your 5-section report to: \`${handoffOutputPath}\``);
  lines.push('Sections: 요청 / 진행 / 산출물 / 검증 / 잔여+인계 + 메타.');
  lines.push('');

  if (previousHandoff) {
    lines.push('## Previous handoff');
    lines.push('```');
    lines.push(previousHandoff.length > 4000 ? previousHandoff.slice(0, 4000) + '\n…' : previousHandoff);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Failure handling');
  lines.push(failureHandlingRule);
  lines.push('');

  lines.push('---');
  lines.push('When done, the Dorothy hooks-routes mirror will close your AgentSession and the');
  lines.push('orchestrator will inspect your report. Do not edit dorothy.db directly.');

  return lines.join('\n');
}

/* ============================================================================
 * Reverse mapping helpers used by the orchestrator service.
 * ========================================================================== */

export interface ResolveStepAgentInput {
  step: RunStep;
  plan: Plan | null;
  liveAgents: Iterable<LiveAgentSlim>;
}

/** Returns the live AgentStatus id this RunStep should be dispatched to, or
 *  null when the caller should fall back to the legacy kanban routing. */
export function resolveLiveAgentForStep({
  step, plan, liveAgents,
}: ResolveStepAgentInput): string | null {
  // The planner writes `step.agentId = task.ownerAgentId`. Trust that.
  if (!MVP_WORKER_ROLES.has(step.agentId)) return null;
  // Sanity: the plan must contain a matching task.
  if (plan) {
    const has = plan.tasks?.some(t => t.ownerAgentId === step.agentId);
    if (!has) return null;
  }
  return selectAgentForOwnerRole(step.agentId, liveAgents);
}

/** Compose the handoff output path used by every worker definition file. */
export function handoffPathFor(agentId: string, slug: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  return `triplan/.claude/reports/${agentId}/${date}/${time}_${slug}.md`;
}
