import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordStart, recordOutput, recordExit,
  getMetrics, getMetricsByAgent, deleteMetrics, allMetrics,
  computeActivity, __resetMetricsForTest,
} from '../../electron/core/observability/session-metrics';

describe('PR-0a — session-metrics', () => {
  beforeEach(() => __resetMetricsForTest());

  it('recordStart creates a metrics row with zero counters', () => {
    recordStart('sess-1', 'backend', 48213);
    const m = getMetrics('sess-1');
    expect(m).toBeDefined();
    expect(m!.agentId).toBe('backend');
    expect(m!.ptyPid).toBe(48213);
    expect(m!.byteCount).toBe(0);
    expect(m!.lineCount).toBe(0);
    expect(typeof m!.startedAt).toBe('string');
  });

  it('recordOutput accumulates byteCount (utf8) and lineCount (newlines)', () => {
    recordStart('sess-1', 'backend');
    recordOutput('sess-1', 'abc\ndef\n');     // 8 bytes, 2 newlines
    recordOutput('sess-1', 'xy');             // +2 bytes, +0 newline
    const m = getMetrics('sess-1')!;
    expect(m.byteCount).toBe(10);
    expect(m.lineCount).toBe(2);
    expect(typeof m.lastOutputAt).toBe('string');
    expect(typeof m.lastOutputAtMs).toBe('number');
  });

  it('counts multibyte utf8 bytes correctly', () => {
    recordStart('sess-1', 'frontend');
    recordOutput('sess-1', '한글\n');         // '한'3 + '글'3 + '\n'1 = 7 bytes, 1 newline
    const m = getMetrics('sess-1')!;
    expect(m.byteCount).toBe(7);
    expect(m.lineCount).toBe(1);
  });

  it('recordExit stores exitCode + exitedAt, keeps the row', () => {
    recordStart('sess-1', 'qa-reviewer');
    recordExit('sess-1', 0);
    const m = getMetrics('sess-1')!;
    expect(m.exitCode).toBe(0);
    expect(typeof m.exitedAt).toBe('string');
  });

  it('getMetricsByAgent returns the most recent session for an agent', () => {
    recordStart('old', 'orchestrator');
    recordStart('new', 'orchestrator');       // later startedAtMs (monotonic clock)
    const m = getMetricsByAgent('orchestrator')!;
    expect(m.sessionId).toBe('new');
  });

  it('is safe (no throw) for unknown session / non-string chunk', () => {
    expect(() => recordOutput('does-not-exist', 'x')).not.toThrow();
    recordStart('sess-1', 'backend');
    expect(() => recordOutput('sess-1', 12345 as unknown as string)).not.toThrow();
    expect(getMetrics('sess-1')!.byteCount).toBe(0); // non-string ignored
  });

  it('deleteMetrics / allMetrics behave', () => {
    recordStart('a', 'backend');
    recordStart('b', 'frontend');
    expect(allMetrics().length).toBe(2);
    deleteMetrics('a');
    expect(getMetrics('a')).toBeUndefined();
    expect(allMetrics().length).toBe(1);
  });
});

// ── PR-0a closeout ──────────────────────────────────────────────
describe('PR-0a closeout ② computeActivity 임계 전환(제어, 가짜 시계)', () => {
  const now = 1_700_000_000_000;
  it('출력 직후 → recent', () => {
    expect(computeActivity(now, now).activity).toBe('recent');
    expect(computeActivity(now, now).secondsSince).toBe(0);
  });
  it('★경계 양방향: <30s recent / =30s silent', () => {
    expect(computeActivity(now - 29_000, now).activity).toBe('recent');
    expect(computeActivity(now - 30_000, now).activity).toBe('silent');
    expect(computeActivity(now - 31_000, now).activity).toBe('silent');
  });
  it('★전환 시퀀스: recent → (정지 경과) silent → (출력 재개) recent', () => {
    expect(computeActivity(now - 5_000, now).activity).toBe('recent');   // 흐름 중
    expect(computeActivity(now - 90_000, now).activity).toBe('silent');  // 정지 경과
    expect(computeActivity(now, now).activity).toBe('recent');           // 재개(ts 갱신)
  });
  it('계측 없음 → unknown(낙관 0)', () => {
    expect(computeActivity(null, now).activity).toBe('unknown');
    expect(computeActivity(undefined, now).secondsSince).toBeNull();
  });
});

describe('PR-0a closeout ③ 메모리 cap(누수 0)', () => {
  beforeEach(() => __resetMetricsForTest());
  it('★1,000회 생성+종료 → Map ≤ 상한(200)', () => {
    for (let i = 0; i < 1000; i++) { recordStart(`s${i}`, 'backend', 100 + i); recordExit(`s${i}`, 0); }
    expect(allMetrics().length).toBeLessThanOrEqual(200);
  });
  it('살아있는(미종료) 세션은 cap 에서 보존', () => {
    recordStart('alive', 'orchestrator'); // 종료 안 함
    for (let i = 0; i < 1000; i++) { recordStart(`d${i}`, 'backend'); recordExit(`d${i}`, 0); }
    expect(getMetrics('alive')).toBeDefined();
  });
  it('방금 종료한 세션은 보존(종료 직후 /sessions 조회 살림)', () => {
    for (let i = 0; i < 1000; i++) { recordStart(`d${i}`, 'backend'); recordExit(`d${i}`, 0); }
    expect(getMetrics('d999')).toBeDefined(); // 가장 최근 종료(seq 큰)는 보존
  });
});

describe('PR-0a closeout ④ PTY 재생성 잔상 0', () => {
  beforeEach(() => __resetMetricsForTest());
  it('재생성 후 getMetricsByAgent 가 새 세션만(이전 byteCount 잔상 0)', () => {
    recordStart('old-pty', 'frontend');
    recordOutput('old-pty', 'stale output\n'); // 이전 PTY 출력
    recordExit('old-pty', 0);
    recordStart('new-pty', 'frontend'); // PTY 재생성(새 ptyId)
    const m = getMetricsByAgent('frontend')!;
    expect(m.sessionId).toBe('new-pty'); // 최신(seq)만
    expect(m.byteCount).toBe(0);         // 이전 출력 잔상 0
  });
});
