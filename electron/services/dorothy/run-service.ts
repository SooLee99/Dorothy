/**
 * Dorothy MVP — Run / RunStep service.
 *
 * Transitions follow docs/rebuild-target-mvp/mvp-run-state-machine.md §2.
 * Invalid transitions are *warned, not rejected* in MVP — the dashboard's
 * job is to surface the warning so users can spot bad orchestrator behavior,
 * not to hard-block legitimate edge cases (e.g. user-initiated cancel from
 * any state, retry-from-failed).
 *
 * Every function tolerates the DB being absent and returns null in that
 * case. This is what lets the rest of Dorothy keep running when better-sqlite3
 * has a packaging issue or the file is locked.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import { safeCreateHookEvent } from './hook-event-service';
import { safeDetectDiagnosticFromHookEvent } from './diagnostic-detector';
import {
  safeCreateOrGetWorkflowProgress,
  safeUpdateWorkflowProgressFromHookEvent,
} from './agent-workflow-progress-service';
import type {
  Run,
  RunState,
  RunStep,
  RunStepState,
  CreateRunInput,
  CreateRunStepInput,
  Priority,
  RunSource,
  RunMode,
  RunModeSource,
} from '../../types/dorothy';

/* ============================================================================
 * Row mapping
 * ========================================================================== */

interface RunRow {
  id: string;
  title: string;
  source: string;
  source_ref_id: string | null;
  priority: string;
  state: string;
  blocked_reason: string | null;
  error_reason: string | null;
  plan_id: string | null;
  kanban_task_id: string | null;
  created_at: string;
  started_at: string | null;
  closed_at: string | null;
  comment: string | null;
  // Phase 5D additions (nullable after ALTER TABLE).
  mode: string | null;
  mode_source: string | null;
  mode_reason: string | null;
}

interface RunStepRow {
  id: string;
  run_id: string;
  step_order: number;
  agent_id: string;
  state: string;
  prompt_ref: string | null;
  started_at: string | null;
  ended_at: string | null;
  retry_count: number;
  error_reason: string | null;
  agent_session_id: string | null;
}

function rowToRun(r: RunRow): Run {
  return {
    id: r.id,
    title: r.title,
    source: r.source as RunSource,
    sourceRefId: r.source_ref_id,
    priority: r.priority as Priority,
    state: r.state as RunState,
    blockedReason: r.blocked_reason,
    errorReason: r.error_reason,
    planId: r.plan_id,
    kanbanTaskId: r.kanban_task_id,
    createdAt: r.created_at,
    startedAt: r.started_at,
    closedAt: r.closed_at,
    comment: r.comment,
    mode: (r.mode ?? null) as RunMode | null,
    modeSource: (r.mode_source ?? null) as RunModeSource | null,
    modeReason: r.mode_reason,
  };
}

function rowToRunStep(r: RunStepRow): RunStep {
  return {
    id: r.id,
    runId: r.run_id,
    order: r.step_order,
    agentId: r.agent_id,
    state: r.state as RunStepState,
    promptRef: r.prompt_ref,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    retryCount: r.retry_count,
    errorReason: r.error_reason,
    agentSessionId: r.agent_session_id,
  };
}

/* ============================================================================
 * Run state transition table
 *
 * Keys are origin states; values are the allowed next states. Entries below
 * intentionally match the table in mvp-run-state-machine.md §2.
 *
 * `cancelled` is reachable from every state (user override), so we apply
 * that universally in `isValidTransition` rather than listing it here.
 * ========================================================================== */

const ALLOWED_NEXT: Record<RunState, ReadonlyArray<RunState>> = {
  created:           ['planned', 'cancelled'],
  planned:           ['approved', 'approval_required', 'failed', 'cancelled'],
  approval_required: ['approved', 'planned', 'cancelled', 'failed'],
  approved:          ['running', 'cancelled'],
  running:           ['running', 'verifying', 'blocked', 'failed', 'cancelled'],
  verifying:         ['reporting', 'needs_fix', 'blocked', 'cancelled', 'failed'],
  needs_fix:         ['running', 'failed', 'cancelled'],
  reporting:         ['completed', 'needs_fix', 'failed', 'cancelled'],
  blocked:           ['running', 'verifying', 'approved', 'cancelled', 'failed'],
  failed:            ['running', 'cancelled'],
  completed:         [],
  cancelled:         [],
};

