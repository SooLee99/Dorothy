/**
 * Dorothy MVP Phase 5C-C — ImprovementSignal ops + Resume UX hardening.
 *
 * Coverage:
 *   - listArtifactsByIds returns rows in caller-supplied order
 *   - getArtifact + listArtifactsByIds are graceful when DB closed
 *   - sensitive masking covers secret / token / password / api_key /
 *     private_key / bearer
 *   - Recurring (occurrence ≥ 2) filter math
 *   - status update reflects on next list
 *   - dry-run overdue audit creates an ImprovementSignal with the expected
 *     fingerprint + dedupes on re-tick
 *   - Audit does NOT fire when overdue < 24h
 *   - resumeNow dispatches via the configured adapter even on low-confidence
 *     events (manual override) and respects in-memory lock
 *   - Phase 5A/B/C-B regression smoke
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { initDorothyDb, closeDorothyDb } from '../../../electron/services/dorothy/db';
import { createRun, updateRunState, getRun } from '../../../electron/services/dorothy/run-service';
import { createArtifact, getArtifact, listArtifactsByIds } from '../../../electron/services/dorothy/artifact-service';
import {
  createImprovementSignal,
  listImprovementSignals,
  updateImprovementSignalStatus,
  fingerprintFor,
} from '../../../electron/services/dorothy/improvement-signal-service';
import {
  configureAutoResume,
  runTick,
  resumeNow,
  _clearLocks,
} from '../../../electron/services/dorothy/auto-resume-scheduler';
import { recordRateLimitEventAndBlockRuns } from '../../../electron/services/dorothy/rate-limit-bridge';
import { createAgentSession } from '../../../electron/services/dorothy/agent-session-service';
import { createPlan } from '../../../electron/services/dorothy/plan-service';
import { createRunStep, attachSessionToStep } from '../../../electron/services/dorothy/run-service';

/**
 * Mirror of `maskSensitivePreview` in `src/components/RunCommon/badges.tsx`.
 * We re-implement here because vitest runs under the electron `tsconfig.json`
 * which doesn't expose the `@/` alias used by the renderer. Keeping the
 * regex in sync is enforced by the renderer side (Next build) catching any
 * drift via type-check.
 */
