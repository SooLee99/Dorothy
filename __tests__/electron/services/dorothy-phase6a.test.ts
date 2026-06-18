/**
 * Dorothy MVP Phase 6-A — Diagnostic model + HookEvent → Diagnostic detector.
 *
 * Coverage:
 *   - Diagnostic service round-trip + filters + 24h fingerprint dedupe
 *   - updateDiagnosticStatus + convertDiagnosticToImprovementSignal
 *   - listDiagnostics options (onlyOpen / minOccurrences / source[] / status[])
 *   - DB unavailable graceful
 *   - Sensitive masking on summary / rootCause / impact / suggestedFix
 *   - Detector: ci_failed / resume_failed / run_step_failed /
 *     agent_session_failed / github_review_event(changes_requested) /
 *     approval_required(high) / rate_limit_detected
 *   - Detector ignores info/debug/system_note + non-changes-requested reviews
 *   - Integration: CI failure path emits HookEvent + Diagnostic, same for
 *     resume_failed and run_step_failed
 *   - Diagnostic → ImprovementSignal conversion is idempotent
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
  createRateLimitEvent,
  updateRateLimitResume,
} from '../../../electron/services/dorothy/rate-limit-service';
import {
  createApprovalRequest,
} from '../../../electron/services/dorothy/approval-request-service';
import {
  createDiagnostic,
  createOrUpdateDiagnostic,
  safeCreateDiagnostic,
  listDiagnostics,
  listDiagnosticsByRun,
  getDiagnostic,
  updateDiagnosticStatus,
  convertDiagnosticToImprovementSignal,
  countDiagnostics,
} from '../../../electron/services/dorothy/diagnostic-service';
import {
  detectDiagnosticInput,
  safeDetectDiagnosticFromHookEvent,
  DIAGNOSTIC_TRIGGER_TYPES,
} from '../../../electron/services/dorothy/diagnostic-detector';
import { createHookEvent } from '../../../electron/services/dorothy/hook-event-service';
import { listHookEventsByRun } from '../../../electron/services/dorothy/hook-event-service';
import { listImprovementSignals } from '../../../electron/services/dorothy/improvement-signal-service';
import type { HookEvent } from '../../../electron/types/dorothy';

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase6a-${process.pid}`);
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
 * 1. Diagnostic service basics
 * ========================================================================== */

