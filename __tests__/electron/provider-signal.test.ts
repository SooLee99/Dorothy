import { describe, it, expect } from 'vitest';
import { computeProviderState } from '../../electron/core/observability/provider-signal';

describe('PR-0b — computeProviderState (불변식: available은 실측 ok만)', () => {
  it('probeOk → available (예측 limited 라도 실측 ok 면 즉시 available)', () => {
    expect(computeProviderState({ probeOk: true, probeLimited: false, predLimited: false, predRecoveryAt: null })).toBe('available');
    // ★불변식: 예측이 limited 여도 실측 ok 면 available
    expect(computeProviderState({ probeOk: true, probeLimited: true, predLimited: true, predRecoveryAt: '2026-06-09T13:00:00Z' })).toBe('available');
  });

  it('probeLimited(확인된 limited) → limited', () => {
    expect(computeProviderState({ probeOk: false, probeLimited: true, predLimited: false, predRecoveryAt: null })).toBe('limited');
  });

  it('예측 한도 + recoveryAt 있음 → recovering(확인 대기)', () => {
    expect(computeProviderState({ probeOk: false, probeLimited: false, predLimited: true, predRecoveryAt: '2026-06-09T13:00:00Z' })).toBe('recovering');
  });

  it('예측 한도 + recoveryAt 없음 → limited', () => {
    expect(computeProviderState({ probeOk: false, probeLimited: false, predLimited: true, predRecoveryAt: null })).toBe('limited');
  });

  it('확인·예측 모두 없음 → unknown', () => {
    expect(computeProviderState({ probeOk: false, probeLimited: false, predLimited: false, predRecoveryAt: null })).toBe('unknown');
  });

  it('★예측 recoveryAt 도달만으로 available 금지 — predLimited 인데 probe 없음은 recovering/limited지 available 아님', () => {
    const s = computeProviderState({ probeOk: false, probeLimited: false, predLimited: true, predRecoveryAt: '2020-01-01T00:00:00Z' });
    expect(s).not.toBe('available');
    expect(s).toBe('recovering');
  });
});
