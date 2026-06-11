/**
 * Dorothy MVP Phase 4.5 — Integration Hardening tests.
 *
 * Coverage matches the Phase 4.5 spec verification list:
 *   - Orchestrator startAgent adapter binds AgentSession
 *   - Plan ownerAgentId beats legacy findMatchingAgent
 *   - TaskDraft.forbiddenPaths flows into the dispatch prompt
 *   - /api/rate-limit/event records an event AND blocks running Runs
 *   - rate-limit curl failure is non-fatal (script semantics)
 *   - No regression on dorothy.db CRUD
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { initDorothyDb, closeDorothyDb, getDorothyDb } from '../../../electron/services/dorothy/db';
import {
  createRun, getRun, updateRunState, listRunStepsByRun,
} from '../../../electron/services/dorothy/run-service';
import { createPlan } from '../../../electron/services/dorothy/plan-service';
import {
  configureOrchestrator,
  advanceRun,
} from '../../../electron/services/dorothy/orchestrator-service';
import {
  selectAgentForOwnerRole,
  buildRunContextPrompt,
  DEFAULT_FORBIDDEN_PATHS,
  DEFAULT_FAILURE_RULE,
  handoffPathFor,
  type LiveAgentSlim,
} from '../../../electron/services/dorothy/agent-routing';
import { createAgentSession, listAgentSessions, findActiveSessionForAgent } from '../../../electron/services/dorothy/agent-session-service';
import { recordRateLimitEventAndBlockRuns } from '../../../electron/services/dorothy/rate-limit-bridge';

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase45-${process.pid}`);
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let dbPath = '';

beforeEach(() => {
  dbPath = path.join(TEST_DIR, `dorothy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const r = initDorothyDb({ filePath: dbPath });
  if (!r.ok) throw new Error(`initDorothyDb failed: ${r.reason}`);
});

afterEach(() => {
  closeDorothyDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
});

/* ============================================================================
 * Orchestrator startAgent adapter
 * ========================================================================== */

describe('orchestrator startAgent adapter', () => {
  it('calls the adapter exactly once and binds the AgentSession to the RunStep', async () => {
    // Live frontend agent in 'idle' state.
    const live: LiveAgentSlim = {
      id: 'agent-fe-1',
      status: 'idle',
      name: 'frontend',
      projectPath: '/x/triplan-frontend',
      skills: [],
    };
    const startAgent = vi.fn(async (_: { agentId: string; prompt: string; runId: string; runStepId: string }) => {
      // Mirror what hooks-routes.ts would do: insert an active AgentSession
      // for this agent immediately so the orchestrator's session-bind step
      // can find it.
      createAgentSession({ agentId: live.id, provider: 'claude' });
    });
    configureOrchestrator({
      getLiveAgents: () => [live],
      startAgent,
    });

    const r = createRun({ title: 'fe small change', source: 'user', priority: 'low' })!;
    createPlan({
      runId: r.id, title: 'fe', description: 'd', state: 'approved',
      tasks: [{
        taskId: 't1', title: 'fe', description: 'fe',
        ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['compiles'],
      }],
    });
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');

    const outcome = await advanceRun(r.id);
    expect(outcome.action).toBe('started_worker_step');
    expect(outcome.agentId).toBe(live.id);
    expect(startAgent).toHaveBeenCalledTimes(1);

    // Session was created by the mock; orchestrator must have attached it.
    const steps = listRunStepsByRun(r.id);
    expect(steps[0].agentSessionId).toBeTruthy();
    const sess = findActiveSessionForAgent(live.id);
    expect(sess?.id).toBe(steps[0].agentSessionId);
  });

  it('marks step pending with errorReason when startAgent throws', async () => {
    const live: LiveAgentSlim = { id: 'agent-fe-2', status: 'idle', name: 'frontend' };
    configureOrchestrator({
      getLiveAgents: () => [live],
      startAgent: async () => {
        throw new Error('synthetic dispatch failure');
      },
    });

    const r = createRun({ title: 'fail dispatch', source: 'user' })!;
    createPlan({
      runId: r.id, title: 'fe', description: 'd', state: 'approved',
      tasks: [{
        taskId: 't1', title: 'fe', description: 'fe',
        ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['ok'],
      }],
    });
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');

    await advanceRun(r.id);

    const steps = listRunStepsByRun(r.id);
    expect(steps).toHaveLength(1);
    expect(steps[0].state).toBe('pending');
    expect(steps[0].errorReason).toContain('synthetic dispatch failure');
    // Run stays in 'running' (we transitioned before the dispatch attempted).
    // The Run Detail UI surfaces the errorReason on the step row.
    const run = getRun(r.id);
    expect(['running', 'approved']).toContain(run?.state);
  });

  it('leaves the step in running state when no startAgent adapter is configured', async () => {
    configureOrchestrator({ getLiveAgents: () => [] }); // no adapter at all
    const r = createRun({ title: 'no adapter', source: 'user' })!;
    createPlan({
      runId: r.id, title: 'd', description: 'd', state: 'approved',
      tasks: [{
        taskId: 't1', title: 'fe', description: 'fe',
        ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['ok'],
      }],
    });
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');

    const outcome = await advanceRun(r.id);
    // Step was still created so the legacy kanban auto-spawn path can pick
    // it up; the orchestrator just isn't doing the actual PTY spawn.
    expect(outcome.action).toBe('started_worker_step');
    const steps = listRunStepsByRun(r.id);
    expect(steps[0].state).toBe('running');
    expect(steps[0].agentSessionId).toBeNull();
  });
});

