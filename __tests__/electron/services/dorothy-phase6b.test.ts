/**
 * Dorothy MVP Phase 6-B — AgentWorkflowProgress.
 *
 * Coverage:
 *   - Template registry — all canonical agents resolve, unknown → generic
 *   - service.createOrGetWorkflowProgress dedupe by quartet
 *   - updateWorkflowProgressStep: progress%, status, completed/failed/skip-fill
 *   - listByRun / listBySession filters
 *   - recomputeWorkflowProgressForRun replays HookEvents deterministically
 *   - safeUpdateWorkflowProgressFromHookEvent does not throw on malformed
 *   - HookEvent integration: agent_session_started / handoff_created /
 *     artifact_created / run_step_failed / rate_limit_detected blocks /
 *     resume_completed unblocks / ci_failed / ci_passed / qa_passed /
 *     approval_required / approval_resolved
 *   - DB unavailable graceful
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
  createRunStep,
  updateRunStepState,
} from '../../../electron/services/dorothy/run-service';
import {
  createAgentSession,
  endAgentSession,
} from '../../../electron/services/dorothy/agent-session-service';
import {
  createArtifact,
  createHandoff,
} from '../../../electron/services/dorothy/artifact-service';
import {
  createRateLimitEvent,
  updateRateLimitResume,
} from '../../../electron/services/dorothy/rate-limit-service';
import {
  createApprovalRequest,
  decideApprovalRequest,
} from '../../../electron/services/dorothy/approval-request-service';
import { createHookEvent } from '../../../electron/services/dorothy/hook-event-service';
import {
  createOrGetWorkflowProgress,
  safeCreateOrGetWorkflowProgress,
  updateWorkflowProgressStep,
  listWorkflowProgress,
  listWorkflowProgressByRun,
  listWorkflowProgressBySession,
  getWorkflowProgress,
  recomputeWorkflowProgressForRun,
  safeUpdateWorkflowProgressFromHookEvent,
  setWorkflowProgressBlocked,
  setWorkflowProgressFailed,
  countWorkflowProgress,
} from '../../../electron/services/dorothy/agent-workflow-progress-service';
import {
  getWorkflowTemplate,
  listWorkflowTemplates,
  resolveWorkflowKindForAgent,
  materializeSteps,
} from '../../../electron/services/dorothy/agent-workflow-templates';
import type { HookEvent } from '../../../electron/types/dorothy';

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase6b-${process.pid}`);
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

function makeHookEvent(partial: Partial<HookEvent> & { type: HookEvent['type'] }): HookEvent {
  return {
    id: partial.id ?? `evt-${Math.random().toString(36).slice(2)}`,
    type: partial.type,
    severity: partial.severity ?? 'info',
    runId: partial.runId ?? null,
    runStepId: partial.runStepId ?? null,
    agentSessionId: partial.agentSessionId ?? null,
    agentId: partial.agentId ?? null,
    artifactId: partial.artifactId ?? null,
    handoffId: partial.handoffId ?? null,
    approvalRequestId: partial.approvalRequestId ?? null,
    rateLimitEventId: partial.rateLimitEventId ?? null,
    pullRequestId: partial.pullRequestId ?? null,
    ciRunId: partial.ciRunId ?? null,
    improvementSignalId: partial.improvementSignalId ?? null,
    kanbanTaskId: partial.kanbanTaskId ?? null,
    source: partial.source ?? 'system',
    title: partial.title ?? 'evt',
    summary: partial.summary ?? null,
    metadata: partial.metadata ?? null,
    createdAt: partial.createdAt ?? new Date().toISOString(),
  };
}

/* ============================================================================
 * 1. Template registry
 * ========================================================================== */

