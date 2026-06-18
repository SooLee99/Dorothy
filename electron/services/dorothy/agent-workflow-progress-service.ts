/**
 * Dorothy MVP Phase 6-B — AgentWorkflowProgress service.
 *
 * One row per `(runId, runStepId, agentSessionId, agentId)` quartet. The
 * service exposes:
 *
 *   - `createOrGetWorkflowProgress` — dedupe by the quartet
 *   - `updateWorkflowProgressStep`  — flip a named step's state + attach evidence
 *   - `recomputeWorkflowProgressForRun` — walk HookEvents / RunSteps / Artifacts
 *     / Handoffs and rebuild progress for the entire Run
 *   - `safeUpdateWorkflowProgressFromHookEvent` — invoked from each emit site
 *     after a HookEvent lands; never throws
 *
 * Storage rules:
 *   - `steps_json` is the canonical step list including per-step evidence ids
 *   - We never store raw output or GitHub body text — only structural ids
 *   - Failure is observability-only; every write goes through a safe wrapper
 *     so the originating Run flow cannot break
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import {
  getWorkflowTemplate,
  resolveWorkflowKindForAgent,
  materializeSteps,
} from './agent-workflow-templates';
import type {
  AgentWorkflowKind,
  AgentWorkflowProgress,
  AgentWorkflowProgressStatus,
  AgentWorkflowStepProgress,
  AgentWorkflowStepStatus,
  CreateOrGetWorkflowProgressInput,
  HookEvent,
  HookEventType,
  UpdateWorkflowProgressStepInput,
} from '../../types/dorothy';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const STALL_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes without an event → stalled candidate

/* ============================================================================
 * Row mapping
 * ========================================================================== */

interface ProgressRow {
  id: string;
  run_id: string;
  run_step_id: string | null;
  agent_session_id: string | null;
  agent_id: string;
  workflow_kind: string;
  status: string;
  current_step_id: string | null;
  current_step_label: string | null;
  steps_json: string;
  progress_percent: number;
  blocked_reason: string | null;
  failed_reason: string | null;
  stalled_reason: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseSteps(raw: string | null): AgentWorkflowStepProgress[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as AgentWorkflowStepProgress[]) : [];
  } catch {
    return [];
  }
}