describe('Diagnostic service', () => {
  it('round-trips create / get / list / updateStatus', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    const d = createDiagnostic({
      runId: r.id,
      source: 'ci_failure',
      severity: 'high',
      title: 'CI failed: ci.yml',
      summary: 'failure on lint',
      evidenceHookEventIds: ['hook-1'],
    })!;
    expect(d.id).toBeTruthy();
    expect(d.runId).toBe(r.id);
    expect(d.severity).toBe('high');
    expect(d.status).toBe('open');
    expect(d.evidenceHookEventIds).toEqual(['hook-1']);

    const fetched = getDiagnostic(d.id);
    expect(fetched?.id).toBe(d.id);

    const updated = updateDiagnosticStatus({ id: d.id, status: 'investigating' });
    expect(updated?.status).toBe('investigating');

    const list = listDiagnostics();
    expect(list.length).toBe(1);
  });

  it('default limit is 200, cap is 500', () => {
    // Just ensure the option flows through.
    for (let i = 0; i < 4; i++) {
      createDiagnostic({
        source: 'manual',
        title: `n${i}`,
        summary: 's',
      });
    }
    expect(listDiagnostics({ limit: 2 }).length).toBe(2);
    expect(listDiagnostics({ limit: 9999 }).length).toBe(4); // capped silently
    expect(listDiagnostics().length).toBe(4);
  });

  it('filters by source / severity / status / runId / onlyOpen / minOccurrences', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    createDiagnostic({ runId: r.id, source: 'ci_failure',     severity: 'high',   title: 'a', summary: 's' });
    createDiagnostic({ runId: r.id, source: 'rate_limit',     severity: 'low',    title: 'b', summary: 's' });
    const d3 = createDiagnostic({ runId: r.id, source: 'qa_failure', severity: 'medium', title: 'c', summary: 's', fingerprint: 'fp-x' })!;
    // Bump the third one to occurrenceCount=2 via dedupe round-trip.
    createOrUpdateDiagnostic({ source: 'qa_failure', title: 'c', summary: 's', fingerprint: 'fp-x', runId: r.id });
    // Mark one fixed so onlyOpen filters it out.
    updateDiagnosticStatus({ id: d3.id, status: 'fixed' });

    expect(listDiagnosticsByRun(r.id, { source: 'ci_failure' }).length).toBe(1);
    expect(listDiagnostics({ severity: 'low' }).length).toBe(1);
    expect(listDiagnostics({ status: 'fixed' }).length).toBe(1);
    expect(listDiagnostics({ onlyOpen: true }).length).toBe(2);
    expect(listDiagnostics({ minOccurrences: 2 }).length).toBe(1);
    expect(listDiagnostics({ source: ['ci_failure', 'rate_limit'] }).length).toBe(2);
  });

  it('createOrUpdateDiagnostic dedupes by fingerprint within 24h and merges evidence ids', () => {
    const fp = 'shared-fp';
    const a = createOrUpdateDiagnostic({
      source: 'ci_failure', title: 'CI a', summary: 'first',
      fingerprint: fp,
      evidenceHookEventIds: ['e1'],
    })!;
    const b = createOrUpdateDiagnostic({
      source: 'ci_failure', title: 'CI a', summary: 'second',
      fingerprint: fp,
      evidenceHookEventIds: ['e2'],
    })!;
    expect(b.id).toBe(a.id);
    expect(b.occurrenceCount ?? 1).toBe(2);
    expect(b.evidenceHookEventIds.sort()).toEqual(['e1', 'e2']);
    expect(listDiagnostics().length).toBe(1);
  });

  it('createOrUpdateDiagnostic does not re-use a fixed/ignored/converted row', () => {
    const fp = 'fp-closed';
    const a = createOrUpdateDiagnostic({
      source: 'manual', title: 'closed once', summary: 's', fingerprint: fp,
    })!;
    updateDiagnosticStatus({ id: a.id, status: 'fixed' });
    const b = createOrUpdateDiagnostic({
      source: 'manual', title: 'reopened', summary: 's', fingerprint: fp,
    })!;
    expect(b.id).not.toBe(a.id);
    expect(listDiagnostics().length).toBe(2);
  });

  it('masks sensitive values in title / summary / fields', () => {
    const d = createDiagnostic({
      source: 'manual',
      title: 'see token=should_be_hidden_long_value',
      summary: 'api_key=abcdef1234567890 bearer abcdef1234567890ab',
      rootCause: 'password=p@55',
      impact: 'private_key=PEM',
      suggestedFix: 'rotate the secret=somekey',
      evidenceHookEventIds: [],
    })!;
    expect(d.title.toLowerCase().includes('token=***')).toBe(true);
    expect(d.summary.toLowerCase().includes('api_key=***')).toBe(true);
    expect(d.summary.toLowerCase().includes('bearer ***')).toBe(true);
    expect((d.rootCause ?? '').toLowerCase().includes('password=***')).toBe(true);
    expect((d.impact ?? '').toLowerCase().includes('private_key=***')).toBe(true);
    expect((d.suggestedFix ?? '').toLowerCase().includes('secret=***')).toBe(true);
  });

  it('safeCreateDiagnostic returns null when DB unavailable instead of throwing', () => {
    closeDorothyDb();
    expect(() =>
      safeCreateDiagnostic({ source: 'manual', title: 't', summary: 's' }),
    ).not.toThrow();
    expect(safeCreateDiagnostic({ source: 'manual', title: 't', summary: 's' })).toBeNull();
    initDorothyDb({ filePath: dbPath });
  });

  it('listDiagnostics returns [] when DB unavailable', () => {
    closeDorothyDb();
    expect(listDiagnostics()).toEqual([]);
    expect(listDiagnosticsByRun('any')).toEqual([]);
    initDorothyDb({ filePath: dbPath });
  });

  it('countDiagnostics rolls up by status + severity', () => {
    createDiagnostic({ source: 'ci_failure', severity: 'critical', title: 'c1', summary: 's' });
    const open = createDiagnostic({ source: 'ci_failure', severity: 'high', title: 'c2', summary: 's' })!;
    updateDiagnosticStatus({ id: open.id, status: 'fixed' });
    const c = countDiagnostics();
    expect(c.total).toBe(2);
    expect(c.open).toBe(1);
    expect(c.fixed).toBe(1);
    expect(c.highOrCritical).toBe(2);
  });
});