describe('Workflow templates', () => {
  it('lists at least the canonical 9 templates + generic fallback', () => {
    const all = listWorkflowTemplates();
    const kinds = new Set(all.map(t => t.kind));
    // Canonical roles documented in Phase 6-B. Phase 6-C+ may add more
    // (contract, database, …) — the contract is "all of these must be
    // registered", not "this is the entire list".
    const required = [
      'approval_validator',
      'architect_plan',
      'backend',
      'devops_reporter',
      'frontend',
      'generic',
      'intake_planner',
      'orchestrator',
      'qa_reviewer',
    ];
    for (const k of required) {
      expect(kinds.has(k as never)).toBe(true);
    }
  });

  it('frontend template includes the documented steps', () => {
    const t = getWorkflowTemplate('frontend');
    expect(t.steps.map(s => s.stepId)).toEqual([
      'spec_read',
      'ui_flow_check',
      'api_contract_check',
      'implementation',
      'frontend_validation',
      'handoff',
    ]);
  });

  it('backend template includes the documented steps', () => {
    const t = getWorkflowTemplate('backend');
    expect(t.steps.map(s => s.stepId)).toEqual([
      'spec_read',
      'api_design_check',
      'db_impact_check',
      'implementation',
      'backend_validation',
      'handoff',
    ]);
  });

  it('qa_reviewer template includes the documented steps', () => {
    const t = getWorkflowTemplate('qa_reviewer');
    expect(t.steps.map(s => s.stepId)).toEqual([
      'handoff_read',
      'acceptance_criteria_check',
      'test_execution',
      'review',
      'qa_report',
    ]);
  });

  it('resolveWorkflowKindForAgent handles aliases', () => {
    expect(resolveWorkflowKindForAgent('frontend')).toBe('frontend');
    expect(resolveWorkflowKindForAgent('qa-reviewer')).toBe('qa_reviewer');
    expect(resolveWorkflowKindForAgent('reviewer')).toBe('qa_reviewer');
    expect(resolveWorkflowKindForAgent('devops-reporter')).toBe('devops_reporter');
    expect(resolveWorkflowKindForAgent('reporter')).toBe('devops_reporter');
    expect(resolveWorkflowKindForAgent('plan-validator')).toBe('approval_validator');
    expect(resolveWorkflowKindForAgent('mystery-bot')).toBe('generic');
    expect(resolveWorkflowKindForAgent(null)).toBe('generic');
  });

  it('materializeSteps yields all pending with empty evidence', () => {
    const steps = materializeSteps('frontend');
    expect(steps.every(s => s.status === 'pending')).toBe(true);
    expect(steps[0].evidenceHookEventIds).toEqual([]);
  });
});

/* ============================================================================
 * 2. Service basics
 * ========================================================================== */

