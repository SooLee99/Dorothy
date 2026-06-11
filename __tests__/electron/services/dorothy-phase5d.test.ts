/**
 * Dorothy MVP Phase 5D — RunMode router + policy + Run persistence.
 *
 * Coverage:
 *   - decideRunMode covers every documented keyword family
 *   - "autopilot" never returns an unknown mode; degrades to persistent
 *     or whatever else matched, with `autopilot deferred` reason
 *   - Risk keywords pass through `riskKeywords` without auto-mutating mode
 *   - createRun persists mode/modeSource/modeReason
 *   - Listing/getting Runs predating the column add still works
 *   - run-mode-policy returns expected budgets
 *   - Orchestrator honours persistent's higher retry budget vs team
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { initDorothyDb, closeDorothyDb } from '../../../electron/services/dorothy/db';
import { createRun, getRun, listRuns, updateRunState } from '../../../electron/services/dorothy/run-service';
import {
  decideRunMode,
  decideRunModeFor,
  compositeSignalText,
  DEFAULT_RUN_MODE,
} from '../../../electron/services/dorothy/run-mode-router';
import {
  policyFor,
  maxFixAttemptsFor,
  parallelAllowedFor,
  RUN_MODE_POLICIES,
} from '../../../electron/services/dorothy/run-mode-policy';

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase5d-${process.pid}`);
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
 * Router — keyword matching
 * ========================================================================== */

describe('decideRunMode — keyword matching', () => {
  it('default is team when no signal text is present', () => {
    const d = decideRunMode('');
    expect(d.mode).toBe(DEFAULT_RUN_MODE);
    expect(d.source).toBe('default');
    expect(d.matchedKeywords).toEqual([]);
  });

  it('"team으로 구현" → team', () => {
    const d = decideRunMode('이번 사이클은 팀으로 구현해줘');
    expect(d.mode).toBe('team');
    expect(d.source).toBe('keyword');
    expect(d.confidence).toBe('high');
  });

  it('"team" 영문도 인식', () => {
    expect(decideRunMode('use team mode').mode).toBe('team');
  });

  it('"테스트 통과할 때까지 계속 고쳐" → ultraqa OR persistent', () => {
    const d = decideRunMode('테스트 통과할 때까지 계속 고쳐줘');
    // "테스트 통과할 때까지" is the ultraqa cue; "계속 고쳐" is persistent.
    // Both are in different families so MODE_ORDER (ultraqa beats persistent)
    // wins; either is acceptable for the spec ("→ persistent 또는 ultraqa").
    expect(['ultraqa', 'persistent']).toContain(d.mode);
    expect(d.source).toBe('keyword');
  });

  it('"수동으로 계획만" → manual', () => {
    expect(decideRunMode('수동으로 계획만 작성해줘').mode).toBe('manual');
  });

  it('"plan only" → manual (영문)', () => {
    expect(decideRunMode('plan only, do not implement').mode).toBe('manual');
  });

  it('"순서대로 안전하게" → pipeline', () => {
    expect(decideRunMode('순서대로 안전하게 진행해줘').mode).toBe('pipeline');
  });

  it('"sequential" → pipeline', () => {
    expect(decideRunMode('sequential roll-out only').mode).toBe('pipeline');
  });

  it('"qa 집중" / "qa focused" → ultraqa', () => {
    expect(decideRunMode('이번에는 qa 집중으로 가자').mode).toBe('ultraqa');
    expect(decideRunMode('go qa focused this cycle').mode).toBe('ultraqa');
  });

  it('"끝까지 고쳐" → persistent', () => {
    expect(decideRunMode('끝까지 고쳐서 머지하자').mode).toBe('persistent');
  });

  it('"keep fixing" → persistent', () => {
    expect(decideRunMode('please keep fixing until tests pass').mode).toBe('persistent');
  });
});

describe('decideRunMode — autopilot deferral', () => {
  it('autopilot alone → persistent with deferred reason', () => {
    const d = decideRunMode('let it autopilot');
    expect(d.mode).toBe('persistent');
    expect(d.reason).toMatch(/autopilot deferred/i);
    expect(d.matchedKeywords).toContain('autopilot');
  });
  it('autopilot + team → team with deferred reason (doesn\'t promote to unknown mode)', () => {
    const d = decideRunMode('team으로 autopilot 으로 돌려줘');
    expect(d.mode).toBe('team');
    expect(d.reason).toMatch(/autopilot deferred/i);
  });
  it('never returns a mode value outside the documented enum', () => {
    const samples = [
      'autopilot please',
      '팀으로 autopilot',
      'persistent autopilot mode',
      'ultraqa autopilot',
    ];
    const valid = new Set(['manual', 'team', 'persistent', 'ultraqa', 'pipeline']);
    for (const text of samples) {
      expect(valid.has(decideRunMode(text).mode)).toBe(true);
    }
  });
});

