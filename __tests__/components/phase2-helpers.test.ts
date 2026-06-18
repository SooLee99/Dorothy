import { describe, it, expect } from 'vitest';
import { evidenceView, probeView, gitView, terminalView, TONE_CLASS, taskRepoBasename, matchesCapsule } from '../../src/components/phase2/lib';

describe('PR-2-U0 — evidenceView (★G1)', () => {
  it('verified===true → tone success(초록) + basis', () => {
    const v = evidenceView({ observed: true, verified: true, basis: { observed: true, value: 'CI green' } });
    expect(v.tone).toBe('success');
    expect(v.label).toBe('검증됨');
    expect(v.basis).toBe('CI green');
  });
  it('★verified===false → 절대 success 아님(미검증)', () => {
    const v = evidenceView({ observed: true, verified: false, basis: { observed: false } });
    expect(v.tone).not.toBe('success');
    expect(v.tone).toBe('neutral');
    expect(v.label).toBe('미검증');
  });
  it('observed false / undefined → 확인 불가', () => {
    expect(evidenceView({ observed: false }).label).toBe('확인 불가');
    expect(evidenceView(undefined).tone).toBe('unknown');
  });
  it('verified true 인데 basis observed:false → 초록이되 basis null', () => {
    const v = evidenceView({ observed: true, verified: true, basis: { observed: false } });
    expect(v.tone).toBe('success');
    expect(v.basis).toBeNull();
  });
});

describe('PR-2-U0 — probeView (★G2)', () => {
  it('up:true → 응답함(port·latency)', () => {
    const v = probeView({ observed: true, up: true, port: 8080, latencyMs: 16 });
    expect(v.tone).toBe('success');
    expect(v.text).toContain('응답함');
    expect(v.text).toContain('8080');
    expect(v.text).toContain('16ms');
  });
  it('up:false → 미응답(reason)', () => {
    const v = probeView({ observed: true, up: false, port: 3000, reason: 'probe-unreachable' });
    expect(v.tone).toBe('danger');
    expect(v.text).toContain('미응답');
    expect(v.text).toContain('probe-unreachable');
  });
  it('observed false → 확인 불가(예측/주장 0)', () => {
    expect(probeView({ observed: false }).text).toBe('확인 불가');
    expect(probeView(undefined).tone).toBe('unknown');
  });
});

describe('PR-2-U0 — gitView (★G3)', () => {
  it('observed → branch/dirty/ahead/behind/lastCommit/checkedAt', () => {
    const v = gitView({ observed: true, branch: 'feature/x', ahead: 2, behind: 0, dirty: 3, lastCommit: { hash: 'abc', msg: 'm', at: 't' }, checkedAt: 't' });
    expect(v.observed).toBe(true);
    if (v.observed) {
      expect(v.branch).toBe('feature/x');
      expect(v.dirty).toBe(3);
      expect(v.ahead).toBe(2);
      expect(v.lastCommit?.hash).toBe('abc');
    }
  });
  it('observed false → 확인 불가', () => {
    expect(gitView({ observed: false }).observed).toBe(false);
    expect(gitView(undefined).observed).toBe(false);
  });
});

describe('PR-2-U0 — terminalView (recent|silent only, advancing 금지)', () => {
  const now = Date.UTC(2026, 5, 9, 12, 0, 0);
  it('lastOutputAt 최근(<30s) → recent', () => {
    const v = terminalView({ data: { lines: [{ idx: 0, text: 'x' }], lastOutputAt: { observed: true, ts: new Date(now - 5000).toISOString() }, output: { observed: true, byteCount: 100, lineCount: 1 } } }, now);
    expect(v.activity).toBe('recent');
    expect(v.secondsSince).toBe(5);
    expect(v.byteCount).toBe(100);
    expect(v.lines.length).toBe(1);
  });
  it('lastOutputAt 오래(>30s) → silent', () => {
    const v = terminalView({ data: { lines: [], lastOutputAt: { observed: true, ts: new Date(now - 120000).toISOString() }, output: { observed: true, byteCount: 0, lineCount: 0 } } }, now);
    expect(v.activity).toBe('silent');
    expect(v.secondsSince).toBe(120);
  });
  it('lastOutputAt observed:false → unknown(확인 불가), 낙관 0', () => {
    const v = terminalView({ data: { lines: [], lastOutputAt: { observed: false, reason: 'probe-pending' }, output: { observed: false } } }, now);
    expect(v.activity).toBe('unknown');
    expect(v.secondsSince).toBeNull();
    expect(v.byteCount).toBeNull();
  });
  it('null 응답 → 빈/unknown', () => {
    const v = terminalView(null, now);
    expect(v.lines).toEqual([]);
    expect(v.activity).toBe('unknown');
  });
  it('activity 는 recent|silent|unknown 만(advancing/progress 없음)', () => {
    expect(['recent', 'silent', 'unknown']).toContain(terminalView(null, now).activity);
  });
});

describe('PR-2-U1 — task↔capsule 조인 (★task.projectId 아닌 projectPath basename ∈ repos)', () => {
  const TRIPLAN = ['triplan', 'triplan-frontend', 'triplan-travel-service'];
  it('taskRepoBasename — projectPath 마지막 조각', () => {
    expect(taskRepoBasename('/Users/soo/workspace/source-code/triplan/triplan-frontend')).toBe('triplan-frontend');
    expect(taskRepoBasename('triplan')).toBe('triplan');
    expect(taskRepoBasename(undefined)).toBeNull();
    expect(taskRepoBasename(null)).toBeNull();
  });
  it('repos 포함 basename → true', () => {
    expect(matchesCapsule('/x/triplan', TRIPLAN)).toBe(true);
    expect(matchesCapsule('/x/triplan-frontend', TRIPLAN)).toBe(true);
    expect(matchesCapsule('/x/triplan-travel-service', TRIPLAN)).toBe(true);
  });
  it('★capsule 미포함(soo-auth-service)은 false — 정직히 제외(거짓 매칭 금지)', () => {
    expect(matchesCapsule('/x/soo-auth-service', TRIPLAN)).toBe(false);
    expect(matchesCapsule('/x/public-toilet-finder', TRIPLAN)).toBe(false);
  });
  it('★repos 없음/빈 → false(조인 불가, 호출부에서 필터 미적용)', () => {
    expect(matchesCapsule('/x/triplan', null)).toBe(false);
    expect(matchesCapsule('/x/triplan', undefined)).toBe(false);
    expect(matchesCapsule('/x/triplan', [])).toBe(false);
  });
  it('projectPath 없음 → false', () => {
    expect(matchesCapsule(undefined, TRIPLAN)).toBe(false);
  });
});

describe('PR-2-U0 — TONE_CLASS', () => {
  it('success만 emerald(초록), 나머지는 비-emerald', () => {
    expect(TONE_CLASS.success).toContain('emerald');
    expect(TONE_CLASS.neutral).not.toContain('emerald');
    expect(TONE_CLASS.unknown).not.toContain('emerald');
    expect(TONE_CLASS.danger).toContain('rose');
  });
});
