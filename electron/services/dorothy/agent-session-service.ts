/**
 * Dorothy MVP — AgentSession service.
 *
 * One AgentSession row per agent PTY/CLI invocation. It is *not* the same as
 * AgentStatus (which is the live runtime snapshot stored in agents.json);
 * see docs/rebuild-target-mvp/mvp-data-models.md §7 for the differences.
 *
 * All writes here are best-effort and DB-absent-tolerant: the legacy
 * AgentStatus update path keeps working even when dorothy.db is missing.
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
  AgentSession,
  AgentSessionEndStatus,
  CreateAgentSessionInput,
  EndAgentSessionInput,
} from '../../types/dorothy';

interface AgentSessionRow {
  id: string;
  run_id: string | null;
  run_step_id: string | null;
  agent_id: string;
  provider: string;
  worktree_path: string | null;
  started_at: string;
  exited_at: string | null;
  end_status: string | null;
  waiting_for_user_input: number;
  pid: number | null;
  raw_log_ref: string | null;
}

function rowToSession(r: AgentSessionRow): AgentSession {
  return {
    id: r.id,
    runId: r.run_id,
    runStepId: r.run_step_id,
    agentId: r.agent_id,
    provider: r.provider,
    worktreePath: r.worktree_path,
    startedAt: r.started_at,
    exitedAt: r.exited_at,
    endStatus: (r.end_status ?? null) as AgentSessionEndStatus | null,
    waitingForUserInput: r.waiting_for_user_input === 1,
    pid: r.pid,
    rawLogRef: r.raw_log_ref,
  };
}

export function createAgentSession(input: CreateAgentSessionInput): AgentSession | null {
  const db = getDorothyDb();
  if (!db) return null;

  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO agent_sessions (
      id, run_id, run_step_id, agent_id, provider, worktree_path,
      started_at, exited_at, end_status, waiting_for_user_input, pid, raw_log_ref
    ) VALUES (
      @id, @run_id, @run_step_id, @agent_id, @provider, @worktree_path,
      @started_at, NULL, NULL, 0, @pid, NULL
    )
  `).run({
    id,
    run_id: input.runId ?? null,
    run_step_id: input.runStepId ?? null,
    agent_id: input.agentId,
    provider: input.provider,
    worktree_path: input.worktreePath ?? null,
    started_at: now,
    pid: input.pid ?? null,
  });

  // Phase 5F — Hook Event timeline.
  const ev = safeCreateHookEvent({
    type: 'agent_session_started',
    severity: 'info',
    source: 'hook',
    runId: input.runId ?? null,
    runStepId: input.runStepId ?? null,
    agentSessionId: id,
    agentId: input.agentId,
    title: `Agent session start — ${input.agentId} (${input.provider})`,
    metadata: {
      provider: input.provider,
      worktreePath: input.worktreePath ?? null,
      pid: input.pid ?? null,
    },
  });
  // Phase 6-B — attach the workflow row + advance first step to in_progress.
  if (input.runId) {
    safeCreateOrGetWorkflowProgress({
      runId: input.runId,
      runStepId: input.runStepId ?? null,
      agentSessionId: id,
      agentId: input.agentId,
    });
  }
  safeUpdateWorkflowProgressFromHookEvent(ev);

  return getAgentSession(id);
}

export function getAgentSession(id: string): AgentSession | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as
    | AgentSessionRow
    | undefined;
  return row ? rowToSession(row) : null;
}

export interface UpdateAgentSessionInput {
  id: string;
  waitingForUserInput?: boolean;
  runId?: string | null;
  runStepId?: string | null;
}

/** Update mid-flight session attributes — kept narrow on purpose. */
export function updateAgentSession(input: UpdateAgentSessionInput): AgentSession | null {
  const db = getDorothyDb();
  if (!db) return null;

  const current = getAgentSession(input.id);
  if (!current) return null;

  db.prepare(`
    UPDATE agent_sessions SET
      waiting_for_user_input = COALESCE(@waiting, waiting_for_user_input),
      run_id      = COALESCE(@run_id, run_id),
      run_step_id = COALESCE(@run_step_id, run_step_id)
    WHERE id = @id
  `).run({
    id: input.id,
    waiting: input.waitingForUserInput === undefined ? null
      : input.waitingForUserInput ? 1 : 0,
    run_id: input.runId ?? null,
    run_step_id: input.runStepId ?? null,
  });

  // Phase 5F — emit on the waiting transition only. Same-value updates
  // (running → running) intentionally produce no timeline noise.
  if (
    input.waitingForUserInput !== undefined &&
    !!input.waitingForUserInput !== !!current.waitingForUserInput
  ) {
    safeCreateHookEvent({
      type: 'agent_session_waiting',
      severity: input.waitingForUserInput ? 'warning' : 'info',
      source: 'hook',
      runId: current.runId,
      runStepId: current.runStepId,
      agentSessionId: input.id,
      agentId: current.agentId,
      title: input.waitingForUserInput
        ? `Agent waiting — ${current.agentId}`
        : `Agent resumed from waiting — ${current.agentId}`,
      metadata: { waiting: !!input.waitingForUserInput, provider: current.provider },
    });
  }

  return getAgentSession(input.id);
}