/* ============================================================================
 * Plan ownerAgentId beats findMatchingAgent
 * ========================================================================== */

describe('Plan-aware routing', () => {
  it('selectAgentForOwnerRole picks the idle agent matching the role over a stale match', () => {
    const liveAgents: LiveAgentSlim[] = [
      { id: 'frontend-busy', status: 'running', name: 'frontend' },
      { id: 'backend-idle',  status: 'idle',    name: 'backend' },
      { id: 'frontend-idle', status: 'idle',    name: 'frontend' },
    ];
    expect(selectAgentForOwnerRole('frontend', liveAgents)).toBe('frontend-idle');
    expect(selectAgentForOwnerRole('backend', liveAgents)).toBe('backend-idle');
    expect(selectAgentForOwnerRole('intake-planner', liveAgents)).toBeNull(); // no live match
    // Non-MVP role string is ignored entirely.
    expect(selectAgentForOwnerRole('totally-random-role', liveAgents)).toBeNull();
  });

  it('integration: orchestrator dispatches to the ownerAgentId of the next task', async () => {
    const liveAgents: LiveAgentSlim[] = [
      { id: 'fe-live', status: 'idle', name: 'frontend' },
      { id: 'be-live', status: 'idle', name: 'backend' },
    ];
    const calls: Array<{ agentId: string; runId: string; runStepId: string }> = [];
    configureOrchestrator({
      getLiveAgents: () => liveAgents,
      startAgent: async ({ agentId, runId, runStepId }) => {
        calls.push({ agentId, runId, runStepId });
        createAgentSession({ agentId, provider: 'claude' });
      },
    });

    const r = createRun({ title: 'be first', source: 'user' })!;
    createPlan({
      runId: r.id, title: 'be first', description: 'd', state: 'approved',
      tasks: [{
        taskId: 't1', title: 'be', description: 'be',
        ownerAgentId: 'backend', dependsOn: [], acceptanceCriteria: ['gradle test'],
      }],
    });
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');

    await advanceRun(r.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].agentId).toBe('be-live'); // matched on ownerAgentId='backend'
  });
});

/* ============================================================================
 * TaskDraft.forbiddenPaths in prompt
 * ========================================================================== */

describe('TaskDraft.forbiddenPaths surfaces in the run-context prompt', () => {
  it('includes both the planner-supplied paths AND the global defaults', () => {
    const prompt = buildRunContextPrompt({
      runId: 'r1', runStepId: 'rs1', planId: 'p1',
      task: {
        taskId: 't1', title: 'demo', description: 'demo',
        ownerAgentId: 'backend', dependsOn: [], acceptanceCriteria: ['ok'],
        forbiddenPaths: ['triplan-frontend/**', 'special/**'],
      },
      allowedWritePaths: ['triplan-travel-service/**'],
      forbiddenPaths: [...DEFAULT_FORBIDDEN_PATHS, 'special/**', 'triplan-frontend/**'],
      validationCommands: ['./gradlew test'],
      handoffOutputPath: handoffPathFor('backend', 't1'),
      failureHandlingRule: DEFAULT_FAILURE_RULE,
      taskSummary: 'demo',
    });
    expect(prompt).toContain('## Forbidden paths');
    expect(prompt).toContain('special/**');
    expect(prompt).toContain('triplan-frontend/**');
    // global defaults still present
    expect(prompt).toContain('.git/**');
    expect(prompt).toContain('~/.dorothy/agents.json');
  });

  it('orchestrator dispatches with the task-supplied forbiddenPaths concatenated to the defaults', async () => {
    const live: LiveAgentSlim = { id: 'be-x', status: 'idle', name: 'backend' };
    let capturedPrompt = '';
    configureOrchestrator({
      getLiveAgents: () => [live],
      startAgent: async ({ prompt }) => {
        capturedPrompt = prompt;
        createAgentSession({ agentId: live.id, provider: 'claude' });
      },
    });

    const r = createRun({ title: 'with forbidden', source: 'user' })!;
    createPlan({
      runId: r.id, title: 'fp', description: 'fp', state: 'approved',
      tasks: [{
        taskId: 't1', title: 'fp', description: 'fp',
        ownerAgentId: 'backend', dependsOn: [], acceptanceCriteria: ['ok'],
        forbiddenPaths: ['triplan-frontend/**', 'super-secret/**'],
        validationCommands: ['./custom-check.sh'],
      }],
    });
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');

    await advanceRun(r.id);
    expect(capturedPrompt).toContain('triplan-frontend/**');
    expect(capturedPrompt).toContain('super-secret/**');
    expect(capturedPrompt).toContain('.git/**'); // default still in place
    expect(capturedPrompt).toContain('./custom-check.sh'); // task-supplied validation cmd
    // Per-owner heuristic fallback should be suppressed when forbiddenPaths
    // was given explicitly — `src/**` is backend's heuristic forbidden but is
    // not in the task's explicit list, so it must NOT appear in the prompt's
    // Forbidden Paths section.
    const forbiddenSection = capturedPrompt.split('## Forbidden paths')[1]?.split('##')[0] ?? '';
    expect(forbiddenSection).not.toContain('- src/**');
  });

  it('falls back to per-owner heuristics when forbiddenPaths is absent', async () => {
    const live: LiveAgentSlim = { id: 'be-y', status: 'idle', name: 'backend' };
    let capturedPrompt = '';
    configureOrchestrator({
      getLiveAgents: () => [live],
      startAgent: async ({ prompt }) => {
        capturedPrompt = prompt;
        createAgentSession({ agentId: live.id, provider: 'claude' });
      },
    });

    const r = createRun({ title: 'no forbidden', source: 'user' })!;
    createPlan({
      runId: r.id, title: 'd', description: 'd', state: 'approved',
      tasks: [{
        taskId: 't1', title: 'be', description: 'be',
        ownerAgentId: 'backend', dependsOn: [], acceptanceCriteria: ['ok'],
        // no forbiddenPaths
      }],
    });
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');

    await advanceRun(r.id);
    // Backend's heuristic forbidden list (defined in orchestrator-service):
    // triplan-frontend/**, src/**
    expect(capturedPrompt).toContain('triplan-frontend/**');
    expect(capturedPrompt).toContain('src/**');
  });
});

