/**
 * Dorothy MVP Phase 6-E — Agent Idle Reason service.
 *
 * Answers "why is this agent not actively working right now?" by reconciling
 * the live AgentSession, the assigned RunSteps, pending ApprovalRequests,
 * scheduled RateLimitEvents, the Run mode policy, and the operator's
 * automation flags (orchestrator auto-spawn, auto-resume mode).
 *
 * The result is a rule-based classification — it never calls an LLM and never
 * mutates anything. All inputs can be injected for tests; otherwise the
 * service reads from dorothy.db + app-settings.json (read-only).
 */

import * as fs from 'fs';
import { APP_SETTINGS_FILE } from '../../constants';
import { listAgentSessions } from './agent-session-service';
import { listRuns, listRunStepsByRun } from './run-service';
import { listApprovalRequests } from './approval-request-service';
import { listRateLimitEvents } from './rate-limit-service';
import { listHandoffsByRun } from './artifact-service';
import { getPlan } from './plan-service';
import { parallelAllowedFor } from './run-mode-policy';
import { normalizeAutoResumeMode, type AutoResumeMode } from './auto-resume-scheduler';
import { normalizeAgentKey } from './agent-definition-registry';
import type {
  AgentSession,
  ApprovalRequest,
  Handoff,
  RateLimitEvent,
  Run,
  RunStep,
  Plan,
} from '../../types/dorothy';

/* ============================================================================
 * Types
 * ========================================================================== */

export type AgentIdleReason =
  | 'active'
  | 'no_assigned_runstep'
  | 'waiting_for_approval'
  | 'blocked_by_rate_limit'
  | 'blocked_by_runmode_policy'
  | 'waiting_for_dependency'
  | 'waiting_for_handoff'
  | 'waiting_for_validation'
  | 'orchestrator_autospawn_disabled'
  | 'auto_resume_dry_run'
  | 'provider_unavailable'
  | 'completed'
  | 'unknown';

export interface AgentIdleStatus {
  agentId: string;
  reason: AgentIdleReason;
  summary: string;
  runId?: string;
  runStepId?: string;
  agentSessionId?: string;
  evidenceHookEventIds?: string[];
  evidenceDiagnosticIds?: string[];
  since?: string;
}

/* Active Run states the orchestrator can still dispatch into. */
const ACTIVE_RUN_STATES = new Set([
  'created', 'planned', 'approval_required', 'approved',
  'running', 'verifying', 'needs_fix', 'reporting', 'blocked',
]);

const TERMINAL_STEP_STATES = new Set(['completed', 'skipped', 'cancelled']);

/* ============================================================================
 * Inputs (all injectable for tests)
 * ========================================================================== */

export interface IdleComputeOptions {
  /** Agents to compute for. When omitted, derived from sessions + run steps. */
  agentIds?: string[];
  sessions?: AgentSession[];
  /** Active runs to consider. When omitted, read from DB. */
  runs?: Run[];
  /** Steps for the active runs. When omitted, read per-run from DB. */
  runSteps?: RunStep[];
  approvals?: ApprovalRequest[];
  rateLimitEvents?: RateLimitEvent[];
  handoffs?: Handoff[];
  plans?: Plan[];
  autoSpawnEnabled?: boolean;
  autoResumeMode?: AutoResumeMode;
}

interface ResolvedInputs {
  sessions: AgentSession[];
  runs: Run[];
  steps: RunStep[];
  approvals: ApprovalRequest[];
  rateLimitEvents: RateLimitEvent[];
  handoffs: Handoff[];
  plans: Plan[];
  autoSpawnEnabled: boolean;
  autoResumeMode: AutoResumeMode;
}

