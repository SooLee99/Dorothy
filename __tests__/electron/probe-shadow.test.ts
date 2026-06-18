import { describe, it, expect } from 'vitest';
import { buildShadowDecision, aggregateShadow, shadowGatePassed, type ShadowDecision } from '../../electron/core/observability/probe-shadow';

const ts = '2026-06-10T00:00:00.000Z';

describe('PR-0c — buildShadowDecision (★decisionUsed=predicted 불변)', () => {
  it('decisionUsed 는 항상 predicted(dispatch 안 바꿈)', () => {
    const d = buildShadowDecision({ ts, provider: 'claude', predicted: { observed: true, limited: false }, probe: { observed: true, result: 'ok' }, state: 'available' });
    expect(d.decisionUsed).toBe('predicted');
  });
  it('predicted allow + observed allow → wouldDiffer false', () => {
    const d = buildShadowDecision({ ts, provider: 'claude', predicted: { observed: true, limited: false }, probe: { observed: true, result: 'ok' }, state: 'available' });
    expect(d.wouldDiffer).toBe(false);
  });
  it('★predicted limited(block) + observed available(allow) → wouldDiffer true(전환 가치)', () => {
    const d = buildShadowDecision({ ts, provider: 'claude', predicted: { observed: true, limited: true }, probe: { observed: true, result: 'ok' }, state: 'available' });
    expect(d.wouldDiffer).toBe(true);
    expect(d.predictedLimited).toBe(true);
  });
  it('predicted allow + observed limited(block) → wouldDiffer true', () => {
    const d = buildShadowDecision({ ts, provider: 'codex', predicted: { observed: true, limited: false }, probe: { observed: true, result: 'limited' }, state: 'limited' });
    expect(d.wouldDiffer).toBe(true);
  });
  it('probe observed:false → probeResult null(actualOutcome 없음)', () => {
    const d = buildShadowDecision({ ts, provider: 'codex', predicted: { observed: true, limited: false }, probe: { observed: false }, state: 'unknown' });
    expect(d.probeResult).toBeNull();
  });
  it('predicted source 없음 → predictedLimited null', () => {
    const d = buildShadowDecision({ ts, provider: 'x', predicted: { observed: false }, probe: { observed: true, result: 'ok' }, state: 'available' });
    expect(d.predictedLimited).toBeNull();
  });
});

describe('PR-0c — aggregateShadow (★meaningful=probe 결과 있는 것만, §6)', () => {
  const mk = (over: Partial<ShadowDecision>): ShadowDecision => ({
    ts, provider: 'claude', predictedLimited: false, observedState: 'available', probeResult: 'ok', wouldDiffer: false, decisionUsed: 'predicted', ...over,
  });
  it('probeResult null 은 meaningful 분모 제외', () => {
    const agg = aggregateShadow([mk({ probeResult: null }), mk({ probeResult: null }), mk({ probeResult: 'ok' })]);
    expect(agg.total).toBe(3);
    expect(agg.meaningful).toBe(1);
  });
  it('observed available + probe ok → match', () => {
    const agg = aggregateShadow([mk({ observedState: 'available', probeResult: 'ok' })]);
    expect(agg.matchRate).toBe(1);
    expect(agg.falseOkCount).toBe(0);
  });
  it('★observed available + probe limited → false-ok(불일치)', () => {
    const agg = aggregateShadow([mk({ observedState: 'available', probeResult: 'limited' })]);
    expect(agg.falseOkCount).toBe(1);
    expect(agg.matchRate).toBe(0);
  });
  it('observed limited + probe limited → match(false-ok 아님)', () => {
    const agg = aggregateShadow([mk({ observedState: 'limited', probeResult: 'limited' })]);
    expect(agg.matchRate).toBe(1);
    expect(agg.falseOkCount).toBe(0);
  });
  it('wouldDiffer 비율', () => {
    const agg = aggregateShadow([mk({ wouldDiffer: true }), mk({ wouldDiffer: false }), mk({ wouldDiffer: false }), mk({ wouldDiffer: false })]);
    expect(agg.wouldDifferCount).toBe(1);
    expect(agg.wouldDifferRate).toBe(0.25);
  });
  it('meaningful 0 → matchRate null(억지 통과 방지)', () => {
    const agg = aggregateShadow([mk({ probeResult: null })]);
    expect(agg.matchRate).toBeNull();
  });
});

describe('PR-0c — shadowGatePassed (이번 PR 은 시작만, 통과는 시간)', () => {
  it('데이터 부족 → 미통과', () => {
    const g = shadowGatePassed({ total: 10, meaningful: 5, matchRate: 1, falseOkCount: 0, wouldDifferCount: 0, wouldDifferRate: 0 });
    expect(g.passed).toBe(false);
    expect(g.reasons.join(' ')).toContain('데이터 부족');
  });
  it('false-ok > 0 → 미통과(카나리 금지)', () => {
    const g = shadowGatePassed({ total: 600, meaningful: 600, matchRate: 0.999, falseOkCount: 1, wouldDifferCount: 0, wouldDifferRate: 0 });
    expect(g.passed).toBe(false);
  });
  it('≥500 meaningful + matchRate≥0.99 + falseOk 0 → 통과', () => {
    const g = shadowGatePassed({ total: 600, meaningful: 550, matchRate: 0.995, falseOkCount: 0, wouldDifferCount: 5, wouldDifferRate: 0.008 });
    expect(g.passed).toBe(true);
    expect(g.reasons).toEqual([]);
  });
});
