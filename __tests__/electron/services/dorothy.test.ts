/**
 * Dorothy MVP Phase 1 — smoke tests for the new SQLite-backed services.
 *
 * We test against a real on-disk SQLite file under os.tmpdir() so DDL/SQL
 * mistakes surface for real. The DB path is injected via
 * `initDorothyDb({ filePath })` so we never touch the production
 * `~/.dorothy/dorothy.db`.
 *
 * Note on module identity: `vi.resetModules()` between tests means each test
 * gets a fresh module-level singleton in db.ts, but every service in the same
 * test resolves `./db` to the same instance (they share the test's import
 * graph). That's the only ordering guarantee we rely on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import {
  initDorothyDb,
  closeDorothyDb,
  getDorothyDb,
  requireDorothyDb,
} from '../../../electron/services/dorothy/db';

import {
  createRun,
  getRun,
  listRuns,
  updateRunState,
  createRunStep,
  updateRunStepState,
  listRunStepsByRun,
} from '../../../electron/services/dorothy/run-service';

import {
  createAgentSession,
  endAgentSession,
  updateAgentSession,
  getAgentSession,
  listAgentSessions,
  findActiveSessionForAgent,
} from '../../../electron/services/dorothy/agent-session-service';

import {
  createPlan,
  updatePlan,
  listPlansByRun,
} from '../../../electron/services/dorothy/plan-service';

import {
  createArtifact,
  listArtifactsByRun,
  createHandoff,
  listHandoffsByRun,
} from '../../../electron/services/dorothy/artifact-service';

import {
  createApprovalRequest,
  decideApprovalRequest,
  listApprovalRequests,
} from '../../../electron/services/dorothy/approval-request-service';

import {
  createRateLimitEvent,
  resolveRateLimitEvent,
  listRateLimitEvents,
} from '../../../electron/services/dorothy/rate-limit-service';

import {
  createIntakeRequest,
  attachIntakeToRun,
} from '../../../electron/services/dorothy/intake-request-service';

import {
  onKanbanTaskChanged,
  targetKanbanColumn,
} from '../../../electron/services/dorothy/kanban-task-adapter';

const TEST_DIR = path.join(os.tmpdir(), `dorothy-test-${process.pid}`);
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let dbPath = '';

beforeEach(() => {
  dbPath = path.join(
    TEST_DIR,
    `dorothy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
  const result = initDorothyDb({ filePath: dbPath });
  if (!result.ok) {
    throw new Error(`initDorothyDb failed: ${result.reason}`);
  }
});

afterEach(() => {
  closeDorothyDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
});

/* ============================================================================
 * db init
 * ========================================================================== */

describe('dorothy db init', () => {
  it('created all MVP tables', () => {
    const handle = requireDorothyDb();
    const tables = handle
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: unknown) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'agent_sessions',
        'approval_requests',
        'artifacts',
        'handoffs',
        'intake_requests',
        'plans',
        'rate_limit_events',
        'run_steps',
        'runs',
      ])
    );
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('graceful degrade: getDorothyDb returns null after close', () => {
    expect(getDorothyDb()).not.toBeNull();
    closeDorothyDb();
    expect(getDorothyDb()).toBeNull();
    // Re-init for the afterEach
    initDorothyDb({ filePath: dbPath });
  });
});

/* ============================================================================
 * runs + run_steps
 * ========================================================================== */