function isValidRunTransition(from: RunState, to: RunState): boolean {
  if (from === to && to === 'running') return true; // self-loop on running
  if (to === 'cancelled') return true;
  const allowed = ALLOWED_NEXT[from];
  return allowed?.includes(to) ?? false;
}

const VALID_RUN_STATES: ReadonlyArray<RunState> = [
  'created', 'planned', 'approval_required', 'approved', 'running',
  'verifying', 'needs_fix', 'reporting', 'completed', 'blocked', 'failed', 'cancelled',
];

/* ============================================================================
 * Run CRUD
 * ========================================================================== */

export function createRun(input: CreateRunInput): Run | null {
  const db = getDorothyDb();
  if (!db) return null;

  const id = uuidv4();
  const now = new Date().toISOString();
  const state: RunState = input.state ?? 'created';
  const priority: Priority = input.priority ?? 'medium';

  if (!VALID_RUN_STATES.includes(state)) {
    console.warn(`[run-service] createRun: invalid state "${state}", falling back to 'created'`);
  }

  db.prepare(`
    INSERT INTO runs (
      id, title, source, source_ref_id, priority, state,
      blocked_reason, error_reason, plan_id, kanban_task_id,
      created_at, started_at, closed_at, comment,
      mode, mode_source, mode_reason
    ) VALUES (
      @id, @title, @source, @source_ref_id, @priority, @state,
      NULL, NULL, @plan_id, @kanban_task_id,
      @created_at, NULL, NULL, @comment,
      @mode, @mode_source, @mode_reason
    )
  `).run({
    id,
    title: input.title,
    source: input.source,
    source_ref_id: input.sourceRefId ?? null,
    priority,
    state,
    plan_id: input.planId ?? null,
    kanban_task_id: input.kanbanTaskId ?? null,
    created_at: now,
    comment: input.comment ?? null,
    // Phase 5D — all nullable; the caller can let the router decide.
    mode: input.mode ?? null,
    mode_source: input.modeSource ?? null,
    mode_reason: input.modeReason ?? null,
  });

  // Phase 5F — Hook Event timeline. Failures swallowed by safeCreateHookEvent.
  safeCreateHookEvent({
    type: 'run_created',
    severity: 'info',
    source: 'orchestrator',
    runId: id,
    title: `Run created — ${input.title}`,
    summary: `source=${input.source}, priority=${priority}, state=${state}`,
    metadata: {
      source: input.source,
      sourceRefId: input.sourceRefId ?? null,
      priority,
      state,
      mode: input.mode ?? null,
      modeSource: input.modeSource ?? null,
      kanbanTaskId: input.kanbanTaskId ?? null,
    },
  });

  return getRun(id);
}