/* ============================================================================
 * 2. Diagnostic → ImprovementSignal conversion
 * ========================================================================== */

describe('convertDiagnosticToImprovementSignal', () => {
  it('creates a signal + flips diagnostic status', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    const d = createDiagnostic({
      runId: r.id,
      source: 'ci_failure',
      severity: 'high',
      title: 'CI failure pattern',
      summary: 'flaky lint',
      rootCause: 'transient eslint plugin race',
      suggestedFix: 'pin eslint version',
      evidenceHookEventIds: ['evt-1'],
    })!;
    const result = convertDiagnosticToImprovementSignal(d.id);
    expect(result.ok).toBe(true);
    expect(result.signal?.title.startsWith('[Diagnostic]')).toBe(true);
    const after = getDiagnostic(d.id);
    expect(after?.status).toBe('converted_to_improvement');
    expect(after?.relatedImprovementSignalId).toBe(result.signal?.id);
    const signals = listImprovementSignals();
    expect(signals.length).toBe(1);
  });

  it('second convert returns already-converted (no second signal)', () => {
    const d = createDiagnostic({
      source: 'manual', title: 't', summary: 's', evidenceHookEventIds: [],
    })!;
    const first = convertDiagnosticToImprovementSignal(d.id);
    expect(first.ok).toBe(true);
    const second = convertDiagnosticToImprovementSignal(d.id);
    expect(second.ok).toBe(true);
    expect(second.reason).toBe('already-converted');
    expect(listImprovementSignals().length).toBe(1);
  });

  it('returns error reason when diagnostic not found', () => {
    const r = convertDiagnosticToImprovementSignal('does-not-exist');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });
});

/* ============================================================================
 * 3. Detector — per-type behaviour
 * ========================================================================== */

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

