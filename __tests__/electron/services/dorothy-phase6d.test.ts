/**
 * Dorothy MVP Phase 6-D — SkillCandidate / Skill Registry preparation.
 *
 * Coverage:
 *   - createSkillCandidate round-trip + masking + clamping
 *   - createOrUpdateSkillCandidate dedupes by fingerprint within 24h
 *   - list / listByRun / updateStatus
 *   - ImprovementSignal → SkillCandidate (per-source category mapping +
 *     proposed slug + guardrails + evidence)
 *   - Diagnostic → SkillCandidate (per-source category mapping)
 *   - convertSkillCandidateToKanbanTask (status flip + idempotent re-convert)
 *   - countSkillCandidates rollup
 *   - dbUnavailable graceful
 *   - slugifySkillName helper
 *   - No skill file is written anywhere on accept / ready_for_registry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import {
  initDorothyDb,
  closeDorothyDb,
} from '../../../electron/services/dorothy/db';
import { createRun } from '../../../electron/services/dorothy/run-service';
import { createDiagnostic } from '../../../electron/services/dorothy/diagnostic-service';
import {
  createImprovementSignal,
} from '../../../electron/services/dorothy/improvement-signal-service';
import {
  createSkillCandidate,
  safeCreateSkillCandidate,
  createOrUpdateSkillCandidate,
  listSkillCandidates,
  listSkillCandidatesByRun,
  getSkillCandidate,
  updateSkillCandidateStatus,
  convertImprovementSignalToSkillCandidate,
  convertDiagnosticToSkillCandidate,
  convertSkillCandidateToKanbanTask,
  countSkillCandidates,
  slugifySkillName,
} from '../../../electron/services/dorothy/skill-candidate-service';

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase6d-${process.pid}`);
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let dbPath = '';
let homeBackup: string | undefined;

beforeEach(() => {
  dbPath = path.join(TEST_DIR, `dorothy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const r = initDorothyDb({ filePath: dbPath });
  if (!r.ok) throw new Error(`initDorothyDb failed: ${r.reason}`);
  // Isolate Kanban file writes so the convert-to-task path never touches
  // the real ~/.dorothy/kanban-tasks.json.
  homeBackup = process.env.HOME;
  const isolated = path.join(TEST_DIR, `home-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(path.join(isolated, '.dorothy'), { recursive: true });
  process.env.HOME = isolated;
});

afterEach(() => {
  closeDorothyDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
  process.env.HOME = homeBackup;
});

/* ============================================================================
 * 1. Service basics
 * ========================================================================== */