/* ============================================================================
 * Rate-limit HTTP endpoint behaviour (functional, via the service it delegates to)
 *
 * We assert the *behaviour* the new POST route exposes; the route file is a
 * thin adapter over recordRateLimitEventAndBlockRuns(), and exercising the
 * service directly avoids spinning a real HTTP server inside the unit test.
 * ========================================================================== */

describe('rate-limit HTTP wiring (service contract)', () => {
  it('records an event AND blocks every running Run with the right blockedReason', () => {
    const r1 = createRun({ title: 'r1', source: 'user' })!;
    const r2 = createRun({ title: 'r2', source: 'user' })!;
    for (const r of [r1, r2]) {
      updateRunState(r.id, 'planned');
      updateRunState(r.id, 'approved');
      updateRunState(r.id, 'running');
    }

    const result = recordRateLimitEventAndBlockRuns({
      engine: 'claude',
      source: 'pm_output',
      message: 'usage limit reached',
      resetAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });

    expect(result.event).toBeTruthy();
    expect(result.event!.engine).toBe('claude');
    expect(result.blockedRunIds.sort()).toEqual([r1.id, r2.id].sort());
    expect(getRun(r1.id)?.state).toBe('blocked');
    expect(getRun(r1.id)?.blockedReason).toBe('rate_limit:claude');
    expect(getRun(r2.id)?.blockedReason).toBe('rate_limit:claude');
  });

  it('returns blockedRunIds=[] when no runs are running (PM-tick safe call)', () => {
    const r = recordRateLimitEventAndBlockRuns({ engine: 'claude', source: 'pm_output' });
    expect(r.event).toBeTruthy();
    expect(r.blockedRunIds).toHaveLength(0);
  });

  it('PM-tick curl failure is non-fatal (smoke: shell script || true semantics)', () => {
    // Sanity proxy: the route helper itself never throws on invalid payload.
    // (the actual `|| true` lives in the shell; we assert here that the
    //  service call would not surface a runtime error to the script either.)
    const r = recordRateLimitEventAndBlockRuns({
      engine: 'claude', source: 'pm_output',
      // affectedRunIds intentionally points at a non-existent Run.
      affectedRunIds: ['does-not-exist'],
    });
    expect(r.event).toBeTruthy();
    expect(r.blockedRunIds).toHaveLength(0); // ignored unknown id; no throw
  });
});

/* ============================================================================
 * Smoke: DB still alive after the new wiring
 * ========================================================================== */

describe('Phase 4.5 regression smoke', () => {
  it('dorothy.db still creates and reads a Run', () => {
    const r = createRun({ title: 'smoke', source: 'user' });
    expect(r).toBeTruthy();
    expect(getDorothyDb()).not.toBeNull();
    expect(getRun(r!.id)?.title).toBe('smoke');
  });

  it('AgentSession can still be created standalone (no Run linkage required)', () => {
    const s = createAgentSession({ agentId: 'frontend', provider: 'claude' });
    expect(s).toBeTruthy();
    expect(s!.runId).toBeNull();
    expect(listAgentSessions({ agentId: 'frontend' })).toHaveLength(1);
  });
});