export function endAgentSession(input: EndAgentSessionInput): AgentSession | null {
  const db = getDorothyDb();
  if (!db) return null;

  const current = getAgentSession(input.id);
  if (!current) return null;
  if (current.exitedAt) {
    // Already ended — idempotent no-op so hook retries are safe.
    return current;
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE agent_sessions SET
      exited_at = @exited_at,
      end_status = @end_status,
      raw_log_ref = COALESCE(@raw_log_ref, raw_log_ref),
      waiting_for_user_input = 0
    WHERE id = @id
  `).run({
    id: input.id,
    exited_at: now,
    end_status: input.endStatus,
    raw_log_ref: input.rawLogRef ?? null,
  });

  // Phase 5F — Hook Event timeline.
  const failure = input.endStatus === 'failed' || input.endStatus === 'timeout';
  const ev = safeCreateHookEvent({
    type: failure ? 'agent_session_failed' : 'agent_session_completed',
    severity: failure ? 'error' : 'info',
    source: 'hook',
    runId: current.runId,
    runStepId: current.runStepId,
    agentSessionId: input.id,
    agentId: current.agentId,
    title: `Agent session ${input.endStatus} — ${current.agentId}`,
    metadata: { endStatus: input.endStatus, provider: current.provider },
  });
  // Phase 6-A — promote agent_session_failed (and timeout) into Diagnostics.
  if (failure) safeDetectDiagnosticFromHookEvent(ev);
  // Phase 6-B — finalise the workflow row (completed or failed).
  safeUpdateWorkflowProgressFromHookEvent(ev);

  return getAgentSession(input.id);
}

export interface ListAgentSessionsOptions {
  agentId?: string;
  runId?: string;
  runStepId?: string;
  active?: boolean; // active = exited_at IS NULL
  limit?: number;
  offset?: number;
}

export function listAgentSessions(opts: ListAgentSessionsOptions = {}): AgentSession[] {
  const db = getDorothyDb();
  if (!db) return [];

  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts.agentId) {
    where.push('agent_id = @agent_id');
    params.agent_id = opts.agentId;
  }
  if (opts.runId) {
    where.push('run_id = @run_id');
    params.run_id = opts.runId;
  }
  if (opts.runStepId) {
    where.push('run_step_id = @run_step_id');
    params.run_step_id = opts.runStepId;
  }
  if (opts.active === true) {
    where.push('exited_at IS NULL');
  } else if (opts.active === false) {
    where.push('exited_at IS NOT NULL');
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;

  const rows = db.prepare(`
    SELECT * FROM agent_sessions ${whereSql}
    ORDER BY started_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }) as AgentSessionRow[];

  return rows.map(rowToSession);
}

/**
 * Find the latest still-active session for an agent. Used by the hooks
 * adapter to know which session a status event refers to.
 */
export function findActiveSessionForAgent(agentId: string): AgentSession | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare(`
    SELECT * FROM agent_sessions
    WHERE agent_id = ? AND exited_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `).get(agentId) as AgentSessionRow | undefined;
  return row ? rowToSession(row) : null;
}