describe('runs + run_steps service', () => {
  it('creates a Run, lists it, and gets it by id', () => {
    const created = createRun({
      title: 'My first run',
      source: 'user',
      priority: 'high',
    });
    expect(created).not.toBeNull();
    expect(created?.title).toBe('My first run');
    expect(created?.state).toBe('created');
    expect(created?.priority).toBe('high');

    const fetched = getRun(created!.id);
    expect(fetched?.id).toBe(created!.id);

    const list = listRuns({ state: 'created' });
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(created!.id);
  });

  it('walks the full happy-path state machine', () => {
    const r = createRun({ title: 't', source: 'pm_tick' })!;
    expect(updateRunState(r.id, 'planned')?.state).toBe('planned');
    expect(updateRunState(r.id, 'approved')?.state).toBe('approved');

    const running = updateRunState(r.id, 'running');
    expect(running?.state).toBe('running');
    expect(running?.startedAt).toBeTruthy();

    expect(updateRunState(r.id, 'verifying')?.state).toBe('verifying');
    expect(updateRunState(r.id, 'reporting')?.state).toBe('reporting');

    const done = updateRunState(r.id, 'completed');
    expect(done?.state).toBe('completed');
    expect(done?.closedAt).toBeTruthy();
  });

  it('records blocked_reason on blocked, clears it on resume', () => {
    const r = createRun({ title: 'b', source: 'user' })!;
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');
    updateRunState(r.id, 'running');
    const blocked = updateRunState(r.id, 'blocked', { blockedReason: 'rate_limit:claude' });
    expect(blocked?.state).toBe('blocked');
    expect(blocked?.blockedReason).toBe('rate_limit:claude');

    const resumed = updateRunState(r.id, 'running');
    expect(resumed?.state).toBe('running');
    expect(resumed?.blockedReason).toBeNull();
  });

  it('warns but still applies a suspicious transition (completed → running)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = createRun({ title: 'x', source: 'user' })!;
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');
    updateRunState(r.id, 'running');
    updateRunState(r.id, 'verifying');
    updateRunState(r.id, 'reporting');
    updateRunState(r.id, 'completed');

    const resurrected = updateRunState(r.id, 'running');
    expect(resurrected?.state).toBe('running');
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('creates a RunStep, lists by run, and transitions states', () => {
    const r = createRun({ title: 'with steps', source: 'user' })!;
    const step = createRunStep({ runId: r.id, order: 0, agentId: 'backend' })!;
    expect(step.state).toBe('pending');

    const started = updateRunStepState(step.id, 'running');
    expect(started?.state).toBe('running');
    expect(started?.startedAt).toBeTruthy();

    const done = updateRunStepState(step.id, 'completed');
    expect(done?.state).toBe('completed');
    expect(done?.endedAt).toBeTruthy();

    expect(listRunStepsByRun(r.id).map(s => s.id)).toEqual([step.id]);
  });

  it('bumps retry_count when asked', () => {
    const r = createRun({ title: 'retry', source: 'user' })!;
    const step = createRunStep({ runId: r.id, order: 0, agentId: 'qa-reviewer' })!;
    updateRunStepState(step.id, 'failed');
    const retried = updateRunStepState(step.id, 'running', { incrementRetry: true });
    expect(retried?.retryCount).toBe(1);
    const retried2 = updateRunStepState(step.id, 'failed', { incrementRetry: true });
    expect(retried2?.retryCount).toBe(2);
  });
});

/* ============================================================================
 * agent_sessions
 * ========================================================================== */

describe('agent_sessions service', () => {
  it('creates a session and ends it as completed', () => {
    const s = createAgentSession({ agentId: 'frontend', provider: 'claude' })!;
    expect(s.exitedAt).toBeNull();
    expect(s.endStatus).toBeNull();

    const ended = endAgentSession({ id: s.id, endStatus: 'completed' });
    expect(ended?.endStatus).toBe('completed');
    expect(ended?.exitedAt).toBeTruthy();

    // Idempotent re-end is a no-op
    const again = endAgentSession({ id: s.id, endStatus: 'failed' });
    expect(again?.endStatus).toBe('completed');

    expect(listAgentSessions({ agentId: 'frontend' }).length).toBe(1);
    expect(findActiveSessionForAgent('frontend')).toBeNull();
  });

  it('finds an active session and marks waitingForUserInput', () => {
    const s = createAgentSession({ agentId: 'qa-reviewer', provider: 'claude' })!;
    updateAgentSession({ id: s.id, waitingForUserInput: true });
    expect(getAgentSession(s.id)?.waitingForUserInput).toBe(true);
    expect(findActiveSessionForAgent('qa-reviewer')?.id).toBe(s.id);
  });
});

/* ============================================================================
 * plans
 * ========================================================================== */

describe('plans + tasks JSON service', () => {
  it('persists tasks JSON and round-trips correctly', () => {
    const r = createRun({ title: 'plan test', source: 'user' })!;
    const plan = createPlan({
      runId: r.id,
      title: 'p1',
      description: 'do things',
      tasks: [
        {
          taskId: 't1',
          title: 'one',
          description: 'first task',
          ownerAgentId: 'backend',
          dependsOn: [],
          acceptanceCriteria: ['compiles', 'passes tests'],
        },
      ],
    })!;
    expect(plan.tasks.length).toBe(1);
    expect(plan.tasks[0].taskId).toBe('t1');

    const updated = updatePlan({
      id: plan.id,
      state: 'approved',
      tasks: [
        ...plan.tasks,
        {
          taskId: 't2',
          title: 'two',
          description: 'second task',
          ownerAgentId: 'frontend',
          dependsOn: ['t1'],
          acceptanceCriteria: ['button renders'],
        },
      ],
    });
    expect(updated?.state).toBe('approved');
    expect(updated?.tasks.length).toBe(2);

    expect(listPlansByRun(r.id).length).toBe(1);
  });
});

/* ============================================================================
 * artifacts + handoffs
 * ========================================================================== */

describe('artifacts + handoffs', () => {
  it('records artifacts and handoffs and lists by run', () => {
    const r = createRun({ title: 'art', source: 'user' })!;
    const step = createRunStep({ runId: r.id, order: 0, agentId: 'backend' })!;
    const step2 = createRunStep({ runId: r.id, order: 1, agentId: 'qa-reviewer' })!;

    const a = createArtifact({
      runId: r.id,
      runStepId: step.id,
      type: 'patch',
      producedByAgentId: 'backend',
      contentRef: 'git:abcdef',
    })!;
    const a2 = createArtifact({
      runId: r.id,
      runStepId: step.id,
      type: 'test',
      producedByAgentId: 'backend',
      meta: { passed: 12, failed: 0 },
    })!;

    expect(listArtifactsByRun(r.id).length).toBe(2);

    const h = createHandoff({
      runId: r.id,
      fromRunStepId: step.id,
      toRunStepId: step2.id,
      summary: 'backend done; ready for QA',
      attachedArtifactIds: [a.id, a2.id],
    })!;
    expect(h.attachedArtifactIds).toEqual([a.id, a2.id]);

    expect(listHandoffsByRun(r.id).length).toBe(1);
  });
});

/* ============================================================================
 * approval_requests
 * ========================================================================== */

describe('approval_requests', () => {
  it('decides and lists approval requests', () => {
    const r = createRun({ title: 'a', source: 'user' })!;
    const req = createApprovalRequest({
      runId: r.id,
      riskLevel: 'high',
      topic: 'SEC-1',
    })!;
    expect(req.state).toBe('pending');

    const decided = decideApprovalRequest({
      id: req.id,
      state: 'user_approved',
      decidedBy: 'user',
      decisionNote: 'looks safe',
    });
    expect(decided?.state).toBe('user_approved');
    expect(decided?.decidedBy).toBe('user');

    expect(listApprovalRequests({ runId: r.id }).length).toBe(1);
  });
});

/* ============================================================================
 * rate_limit_events
 * ========================================================================== */

describe('rate_limit_events', () => {
  it('records and resolves a rate limit event', () => {
    const evt = createRateLimitEvent({
      engine: 'claude',
      source: 'pm_output',
      message: '5h cooldown',
    })!;
    expect(evt.engine).toBe('claude');
    expect(evt.resolvedAt).toBeNull();

    const resolved = resolveRateLimitEvent(evt.id);
    expect(resolved?.resolvedAt).toBeTruthy();
    expect(resolved?.resumedAt).toBeTruthy();

    expect(listRateLimitEvents({ active: true }).length).toBe(0);
  });
});

/* ============================================================================
 * intake_requests
 * ========================================================================== */

describe('intake_requests', () => {
  it('creates and attaches to a run', () => {
    const r = createRun({ title: 'i', source: 'user' })!;
    const i = createIntakeRequest({
      source: 'user',
      rawContent: 'please look at this',
    })!;
    const attached = attachIntakeToRun(i.id, r.id);
    expect(attached?.routedRunId).toBe(r.id);
  });
});

/* ============================================================================
 * kanban-task-adapter
 * ========================================================================== */

describe('kanban-task-adapter', () => {
  it('creates a mirror Run when a kanban task hits planned, then reuses it', () => {
    // backlog → no run
    expect(onKanbanTaskChanged({
      id: 'k1', title: 'do it', column: 'backlog', priority: 'medium',
    })).toBeNull();

    // planned → run.state='approved'
    const plannedRun = onKanbanTaskChanged({
      id: 'k1', title: 'do it', column: 'planned', priority: 'medium',
    });
    expect(plannedRun?.state).toBe('approved');
    expect(plannedRun?.kanbanTaskId).toBe('k1');

    // ongoing → run.state='running' (same kanban task — should reuse)
    const ongoingRun = onKanbanTaskChanged({
      id: 'k1', title: 'do it', column: 'ongoing', priority: 'medium',
    });
    expect(ongoingRun?.id).toBe(plannedRun?.id);
    expect(ongoingRun?.state).toBe('running');

    // done → completed
    const doneRun = onKanbanTaskChanged({
      id: 'k1', title: 'do it', column: 'done', priority: 'medium',
    });
    expect(doneRun?.state).toBe('completed');
  });

  it('does not loop when source is the Run side', () => {
    expect(onKanbanTaskChanged(
      { id: 'k2', title: 'noop', column: 'planned' },
      { source: 'run' }
    )).toBeNull();
  });

  it('returns the target column for a Run, null for failed/cancelled', () => {
    const r = createRun({
      title: 'k3', source: 'kanban', kanbanTaskId: 'k3', state: 'running',
    })!;
    expect(targetKanbanColumn(r)).toBe('ongoing');
    const failed = updateRunState(r.id, 'failed')!;
    expect(targetKanbanColumn(failed)).toBeNull();
  });
});
