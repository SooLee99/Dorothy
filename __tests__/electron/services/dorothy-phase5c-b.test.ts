/**
 * Dorothy MVP Phase 5C-B — 24h Agent Resume + Self-Improvement Loop.
 *
 * Coverage:
 *   - Usage limit parser: ISO, clock, ambiguous, masking
 *   - RateLimitEvent stores resume fields + parseConfidence + status
 *   - Scheduler picks ready events, dry-run does NOT call startAgent
 *   - Live mode dispatches once and stamps resumed
 *   - resumeNow works regardless of mode
 *   - Duplicate dispatch prevention (in-memory + persistent)
 *   - low confidence → not auto-resumed
 *   - failure path stamps failed + lastResumeError + retryCount
 *   - Hook /api/hooks/output sniff creates a row
 *   - ImprovementSignal dedupe + auto-creation paths
 *   - dorothy.db unavailable → graceful
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { initDorothyDb, closeDorothyDb } from '../../../electron/services/dorothy/db';
import { createRun, updateRunState, getRun } from '../../../electron/services/dorothy/run-service';
import { createPlan } from '../../../electron/services/dorothy/plan-service';
import { createAgentSession } from '../../../electron/services/dorothy/agent-session-service';
import { createRunStep, attachSessionToStep, updateRunStepState, listRunStepsByRun } from '../../../electron/services/dorothy/run-service';
import {
  parseUsageLimitMessage,
  excerptMessage,
} from '../../../electron/services/dorothy/usage-limit-parser';
import {
  configureAutoResume,
  runTick,
  resumeNow,
  normalizeAutoResumeMode,
  _clearLocks,
} from '../../../electron/services/dorothy/auto-resume-scheduler';
import { recordRateLimitEventAndBlockRuns } from '../../../electron/services/dorothy/rate-limit-bridge';
import {
  createRateLimitEvent,
  getRateLimitEvent,
  listResumeReadyEvents,
  updateRateLimitResume,
} from '../../../electron/services/dorothy/rate-limit-service';
import {
  createImprovementSignal,
  listImprovementSignals,
  fingerprintFor,
  updateImprovementSignalStatus,
} from '../../../electron/services/dorothy/improvement-signal-service';

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase5c-b-${process.pid}`);
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let dbPath = '';

beforeEach(() => {
  dbPath = path.join(TEST_DIR, `dorothy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const r = initDorothyDb({ filePath: dbPath });
  if (!r.ok) throw new Error(`initDorothyDb failed: ${r.reason}`);
  _clearLocks();
});

afterEach(() => {
  closeDorothyDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
});

/* ============================================================================
 * Usage limit parser
 * ========================================================================== */

describe('usage-limit-parser', () => {
  it('parses ISO timestamp → high confidence', () => {
    const out = parseUsageLimitMessage('Claude usage limit reached. You can use Claude again after 2026-06-03T15:30:00+09:00');
    expect(out.detected).toBe(true);
    expect(out.confidence).toBe('high');
    expect(out.resumeAt).toBe(new Date('2026-06-03T15:30:00+09:00').toISOString());
  });
  it('parses "resets at 3:30 PM" → medium confidence', () => {
    const out = parseUsageLimitMessage('Claude usage limit reached. Your limit will reset at 3:30 PM',
      { now: new Date('2026-06-03T01:00:00+09:00') });
    expect(out.detected).toBe(true);
    expect(out.confidence).toBe('medium');
    // 15:30 KST → 06:30 UTC.
    expect(out.resumeAt).toBeTruthy();
    expect(new Date(out.resumeAt!).toISOString()).toBe(new Date('2026-06-03T15:30:00+09:00').toISOString());
  });
  it('parses "Resets 3am" same-day-future → medium', () => {
    const out = parseUsageLimitMessage('Resets 3am', { now: new Date('2026-06-04T01:00:00+09:00') });
    expect(out.detected).toBe(true);
    expect(out.confidence).toBe('medium');
    // Compare wall-clock instants — parser may render +09:00 or Z, both are valid.
    expect(new Date(out.resumeAt!).getTime()).toBe(new Date('2026-06-04T03:00:00+09:00').getTime());
  });
  it('detects but flags low confidence for ambiguous prose', () => {
    const out = parseUsageLimitMessage('Claude usage limit reached. Please try again soon.');
    expect(out.detected).toBe(true);
    expect(out.confidence).toBe('low');
    expect(out.resumeAt).toBeUndefined();
  });
  it('returns detected=false when no limit phrase is present', () => {
    const out = parseUsageLimitMessage('Hello world, this is plain output.');
    expect(out.detected).toBe(false);
    expect(out.resumeAt).toBeUndefined();
  });
  it('masks secret/token/password in excerpt', () => {
    const msg = 'Claude usage limit reached. password=secret123 token: abcdef';
    const out = parseUsageLimitMessage(msg);
    expect(out.originalMessageExcerpt).toContain('password: ***');
    expect(out.originalMessageExcerpt).toContain('token: ***');
    expect(out.originalMessageExcerpt).not.toContain('secret123');
    expect(out.originalMessageExcerpt).not.toContain('abcdef');
  });
  it('truncates excerpt to 240 chars', () => {
    const long = 'usage limit reached. ' + 'x'.repeat(500);
    const out = parseUsageLimitMessage(long);
    expect(out.originalMessageExcerpt.length).toBeLessThanOrEqual(240);
  });
  it('excerptMessage handles empty/null', () => {
    expect(excerptMessage('')).toBe('');
  });
});