describe('SkillCandidate service basics', () => {
  it('round-trips create / get / list / updateStatus', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    const c = createSkillCandidate({
      title: 'recurring lint failure',
      summary: 'eslint flagged 3 files repeatedly',
      category: 'qa',
      source: 'qa_failure',
      severity: 'medium',
      runId: r.id,
      relatedAgentId: 'qa-reviewer',
      proposedSkillName: 'lint-rerun',
      proposedTrigger: 'QA reports lint failure',
      proposedInputs: ['Failing eslint command', 'Last output excerpt'],
      proposedOutputs: ['Suggested fix'],
      proposedGuardrails: ['Never auto-edit eslint config'],
      proposedValidation: ['Replay command'],
      evidenceHookEventIds: ['hook-1', 'hook-2'],
    })!;
    expect(c.id).toBeTruthy();
    expect(c.category).toBe('qa');
    expect(c.status).toBe('open');
    expect(c.proposedSkillName).toBe('lint-rerun');
    expect(c.proposedInputs).toEqual(['Failing eslint command', 'Last output excerpt']);
    expect(c.evidenceHookEventIds).toEqual(['hook-1', 'hook-2']);

    const fetched = getSkillCandidate(c.id);
    expect(fetched?.id).toBe(c.id);

    const updated = updateSkillCandidateStatus({ id: c.id, status: 'triaged' });
    expect(updated?.status).toBe('triaged');

    const list = listSkillCandidates();
    expect(list.length).toBe(1);
  });

  it('default limit is 200, cap is 500', () => {
    for (let i = 0; i < 6; i++) {
      createSkillCandidate({ title: `c${i}`, summary: 's', source: 'manual' });
    }
    expect(listSkillCandidates({ limit: 3 }).length).toBe(3);
    expect(listSkillCandidates({ limit: 9999 }).length).toBe(6); // cap silent
    expect(listSkillCandidates().length).toBe(6);
  });

  it('filters by category / source / severity / status / onlyOpen / minOccurrences', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    createSkillCandidate({ title: 'a', summary: 's', source: 'qa_failure',  category: 'qa',          severity: 'high',   runId: r.id });
    createSkillCandidate({ title: 'b', summary: 's', source: 'ci_failure',  category: 'devops',      severity: 'medium', runId: r.id });
    const c3 = createSkillCandidate({
      title: 'c', summary: 's', source: 'manual', category: 'orchestration', severity: 'low',
      runId: r.id, fingerprint: 'fp-x',
    })!;
    createOrUpdateSkillCandidate({
      title: 'c', summary: 's', source: 'manual', category: 'orchestration', severity: 'low',
      runId: r.id, fingerprint: 'fp-x',
    });
    updateSkillCandidateStatus({ id: c3.id, status: 'dismissed' });

    expect(listSkillCandidatesByRun(r.id, { category: 'qa' }).length).toBe(1);
    expect(listSkillCandidates({ source: 'ci_failure' }).length).toBe(1);
    expect(listSkillCandidates({ severity: 'high' }).length).toBe(1);
    expect(listSkillCandidates({ status: 'dismissed' }).length).toBe(1);
    expect(listSkillCandidates({ onlyOpen: true }).length).toBe(2);
    expect(listSkillCandidates({ minOccurrences: 2 }).length).toBe(1);
    expect(listSkillCandidates({ category: ['qa', 'devops'] }).length).toBe(2);
  });

  it('createOrUpdateSkillCandidate dedupes by fingerprint within 24h and merges evidence', () => {
    const fp = 'shared-fp';
    const a = createOrUpdateSkillCandidate({
      title: 'recurring',
      summary: 'first observation',
      source: 'qa_failure',
      category: 'qa',
      fingerprint: fp,
      evidenceHookEventIds: ['e1'],
    })!;
    const b = createOrUpdateSkillCandidate({
      title: 'recurring',
      summary: 'second observation',
      source: 'qa_failure',
      category: 'qa',
      fingerprint: fp,
      evidenceHookEventIds: ['e2'],
    })!;
    expect(b.id).toBe(a.id);
    expect(b.occurrenceCount ?? 1).toBe(2);
    expect(b.evidenceHookEventIds?.sort()).toEqual(['e1', 'e2']);
    expect(listSkillCandidates().length).toBe(1);
  });

  it('terminal status (dismissed / accepted / ready_for_registry / converted_to_task) breaks dedupe', () => {
    const fp = 'fp-terminal';
    const a = createOrUpdateSkillCandidate({
      title: 'closed once', summary: 's', source: 'manual', category: 'general', fingerprint: fp,
    })!;
    updateSkillCandidateStatus({ id: a.id, status: 'accepted' });
    const b = createOrUpdateSkillCandidate({
      title: 'reopened', summary: 's', source: 'manual', category: 'general', fingerprint: fp,
    })!;
    expect(b.id).not.toBe(a.id);
    expect(listSkillCandidates().length).toBe(2);
  });

  it('masks sensitive values in title / summary / proposed fields', () => {
    const c = createSkillCandidate({
      title: 'see token=should_be_hidden_long_value',
      summary: 'api_key=abcdef1234567890 bearer abcdef1234567890ab',
      source: 'manual',
      category: 'security',
      proposedSkillName: 'secret=oops',
      proposedSkillDescription: 'private_key=PEM',
      proposedTrigger: 'password=p@55',
      proposedInputs: ['client_secret=hidden_value'],
      proposedGuardrails: ['Skill must not write to .env*'],
    })!;
    expect(c.title.toLowerCase().includes('token=***')).toBe(true);
    expect(c.summary.toLowerCase().includes('api_key=***')).toBe(true);
    expect(c.summary.toLowerCase().includes('bearer ***')).toBe(true);
    expect((c.proposedSkillName ?? '').toLowerCase().includes('secret=***')).toBe(true);
    expect((c.proposedSkillDescription ?? '').toLowerCase().includes('private_key=***')).toBe(true);
    expect((c.proposedTrigger ?? '').toLowerCase().includes('password=***')).toBe(true);
    expect((c.proposedInputs ?? [])[0].toLowerCase().includes('client_secret=***')).toBe(true);
  });

  it('safeCreateSkillCandidate returns null when DB unavailable instead of throwing', () => {
    closeDorothyDb();
    expect(() => safeCreateSkillCandidate({ title: 't', summary: 's', source: 'manual' })).not.toThrow();
    expect(safeCreateSkillCandidate({ title: 't', summary: 's', source: 'manual' })).toBeNull();
    initDorothyDb({ filePath: dbPath });
  });

  it('listSkillCandidates returns [] when DB unavailable', () => {
    closeDorothyDb();
    expect(listSkillCandidates()).toEqual([]);
    expect(listSkillCandidatesByRun('any')).toEqual([]);
    initDorothyDb({ filePath: dbPath });
  });

  it('countSkillCandidates rolls up by status', () => {
    const a = createSkillCandidate({ title: 'a', summary: 's', source: 'manual' })!;
    const b = createSkillCandidate({ title: 'b', summary: 's', source: 'manual' })!;
    const c = createSkillCandidate({ title: 'c', summary: 's', source: 'manual' })!;
    updateSkillCandidateStatus({ id: b.id, status: 'accepted' });
    updateSkillCandidateStatus({ id: c.id, status: 'ready_for_registry' });
    const counts = countSkillCandidates();
    expect(counts.total).toBe(3);
    expect(counts.open).toBe(1);
    expect(counts.accepted).toBe(1);
    expect(counts.readyForRegistry).toBe(1);
    void a;
  });
});