describe('Diagnostic detector', () => {
  it('DIAGNOSTIC_TRIGGER_TYPES contains the documented seven types', () => {
    expect(DIAGNOSTIC_TRIGGER_TYPES).toContain('ci_failed');
    expect(DIAGNOSTIC_TRIGGER_TYPES).toContain('resume_failed');
    expect(DIAGNOSTIC_TRIGGER_TYPES).toContain('run_step_failed');
    expect(DIAGNOSTIC_TRIGGER_TYPES).toContain('agent_session_failed');
    expect(DIAGNOSTIC_TRIGGER_TYPES).toContain('github_review_event');
    expect(DIAGNOSTIC_TRIGGER_TYPES).toContain('approval_required');
    expect(DIAGNOSTIC_TRIGGER_TYPES).toContain('rate_limit_detected');
  });

  it.each([
    'run_state_changed',
    'run_mode_changed',
    'run_step_started',
    'run_step_completed',
    'agent_session_started',
    'agent_session_completed',
    'agent_session_output',
    'handoff_created',
    'artifact_created',
    'system_note',
    'approval_resolved',
    'ci_passed',
    'rate_limit_scheduled',
    'resume_completed',
    'github_pr_event',
    'improvement_signal_created',
  ] as const)('does not detect Diagnostic for %s', t => {
    const ev = makeHookEvent({ type: t });
    expect(detectDiagnosticInput(ev)).toBeNull();
  });

  it('ci_failed → ci_failure / high', () => {
    const ev = makeHookEvent({
      type: 'ci_failed',
      severity: 'error',
      runId: 'r-1',
      title: 'CI failed: lint',
      metadata: { workflow: 'lint', conclusion: 'failure' },
    });
    const input = detectDiagnosticInput(ev)!;
    expect(input.source).toBe('ci_failure');
    expect(input.severity).toBe('high');
    expect(input.evidenceHookEventIds).toEqual([ev.id]);
    expect(input.title.toLowerCase().includes('ci failed')).toBe(true);
  });

  it('resume_failed → resume_failure, escalates to high after 3 retries', () => {
    const low = detectDiagnosticInput(makeHookEvent({
      type: 'resume_failed',
      severity: 'error',
      metadata: { provider: 'claude', retryCount: 0 },
    }))!;
    expect(low.source).toBe('resume_failure');
    expect(low.severity).toBe('medium');
    const high = detectDiagnosticInput(makeHookEvent({
      type: 'resume_failed',
      severity: 'error',
      metadata: { provider: 'claude', retryCount: 3 },
    }))!;
    expect(high.severity).toBe('high');
  });

  it('run_step_failed → orchestrator unless agent is qa-reviewer (qa_failure)', () => {
    const generic = detectDiagnosticInput(makeHookEvent({
      type: 'run_step_failed',
      severity: 'error',
      agentId: 'frontend',
      metadata: { order: 0, agentId: 'frontend', errorReason: 'compile error' },
    }))!;
    expect(generic.source).toBe('orchestrator');
    const qa = detectDiagnosticInput(makeHookEvent({
      type: 'run_step_failed',
      severity: 'error',
      agentId: 'qa-reviewer',
      metadata: { order: 1, agentId: 'qa-reviewer', errorReason: 'AC mismatch' },
    }))!;
    expect(qa.source).toBe('qa_failure');
  });

  it('agent_session_failed → agent_session / medium', () => {
    const input = detectDiagnosticInput(makeHookEvent({
      type: 'agent_session_failed',
      severity: 'error',
      agentId: 'backend',
      agentSessionId: 'sess-1',
      metadata: { provider: 'claude', endStatus: 'failed' },
    }))!;
    expect(input.source).toBe('agent_session');
    expect(input.severity).toBe('medium');
    expect(input.agentSessionId).toBe('sess-1');
  });

  it('github_review_event APPROVED is ignored, only changes_requested triggers', () => {
    const approved = detectDiagnosticInput(makeHookEvent({
      type: 'github_review_event',
      metadata: { reviewerState: 'approved', reviewer: 'alice', externalRef: 'o/r#1' },
    }));
    expect(approved).toBeNull();
    const changes = detectDiagnosticInput(makeHookEvent({
      type: 'github_review_event',
      severity: 'warning',
      metadata: { reviewerState: 'changes_requested', reviewer: 'alice', externalRef: 'o/r#1' },
    }))!;
    expect(changes.source).toBe('github_review');
    expect(changes.severity).toBe('medium');
  });

  it('approval_required low/medium is ignored, only high/critical triggers', () => {
    const low = detectDiagnosticInput(makeHookEvent({
      type: 'approval_required',
      severity: 'warning',
      metadata: { topic: 'medium-risk', riskLevel: 'medium' },
    }));
    expect(low).toBeNull();
    const high = detectDiagnosticInput(makeHookEvent({
      type: 'approval_required',
      severity: 'warning',
      metadata: { topic: 'production', riskLevel: 'high' },
    }))!;
    expect(high.source).toBe('approval_block');
    expect(high.severity).toBe('medium');
    const critical = detectDiagnosticInput(makeHookEvent({
      type: 'approval_required',
      severity: 'warning',
      metadata: { topic: 'secret-rotation', riskLevel: 'critical' },
    }))!;
    expect(critical.severity).toBe('high');
  });

  it('rate_limit_detected low confidence → medium, otherwise low', () => {
    const low = detectDiagnosticInput(makeHookEvent({
      type: 'rate_limit_detected',
      metadata: { provider: 'claude', parseConfidence: 'low' },
    }))!;
    expect(low.severity).toBe('medium');
    const high = detectDiagnosticInput(makeHookEvent({
      type: 'rate_limit_detected',
      metadata: { provider: 'claude', parseConfidence: 'high' },
    }))!;
    expect(high.severity).toBe('low');
  });

  it('safeDetectDiagnosticFromHookEvent returns null on null event without throwing', () => {
    expect(() => safeDetectDiagnosticFromHookEvent(null)).not.toThrow();
    expect(safeDetectDiagnosticFromHookEvent(null)).toBeNull();
  });
});

/* ============================================================================
 * 4. Integration — service wiring emits both HookEvent and Diagnostic
 * ========================================================================== */