describe('decideRunMode — risk keywords', () => {
  it('exposes risk keywords without changing the mode', () => {
    const d = decideRunMode('팀으로 production deploy 진행');
    expect(d.mode).toBe('team'); // mode chosen by the team keyword
    expect(d.riskKeywords).toEqual(expect.arrayContaining(['production', 'deploy']));
  });

  it('risk keyword without mode hint stays on the default + carries gate signal', () => {
    const d = decideRunMode('drop the legacy table next sprint');
    expect(d.mode).toBe('team'); // default
    expect(d.source).toBe('default');
    expect(d.riskKeywords).toContain('drop');
  });
});

describe('compositeSignalText / decideRunModeFor', () => {
  it('joins title + description + prompt + task descriptions', () => {
    const text = compositeSignalText({
      title: 'feat: 결제',
      description: '팀으로 진행',
      taskDescriptions: ['production secret rotate', '테스트 강화'],
    });
    expect(text).toContain('팀으로 진행');
    expect(text).toContain('production');
  });
  it('decideRunModeFor returns a decision over the composed text', () => {
    const d = decideRunModeFor({
      title: '결제 모듈 점검',
      description: '순서대로 안전하게',
    });
    expect(d.mode).toBe('pipeline');
  });
});

/* ============================================================================
 * Policy registry
 * ========================================================================== */

describe('run-mode-policy', () => {
  it.each([
    ['manual',     0, false],
    ['team',       2, true],
    ['persistent', 3, true],
    ['ultraqa',    2, false],
    ['pipeline',   1, false],
  ] as const)('%s: maxFixAttempts=%i parallel=%s', (mode, fixes, par) => {
    expect(policyFor(mode).maxFixAttempts).toBe(fixes);
    expect(maxFixAttemptsFor(mode)).toBe(fixes);
    expect(parallelAllowedFor(mode)).toBe(par);
  });

  it('null/unknown falls back to team policy', () => {
    expect(policyFor(null).mode).toBe('team');
    expect(policyFor(undefined).mode).toBe('team');
  });

  it('registry covers every documented mode', () => {
    expect(Object.keys(RUN_MODE_POLICIES).sort()).toEqual(
      ['manual', 'persistent', 'pipeline', 'team', 'ultraqa'].sort(),
    );
  });

  it('ultraqa requires validation commands', () => {
    expect(policyFor('ultraqa').requireValidationCommands).toBe(true);
    expect(policyFor('team').requireValidationCommands).toBe(false);
  });
});

/* ============================================================================
 * Run persistence — column add + null safety
 * ========================================================================== */

describe('Run persistence', () => {
  it('createRun stores mode / modeSource / modeReason', () => {
    const r = createRun({
      title: 'feat: small',
      source: 'user',
      mode: 'persistent',
      modeSource: 'keyword',
      modeReason: 'matched persistent keyword "끝까지 고쳐"',
    });
    expect(r).toBeTruthy();
    expect(r!.mode).toBe('persistent');
    expect(r!.modeSource).toBe('keyword');
    expect(r!.modeReason).toMatch(/persistent/);

    // Re-fetch via list to ensure rowToRun maps the new columns.
    const list = listRuns({ limit: 10 });
    const back = list.find(x => x.id === r!.id)!;
    expect(back.mode).toBe('persistent');
  });

  it('createRun without mode is allowed (backward compatible)', () => {
    const r = createRun({ title: 'no-mode', source: 'user' })!;
    expect(r.mode).toBeNull();
    expect(r.modeSource).toBeNull();
    expect(r.modeReason).toBeNull();
  });

  it('listRuns still works when mode column is unset on existing rows', () => {
    createRun({ title: 'a', source: 'user' });
    createRun({ title: 'b', source: 'user', mode: 'team', modeSource: 'default' });
    const all = listRuns({ limit: 10 });
    expect(all.length).toBe(2);
    // The unset row should hold null for mode and not crash the row mapper.
    expect(all.find(r => r.title === 'a')!.mode).toBeNull();
    expect(all.find(r => r.title === 'b')!.mode).toBe('team');
  });
});

/* ============================================================================
 * Orchestrator-policy integration — retry budget from policy
 * ========================================================================== */

describe('orchestrator retry budget reads from policy', () => {
  // We test advanceRun via the same paths used in Phase 3+4 tests; here we
  // only need to confirm that the budget *source* changes with the Run mode.
  // The actual state-machine behaviour is covered by phase3+4 + 5C-B suites.

  it('persistent run gets budget=3', () => {
    const r = createRun({ title: 'persistent-budget', source: 'user', mode: 'persistent' })!;
    expect(maxFixAttemptsFor(r.mode)).toBe(3);
    // updateRunState retains mode.
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');
    expect(getRun(r.id)?.mode).toBe('persistent');
  });

  it('manual run gets budget=0', () => {
    const r = createRun({ title: 'manual-budget', source: 'user', mode: 'manual' })!;
    expect(maxFixAttemptsFor(r.mode)).toBe(0);
  });

  it('pipeline run gets budget=1', () => {
    const r = createRun({ title: 'pipeline-budget', source: 'user', mode: 'pipeline' })!;
    expect(maxFixAttemptsFor(r.mode)).toBe(1);
  });
});