describe('WorkflowProgress service basics', () => {
  it('createOrGetWorkflowProgress dedupes on the (run,step,session,agent) quartet', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const a = createOrGetWorkflowProgress({
      runId: run.id, agentId: 'frontend',
    })!;
    const b = createOrGetWorkflowProgress({
      runId: run.id, agentId: 'frontend',
    })!;
    expect(b.id).toBe(a.id);
    // Different agent → distinct row.
    const c = createOrGetWorkflowProgress({
      runId: run.id, agentId: 'backend',
    })!;
    expect(c.id).not.toBe(a.id);
  });

  it('updateWorkflowProgressStep advances and recomputes progressPercent', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const p = createOrGetWorkflowProgress({ runId: run.id, agentId: 'frontend' })!;
    const t = getWorkflowTemplate('frontend');
    const firstId = t.steps[0].stepId;
    const updated = updateWorkflowProgressStep({
      progressId: p.id, stepId: firstId, status: 'in_progress',
    })!;
    expect(updated.progressPercent).toBe(0);
    expect(updated.status).toBe('in_progress');
    expect(updated.currentStepLabel).toBe(t.steps[0].label);
    // Complete the first step.
    const after = updateWorkflowProgressStep({
      progressId: p.id, stepId: firstId, status: 'completed',
    })!;
    expect(after.progressPercent).toBe(Math.round((1 / t.steps.length) * 100));
  });

  it('completing the last step flips the workflow status to completed', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const p = createOrGetWorkflowProgress({ runId: run.id, agentId: 'frontend' })!;
    const t = getWorkflowTemplate('frontend');
    // Walk the entire template.
    for (const s of t.steps) {
      updateWorkflowProgressStep({ progressId: p.id, stepId: s.stepId, status: 'completed' });
    }
    const after = getWorkflowProgress(p.id)!;
    expect(after.status).toBe('completed');
    expect(after.progressPercent).toBe(100);
  });

  it('failed step flips the workflow status to failed', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const p = createOrGetWorkflowProgress({ runId: run.id, agentId: 'backend' })!;
    const t = getWorkflowTemplate('backend');
    updateWorkflowProgressStep({ progressId: p.id, stepId: t.steps[2].stepId, status: 'failed', note: 'migration broke' });
    setWorkflowProgressFailed(p.id, 'migration broke');
    const after = getWorkflowProgress(p.id)!;
    expect(after.status).toBe('failed');
    expect(after.failedReason).toBe('migration broke');
  });

  it('setWorkflowProgressBlocked moves status to blocked and back to in_progress when cleared', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const p = createOrGetWorkflowProgress({ runId: run.id, agentId: 'frontend' })!;
    updateWorkflowProgressStep({ progressId: p.id, stepId: 'spec_read', status: 'in_progress' });
    setWorkflowProgressBlocked(p.id, 'awaiting design review');
    expect(getWorkflowProgress(p.id)?.status).toBe('blocked');
    setWorkflowProgressBlocked(p.id, null);
    expect(getWorkflowProgress(p.id)?.status).toBe('in_progress');
  });

  it('advancing past pending steps marks them skipped (not pending)', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const p = createOrGetWorkflowProgress({ runId: run.id, agentId: 'frontend' })!;
    // Jump directly to `implementation` without touching the earlier steps.
    updateWorkflowProgressStep({ progressId: p.id, stepId: 'implementation', status: 'in_progress' });
    const after = getWorkflowProgress(p.id)!;
    const skipped = after.steps.filter(s => s.status === 'skipped').map(s => s.stepId);
    expect(skipped).toEqual(['spec_read', 'ui_flow_check', 'api_contract_check']);
  });

  it('listByRun / listBySession filter correctly', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    createOrGetWorkflowProgress({ runId: run.id, agentId: 'frontend', agentSessionId: 'sess-1' });
    createOrGetWorkflowProgress({ runId: run.id, agentId: 'backend',  agentSessionId: 'sess-2' });
    expect(listWorkflowProgressByRun(run.id).length).toBe(2);
    expect(listWorkflowProgressBySession('sess-1').length).toBe(1);
    expect(listWorkflowProgressBySession('sess-1')[0].agentId).toBe('frontend');
  });

  it('countWorkflowProgress rolls up by status', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const p1 = createOrGetWorkflowProgress({ runId: run.id, agentId: 'frontend' })!;
    const p2 = createOrGetWorkflowProgress({ runId: run.id, agentId: 'backend' })!;
    updateWorkflowProgressStep({ progressId: p1.id, stepId: 'spec_read', status: 'in_progress' });
    setWorkflowProgressBlocked(p2.id, 'rate limited');
    const c = countWorkflowProgress();
    expect(c.in_progress).toBe(1);
    expect(c.blocked).toBe(1);
    expect(c.total).toBe(2);
  });

  it('safe wrappers do not throw when DB is unavailable', () => {
    closeDorothyDb();
    expect(() => safeCreateOrGetWorkflowProgress({ runId: 'r', agentId: 'frontend' })).not.toThrow();
    expect(safeCreateOrGetWorkflowProgress({ runId: 'r', agentId: 'frontend' })).toBeNull();
    expect(() => safeUpdateWorkflowProgressFromHookEvent(null)).not.toThrow();
    initDorothyDb({ filePath: dbPath });
  });

  it('listWorkflowProgress returns [] when DB unavailable', () => {
    closeDorothyDb();
    expect(listWorkflowProgress()).toEqual([]);
    initDorothyDb({ filePath: dbPath });
  });
});

/* ============================================================================
 * 3. HookEvent integration through full service paths
 *
 * Each test asserts that the wired service emits + advances the workflow row.
 * ========================================================================== */