/* ============================================================================
 * 2. slugifySkillName helper
 * ========================================================================== */

describe('slugifySkillName', () => {
  it('strips leading markers and lowercases', () => {
    expect(slugifySkillName('[Improvement] Lint failure recurring')).toBe('lint-failure-recurring');
    expect(slugifySkillName('[Diagnostic] CI failed: lint!!')).toBe('ci-failed-lint');
  });
  it('falls back to "skill" for empty / pure-symbol titles', () => {
    expect(slugifySkillName('')).toBe('skill');
    expect(slugifySkillName('!!!')).toBe('skill');
  });
  it('caps at 60 chars and removes trailing dashes', () => {
    const long = 'A'.repeat(200);
    const slug = slugifySkillName(long);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });
});

/* ============================================================================
 * 3. ImprovementSignal → SkillCandidate
 * ========================================================================== */

describe('convertImprovementSignalToSkillCandidate', () => {
  it('creates a candidate with category=qa for qa_failure source', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    const s = createImprovementSignal({
      runId: r.id,
      source: 'qa_failure',
      severity: 'high',
      title: 'flaky lint',
      summary: 'eslint exits 1',
      evidenceArtifactIds: ['art-1'],
    })!;
    const result = convertImprovementSignalToSkillCandidate(s.id);
    expect(result.ok).toBe(true);
    expect(result.candidate?.category).toBe('qa');
    expect(result.candidate?.severity).toBe('high');
    expect(result.candidate?.source).toBe('improvement_signal');
    expect(result.candidate?.improvementSignalId).toBe(s.id);
    expect(result.candidate?.title.startsWith('[Skill]')).toBe(true);
    expect(result.candidate?.proposedSkillName).toMatch(/flaky-lint/);
    expect(result.candidate?.evidenceArtifactIds).toEqual(['art-1']);
    expect(result.candidate?.proposedGuardrails?.length ?? 0).toBeGreaterThan(0);
    expect(result.candidate?.proposedValidation?.length ?? 0).toBeGreaterThan(0);
  });

  it.each([
    ['qa_failure',                'qa'],
    ['ci_failure',                'devops'],
    ['rate_limit',                'orchestration'],
    ['approval_required',         'security'],
    ['review_changes_requested',  'qa'],
    ['retry_exceeded',            'orchestration'],
    ['manual_note',               'general'],
  ] as const)('maps ImprovementSignal source=%s to category=%s', (src, expectedCategory) => {
    const r = createRun({ title: 'r', source: 'user' })!;
    const s = createImprovementSignal({
      runId: r.id,
      source: src,
      severity: 'medium',
      title: `${src} title`,
      summary: 'summary',
    })!;
    const result = convertImprovementSignalToSkillCandidate(s.id);
    expect(result.ok).toBe(true);
    expect(result.candidate?.category).toBe(expectedCategory);
  });

  it('handles missing improvement signal gracefully', () => {
    const r = convertImprovementSignalToSkillCandidate('does-not-exist');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });
});

/* ============================================================================
 * 4. Diagnostic → SkillCandidate
 * ========================================================================== */