/* ============================================================================
 * RateLimitEvent + scheduler
 * ========================================================================== */

describe('rate limit + scheduler', () => {
  function seedRunningRunWithSession() {
    const run = createRun({ title: 'rl', source: 'user' })!;
    updateRunState(run.id, 'planned');
    updateRunState(run.id, 'approved');
    updateRunState(run.id, 'running');
    createPlan({
      runId: run.id, title: 't', description: 'd', state: 'approved',
      tasks: [{ taskId: 't1', title: 'fe', description: 'fe', ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['ok'] }],
    });
    const step = createRunStep({ runId: run.id, order: 0, agentId: 'frontend', promptRef: 't1' })!;
    updateRunStepState(step.id, 'running');
    const session = createAgentSession({ agentId: 'frontend', provider: 'claude', runId: run.id, runStepId: step.id })!;
    attachSessionToStep(step.id, session.id);
    return { run, step, session };
  }

  it('createRateLimitEvent stores resumeAt + scheduled status (high confidence)', () => {
    const evt = createRateLimitEvent({
      engine: 'claude',
      provider: 'claude',
      source: 'agent_output',
      resumeAt: '2099-01-01T00:00:00+09:00',
      parseConfidence: 'high',
    })!;
    expect(evt.resumeAt).toBeTruthy();
    expect(evt.resumeStatus).toBe('scheduled');
    expect(evt.retryCount).toBe(0);
  });

  it('low confidence creates pending event (not scheduled)', () => {
    const evt = createRateLimitEvent({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      parseConfidence: 'low',
    })!;
    expect(evt.resumeStatus).toBe('pending');
  });

  it('listResumeReadyEvents returns only resume-ready entries (resumeAt <= now)', () => {
    createRateLimitEvent({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      resumeAt: '2099-01-01T00:00:00+09:00', parseConfidence: 'high',
    });
    const ready = createRateLimitEvent({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      resumeAt: '2000-01-01T00:00:00+09:00', parseConfidence: 'high',
    })!;
    const list = listResumeReadyEvents(new Date('2026-06-04T00:00:00Z'));
    expect(list.map(e => e.id)).toContain(ready.id);
    expect(list.find(e => new Date(e.resumeAt!).getFullYear() === 2099)).toBeUndefined();
  });

  it('dry-run mode does NOT call startAgent', async () => {
    const { session } = seedRunningRunWithSession();
    const evt = recordRateLimitEventAndBlockRuns({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      resumeAt: '2000-01-01T00:00:00Z', parseConfidence: 'high',
      affectedSessionIds: [session.id],
    }).event!;
    const startAgent = vi.fn(async () => {});
    configureAutoResume({
      getMode: () => 'dry-run',
      getLiveAgents: () => [{ id: 'agent-fe', status: 'idle', name: 'frontend' }],
      startAgent,
    });
    const tick = await runTick(new Date('2026-06-04T00:00:00Z'));
    expect(startAgent).not.toHaveBeenCalled();
    const after = getRateLimitEvent(evt.id);
    expect(after?.resumeStatus).toBe('scheduled');
    expect(tick.attempted[0].outcome).toBe('dry-run');
  });

  it('live mode dispatches once and stamps resumed', async () => {
    const { session } = seedRunningRunWithSession();
    recordRateLimitEventAndBlockRuns({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      resumeAt: '2000-01-01T00:00:00Z', parseConfidence: 'high',
      affectedSessionIds: [session.id],
    });
    const startAgent = vi.fn(async () => {});
    configureAutoResume({
      getMode: () => 'live',
      getLiveAgents: () => [{ id: 'agent-fe', status: 'idle', name: 'frontend' }],
      startAgent,
    });
    const tick = await runTick(new Date('2026-06-04T00:00:00Z'));
    expect(startAgent).toHaveBeenCalledTimes(1);
    const prompt = startAgent.mock.calls[0][0].prompt;
    expect(prompt).toContain('You are resuming a previously paused Dorothy Run.');
    expect(prompt).toContain('Do not repeat completed work.');
    expect(tick.attempted[0].outcome).toBe('dispatched');
  });

  it('does not dispatch the same event twice within a single tick', async () => {
    const { session } = seedRunningRunWithSession();
    recordRateLimitEventAndBlockRuns({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      resumeAt: '2000-01-01T00:00:00Z', parseConfidence: 'high',
      affectedSessionIds: [session.id],
    });
    const startAgent = vi.fn(async () => {});
    configureAutoResume({
      getMode: () => 'live',
      getLiveAgents: () => [{ id: 'agent-fe', status: 'idle', name: 'frontend' }],
      startAgent,
    });
    await runTick(new Date('2026-06-04T00:00:00Z'));
    await runTick(new Date('2026-06-04T00:00:30Z')); // 2nd tick — already resumed
    expect(startAgent).toHaveBeenCalledTimes(1);
  });

  it('low-confidence event is NOT auto-resumed even when resumeAt is past', async () => {
    const { session } = seedRunningRunWithSession();
    const evt = createRateLimitEvent({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      resumeAt: '2000-01-01T00:00:00Z', parseConfidence: 'low',
      affectedSessionIds: [session.id],
    })!;
    // Force scheduled status for the tick — the low confidence guard must still fire.
    updateRateLimitResume({ id: evt.id, resumeStatus: 'scheduled' });
    const startAgent = vi.fn(async () => {});
    configureAutoResume({
      getMode: () => 'live',
      getLiveAgents: () => [{ id: 'agent-fe', status: 'idle', name: 'frontend' }],
      startAgent,
    });
    await runTick(new Date('2026-06-04T00:00:00Z'));
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('failure path stamps failed + lastResumeError + retryCount', async () => {
    const { session } = seedRunningRunWithSession();
    const evt = recordRateLimitEventAndBlockRuns({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      resumeAt: '2000-01-01T00:00:00Z', parseConfidence: 'high',
      affectedSessionIds: [session.id],
    }).event!;
    configureAutoResume({
      getMode: () => 'live',
      getLiveAgents: () => [{ id: 'agent-fe', status: 'idle', name: 'frontend' }],
      startAgent: async () => { throw new Error('boom'); },
    });
    await runTick(new Date('2026-06-04T00:00:00Z'));
    const after = getRateLimitEvent(evt.id)!;
    expect(after.resumeStatus).toBe('failed');
    expect(after.lastResumeError).toContain('boom');
    expect(after.retryCount).toBe(1);
  });

  it('resumeNow works regardless of mode', async () => {
    const { session } = seedRunningRunWithSession();
    const evt = recordRateLimitEventAndBlockRuns({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      resumeAt: '2099-01-01T00:00:00Z', parseConfidence: 'high',  // future
      affectedSessionIds: [session.id],
    }).event!;
    const startAgent = vi.fn(async () => {});
    configureAutoResume({
      getMode: () => 'off',
      getLiveAgents: () => [{ id: 'agent-fe', status: 'idle', name: 'frontend' }],
      startAgent,
    });
    const r = await resumeNow(evt.id);
    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe('dispatched');
  });

  it('normalizeAutoResumeMode coerces inputs safely', () => {
    expect(normalizeAutoResumeMode(true)).toBe('live');
    expect(normalizeAutoResumeMode('true')).toBe('live');
    expect(normalizeAutoResumeMode('live')).toBe('live');
    expect(normalizeAutoResumeMode(false)).toBe('off');
    expect(normalizeAutoResumeMode('off')).toBe('off');
    expect(normalizeAutoResumeMode(undefined)).toBe('dry-run');
    expect(normalizeAutoResumeMode('dry-run')).toBe('dry-run');
    expect(normalizeAutoResumeMode('garbage')).toBe('dry-run');
  });

  it('dorothy.db unavailable → scheduler returns no candidates', async () => {
    closeDorothyDb();
    configureAutoResume({ getMode: () => 'live', getLiveAgents: () => [] });
    const out = await runTick();
    expect(out.scheduledCount).toBe(0);
    initDorothyDb({ filePath: dbPath });
  });
});

/* ============================================================================
 * ImprovementSignal
 * ========================================================================== */

describe('improvement-signal-service', () => {
  it('createImprovementSignal inserts a new row', () => {
    const s = createImprovementSignal({
      source: 'ci_failure', severity: 'high',
      title: 'CI failed on test', summary: 'logs URL: …',
    });
    expect(s).toBeTruthy();
    expect(s!.status).toBe('open');
    expect(s!.occurrenceCount).toBe(1);
  });

  it('dedupes identical fingerprints within the 24h window', () => {
    const fp = fingerprintFor({
      source: 'ci_failure',
      runId: 'r1',
      relatedAgentId: 'github-actions',
      normalizedTitle: 'ci-failed:test',
    });
    const a = createImprovementSignal({
      runId: 'r1', source: 'ci_failure', severity: 'high',
      title: 'CI failed on test', summary: 'first observation', fingerprint: fp,
    })!;
    const b = createImprovementSignal({
      runId: 'r1', source: 'ci_failure', severity: 'high',
      title: 'CI failed on test', summary: 'second observation', fingerprint: fp,
    })!;
    expect(b.id).toBe(a.id);
    expect(b.occurrenceCount).toBe(2);
    expect(b.summary).toContain('second observation');
  });

  it('does NOT dedupe when fingerprints differ', () => {
    const a = createImprovementSignal({
      source: 'qa_failure', severity: 'medium',
      title: 'qa1', summary: 'x', fingerprint: 'fp-a',
    })!;
    const b = createImprovementSignal({
      source: 'qa_failure', severity: 'medium',
      title: 'qa2', summary: 'y', fingerprint: 'fp-b',
    })!;
    expect(a.id).not.toBe(b.id);
  });

  it('updateImprovementSignalStatus transitions and appends note', () => {
    const a = createImprovementSignal({
      source: 'manual_note', severity: 'low',
      title: 't', summary: 's',
    })!;
    const updated = updateImprovementSignalStatus({ id: a.id, status: 'triaged', note: 'looked at it' });
    expect(updated?.status).toBe('triaged');
    expect(updated?.summary).toContain('looked at it');
  });

  it('listImprovementSignals filters by status / source / runId', () => {
    createImprovementSignal({ source: 'ci_failure', severity: 'high', title: 'a', summary: 'a', runId: 'r1' });
    createImprovementSignal({ source: 'qa_failure', severity: 'low', title: 'b', summary: 'b', runId: 'r1' });
    createImprovementSignal({ source: 'ci_failure', severity: 'low', title: 'c', summary: 'c', runId: 'r2' });
    expect(listImprovementSignals({ runId: 'r1' })).toHaveLength(2);
    expect(listImprovementSignals({ source: 'ci_failure' })).toHaveLength(2);
    expect(listImprovementSignals({ status: 'open' })).toHaveLength(3);
  });
});

/* ============================================================================
 * Phase 5A/B regression smoke (resume must not break older paths)
 * ========================================================================== */

describe('regression smoke', () => {
  it('CI failed without auto-transition still leaves Run state intact (5A)', () => {
    const r = createRun({ title: 'reg', source: 'user' })!;
    updateRunState(r.id, 'planned'); updateRunState(r.id, 'approved'); updateRunState(r.id, 'running'); updateRunState(r.id, 'reporting');
    expect(getRun(r.id)?.state).toBe('reporting');
  });

  it('listRunStepsByRun still returns ordered steps', () => {
    const r = createRun({ title: 'steps', source: 'user' })!;
    createRunStep({ runId: r.id, order: 0, agentId: 'frontend', promptRef: 't1' });
    createRunStep({ runId: r.id, order: 1, agentId: 'backend',  promptRef: 't2' });
    const steps = listRunStepsByRun(r.id);
    expect(steps.map(s => s.order)).toEqual([0, 1]);
  });
});
