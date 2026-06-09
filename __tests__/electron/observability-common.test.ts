import { describe, it, expect } from 'vitest';
import { serverNow } from '../../electron/core/observability/server-clock';
import { observed, unknown, observedOr } from '../../electron/core/observability/observed';
import { envelope } from '../../electron/core/observability/envelope';
import { maskSecrets, VALUE_MATCHING_ENABLED } from '../../electron/core/observability/secret-mask';

describe('PR-0-common — server-clock', () => {
  it('returns ISO string + epochMs + monotonicMs', () => {
    const n = serverNow();
    expect(typeof n.iso).toBe('string');
    expect(n.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof n.epochMs).toBe('number');
    expect(n.monotonicMs).toBeGreaterThanOrEqual(0);
  });

  it('is monotonic — epochMs never decreases across calls', () => {
    let prev = serverNow().epochMs;
    for (let i = 0; i < 1000; i++) {
      const cur = serverNow().epochMs;
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe('PR-0-common — observed wrapper', () => {
  it('observed() spreads payload under observed:true', () => {
    expect(observed({ value: 'triplan' })).toEqual({ observed: true, value: 'triplan' });
    expect(observed({ alive: true, pid: 48213 })).toEqual({ observed: true, alive: true, pid: 48213 });
    expect(observed({ ts: '2026-06-09T00:00:00.000Z' })).toEqual({ observed: true, ts: '2026-06-09T00:00:00.000Z' });
  });

  it('unknown() carries reason and NO value (no optimistic default)', () => {
    const u = unknown('mapping-uncertain');
    expect(u).toEqual({ observed: false, reason: 'mapping-uncertain' });
    expect('value' in u).toBe(false);
  });

  it('observedOr() falls back to unknown when payload is null/undefined', () => {
    expect(observedOr({ value: 'x' }, 'source-missing')).toEqual({ observed: true, value: 'x' });
    expect(observedOr(null, 'source-missing')).toEqual({ observed: false, reason: 'source-missing' });
    expect(observedOr(undefined, 'probe-pending')).toEqual({ observed: false, reason: 'probe-pending' });
  });
});

describe('PR-0-common — envelope', () => {
  it('wraps data with meta(serverNow, generatedAt, sources, partial)', () => {
    const e = envelope({ sessions: [] }, { sources: ['agent-manager'] });
    expect(e.data).toEqual({ sessions: [] });
    expect(e.meta.sources).toEqual(['agent-manager']);
    expect(e.meta.partial).toBe(false);
    expect(typeof e.meta.serverNow).toBe('string');
    expect(e.meta.generatedAt).toBe(e.meta.serverNow);
  });

  it('defaults sources=[] and partial=false; honors partial=true', () => {
    expect(envelope(1).meta).toMatchObject({ sources: [], partial: false });
    expect(envelope(1, { partial: true }).meta.partial).toBe(true);
  });
});

describe('PR-0-common — maskSecrets', () => {
  it('(3) redacts token patterns (Bearer/prefix/JWT/AWS/Telegram)', () => {
    expect(maskSecrets('Authorization: Bearer abc123.def-456')).not.toContain('abc123.def-456');
    expect(maskSecrets('key sk-ant-abcdef123456')).not.toContain('abcdef123456');
    expect(maskSecrets('tok ghp_abcdefghijklmnop')).toContain('ghp_[REDACTED]');
    const jwt = 'eyJhbGc.eyJzdWIiOiIx.SflKxwRJ';
    expect(maskSecrets(`token=${jwt}`)).not.toContain('SflKxwRJ');
    expect(maskSecrets('aws AKIAIOSFODNN7EXAMPLE here')).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(maskSecrets('tg 123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKK')).not.toContain('AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKK');
  });

  it('(2) redacts env/JSON secret assignments', () => {
    expect(maskSecrets('api_key=supersecretvalue')).toBe('api_key=[REDACTED]');
    expect(maskSecrets('"password": "hunter2pass"')).toContain('[REDACTED]');
    expect(maskSecrets('TELEGRAM_BOT_TOKEN=plainmasked123')).toContain('[REDACTED]');
  });

  it('keeps non-secret text intact', () => {
    expect(maskSecrets('PASS  7 passed (1.2s)')).toBe('PASS  7 passed (1.2s)');
    expect(maskSecrets('')).toBe('');
    // @ts-expect-error — defensive: non-string input
    expect(maskSecrets(null)).toBe('');
  });

  // ★스펙 DoD: '값 매칭 가능/불가' 두 경로
  describe('value-matching (1) — two paths', () => {
    it('PATH A (knownValues 주어짐): redacts an arbitrary plain secret by exact match', () => {
      const secret = 'plainword-not-a-token-shape';
      const line = `the configured value is ${secret} ok`;
      expect(maskSecrets(line, [secret])).not.toContain(secret);
      expect(maskSecrets(line, [secret])).toContain('[REDACTED]');
    });

    it('PATH B (기본, knownValues 없음): a plain secret with no pattern is NOT masked (=값매칭 불가 한계)', () => {
      const secret = 'plainword-not-a-token-shape';
      const line = `the configured value is ${secret} ok`;
      // 패턴(2)(3) 어디에도 안 걸리는 평문은 그대로 남는다 — §1.2 출구의 정직한 한계.
      expect(maskSecrets(line)).toContain(secret);
    });

    it('VALUE_MATCHING_ENABLED is false (값 소스 미배선, §1.2 출구)', () => {
      expect(VALUE_MATCHING_ENABLED).toBe(false);
    });
  });
});