describe('convertDiagnosticToSkillCandidate', () => {
  it('creates a candidate with category mapped from diagnostic.source', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    const d = createDiagnostic({
      runId: r.id,
      source: 'ci_failure',
      severity: 'high',
      title: 'CI failed: lint',
      summary: 'workflow=lint conclusion=failure',
      rootCause: 'transient',
      suggestedFix: 'rerun',
      evidenceHookEventIds: ['hook-1'],
    })!;
    const result = convertDiagnosticToSkillCandidate(d.id);
    expect(result.ok).toBe(true);
    expect(result.candidate?.category).toBe('devops');
    expect(result.candidate?.source).toBe('diagnostic');
    expect(result.candidate?.diagnosticId).toBe(d.id);
    expect(result.candidate?.severity).toBe('high');
    expect(result.candidate?.title.startsWith('[Diagnostic Skill]')).toBe(true);
    expect((result.candidate?.evidenceHookEventIds ?? []).includes('hook-1')).toBe(true);
    expect(result.candidate?.summary.includes('rootCause: transient')).toBe(true);
    expect(result.candidate?.summary.includes('suggestedFix: rerun')).toBe(true);
  });

  it('maps critical diagnostic severity to high', () => {
    const d = createDiagnostic({
      source: 'orchestrator', severity: 'critical', title: 'orch', summary: 's',
    })!;
    const result = convertDiagnosticToSkillCandidate(d.id);
    expect(result.candidate?.severity).toBe('high');
  });

  it.each([
    ['qa_failure',     'qa'],
    ['ci_failure',     'devops'],
    ['rate_limit',     'orchestration'],
    ['resume_failure', 'orchestration'],
    ['approval_block', 'security'],
    ['github_review',  'qa'],
    ['orchestrator',   'orchestration'],
    ['agent_session',  'general'],
  ] as const)('maps Diagnostic source=%s to category=%s', (src, expectedCategory) => {
    const d = createDiagnostic({ source: src, title: 't', summary: 's', severity: 'medium' })!;
    const result = convertDiagnosticToSkillCandidate(d.id);
    expect(result.ok).toBe(true);
    expect(result.candidate?.category).toBe(expectedCategory);
  });

  it('handles missing diagnostic gracefully', () => {
    const r = convertDiagnosticToSkillCandidate('does-not-exist');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });
});

/* ============================================================================
 * 5. SkillCandidate → KanbanTask
 * ========================================================================== */

describe('convertSkillCandidateToKanbanTask', () => {
  it('creates a backlog task + flips status + stamps convertedTaskId', () => {
    const c = createSkillCandidate({
      title: 'lint rerun', summary: 'rerun lint after fix',
      source: 'qa_failure', category: 'qa',
      proposedSkillName: 'lint-rerun',
      proposedTrigger: 'QA fails on lint',
      proposedInputs: ['failing command'],
      proposedOutputs: ['suggested fix'],
      proposedGuardrails: ['Never auto-edit config'],
      proposedValidation: ['Replay command'],
      evidenceHookEventIds: ['hook-1'],
    })!;
    const result = convertSkillCandidateToKanbanTask(c.id);
    expect(result.ok).toBe(true);
    expect(result.task).not.toBeNull();
    expect(result.task?.title.startsWith('[SkillCandidate]')).toBe(true);
    expect(result.task?.column).toBe('backlog');
    expect(result.task?.labels.includes('skill-candidate')).toBe(true);
    const after = getSkillCandidate(c.id);
    expect(after?.status).toBe('converted_to_task');
    expect(after?.convertedTaskId).toBe(result.task?.id);
  });

  it('refuses to re-convert an already-converted candidate', () => {
    const c = createSkillCandidate({ title: 'once', summary: 's', source: 'manual' })!;
    const first = convertSkillCandidateToKanbanTask(c.id);
    expect(first.ok).toBe(true);
    const second = convertSkillCandidateToKanbanTask(c.id);
    expect(second.ok).toBe(true);
    expect(second.reason).toBe('already-converted');
    expect(second.task?.id).toBe(first.task?.id);
  });

  it('refuses unknown candidate id', () => {
    const r = convertSkillCandidateToKanbanTask('does-not-exist');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });
});

/* ============================================================================
 * 6. Safety — no skill file is ever written
 * ========================================================================== */

describe('Skill file safety — accept / ready_for_registry never writes files', () => {
  it('accepting / readying a candidate does not create files anywhere', () => {
    const home = process.env.HOME!;
    const claudeSkillsDir = path.join(home, '.claude', 'skills');
    const dorothySkillsDir = path.join(home, '.dorothy', 'skills');
    // Baseline — neither dir exists before this test.
    const before = {
      claude: fs.existsSync(claudeSkillsDir),
      dorothy: fs.existsSync(dorothySkillsDir),
    };
    const c = createSkillCandidate({
      title: 'never-writes-anything',
      summary: 'should not produce a file',
      source: 'manual',
      category: 'general',
    })!;
    updateSkillCandidateStatus({ id: c.id, status: 'accepted' });
    updateSkillCandidateStatus({ id: c.id, status: 'ready_for_registry' });
    const after = {
      claude: fs.existsSync(claudeSkillsDir),
      dorothy: fs.existsSync(dorothySkillsDir),
    };
    // Neither directory should suddenly appear.
    expect(after.claude).toBe(before.claude);
    expect(after.dorothy).toBe(before.dorothy);
    // The candidate's own status should land where requested.
    expect(getSkillCandidate(c.id)?.status).toBe('ready_for_registry');
  });
});