describe('HookEvent integration via service paths', () => {
  it('createAgentSession initialises the workflow row and flips first step to in_progress', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const sess = createAgentSession({
      runId: run.id, agentId: 'frontend', provider: 'claude',
    })!;
    const rows = listWorkflowProgressByRun(run.id, { workflowKind: 'frontend' });
    expect(rows.length).toBe(1);
    expect(rows[0].agentSessionId).toBe(sess.id);
    expect(rows[0].status).toBe('in_progress');
    expect(rows[0].steps[0].status).toBe('in_progress');
  });

  it('endAgentSession(completed) advances workflow handoff step', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const sess = createAgentSession({ runId: run.id, agentId: 'frontend', provider: 'claude' })!;
    endAgentSession({ id: sess.id, endStatus: 'completed' });
    const rows = listWorkflowProgressByRun(run.id, { workflowKind: 'frontend' });
    const after = rows[0];
    const handoff = after.steps.find(s => s.stepId === 'handoff');
    expect(handoff?.status).toBe('completed');
  });

  it('endAgentSession(failed) flips workflow status to failed', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const sess = createAgentSession({ runId: run.id, agentId: 'frontend', provider: 'claude' })!;
    endAgentSession({ id: sess.id, endStatus: 'failed' });
    const rows = listWorkflowProgressByRun(run.id);
    expect(rows[0].status).toBe('failed');
  });

  it('createArtifact attaches evidence to the validation step', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const step = createRunStep({ runId: run.id, order: 0, agentId: 'frontend' })!;
    updateRunStepState(step.id, 'running');
    const art = createArtifact({
      runId: run.id, runStepId: step.id, type: 'patch', producedByAgentId: 'frontend',
    })!;
    expect(art).not.toBeNull();
    const rows = listWorkflowProgressByRun(run.id, { workflowKind: 'frontend' });
    const after = rows[0];
    // The detector picks the first step whose id contains `validation`,
    // which is `frontend_validation` for the frontend template.
    const valStep = after.steps.find(s => s.stepId === 'frontend_validation');
    expect(valStep).toBeTruthy();
    expect((valStep?.evidenceArtifactIds ?? []).length).toBeGreaterThan(0);
  });

  it('createHandoff completes the handoff step', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const s1 = createRunStep({ runId: run.id, order: 0, agentId: 'frontend' })!;
    const s2 = createRunStep({ runId: run.id, order: 1, agentId: 'qa-reviewer' })!;
    createHandoff({ runId: run.id, fromRunStepId: s1.id, toRunStepId: s2.id, summary: 'done' });
    // The handoff event is associated with the qa-reviewer row (toRunStepId).
    const qaRow = listWorkflowProgressByRun(run.id, { workflowKind: 'qa_reviewer' })[0];
    expect(qaRow).toBeTruthy();
    const handoff = qaRow.steps.find(s => s.stepId === 'qa_report');
    expect(handoff?.status).toBe('completed');
  });

  it('updateRunStepState(failed) flips workflow to failed', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const step = createRunStep({ runId: run.id, order: 0, agentId: 'backend' })!;
    updateRunStepState(step.id, 'running');
    updateRunStepState(step.id, 'failed', { errorReason: 'compile error' });
    const rows = listWorkflowProgressByRun(run.id, { workflowKind: 'backend' });
    expect(rows[0].status).toBe('failed');
    expect(rows[0].failedReason).toMatch(/compile error|failed/);
  });

  it('rate_limit_detected blocks active workflows, resume_completed clears them', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    // Seed an active workflow row.
    createAgentSession({ runId: run.id, agentId: 'frontend', provider: 'claude' });
    const evt = createRateLimitEvent({
      engine: 'claude', source: 'hook', provider: 'claude',
      resumeAt: new Date(Date.now() + 60_000).toISOString(),
      parseConfidence: 'high',
      affectedRunIds: [run.id],
    })!;
    const blocked = listWorkflowProgressByRun(run.id)[0];
    expect(blocked.status).toBe('blocked');
    updateRateLimitResume({ id: evt.id, resumeStatus: 'resumed' });
    const unblocked = listWorkflowProgressByRun(run.id)[0];
    // After unblock the previously-blocked row falls back to in_progress (not_started would mean fresh).
    expect(['in_progress', 'not_started']).toContain(unblocked.status);
    expect(unblocked.blockedReason).toBeNull();
  });

  it('ci_failed flips DevOps / Reporter workflow to failed', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    // Simulate a ci_failed HookEvent (without invoking the full HTTP layer).
    const ev = createHookEvent({
      type: 'ci_failed',
      severity: 'error',
      source: 'github_webhook',
      runId: run.id,
      title: 'CI failed: lint',
      metadata: { workflow: 'lint', conclusion: 'failure' },
    });
    safeUpdateWorkflowProgressFromHookEvent(ev);
    const rows = listWorkflowProgressByRun(run.id, { workflowKind: 'devops_reporter' });
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('failed');
  });

  it('ci_passed flips DevOps / Reporter ci_summary_check to completed', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const ev = createHookEvent({
      type: 'ci_passed',
      severity: 'info',
      source: 'github_webhook',
      runId: run.id,
      title: 'CI passed: lint',
      metadata: { workflow: 'lint' },
    });
    safeUpdateWorkflowProgressFromHookEvent(ev);
    const rows = listWorkflowProgressByRun(run.id, { workflowKind: 'devops_reporter' });
    const ciStep = rows[0].steps.find(s => s.stepId === 'ci_summary_check');
    expect(ciStep?.status).toBe('completed');
  });

  it('qa_passed completes the QA workflow step', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const ev = createHookEvent({
      type: 'qa_passed',
      severity: 'info',
      source: 'qa_reviewer',
      runId: run.id,
      agentId: 'qa-reviewer',
      title: 'QA passed',
    });
    safeUpdateWorkflowProgressFromHookEvent(ev);
    const rows = listWorkflowProgressByRun(run.id, { workflowKind: 'qa_reviewer' });
    expect(rows.length).toBe(1);
    const qaStep = rows[0].steps.find(s => ['test_execution', 'review', 'qa_report'].includes(s.stepId));
    expect(qaStep?.status).toBe('completed');
  });

  it('approval_required blocks the Approval Validator workflow', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    createApprovalRequest({ runId: run.id, riskLevel: 'high', topic: 'production', state: 'pending' });
    const rows = listWorkflowProgressByRun(run.id, { workflowKind: 'approval_validator' });
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('blocked');
  });

  it('approval_resolved unblocks the Approval Validator workflow', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const req = createApprovalRequest({ runId: run.id, riskLevel: 'high', topic: 'production', state: 'pending' })!;
    decideApprovalRequest({ id: req.id, state: 'user_approved', decidedBy: 'user' });
    const rows = listWorkflowProgressByRun(run.id, { workflowKind: 'approval_validator' });
    expect(['in_progress', 'completed']).toContain(rows[0].status);
    expect(rows[0].blockedReason).toBeNull();
  });
});