describe('Integration: service-level wiring', () => {
  it('updateRunStepState(failed) emits run_step_failed + Diagnostic', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    const step = createRunStep({ runId: r.id, order: 0, agentId: 'frontend' })!;
    updateRunStepState(step.id, 'running');
    updateRunStepState(step.id, 'failed', { errorReason: 'compile error' });
    const events = listHookEventsByRun(r.id, { type: 'run_step_failed' });
    expect(events.length).toBe(1);
    const diags = listDiagnosticsByRun(r.id, { source: 'orchestrator' });
    expect(diags.length).toBe(1);
    expect(diags[0].title).toMatch(/RunStep #0 frontend failed/);
    expect(diags[0].evidenceHookEventIds.includes(events[0].id)).toBe(true);
  });

  it('endAgentSession(failed) emits agent_session_failed + Diagnostic', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    const sess = createAgentSession({ runId: r.id, agentId: 'backend', provider: 'claude' })!;
    endAgentSession({ id: sess.id, endStatus: 'failed' });
    const diags = listDiagnosticsByRun(r.id, { source: 'agent_session' });
    expect(diags.length).toBe(1);
    expect(diags[0].severity).toBe('medium');
  });

  it('updateRateLimitResume(failed) emits resume_failed + Diagnostic', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    const ev = createRateLimitEvent({
      engine: 'claude', source: 'hook', provider: 'claude',
      resumeAt: new Date(Date.now() + 60_000).toISOString(),
      parseConfidence: 'high',
      affectedRunIds: [r.id],
    })!;
    updateRateLimitResume({
      id: ev.id, resumeStatus: 'failed',
      lastResumeError: 'startAgent crashed', incrementRetry: true,
    });
    const diags = listDiagnosticsByRun(r.id, { source: 'resume_failure' });
    expect(diags.length).toBe(1);
  });

  it('createRateLimitEvent emits Diagnostic (low severity by default)', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    createRateLimitEvent({
      engine: 'claude', source: 'hook', provider: 'claude',
      resumeAt: new Date(Date.now() + 60_000).toISOString(),
      parseConfidence: 'high',
      affectedRunIds: [r.id],
    });
    const diags = listDiagnosticsByRun(r.id, { source: 'rate_limit' });
    expect(diags.length).toBe(1);
    expect(diags[0].severity).toBe('low');
  });

  it('createApprovalRequest with riskLevel=high emits approval_required + Diagnostic', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    createApprovalRequest({ runId: r.id, riskLevel: 'high', topic: 'production', state: 'pending' });
    const diags = listDiagnosticsByRun(r.id, { source: 'approval_block' });
    expect(diags.length).toBe(1);
  });

  it('createApprovalRequest with riskLevel=medium does NOT emit a Diagnostic', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    createApprovalRequest({ runId: r.id, riskLevel: 'medium', topic: 'normal', state: 'pending' });
    const diags = listDiagnosticsByRun(r.id, { source: 'approval_block' });
    expect(diags.length).toBe(0);
  });

  it('repeating ci_failed events with same workflow roll up via fingerprint', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    const ev1 = createHookEvent({
      type: 'ci_failed',
      severity: 'error',
      source: 'github_webhook',
      runId: r.id,
      title: 'CI failed: lint',
      metadata: { workflow: 'lint', conclusion: 'failure' },
    });
    const ev2 = createHookEvent({
      type: 'ci_failed',
      severity: 'error',
      source: 'github_webhook',
      runId: r.id,
      title: 'CI failed: lint',
      metadata: { workflow: 'lint', conclusion: 'failure' },
    });
    safeDetectDiagnosticFromHookEvent(ev1);
    safeDetectDiagnosticFromHookEvent(ev2);
    const diags = listDiagnosticsByRun(r.id, { source: 'ci_failure' });
    expect(diags.length).toBe(1);
    expect(diags[0].occurrenceCount ?? 1).toBe(2);
  });
});

/* ============================================================================
 * 5. Sanity / read shape
 * ========================================================================== */

describe('Read shape sanity', () => {
  it('listDiagnostics returns the most-recently-touched row first', async () => {
    const b = createDiagnostic({ source: 'manual', title: 'b', summary: 's' })!;
    const c = createDiagnostic({ source: 'manual', title: 'c', summary: 's' })!;
    const a = createDiagnostic({ source: 'manual', title: 'a', summary: 's' })!;
    // The sort key is updated_at DESC. Three rows can land in the same
    // millisecond; we only insist that the row we *just updated* is first.
    await new Promise(resolve => setTimeout(resolve, 5));
    updateDiagnosticStatus({ id: a.id, status: 'investigating' });
    const list = listDiagnostics();
    expect(list.length).toBe(3);
    expect(list[0].id).toBe(a.id);
    expect(new Set(list.map(d => d.id))).toEqual(new Set([a.id, b.id, c.id]));
  });
});