export function getRun(id: string): Run | null {
  const db = getDorothyDb();
  if (!db) return null;

  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export interface ListRunsOptions {
  state?: RunState | RunState[];
  source?: RunSource;
  kanbanTaskId?: string;
  limit?: number;
  offset?: number;
}

export function listRuns(opts: ListRunsOptions = {}): Run[] {
  const db = getDorothyDb();
  if (!db) return [];

  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts.state) {
    if (Array.isArray(opts.state)) {
      // Build a placeholder list — values are enum strings, no injection risk.
      const placeholders = opts.state.map((_, i) => `@state${i}`);
      opts.state.forEach((s, i) => { params[`state${i}`] = s; });
      where.push(`state IN (${placeholders.join(',')})`);
    } else {
      where.push('state = @state');
      params.state = opts.state;
    }
  }
  if (opts.source) {
    where.push('source = @source');
    params.source = opts.source;
  }
  if (opts.kanbanTaskId) {
    where.push('kanban_task_id = @kanban_task_id');
    params.kanban_task_id = opts.kanbanTaskId;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;

  const rows = db.prepare(`
    SELECT * FROM runs ${whereSql}
    ORDER BY created_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }) as RunRow[];

  return rows.map(rowToRun);
}

export interface UpdateRunStateOptions {
  blockedReason?: string | null;
  errorReason?: string | null;
  comment?: string | null;
}

/**
 * Move a Run to a new state. Validates the transition; on invalid we still
 * apply the change but log a warning (see file header). Returns the new
 * row or null if the Run does not exist / DB is unavailable.
 */
export function updateRunState(
  id: string,
  next: RunState,
  options: UpdateRunStateOptions = {}
): Run | null {
  const db = getDorothyDb();
  if (!db) return null;

  const current = getRun(id);
  if (!current) {
    console.warn(`[run-service] updateRunState: run ${id} not found`);
    return null;
  }

  if (!VALID_RUN_STATES.includes(next)) {
    console.warn(`[run-service] updateRunState: invalid target state "${next}" for run ${id}`);
    return current;
  }

  if (!isValidRunTransition(current.state, next)) {
    console.warn(
      `[run-service] updateRunState: suspicious transition ${current.state} → ${next} on run ${id} (applied anyway)`
    );
  }

  const now = new Date().toISOString();
  // Derive timestamp side-effects from the transition.
  const setStartedAt = next === 'running' && !current.startedAt;
  const setClosedAt = (next === 'completed' || next === 'cancelled' || next === 'failed') && !current.closedAt;

  db.prepare(`
    UPDATE runs SET
      state = @state,
      blocked_reason = @blocked_reason,
      error_reason = @error_reason,
      comment = COALESCE(@comment, comment),
      started_at = CASE WHEN @set_started THEN @now ELSE started_at END,
      closed_at  = CASE WHEN @set_closed THEN @now ELSE closed_at END
    WHERE id = @id
  `).run({
    id,
    state: next,
    blocked_reason: next === 'blocked' ? (options.blockedReason ?? null) : null,
    error_reason: options.errorReason ?? (next === 'failed' ? current.errorReason : null),
    comment: options.comment ?? null,
    set_started: setStartedAt ? 1 : 0,
    set_closed: setClosedAt ? 1 : 0,
    now,
  });

  // Phase 5F — emit run_state_changed only when the state actually moved. We
  // explicitly suppress the no-op self-update so the timeline doesn't bloat
  // (the `running → running` allowed self-loop fires `advanceRun` on every
  // tick).
  if (current.state !== next) {
    const severity = next === 'failed' ? 'error'
                   : next === 'blocked' ? 'warning'
                   : next === 'needs_fix' ? 'warning'
                   : next === 'completed' ? 'info'
                   : 'info';
    safeCreateHookEvent({
      type: 'run_state_changed',
      severity,
      source: 'orchestrator',
      runId: id,
      title: `Run ${current.state} → ${next}`,
      summary: options.blockedReason ?? options.errorReason ?? options.comment ?? null,
      metadata: {
        from: current.state,
        to: next,
        blockedReason: options.blockedReason ?? null,
        errorReason: options.errorReason ?? null,
      },
    });
  }

  return getRun(id);
}

/**
 * Phase 5E — operator-driven RunMode change.
 *
 * Refuses to edit `completed / failed / cancelled` Runs so a terminated Run
 * cannot have its mode rewritten in retrospect. Always stamps the new mode
 * with `modeSource='manual'` (or the caller's override) so the audit trail
 * tells future readers a human flipped it.
 */
export interface UpdateRunModeInput {
  id: string;
  mode: 'manual' | 'team' | 'persistent' | 'ultraqa' | 'pipeline';
  reason?: string | null;
  /** Defaults to 'manual'; tests / migrations can stamp 'policy' or 'default'. */
  source?: 'manual' | 'keyword' | 'policy' | 'default';
}

export function updateRunMode(input: UpdateRunModeInput): Run | null {
  const db = getDorothyDb();
  if (!db) return null;
  const current = getRun(input.id);
  if (!current) {
    console.warn(`[run-service] updateRunMode: run ${input.id} not found`);
    return null;
  }
  // Terminal states are locked — we don't rewrite history.
  if (current.state === 'completed' || current.state === 'failed' || current.state === 'cancelled') {
    console.warn(`[run-service] updateRunMode: run ${input.id} is ${current.state}; refusing to edit mode`);
    return current;
  }
  const reason = input.reason ?? `mode set to ${input.mode} by user`;
  const source = input.source ?? 'manual';
  db.prepare(`
    UPDATE runs SET
      mode = @mode,
      mode_source = @source,
      mode_reason = @reason
    WHERE id = @id
  `).run({
    id: input.id,
    mode: input.mode,
    source,
    reason,
  });
  // Phase 5F — emit only when the *value* of mode actually changed. A
  // same-mode re-stamp (manual click on the current mode, or a webhook hint
  // that resolves to the same mode) intentionally produces no timeline noise.
  if (current.mode !== input.mode) {
    safeCreateHookEvent({
      type: 'run_mode_changed',
      severity: 'info',
      source: 'orchestrator',
      runId: input.id,
      title: `Run mode ${current.mode ?? '(unset)'} → ${input.mode}`,
      summary: reason,
      metadata: { from: current.mode ?? null, to: input.mode, source, reason },
    });
  }
  return getRun(input.id);
}

/** Convenience for orchestrator code: attach the canonical Plan to a Run. */
export function setRunPlan(runId: string, planId: string | null): Run | null {
  const db = getDorothyDb();
  if (!db) return null;
  db.prepare('UPDATE runs SET plan_id = @plan_id WHERE id = @id').run({ id: runId, plan_id: planId });
  return getRun(runId);
}

/* ============================================================================
 * RunStep CRUD
 * ========================================================================== */

const VALID_STEP_STATES: ReadonlyArray<RunStepState> = [
  'pending', 'running', 'completed', 'failed', 'skipped', 'cancelled',
];

export function createRunStep(input: CreateRunStepInput): RunStep | null {
  const db = getDorothyDb();
  if (!db) return null;

  const id = uuidv4();
  const state: RunStepState = input.state ?? 'pending';

  if (!VALID_STEP_STATES.includes(state)) {
    console.warn(`[run-service] createRunStep: invalid state "${state}", falling back to 'pending'`);
  }

  db.prepare(`
    INSERT INTO run_steps (
      id, run_id, step_order, agent_id, state, prompt_ref,
      started_at, ended_at, retry_count, error_reason, agent_session_id
    ) VALUES (
      @id, @run_id, @step_order, @agent_id, @state, @prompt_ref,
      NULL, NULL, 0, NULL, NULL
    )
  `).run({
    id,
    run_id: input.runId,
    step_order: input.order,
    agent_id: input.agentId,
    state,
    prompt_ref: input.promptRef ?? null,
  });

  // Phase 5F — Run step created.
  safeCreateHookEvent({
    type: 'run_step_created',
    severity: 'info',
    source: 'orchestrator',
    runId: input.runId,
    runStepId: id,
    agentId: input.agentId,
    title: `Run step #${input.order} created — ${input.agentId}`,
    summary: input.promptRef ?? null,
    metadata: { order: input.order, agentId: input.agentId, promptRef: input.promptRef ?? null, state },
  });
  // Phase 6-B — initialise the agent workflow progress row when the
  // RunStep is created so it shows up on Run Detail even before the PTY
  // session lands.
  safeCreateOrGetWorkflowProgress({
    runId: input.runId,
    runStepId: id,
    agentId: input.agentId,
  });

  return getRunStep(id);
}