/* ============================================================================
 * 4. Recompute
 * ========================================================================== */

describe('recomputeWorkflowProgressForRun', () => {
  it('replays HookEvents chronologically and is idempotent', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const step = createRunStep({ runId: run.id, order: 0, agentId: 'frontend' })!;
    updateRunStepState(step.id, 'running');
    const sess = createAgentSession({ runId: run.id, runStepId: step.id, agentId: 'frontend', provider: 'claude' })!;
    createArtifact({ runId: run.id, runStepId: step.id, type: 'patch', producedByAgentId: 'frontend' });
    endAgentSession({ id: sess.id, endStatus: 'completed' });
    updateRunStepState(step.id, 'completed');

    const beforeRows = listWorkflowProgressByRun(run.id);
    const beforeIds = new Set(beforeRows.map(r => r.id));

    // First recompute — new ids, same final state.
    const recomputed = recomputeWorkflowProgressForRun(run.id);
    expect(recomputed.length).toBeGreaterThan(0);
    const newRow = recomputed.find(r => r.agentId === 'frontend');
    expect(newRow?.status).toBe('completed');
    expect(newRow?.progressPercent).toBeGreaterThanOrEqual(50);
    // Ids changed (we wipe + reinsert), but the count + final state are stable.
    const newIds = new Set(recomputed.map(r => r.id));
    expect(newIds.size).toBe(recomputed.length);
    expect([...newIds].some(id => beforeIds.has(id))).toBe(false);

    // Second recompute — same shape (idempotent).
    const second = recomputeWorkflowProgressForRun(run.id);
    const secondFrontend = second.find(r => r.agentId === 'frontend');
    expect(secondFrontend?.status).toBe('completed');
  });
});
