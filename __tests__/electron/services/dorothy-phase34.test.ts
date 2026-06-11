/**
 * Dorothy MVP Phase 3 + 4 — orchestrator, plan-validator, rate-limit-bridge.
 *
 * Mirrors the same on-disk DB pattern as `dorothy.test.ts`. Tests cover the
 * happy paths the user listed in the Phase-3/4 spec:
 *   - Run state transitions (approved → running → verifying → reporting → completed)
 *   - retry budget exhaustion → needs_fix
 *   - QA-failure → needs_fix → orchestrator re-dispatch
 *   - Plan validator: auto_approved / pending (user gate) / rejected paths
 *   - Rate limit bridge: block all running runs + resume restores prior state
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import {
  initDorothyDb,
  closeDorothyDb,
} from '../../../electron/services/dorothy/db';
import {
  createRun,
  getRun,
  updateRunState,
  listRunStepsByRun,
} from '../../../electron/services/dorothy/run-service';
import { createPlan, updatePlan } from '../../../electron/services/dorothy/plan-service';
import {
  configureOrchestrator,
  advanceRun,
  completeRunStep,
} from '../../../electron/services/dorothy/orchestrator-service';
import {
  evaluatePlan,
  validatePlan,
} from '../../../electron/services/dorothy/plan-validator-service';
import {
  recordRateLimitEventAndBlockRuns,
  resumeRateLimitEvent,
  _peekMemo,
} from '../../../electron/services/dorothy/rate-limit-bridge';
import { listHandoffsByRun } from '../../../electron/services/dorothy/artifact-service';

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase34-${process.pid}`);
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let dbPath = '';

beforeEach(() => {
  dbPath = path.join(TEST_DIR, `dorothy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const r = initDorothyDb({ filePath: dbPath });
  if (!r.ok) throw new Error(`initDorothyDb failed: ${r.reason}`);
  // Tell the orchestrator we have no live agents and no start adapter —
  // dispatch becomes a no-op so we can drive state transitions purely with
  // completeRunStep calls.
  configureOrchestrator({ getLiveAgents: () => [] });
});

afterEach(() => {
  closeDorothyDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
});

/* ============================================================================
 * Plan validator
 * ========================================================================== */

describe('plan-validator', () => {
  it('auto-approves a low-risk plan with all checks passing', () => {
    const r = createRun({ title: 'feat: small UI tweak', source: 'user', priority: 'low' })!;
    updateRunState(r.id, 'planned'); // intake-planner would do this for us
    const p = createPlan({
      runId: r.id,
      title: 'feat: small UI tweak',
      description: 'Tweak a label',
      riskLevel: 'low',
      tasks: [{
        taskId: 't1', title: 'edit label', description: 'rename',
        ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['compiles'],
      }],
    })!;
    const v = evaluatePlan(p);
    expect(v.approvalState).toBe('auto_approved');
    expect(v.shouldApprove).toBe(true);
    expect(v.checks.every(c => c.passed)).toBe(true);

    const res = validatePlan(p.id);
    expect(res?.verdict.approvalState).toBe('auto_approved');
    expect(getRun(r.id)?.state).toBe('approved');
  });

  it('requires user gate when a topic like SEC-1 is mentioned', () => {
    const r = createRun({ title: 'rotate token (SEC-1)', source: 'user', priority: 'high' })!;
    updateRunState(r.id, 'planned');
    const p = createPlan({
      runId: r.id,
      title: 'rotate token',
      description: 'SEC-1 rotation — must affect production secret store',
      riskLevel: 'high',
      tasks: [{
        taskId: 't1', title: 'rotate', description: 'rotate',
        ownerAgentId: 'backend', dependsOn: [], acceptanceCriteria: ['old token revoked'],
      }],
    })!;
    const v = evaluatePlan(p);
    expect(v.approvalState).toBe('pending');
    expect(v.needsUserGate).toBe(true);
    expect(v.topic).toMatch(/gate:|forbidden:|risk:/);

    validatePlan(p.id);
    expect(getRun(r.id)?.state).toBe('approval_required');
  });

  it('rejects a plan with no ownerAgentId', () => {
    const r = createRun({ title: 'unassigned', source: 'user' })!;
    updateRunState(r.id, 'planned');
    const p = createPlan({
      runId: r.id,
      title: 'unassigned',
      description: 'no owner',
      tasks: [{
        taskId: 't1', title: 'x', description: 'y',
        ownerAgentId: '', dependsOn: [], acceptanceCriteria: ['ac'],
      }],
    })!;
    const v = evaluatePlan(p);
    expect(v.approvalState).toBe('rejected');
    expect(v.rejected).toBe(true);

    validatePlan(p.id);
    // Rejected plans intentionally do NOT auto-fail the Run — the planner
    // gets a chance to retry with a cleaner Plan. Run stays in 'planned'.
    expect(getRun(r.id)?.state).toBe('planned');
  });

  it('appends to triplan/approvals/*.md when the path exists', () => {
    const fakeTriplan = path.join(TEST_DIR, `triplan-${Date.now()}`);
    fs.mkdirSync(path.join(fakeTriplan, 'approvals'), { recursive: true });
    process.env.DOROTHY_TRIPLAN_ROOT = fakeTriplan;

    const r = createRun({ title: 'mirror test', source: 'user', priority: 'low' })!;
    updateRunState(r.id, 'planned');
    const p = createPlan({
      runId: r.id,
      title: 'mirror test', description: 'low risk',
      riskLevel: 'low',
      tasks: [{
        taskId: 't1', title: 'noop', description: 'noop',
        ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['ok'],
      }],
    })!;
    const res = validatePlan(p.id);
    const mdPath = res?.mirroredMdPath;
    expect(mdPath).toBeTruthy();
    expect(fs.existsSync(mdPath!)).toBe(true);
    const body = fs.readFileSync(mdPath!, 'utf8');
    expect(body).toContain('AUTO_APPROVED');
    expect(body).toContain(p.id);

    delete process.env.DOROTHY_TRIPLAN_ROOT;
  });
});