export function getRunStep(id: string): RunStep | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM run_steps WHERE id = ?').get(id) as RunStepRow | undefined;
  return row ? rowToRunStep(row) : null;
}

export function listRunStepsByRun(runId: string): RunStep[] {
  const db = getDorothyDb();
  if (!db) return [];
  const rows = db.prepare(
    'SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_order ASC'
  ).all(runId) as RunStepRow[];
  return rows.map(rowToRunStep);
}

export interface UpdateRunStepStateOptions {
  errorReason?: string | null;
  agentSessionId?: string | null;
  /** Bump retry counter (use when retrying a previously failed step). */
  incrementRetry?: boolean;
}

export function updateRunStepState(
  id: string,
  next: RunStepState,
  options: UpdateRunStepStateOptions = {}
): RunStep | null {
  const db = getDorothyDb();
  if (!db) return null;

  const current = getRunStep(id);
  if (!current) {
    console.warn(`[run-service] updateRunStepState: step ${id} not found`);
    return null;
  }

  if (!VALID_STEP_STATES.includes(next)) {
    console.warn(`[run-service] updateRunStepState: invalid state "${next}" for step ${id}`);
    return current;
  }

  const now = new Date().toISOString();
  const setStarted = next === 'running' && !current.startedAt;
  const setEnded = (next === 'completed' || next === 'failed' || next === 'cancelled' || next === 'skipped') && !current.endedAt;

  db.prepare(`
    UPDATE run_steps SET
      state = @state,
      error_reason = COALESCE(@error_reason, error_reason),
      agent_session_id = COALESCE(@agent_session_id, agent_session_id),
      retry_count = retry_count + @inc,
      started_at = CASE WHEN @set_started THEN @now ELSE started_at END,
      ended_at   = CASE WHEN @set_ended THEN @now ELSE ended_at END
    WHERE id = @id
  `).run({
    id,
    state: next,
    error_reason: options.errorReason ?? null,
    agent_session_id: options.agentSessionId ?? null,
    inc: options.incrementRetry ? 1 : 0,
    set_started: setStarted ? 1 : 0,
    set_ended: setEnded ? 1 : 0,
    now,
  });

  // Phase 5F — emit run_step_started / completed / failed only on real
  // transitions. We never emit when the state is unchanged.
  if (current.state !== next) {
    if (next === 'running') {
      const ev = safeCreateHookEvent({
        type: 'run_step_started',
        severity: 'info',
        source: 'orchestrator',
        runId: current.runId,
        runStepId: id,
        agentId: current.agentId,
        agentSessionId: options.agentSessionId ?? current.agentSessionId ?? null,
        title: `Step #${current.order} ${current.agentId} started`,
        metadata: { order: current.order, retry: options.incrementRetry ? current.retryCount + 1 : current.retryCount },
      });
      safeUpdateWorkflowProgressFromHookEvent(ev);
    } else if (next === 'completed') {
      const ev = safeCreateHookEvent({
        type: 'run_step_completed',
        severity: 'info',
        source: 'orchestrator',
        runId: current.runId,
        runStepId: id,
        agentId: current.agentId,
        agentSessionId: current.agentSessionId ?? null,
        title: `Step #${current.order} ${current.agentId} completed`,
        metadata: { order: current.order },
      });
      safeUpdateWorkflowProgressFromHookEvent(ev);
    } else if (next === 'failed') {
      const ev = safeCreateHookEvent({
        type: 'run_step_failed',
        severity: 'error',
        source: 'orchestrator',
        runId: current.runId,
        runStepId: id,
        agentId: current.agentId,
        agentSessionId: current.agentSessionId ?? null,
        title: `Step #${current.order} ${current.agentId} failed`,
        summary: options.errorReason ?? current.errorReason ?? null,
        metadata: {
          order: current.order,
          agentId: current.agentId,
          errorReason: options.errorReason ?? current.errorReason ?? null,
          retryCount: current.retryCount,
        },
      });
      // Phase 6-A — promote into a Diagnostic for /diagnostics visibility.
      safeDetectDiagnosticFromHookEvent(ev);
      // Phase 6-B — flip the matching workflow step to failed + set
      // the rollup status. This is idempotent with the detector wiring.
      safeUpdateWorkflowProgressFromHookEvent(ev);
    }
  }

  return getRunStep(id);
}

/** Bind an existing session to a step (used by hooks integration). */
export function attachSessionToStep(stepId: string, sessionId: string | null): RunStep | null {
  const db = getDorothyDb();
  if (!db) return null;
  db.prepare('UPDATE run_steps SET agent_session_id = @sid WHERE id = @id')
    .run({ id: stepId, sid: sessionId });
  return getRunStep(stepId);
}

// Test/debug helper — exposed so the rate-limit transition rules and the
// kanban adapter can both share the same source of truth.
export { isValidRunTransition, ALLOWED_NEXT };