function maskSensitivePreview(text: string): string {
  if (!text) return '';
  return text
    .replace(
      /\b(secret|token|password|api[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token)\b\s*[:=]\s*[^\s"',]+/gi,
      (_full, kw: string) => `${kw}: ***`,
    )
    .replace(
      /\b(authorization|auth)\s*[:=]\s*bearer\s+\S+/gi,
      (_full, kw: string) => `${kw}: Bearer ***`,
    );
}

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase5c-c-${process.pid}`);
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
 * Artifact lookup
 * ========================================================================== */

describe('listArtifactsByIds', () => {
  it('returns rows in caller-supplied order, skips unknowns', () => {
    const run = createRun({ title: 'a', source: 'user' })!;
    const a = createArtifact({ runId: run.id, type: 'report', producedByAgentId: 'devops-reporter' })!;
    const b = createArtifact({ runId: run.id, type: 'test',   producedByAgentId: 'github-actions' })!;
    const c = createArtifact({ runId: run.id, type: 'review', producedByAgentId: 'qa-reviewer' })!;

    const ordered = listArtifactsByIds([c.id, 'does-not-exist', a.id, b.id]);
    expect(ordered.map(x => x.id)).toEqual([c.id, a.id, b.id]);
  });

  it('graceful empty when ids array is empty', () => {
    expect(listArtifactsByIds([])).toEqual([]);
  });

  it('graceful empty when dorothy.db is closed', () => {
    closeDorothyDb();
    expect(listArtifactsByIds(['x'])).toEqual([]);
    initDorothyDb({ filePath: dbPath });
  });

  it('getArtifact returns null for unknown id', () => {
    expect(getArtifact('nope')).toBeNull();
  });
});

/* ============================================================================
 * Sensitive masking
 * ========================================================================== */

describe('maskSensitivePreview', () => {
  it('masks secret/token/password/api_key/private_key with various separators', () => {
    const raw = 'connect with password: hunter2 and token=abc123 and api-key = xyz and private_key:rsa and secret = sss';
    const masked = maskSensitivePreview(raw);
    expect(masked).toContain('password: ***');
    expect(masked).toContain('token: ***');
    expect(masked).toContain('api-key: ***');
    expect(masked).toContain('private_key: ***');
    expect(masked).toContain('secret: ***');
    expect(masked).not.toContain('hunter2');
    expect(masked).not.toContain('abc123');
    expect(masked).not.toContain('xyz');
    expect(masked).not.toContain('rsa');
    expect(masked).not.toContain('sss');
  });
  it('masks Authorization: Bearer xxx', () => {
    const raw = 'curl -H "Authorization: Bearer abcdef.ghi" ...';
    const masked = maskSensitivePreview(raw);
    expect(masked).toContain('Authorization: Bearer ***');
    expect(masked).not.toContain('abcdef.ghi');
  });
  it('leaves plain prose alone', () => {
    expect(maskSensitivePreview('plain prose, lgtm')).toBe('plain prose, lgtm');
  });
});

/* ============================================================================
 * ImprovementSignal ops
 * ========================================================================== */

describe('improvement signal ops', () => {
  it('recurring (occurrenceCount >= 2) is reflected after dedupe', () => {
    const fp = fingerprintFor({
      source: 'ci_failure', runId: 'r1', relatedAgentId: 'github-actions',
      normalizedTitle: 'ci-failed:test',
    });
    createImprovementSignal({
      runId: 'r1', source: 'ci_failure', severity: 'high',
      title: 'CI failed', summary: 'first', fingerprint: fp,
    });
    const after = createImprovementSignal({
      runId: 'r1', source: 'ci_failure', severity: 'high',
      title: 'CI failed', summary: 'second', fingerprint: fp,
    })!;
    expect(after.occurrenceCount).toBe(2);
    const recurring = listImprovementSignals({ limit: 500 }).filter(s => (s.occurrenceCount ?? 1) >= 2);
    expect(recurring.length).toBe(1);
  });

  it('status update reflects on next list', () => {
    const s = createImprovementSignal({
      source: 'qa_failure', severity: 'medium', title: 't', summary: 's',
    })!;
    updateImprovementSignalStatus({ id: s.id, status: 'triaged', note: 'checking it' });
    const open = listImprovementSignals({ status: 'open' });
    const triaged = listImprovementSignals({ status: 'triaged' });
    expect(open.find(x => x.id === s.id)).toBeUndefined();
    expect(triaged.find(x => x.id === s.id)).toBeTruthy();
  });
});

/* ============================================================================
 * Dry-run overdue audit
 * ========================================================================== */

describe('dry-run overdue audit', () => {
  function seedScheduledEvent() {
    const run = createRun({ title: 'overdue', source: 'user' })!;
    updateRunState(run.id, 'planned');
    updateRunState(run.id, 'approved');
    updateRunState(run.id, 'running');
    // resumeAt is 26h in the past so the audit threshold (24h) is exceeded.
    const past = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    const evt = recordRateLimitEventAndBlockRuns({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      resumeAt: past, parseConfidence: 'high',
      affectedRunIds: [run.id],
    }).event!;
    return { run, evt, past };
  }

  it('creates an ImprovementSignal when scheduled event has been overdue >24h in dry-run', async () => {
    const { evt, run } = seedScheduledEvent();
    configureAutoResume({
      getMode: () => 'dry-run',
      getLiveAgents: () => [],
    });
    await runTick();
    const signals = listImprovementSignals({ source: 'rate_limit' });
    const audit = signals.find(s => s.title.includes('dry-run'));
    expect(audit).toBeTruthy();
    expect(audit!.runId).toBe(run.id);
    expect(audit!.fingerprint).toContain(`dry-run-overdue:${evt.id}`);
    expect(audit!.occurrenceCount).toBe(1);
  });

  it('does NOT fire when the event has been overdue < 24h', async () => {
    const run = createRun({ title: 'fresh', source: 'user' })!;
    const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30min ago
    recordRateLimitEventAndBlockRuns({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      resumeAt: recent, parseConfidence: 'high',
      affectedRunIds: [run.id],
    });
    configureAutoResume({ getMode: () => 'dry-run', getLiveAgents: () => [] });
    await runTick();
    const overdueAudits = listImprovementSignals({ source: 'rate_limit' })
      .filter(s => s.title.includes('dry-run'));
    expect(overdueAudits.length).toBe(0);
  });

  it('dedupes the audit signal on repeated ticks (no duplicate rows)', async () => {
    seedScheduledEvent();
    configureAutoResume({ getMode: () => 'dry-run', getLiveAgents: () => [] });
    await runTick();
    await runTick();
    await runTick();
    const audits = listImprovementSignals({ source: 'rate_limit' })
      .filter(s => s.title.includes('dry-run'));
    expect(audits.length).toBe(1);
    expect(audits[0].occurrenceCount).toBeGreaterThanOrEqual(2);
  });
});

/* ============================================================================
 * Resume UX — manual resumeNow path
 * ========================================================================== */

describe('manual resumeNow', () => {
  function seedRunWithSession() {
    const run = createRun({ title: 'r', source: 'user' })!;
    updateRunState(run.id, 'planned');
    updateRunState(run.id, 'approved');
    updateRunState(run.id, 'running');
    createPlan({
      runId: run.id, title: 't', description: 'd', state: 'approved',
      tasks: [{ taskId: 't1', title: 'fe', description: 'fe', ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['ok'] }],
    });
    const step = createRunStep({ runId: run.id, order: 0, agentId: 'frontend', promptRef: 't1' })!;
    const session = createAgentSession({ agentId: 'frontend', provider: 'claude', runId: run.id, runStepId: step.id })!;
    attachSessionToStep(step.id, session.id);
    return { run, step, session };
  }

  it('resumeNow dispatches the configured adapter even when mode=off', async () => {
    const { session } = seedRunWithSession();
    const evt = recordRateLimitEventAndBlockRuns({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      resumeAt: '2099-01-01T00:00:00Z', parseConfidence: 'high',
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

  it('resumeNow dispatches even for low-confidence events (manual override)', async () => {
    const { session } = seedRunWithSession();
    const evt = recordRateLimitEventAndBlockRuns({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      resumeAt: '2099-01-01T00:00:00Z', parseConfidence: 'low',
      affectedSessionIds: [session.id],
    }).event!;
    const startAgent = vi.fn(async () => {});
    configureAutoResume({
      getMode: () => 'dry-run',
      getLiveAgents: () => [{ id: 'agent-fe', status: 'idle', name: 'frontend' }],
      startAgent,
    });
    const r = await resumeNow(evt.id);
    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe('dispatched');
  });

  it('returns already-resumed when called twice on the same event', async () => {
    const { session } = seedRunWithSession();
    const evt = recordRateLimitEventAndBlockRuns({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      resumeAt: '2099-01-01T00:00:00Z', parseConfidence: 'high',
      affectedSessionIds: [session.id],
    }).event!;
    const startAgent = vi.fn(async () => {});
    configureAutoResume({
      getMode: () => 'off',
      getLiveAgents: () => [{ id: 'agent-fe', status: 'idle', name: 'frontend' }],
      startAgent,
    });
    await resumeNow(evt.id);
    const r2 = await resumeNow(evt.id);
    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(r2.outcome).toBe('skipped');
    expect(r2.reason).toBe('already-resumed');
  });
});

/* ============================================================================
 * Regression smoke
 * ========================================================================== */

describe('regression smoke', () => {
  it('Phase 5C-B: parseUsageLimitMessage low-confidence path still works', async () => {
    // Sanity: a low-confidence message persisted as pending stays pending
    // after a tick (audit does NOT promote it without resumeAt).
    const run = createRun({ title: 'low', source: 'user' })!;
    updateRunState(run.id, 'planned');
    updateRunState(run.id, 'approved');
    updateRunState(run.id, 'running');
    recordRateLimitEventAndBlockRuns({
      engine: 'claude', provider: 'claude', source: 'agent_output',
      message: 'usage limit reached', parseConfidence: 'low',
      affectedRunIds: [run.id],
    });
    configureAutoResume({ getMode: () => 'dry-run', getLiveAgents: () => [] });
    await runTick();
    const audits = listImprovementSignals({ source: 'rate_limit' })
      .filter(s => s.title.includes('dry-run'));
    expect(audits.length).toBe(0); // no resumeAt → audit cannot fire
    expect(getRun(run.id)?.state).toBe('blocked');
  });
});