/* ============================================================================
 * Orchestrator state-machine
 * ========================================================================== */

describe('orchestrator state transitions', () => {
  function buildApprovedRunWithPlan(): { runId: string; planId: string } {
    const r = createRun({ title: 'orch test', source: 'user', priority: 'low' })!;
    const p = createPlan({
      runId: r.id,
      title: 'orch test',
      description: 'two-step',
      state: 'approved',
      tasks: [
        {
          taskId: 'fe', title: 'fe', description: 'fe',
          ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['compiles'],
        },
        {
          taskId: 'be', title: 'be', description: 'be',
          ownerAgentId: 'backend', dependsOn: ['fe'], acceptanceCriteria: ['tests pass'],
        },
      ],
    })!;
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');
    return { runId: r.id, planId: p.id };
  }

  it('walks approved → running → verifying → reporting → completed', async () => {
    const { runId } = buildApprovedRunWithPlan();

    // 1) approved → running with first worker step.
    let out = await advanceRun(runId);
    expect(out.action).toBe('started_worker_step');
    expect(getRun(runId)?.state).toBe('running');
    let steps = listRunStepsByRun(runId);
    expect(steps).toHaveLength(1);
    expect(steps[0].agentId).toBe('frontend');

    // 2) complete the FE step. completeRunStep advances.
    out = (await completeRunStep({ runStepId: steps[0].id, endStatus: 'completed' }))!;
    expect(['started_worker_step', 'started_qa_step']).toContain(out.action);
    steps = listRunStepsByRun(runId);
    expect(steps).toHaveLength(2);
    expect(steps[1].agentId).toBe('backend');

    // 3) complete BE → QA inserted, state goes verifying.
    out = (await completeRunStep({ runStepId: steps[1].id, endStatus: 'completed' }))!;
    expect(out.action).toBe('started_qa_step');
    expect(getRun(runId)?.state).toBe('verifying');

    // 4) QA passes → reporting.
    steps = listRunStepsByRun(runId);
    const qaStep = steps.find(s => s.agentId === 'qa-reviewer')!;
    out = (await completeRunStep({ runStepId: qaStep.id, endStatus: 'completed' }))!;
    expect(out.action).toBe('started_report_step');
    expect(getRun(runId)?.state).toBe('reporting');

    // 5) Reporter completes → completed.
    steps = listRunStepsByRun(runId);
    const reportStep = steps.find(s => s.agentId === 'devops-reporter')!;
    out = (await completeRunStep({ runStepId: reportStep.id, endStatus: 'completed' }))!;
    expect(out.action).toBe('completed_run');
    expect(getRun(runId)?.state).toBe('completed');
  });

  it('QA failure → needs_fix → orchestrator re-dispatches worker', async () => {
    const { runId } = buildApprovedRunWithPlan();

    // Drive FE and BE to completion.
    let out = await advanceRun(runId);
    let steps = listRunStepsByRun(runId);
    await completeRunStep({ runStepId: steps[0].id, endStatus: 'completed' });
    steps = listRunStepsByRun(runId);
    await completeRunStep({ runStepId: steps[1].id, endStatus: 'completed' });

    // QA dispatched. Fail it (retry budget = 2 ⇒ up to 3 attempts total).
    steps = listRunStepsByRun(runId);
    const qa1 = steps.find(s => s.agentId === 'qa-reviewer')!;
    out = (await completeRunStep({ runStepId: qa1.id, endStatus: 'failed', errorReason: 'flaky test' }))!;
    // First QA failure → orchestrator re-dispatches QA (retry phase).
    expect(out.action).toBe('started_qa_step');
    expect(out.reason).toMatch(/retry/);
    steps = listRunStepsByRun(runId);
    const qa2 = steps[steps.length - 1];
    expect(qa2.agentId).toBe('qa-reviewer');

    // Second failure — still within retry budget.
    out = (await completeRunStep({ runStepId: qa2.id, endStatus: 'failed' }))!;
    expect(out.action).toBe('started_qa_step');
    steps = listRunStepsByRun(runId);
    const qa3 = steps[steps.length - 1];

    // Third failure exhausts the budget → needs_fix.
    out = (await completeRunStep({ runStepId: qa3.id, endStatus: 'failed' }))!;
    expect(out.action).toBe('needs_fix');
    expect(getRun(runId)?.state).toBe('needs_fix');
  });

  it('creates a Handoff row for each completed worker step', async () => {
    const { runId } = buildApprovedRunWithPlan();
    await advanceRun(runId);
    let steps = listRunStepsByRun(runId);
    await completeRunStep({ runStepId: steps[0].id, endStatus: 'completed', handoffSummary: 'FE done' });
    steps = listRunStepsByRun(runId);
    await completeRunStep({ runStepId: steps[1].id, endStatus: 'completed', handoffSummary: 'BE done' });

    const handoffs = listHandoffsByRun(runId);
    // First worker has no predecessor → no handoff. Subsequent steps create
    // one handoff each (BE→QA, QA→Reporter, etc.).
    expect(handoffs.length).toBeGreaterThanOrEqual(1);
    expect(handoffs[0].summary).toMatch(/done|Step/);
  });
});