function rowToProgress(r: ProgressRow): AgentWorkflowProgress {
  return {
    id: r.id,
    runId: r.run_id,
    runStepId: r.run_step_id,
    agentSessionId: r.agent_session_id,
    agentId: r.agent_id,
    workflowKind: r.workflow_kind as AgentWorkflowKind,
    status: r.status as AgentWorkflowProgressStatus,
    currentStepId: r.current_step_id,
    currentStepLabel: r.current_step_label,
    steps: parseSteps(r.steps_json),
    progressPercent: r.progress_percent,
    blockedReason: r.blocked_reason,
    failedReason: r.failed_reason,
    stalledReason: r.stalled_reason,
    lastEventAt: r.last_event_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ============================================================================
 * Progress computation
 * ========================================================================== */

function computeProgressPercent(steps: AgentWorkflowStepProgress[]): number {
  if (steps.length === 0) return 0;
  const completed = steps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
  return Math.round((completed / steps.length) * 100);
}

function computeRollupStatus(
  steps: AgentWorkflowStepProgress[],
  blockedReason: string | null,
  failedReason: string | null,
): AgentWorkflowProgressStatus {
  if (failedReason) return 'failed';
  if (blockedReason) return 'blocked';
  if (steps.length === 0) return 'not_started';
  const hasFailed = steps.some(s => s.status === 'failed');
  if (hasFailed) return 'failed';
  const allDone = steps.every(s => s.status === 'completed' || s.status === 'skipped');
  if (allDone) return 'completed';
  const anyActive = steps.some(s => s.status === 'in_progress' || s.status === 'completed');
  return anyActive ? 'in_progress' : 'not_started';
}

function findCurrentStep(steps: AgentWorkflowStepProgress[]): AgentWorkflowStepProgress | null {
  const inProgress = steps.find(s => s.status === 'in_progress');
  if (inProgress) return inProgress;
  // Otherwise pick the first non-completed step so the UI has a "next up" cue.
  const next = steps.find(s => s.status === 'pending');
  return next ?? null;
}

function clampString(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Append a value to an evidence array without duplicates and with a sane cap. */
function appendUnique(arr: string[] | undefined, id: string | null | undefined, cap = 50): string[] {
  if (!id) return arr ?? [];
  const next = arr ? [...arr] : [];
  if (!next.includes(id)) next.push(id);
  return next.slice(-cap);
}

/* ============================================================================
 * CRUD
 * ========================================================================== */

export function createOrGetWorkflowProgress(input: CreateOrGetWorkflowProgressInput): AgentWorkflowProgress | null {
  const db = getDorothyDb();
  if (!db) return null;

  // Dedupe key — when any of step / session id is missing we still keep
  // one row per (run, agent, …) tuple so the recompute path can merge.
  const row = db.prepare(`
    SELECT * FROM agent_workflow_progress
    WHERE run_id = @run_id
      AND agent_id = @agent_id
      AND COALESCE(run_step_id, '') = COALESCE(@run_step_id, '')
      AND COALESCE(agent_session_id, '') = COALESCE(@agent_session_id, '')
    LIMIT 1
  `).get({
    run_id: input.runId,
    agent_id: input.agentId,
    run_step_id: input.runStepId ?? null,
    agent_session_id: input.agentSessionId ?? null,
  }) as ProgressRow | undefined;

  if (row) return rowToProgress(row);

  const id = uuidv4();
  const now = new Date().toISOString();
  const kind = input.workflowKind ?? resolveWorkflowKindForAgent(input.agentId);
  const steps = materializeSteps(kind);
  const status: AgentWorkflowProgressStatus = 'not_started';
  db.prepare(`
    INSERT INTO agent_workflow_progress (
      id, run_id, run_step_id, agent_session_id, agent_id,
      workflow_kind, status, current_step_id, current_step_label,
      steps_json, progress_percent,
      blocked_reason, failed_reason, stalled_reason, last_event_at,
      created_at, updated_at
    ) VALUES (
      @id, @run_id, @run_step_id, @agent_session_id, @agent_id,
      @workflow_kind, @status, NULL, NULL,
      @steps_json, 0,
      NULL, NULL, NULL, NULL,
      @now, @now
    )
  `).run({
    id,
    run_id: input.runId,
    run_step_id: input.runStepId ?? null,
    agent_session_id: input.agentSessionId ?? null,
    agent_id: input.agentId,
    workflow_kind: kind,
    status,
    steps_json: JSON.stringify(steps),
    now,
  });
  return getWorkflowProgress(id);
}

export function safeCreateOrGetWorkflowProgress(input: CreateOrGetWorkflowProgressInput): AgentWorkflowProgress | null {
  try {
    return createOrGetWorkflowProgress(input);
  } catch (err) {
    console.warn(
      '[workflow-progress] safeCreateOrGet suppressed error:',
      err instanceof Error ? err.message : 'unknown',
    );
    return null;
  }
}

export function getWorkflowProgress(id: string): AgentWorkflowProgress | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM agent_workflow_progress WHERE id = ?').get(id) as
    | ProgressRow
    | undefined;
  return row ? rowToProgress(row) : null;
}

export interface ListWorkflowProgressOptions {
  runId?: string;
  runStepId?: string;
  agentSessionId?: string;
  agentId?: string;
  workflowKind?: AgentWorkflowKind | AgentWorkflowKind[];
  status?: AgentWorkflowProgressStatus | AgentWorkflowProgressStatus[];
  limit?: number;
  offset?: number;
}

function clampLimit(n: number | undefined): number {
  const v = n ?? DEFAULT_LIMIT;
  if (v <= 0) return DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

export function listWorkflowProgress(opts: ListWorkflowProgressOptions = {}): AgentWorkflowProgress[] {
  const db = getDorothyDb();
  if (!db) return [];
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.runId)           { where.push('run_id = @run_id'); params.run_id = opts.runId; }
  if (opts.runStepId)       { where.push('run_step_id = @run_step_id'); params.run_step_id = opts.runStepId; }
  if (opts.agentSessionId)  { where.push('agent_session_id = @agent_session_id'); params.agent_session_id = opts.agentSessionId; }
  if (opts.agentId)         { where.push('agent_id = @agent_id'); params.agent_id = opts.agentId; }
  if (opts.workflowKind) {
    if (Array.isArray(opts.workflowKind)) {
      const ph = opts.workflowKind.map((_, i) => `@kind${i}`);
      opts.workflowKind.forEach((k, i) => { params[`kind${i}`] = k; });
      where.push(`workflow_kind IN (${ph.join(',')})`);
    } else { where.push('workflow_kind = @workflow_kind'); params.workflow_kind = opts.workflowKind; }
  }
  if (opts.status) {
    if (Array.isArray(opts.status)) {
      const ph = opts.status.map((_, i) => `@status${i}`);
      opts.status.forEach((s, i) => { params[`status${i}`] = s; });
      where.push(`status IN (${ph.join(',')})`);
    } else { where.push('status = @status'); params.status = opts.status; }
  }
  const limit = clampLimit(opts.limit);
  const offset = opts.offset ?? 0;
  const sql = `
    SELECT * FROM agent_workflow_progress
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `;
  const rows = db.prepare(sql).all({ ...params, limit, offset }) as ProgressRow[];
  return rows.map(rowToProgress);
}

export function listWorkflowProgressByRun(runId: string, opts: Omit<ListWorkflowProgressOptions, 'runId'> = {}): AgentWorkflowProgress[] {
  return listWorkflowProgress({ ...opts, runId });
}

export function listWorkflowProgressBySession(agentSessionId: string, opts: Omit<ListWorkflowProgressOptions, 'agentSessionId'> = {}): AgentWorkflowProgress[] {
  return listWorkflowProgress({ ...opts, agentSessionId });
}

/* ============================================================================
 * Step updates
 * ========================================================================== */

export function updateWorkflowProgressStep(input: UpdateWorkflowProgressStepInput): AgentWorkflowProgress | null {
  const db = getDorothyDb();
  if (!db) return null;
  const current = getWorkflowProgress(input.progressId);
  if (!current) return null;

  const steps = current.steps.map(s => ({ ...s }));
  const idx = steps.findIndex(s => s.stepId === input.stepId);
  if (idx === -1) return current;

  const step = steps[idx];
  const now = new Date().toISOString();

  if (input.status && input.status !== step.status) {
    if (input.status === 'in_progress' && !step.startedAt) step.startedAt = now;
    if (input.status === 'completed' || input.status === 'failed' || input.status === 'skipped') {
      if (!step.completedAt) step.completedAt = now;
    }
    step.status = input.status;
    // Earlier-named steps that are still pending should be auto-promoted to
    // skipped when we jump past them — that keeps progressPercent meaningful
    // when the agent skips a phase (e.g. running validation without a separate
    // implementation step). We *only* skip earlier steps that are still
    // pending, never overwrite completed / failed / in_progress.
    if (input.status === 'in_progress' || input.status === 'completed') {
      for (let i = 0; i < idx; i++) {
        if (steps[i].status === 'pending') {
          steps[i].status = 'skipped';
          if (!steps[i].startedAt) steps[i].startedAt = now;
          if (!steps[i].completedAt) steps[i].completedAt = now;
        } else if (input.status === 'completed' && steps[i].status === 'in_progress') {
          // The agent moved past this step without explicitly closing it.
          // Treat as completed so the rollup status can settle.
          steps[i].status = 'completed';
          if (!steps[i].completedAt) steps[i].completedAt = now;
        }
      }
    }
  }
  if (input.addHookEventId) step.evidenceHookEventIds = appendUnique(step.evidenceHookEventIds, input.addHookEventId);
  if (input.addArtifactId)  step.evidenceArtifactIds = appendUnique(step.evidenceArtifactIds, input.addArtifactId);
  if (input.addHandoffId)   step.evidenceHandoffIds  = appendUnique(step.evidenceHandoffIds, input.addHandoffId);
  if (input.note != null) {
    step.note = clampString(input.note, 240);
  }

  const failed = steps.find(s => s.status === 'failed');
  const failedReason = failed ? (failed.note ?? `step ${failed.stepId} failed`) : current.failedReason ?? null;
  const blockedReason = current.blockedReason ?? null;
  const newStatus = computeRollupStatus(steps, blockedReason, failedReason);
  const cur = findCurrentStep(steps);
  const progressPercent = computeProgressPercent(steps);

  db.prepare(`
    UPDATE agent_workflow_progress SET
      steps_json = @steps_json,
      progress_percent = @progress_percent,
      current_step_id = @current_step_id,
      current_step_label = @current_step_label,
      status = @status,
      failed_reason = @failed_reason,
      blocked_reason = @blocked_reason,
      last_event_at = @last_event_at,
      updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: input.progressId,
    steps_json: JSON.stringify(steps),
    progress_percent: progressPercent,
    current_step_id: cur?.stepId ?? null,
    current_step_label: cur?.label ?? null,
    status: newStatus,
    failed_reason: failedReason,
    blocked_reason: blockedReason,
    last_event_at: now,
    updated_at: now,
  });
  return getWorkflowProgress(input.progressId);
}

export function setWorkflowProgressBlocked(progressId: string, reason: string | null): AgentWorkflowProgress | null {
  const db = getDorothyDb();
  if (!db) return null;
  const cur = getWorkflowProgress(progressId);
  if (!cur) return null;
  const now = new Date().toISOString();
  const newStatus = computeRollupStatus(cur.steps, reason, cur.failedReason ?? null);
  db.prepare(`
    UPDATE agent_workflow_progress SET
      blocked_reason = @reason,
      status = @status,
      last_event_at = @now,
      updated_at = @now
    WHERE id = @id
  `).run({ id: progressId, reason, status: newStatus, now });
  return getWorkflowProgress(progressId);
}

export function setWorkflowProgressFailed(progressId: string, reason: string | null): AgentWorkflowProgress | null {
  const db = getDorothyDb();
  if (!db) return null;
  const cur = getWorkflowProgress(progressId);
  if (!cur) return null;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE agent_workflow_progress SET
      failed_reason = @reason,
      status = 'failed',
      last_event_at = @now,
      updated_at = @now
    WHERE id = @id
  `).run({ id: progressId, reason, now });
  return getWorkflowProgress(progressId);
}

/* ============================================================================
 * HookEvent → step mapping
 *
 * Conservative rules — we *only* update progress when the HookEvent has
 * enough context to identify a specific row. Anything else is a no-op.
 *
 * `safeUpdateWorkflowProgressFromHookEvent(event)` is the hot-path entry.
 * ========================================================================== */

/** Pick the workflow step that an event should advance, given the template. */
function pickTargetStep(
  progress: AgentWorkflowProgress,
  hint:
    | 'first'
    | 'last'
    | 'handoff'
    | 'validation'
    | 'ci'
    | 'qa'
    | 'approval'
    | 'session_started',
): AgentWorkflowStepProgress | null {
  const steps = progress.steps;
  if (steps.length === 0) return null;
  switch (hint) {
    case 'first':            return steps[0];
    case 'last':             return steps[steps.length - 1];
    case 'session_started':  return steps[0];
    case 'handoff': {
      const handoff = steps.find(s => s.stepId === 'handoff' || s.stepId === 'handoff_route' || s.stepId === 'task_draft' || s.stepId === 'qa_report' || s.stepId === 'final_report');
      return handoff ?? steps[steps.length - 1];
    }
    case 'validation': {
      // Frontend / Backend validation steps, or generic 'work'.
      return steps.find(s => s.stepId.includes('validation')) ?? steps.find(s => s.stepId === 'implementation' || s.stepId === 'work') ?? steps[steps.length - 1];
    }
    case 'ci': {
      return steps.find(s => s.stepId === 'ci_summary_check') ?? steps[steps.length - 1];
    }
    case 'qa': {
      return steps.find(s => s.stepId === 'test_execution' || s.stepId === 'review' || s.stepId === 'qa_report') ?? steps[steps.length - 1];
    }
    case 'approval': {
      return steps.find(s => s.stepId === 'approval_decision') ?? steps[steps.length - 1];
    }
    default: return null;
  }
}

/** When a HookEvent arrives we may not know the exact agentId. Resolve via:
 *    1. event.agentId
 *    2. event.runStepId → run_steps.agent_id
 *  Returns null when we cannot identify an agent — the caller skips.
 */
function resolveAgentForEvent(event: HookEvent): { agentId: string; runStepId: string | null } | null {
  if (event.agentId) {
    return { agentId: event.agentId, runStepId: event.runStepId ?? null };
  }
  if (event.runStepId) {
    const db = getDorothyDb();
    if (!db) return null;
    const row = db.prepare('SELECT agent_id FROM run_steps WHERE id = ?').get(event.runStepId) as
      | { agent_id: string }
      | undefined;
    if (row?.agent_id) {
      return { agentId: row.agent_id, runStepId: event.runStepId };
    }
  }
  return null;
}

export function safeUpdateWorkflowProgressFromHookEvent(event: HookEvent | null | undefined): void {
  if (!event) return;
  try {
    updateWorkflowProgressFromHookEvent(event);
  } catch (err) {
    console.warn(
      '[workflow-progress] safeUpdate suppressed error:',
      err instanceof Error ? err.message : 'unknown',
    );
  }
}

function updateWorkflowProgressFromHookEvent(event: HookEvent): void {
  // Approval events drive the Approval Validator workflow — they have a Run
  // but rarely an agentId. Handle separately.
  if (event.type === 'approval_required' || event.type === 'approval_resolved') {
    handleApprovalEvent(event);
    return;
  }

  // Rate limit / resume — block / unblock every active workflow on this Run.
  if (event.type === 'rate_limit_detected') {
    handleBlockingEvent(event, true);
    return;
  }
  if (event.type === 'resume_completed') {
    handleBlockingEvent(event, false);
    return;
  }

  // CI events drive the DevOps / Reporter workflow even when the event has
  // no agentId attached (the webhook handler doesn't know which agent owns
  // the CI run). Handle before the generic resolver.
  if (event.type === 'ci_failed' || event.type === 'ci_passed') {
    handleCiEvent(event);
    return;
  }

  // Everything else needs an identified agent + run.
  if (!event.runId) return;
  const resolved = resolveAgentForEvent(event);
  if (!resolved) return;

  const progress = safeCreateOrGetWorkflowProgress({
    runId: event.runId,
    runStepId: resolved.runStepId,
    agentSessionId: event.agentSessionId ?? null,
    agentId: resolved.agentId,
  });
  if (!progress) return;

  switch (event.type) {
    case 'agent_session_started':
    case 'run_step_started': {
      const target = pickTargetStep(progress, 'first');
      if (target) {
        updateWorkflowProgressStep({
          progressId: progress.id,
          stepId: target.stepId,
          status: 'in_progress',
          addHookEventId: event.id,
        });
      }
      break;
    }
    case 'agent_session_completed':
    case 'run_step_completed': {
      const target = pickTargetStep(progress, 'handoff');
      if (target) {
        updateWorkflowProgressStep({
          progressId: progress.id,
          stepId: target.stepId,
          status: 'completed',
          addHookEventId: event.id,
        });
      }
      break;
    }
    case 'agent_session_failed':
    case 'run_step_failed': {
      // Mark the current in-progress step (or the last step) failed and
      // stamp failedReason. The rollup will flip status to 'failed'.
      const current = progress.steps.find(s => s.status === 'in_progress')
        ?? progress.steps[progress.steps.length - 1];
      if (current) {
        updateWorkflowProgressStep({
          progressId: progress.id,
          stepId: current.stepId,
          status: 'failed',
          addHookEventId: event.id,
          note: clampString(event.summary ?? event.title, 240),
        });
        setWorkflowProgressFailed(progress.id, clampString(event.summary ?? event.title, 240));
      }
      break;
    }
    case 'handoff_created': {
      const target = pickTargetStep(progress, 'handoff');
      if (target) {
        updateWorkflowProgressStep({
          progressId: progress.id,
          stepId: target.stepId,
          status: 'completed',
          addHookEventId: event.id,
          addHandoffId: event.handoffId,
        });
      }
      break;
    }
    case 'artifact_created': {
      const target = pickTargetStep(progress, 'validation');
      if (target) {
        updateWorkflowProgressStep({
          progressId: progress.id,
          stepId: target.stepId,
          status: target.status === 'completed' ? 'completed' : 'in_progress',
          addHookEventId: event.id,
          addArtifactId: event.artifactId,
        });
      }
      break;
    }
    case 'qa_failed': {
      const target = pickTargetStep(progress, 'qa');
      if (target) {
        updateWorkflowProgressStep({
          progressId: progress.id,
          stepId: target.stepId,
          status: 'failed',
          addHookEventId: event.id,
        });
      }
      break;
    }
    case 'qa_passed': {
      const target = pickTargetStep(progress, 'qa');
      if (target) {
        updateWorkflowProgressStep({
          progressId: progress.id,
          stepId: target.stepId,
          status: 'completed',
          addHookEventId: event.id,
        });
      }
      break;
    }
    default:
      // No-op for the rest — keeps the surface narrow.
      break;
  }
}

function handleApprovalEvent(event: HookEvent): void {
  if (!event.runId) return;
  const progress = safeCreateOrGetWorkflowProgress({
    runId: event.runId,
    agentId: 'plan-validator',
    workflowKind: 'approval_validator',
  });
  if (!progress) return;
  if (event.type === 'approval_required') {
    const decision = pickTargetStep(progress, 'approval');
    if (decision) {
      updateWorkflowProgressStep({
        progressId: progress.id,
        stepId: decision.stepId,
        status: 'in_progress',
        addHookEventId: event.id,
      });
    }
    setWorkflowProgressBlocked(progress.id, clampString(event.title, 240));
  } else if (event.type === 'approval_resolved') {
    setWorkflowProgressBlocked(progress.id, null);
    const decision = pickTargetStep(progress, 'approval');
    if (decision) {
      updateWorkflowProgressStep({
        progressId: progress.id,
        stepId: decision.stepId,
        status: 'completed',
        addHookEventId: event.id,
      });
    }
  }
}

function handleCiEvent(event: HookEvent): void {
  if (!event.runId) return;
  const reporterProgress = safeCreateOrGetWorkflowProgress({
    runId: event.runId,
    agentId: 'devops-reporter',
    workflowKind: 'devops_reporter',
  });
  if (!reporterProgress) return;
  const target = pickTargetStep(reporterProgress, 'ci');
  if (target) {
    updateWorkflowProgressStep({
      progressId: reporterProgress.id,
      stepId: target.stepId,
      status: event.type === 'ci_failed' ? 'failed' : 'completed',
      addHookEventId: event.id,
      note: event.type === 'ci_failed' ? clampString(event.summary ?? event.title, 240) : null,
    });
  }
  if (event.type === 'ci_failed') {
    setWorkflowProgressFailed(reporterProgress.id, clampString(event.summary ?? event.title, 240));
  }
}

function handleBlockingEvent(event: HookEvent, block: boolean): void {
  if (!event.runId) return;
  // Touch every active workflow on this run.
  const rows = listWorkflowProgressByRun(event.runId, { limit: 50 });
  for (const p of rows) {
    if (p.status === 'completed' || p.status === 'failed') continue;
    if (block) {
      setWorkflowProgressBlocked(p.id, clampString(event.title, 240));
    } else if (p.blockedReason) {
      // Unblock once a resume completes — but only the rows we actually blocked.
      setWorkflowProgressBlocked(p.id, null);
    }
  }
}

/* ============================================================================
 * Recompute — rebuild every Run progress from raw HookEvent + RunStep history.
 *
 * We re-init the row's steps array from the template, then replay HookEvents
 * in chronological order. The result is convergent: calling recompute twice
 * yields the same state.
 * ========================================================================== */

interface RecomputeOptions {
  /** Default true — keep existing rows that are not produced by recompute. */
  preserveOthers?: boolean;
}

export function recomputeWorkflowProgressForRun(runId: string, _opts: RecomputeOptions = {}): AgentWorkflowProgress[] {
  const db = getDorothyDb();
  if (!db) return [];

  // Pull HookEvents for the Run in ascending order so a replay yields
  // deterministic state. Cap at 1k so recompute on a chronically-failing
  // Run cannot blow up.
  const events = db.prepare(`
    SELECT id, type, severity, run_id, run_step_id, agent_session_id, agent_id,
           artifact_id, handoff_id, approval_request_id, rate_limit_event_id,
           pull_request_id, ci_run_id, improvement_signal_id, kanban_task_id,
           source, title, summary, metadata_json, created_at
    FROM hook_events
    WHERE run_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT 1000
  `).all(runId) as Array<{
    id: string; type: string; severity: string;
    run_id: string | null; run_step_id: string | null; agent_session_id: string | null; agent_id: string | null;
    artifact_id: string | null; handoff_id: string | null; approval_request_id: string | null;
    rate_limit_event_id: string | null; pull_request_id: string | null; ci_run_id: string | null;
    improvement_signal_id: string | null; kanban_task_id: string | null;
    source: string; title: string; summary: string | null;
    metadata_json: string | null; created_at: string;
  }>;

  // Wipe the existing rows for this Run so the recompute is a true rebuild.
  db.prepare('DELETE FROM agent_workflow_progress WHERE run_id = ?').run(runId);

  for (const r of events) {
    const event: HookEvent = {
      id: r.id,
      type: r.type as HookEventType,
      severity: r.severity as HookEvent['severity'],
      runId: r.run_id,
      runStepId: r.run_step_id,
      agentSessionId: r.agent_session_id,
      agentId: r.agent_id,
      artifactId: r.artifact_id,
      handoffId: r.handoff_id,
      approvalRequestId: r.approval_request_id,
      rateLimitEventId: r.rate_limit_event_id,
      pullRequestId: r.pull_request_id,
      ciRunId: r.ci_run_id,
      improvementSignalId: r.improvement_signal_id,
      kanbanTaskId: r.kanban_task_id,
      source: r.source as HookEvent['source'],
      title: r.title,
      summary: r.summary,
      metadata: null, // metadata is intentionally not loaded — recompute uses ids only
      createdAt: r.created_at,
    };
    safeUpdateWorkflowProgressFromHookEvent(event);
  }
  return listWorkflowProgressByRun(runId);
}

/* ============================================================================
 * Stalled detection (conservative)
 *
 * `markStalledCandidates` flags rows whose `last_event_at` is older than the
 * threshold AND whose status is `in_progress`. Auto-creating Diagnostics
 * from stalled rows is intentionally deferred (Phase 6-C+); this helper
 * exists so the dashboard can highlight stale workflows.
 * ========================================================================== */

export function markStalledCandidates(now: Date = new Date()): number {
  const db = getDorothyDb();
  if (!db) return 0;
  const threshold = new Date(now.getTime() - STALL_THRESHOLD_MS).toISOString();
  const updated = db.prepare(`
    UPDATE agent_workflow_progress SET
      status = 'stalled',
      stalled_reason = COALESCE(stalled_reason, 'No HookEvent in 30+ minutes'),
      updated_at = @now
    WHERE status = 'in_progress'
      AND COALESCE(last_event_at, updated_at) < @threshold
  `).run({ threshold, now: now.toISOString() });
  return updated.changes ?? 0;
}

/* ============================================================================
 * Counters for the Command Center
 * ========================================================================== */

export interface WorkflowProgressCounts {
  not_started: number;
  in_progress: number;
  blocked: number;
  failed: number;
  completed: number;
  stalled: number;
  total: number;
}

export function countWorkflowProgress(): WorkflowProgressCounts {
  const db = getDorothyDb();
  const empty: WorkflowProgressCounts = {
    not_started: 0, in_progress: 0, blocked: 0, failed: 0, completed: 0, stalled: 0, total: 0,
  };
  if (!db) return empty;
  type Row = { status: string; n: number };
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM agent_workflow_progress GROUP BY status').all() as Row[];
  for (const r of rows) {
    empty.total += r.n;
    if (r.status in empty) (empty as unknown as Record<string, number>)[r.status] = r.n;
  }
  return empty;
}