function readAutomationFlags(): { autoSpawnEnabled: boolean; autoResumeMode: AutoResumeMode } {
  try {
    if (fs.existsSync(APP_SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf-8'));
      return {
        autoSpawnEnabled: s?.dorothyOrchestratorAutoSpawn !== false,
        autoResumeMode: normalizeAutoResumeMode(s?.dorothyAutoResumeRateLimitedSessions),
      };
    }
  } catch {
    /* fall through to defaults */
  }
  return { autoSpawnEnabled: true, autoResumeMode: 'dry-run' };
}

function resolveInputs(opts: IdleComputeOptions): ResolvedInputs {
  const flags = readAutomationFlags();
  const sessions = opts.sessions ?? safe(() => listAgentSessions({ limit: 500 }), []);
  const runs = opts.runs ?? safe(
    () => listRuns({ state: Array.from(ACTIVE_RUN_STATES) as Run['state'][], limit: 200 }),
    [],
  );
  let steps = opts.runSteps;
  if (!steps) {
    steps = [];
    for (const r of runs) {
      steps.push(...safe(() => listRunStepsByRun(r.id), []));
    }
  }
  const approvals = opts.approvals ?? safe(
    () => listApprovalRequests({ state: 'pending', limit: 200 }),
    [],
  );
  const rateLimitEvents = opts.rateLimitEvents ?? safe(
    () => listRateLimitEvents({ resumeStatus: ['scheduled', 'pending', 'resuming', 'failed'], limit: 200 }),
    [],
  );
  let handoffs = opts.handoffs;
  if (!handoffs) {
    handoffs = [];
    for (const r of runs) handoffs.push(...safe(() => listHandoffsByRun(r.id), []));
  }
  let plans = opts.plans;
  if (!plans) {
    plans = [];
    for (const r of runs) {
      if (r.planId) {
        const p = safe(() => getPlan(r.planId as string), null as Plan | null);
        if (p) plans.push(p);
      }
    }
  }
  return {
    sessions,
    runs,
    steps,
    approvals,
    rateLimitEvents,
    handoffs,
    plans,
    autoSpawnEnabled: opts.autoSpawnEnabled ?? flags.autoSpawnEnabled,
    autoResumeMode: opts.autoResumeMode ?? flags.autoResumeMode,
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/* ============================================================================
 * Core classification
 * ========================================================================== */

export function computeIdleStatusForAgent(
  agentId: string,
  inputs: ResolvedInputs,
): AgentIdleStatus {
  const key = normalizeAgentKey(agentId);
  const runById = new Map(inputs.runs.map(r => [r.id, r]));

  // 1) active session wins.
  const activeSession = inputs.sessions.find(
    s => normalizeAgentKey(s.agentId) === key && !s.exitedAt,
  );
  if (activeSession) {
    return {
      agentId,
      reason: 'active',
      summary: `Live session running${activeSession.runId ? ` on run ${activeSession.runId.slice(0, 8)}` : ''}.`,
      runId: activeSession.runId ?? undefined,
      runStepId: activeSession.runStepId ?? undefined,
      agentSessionId: activeSession.id,
      since: activeSession.startedAt,
    };
  }

  // Candidate pending step assigned to this agent within an active run.
  const pendingSteps = inputs.steps.filter(
    st =>
      normalizeAgentKey(st.agentId) === key &&
      st.state === 'pending' &&
      runById.has(st.runId),
  );
  const step = pendingSteps[0];

  const scheduledRateLimit = inputs.rateLimitEvents[0];

  if (!step) {
    // No work assigned. Distinguish "globally blocked" vs "nothing to do".
    if (scheduledRateLimit) {
      if (inputs.autoResumeMode === 'dry-run') {
        return {
          agentId,
          reason: 'auto_resume_dry_run',
          summary: `Rate limit scheduled (${scheduledRateLimit.engine}); auto-resume is dry-run so nothing restarts automatically.`,
          since: scheduledRateLimit.detectedAt,
        };
      }
      return {
        agentId,
        reason: 'blocked_by_rate_limit',
        summary: `Engine ${scheduledRateLimit.engine} rate-limited; waiting for reset.`,
        since: scheduledRateLimit.detectedAt,
      };
    }
    if (!inputs.autoSpawnEnabled && inputs.runs.length > 0) {
      return {
        agentId,
        reason: 'orchestrator_autospawn_disabled',
        summary: 'Active runs exist but orchestrator auto-spawn is disabled — no session will start automatically.',
      };
    }
    return {
      agentId,
      reason: 'no_assigned_runstep',
      summary: 'No pending RunStep is assigned to this agent.',
    };
  }

  // We have a pending step. Walk the blocker chain (first match wins).
  const run = runById.get(step.runId)!;
  const ctx = { agentId, runId: run.id, runStepId: step.id };

  // approval pending on this run
  const approval = inputs.approvals.find(a => a.runId === run.id);
  if (approval) {
    return {
      ...ctx,
      reason: 'waiting_for_approval',
      summary: `Run is waiting on an ApprovalRequest (${approval.riskLevel} risk).`,
      since: approval.createdAt,
    };
  }

  // rate limit affecting this run (or any scheduled engine)
  const rlForRun =
    inputs.rateLimitEvents.find(e => (e.affectedRunIds ?? []).includes(run.id)) ??
    scheduledRateLimit;
  if (rlForRun) {
    if (inputs.autoResumeMode === 'dry-run') {
      return {
        ...ctx,
        reason: 'auto_resume_dry_run',
        summary: `Rate limit on ${rlForRun.engine}; auto-resume dry-run will not restart this step.`,
        since: rlForRun.detectedAt,
      };
    }
    return {
      ...ctx,
      reason: 'blocked_by_rate_limit',
      summary: `Engine ${rlForRun.engine} rate-limited; step held until reset.`,
      since: rlForRun.detectedAt,
    };
  }

  // dependency: a prior-order step in this run not yet terminal
  const runSteps = inputs.steps.filter(s => s.runId === run.id);
  const priorIncomplete = runSteps.filter(
    s => s.order < step.order && !TERMINAL_STEP_STATES.has(s.state),
  );
  if (priorIncomplete.length > 0) {
    return {
      ...ctx,
      reason: 'waiting_for_dependency',
      summary: `Waiting on ${priorIncomplete.length} earlier RunStep(s) to finish first.`,
    };
  }

  // handoff: prior steps done, but no handoff routed into this step yet
  if (step.order > 0) {
    const hasIncomingHandoff = inputs.handoffs.some(h => h.toRunStepId === step.id);
    const priorCompleted = runSteps.some(
      s => s.order < step.order && s.state === 'completed',
    );
    if (priorCompleted && !hasIncomingHandoff) {
      return {
        ...ctx,
        reason: 'waiting_for_handoff',
        summary: 'Upstream step completed but no Handoff has been routed into this step yet.',
      };
    }
  }

  // run-mode parallelism policy
  const anotherRunning = runSteps.some(s => s.state === 'running');
  if (anotherRunning && !parallelAllowedFor(run.mode)) {
    return {
      ...ctx,
      reason: 'blocked_by_runmode_policy',
      summary: `Run mode "${run.mode ?? 'team'}" disallows parallel steps; another step is running.`,
    };
  }

  // validation gate (ultraqa requires validationCommands on the task)
  if (run.mode === 'ultraqa') {
    const plan = inputs.plans.find(p => p.id === run.planId);
    const task = plan?.tasks?.find(t => normalizeAgentKey(t.ownerAgentId) === key);
    if (task && (!task.validationCommands || task.validationCommands.length === 0)) {
      return {
        ...ctx,
        reason: 'waiting_for_validation',
        summary: 'ultraqa mode requires validationCommands on the task, but none are defined.',
      };
    }
  }

  // auto-spawn disabled — the step exists but nothing will dispatch it
  if (!inputs.autoSpawnEnabled) {
    return {
      ...ctx,
      reason: 'orchestrator_autospawn_disabled',
      summary: 'Step is ready but orchestrator auto-spawn is disabled.',
    };
  }

  return {
    ...ctx,
    reason: 'unknown',
    summary: 'Step is queued; no specific blocker detected (awaiting dispatch tick).',
  };
}

/* ============================================================================
 * Public surface
 * ========================================================================== */

export function computeIdleStatuses(opts: IdleComputeOptions = {}): AgentIdleStatus[] {
  const inputs = resolveInputs(opts);

  // Resolve the set of agent ids to report on.
  let agentIds = opts.agentIds;
  if (!agentIds || agentIds.length === 0) {
    const set = new Set<string>();
    for (const s of inputs.sessions) if (s.agentId) set.add(s.agentId);
    for (const st of inputs.steps) if (st.agentId) set.add(st.agentId);
    agentIds = Array.from(set);
  }

  return agentIds.map(id => computeIdleStatusForAgent(id, inputs));
}

export function getIdleStatus(agentId: string, opts: IdleComputeOptions = {}): AgentIdleStatus {
  const inputs = resolveInputs(opts);
  return computeIdleStatusForAgent(agentId, inputs);
}