/* ============================================================================
 * Rate-limit bridge
 * ========================================================================== */

describe('rate-limit ↔ Run bridge', () => {
  it('blocks all running runs when a rate-limit event is recorded', () => {
    const r1 = createRun({ title: 'r1', source: 'user' })!;
    const r2 = createRun({ title: 'r2', source: 'user' })!;
    updateRunState(r1.id, 'planned'); updateRunState(r1.id, 'approved'); updateRunState(r1.id, 'running');
    updateRunState(r2.id, 'planned'); updateRunState(r2.id, 'approved'); updateRunState(r2.id, 'running');

    const out = recordRateLimitEventAndBlockRuns({
      engine: 'claude', source: 'pm_output',
      message: '5h cooldown',
    });
    expect(out.event).toBeTruthy();
    expect(out.blockedRunIds.sort()).toEqual([r1.id, r2.id].sort());
    expect(getRun(r1.id)?.state).toBe('blocked');
    expect(getRun(r1.id)?.blockedReason).toBe('rate_limit:claude');
    expect(getRun(r2.id)?.state).toBe('blocked');

    // Memo should remember each run's pre-block state for resume.
    const memo = _peekMemo(out.event!.id);
    expect(memo?.get(r1.id)).toBe('running');
    expect(memo?.get(r2.id)).toBe('running');
  });

  it('restores prior state when the event resumes', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    updateRunState(r.id, 'planned'); updateRunState(r.id, 'approved'); updateRunState(r.id, 'verifying');

    const out = recordRateLimitEventAndBlockRuns({
      engine: 'codex', source: 'usage_scan',
    });
    expect(getRun(r.id)?.state).toBe('blocked');

    const resume = resumeRateLimitEvent(out.event!.id);
    expect(resume.resumedRunIds).toContain(r.id);
    expect(getRun(r.id)?.state).toBe('verifying');
    // memo is consumed
    expect(_peekMemo(out.event!.id)).toBeUndefined();
  });

  it('fallback: resumes blocked runs by engine when memo is missing', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    updateRunState(r.id, 'planned'); updateRunState(r.id, 'approved'); updateRunState(r.id, 'running');
    updateRunState(r.id, 'blocked', { blockedReason: 'rate_limit:claude' });
    // No memo: simulate an Electron restart by calling resume with a fresh id.
    // The bridge falls back to scanning blocked runs whose blockedReason matches.
    const r2 = createRun({ title: 'r2', source: 'user' })!;
    updateRunState(r2.id, 'planned'); updateRunState(r2.id, 'approved'); updateRunState(r2.id, 'running');
    const out = recordRateLimitEventAndBlockRuns({ engine: 'claude', source: 'manual' });
    // Now manually clobber the memo to test fallback.
    (_peekMemo(out.event!.id) ?? new Map()).clear();

    const resume = resumeRateLimitEvent('does-not-exist', 'claude');
    expect(resume.resumedRunIds.length).toBeGreaterThanOrEqual(1);
    expect(getRun(r.id)?.state).toBe('running');
  });
});
