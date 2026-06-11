/**
 * Dorothy MVP Phase 6-M — Codex runtime hardening + stale session detection.
 *
 * All pure / injected — no startAgent, no PTY, no Codex token.
 */

import { describe, it, expect } from 'vitest';
import { resolveLaunchModel } from '../../../electron/core/provider-model-compatibility';
import {
  detectStaleProviderModelSessions,
  getCodexRuntimeReadiness,
  parseCodexConfigModel,
} from '../../../electron/services/dorothy/codex-runtime-service';
import { CodexProvider } from '../../../electron/providers/codex-provider';
import type { AgentSession } from '../../../electron/types/dorothy';

function mockFs(existing: string[], files: Record<string, string> = {}) {
  const set = new Set(existing);
  return {
    existsSync: (p: string) => set.has(p) || p in files,
    statSync: () => ({ isDirectory: () => false }) as ReturnType<typeof import('fs').statSync>,
    accessSync: () => undefined,
    readFileSync: ((p: string) => files[p] ?? '') as typeof import('fs').readFileSync,
  } as Pick<typeof import('fs'), 'existsSync' | 'statSync' | 'accessSync' | 'readFileSync'>;
}

const HOME = '/Users/soo';

describe('Phase 6-M — Codex hard gate (model resolution)', () => {
  it('codex + opus → undefined (no --model)', () => {
    expect(resolveLaunchModel('codex', 'opus')).toBeUndefined();
  });
  it('codex + opus + no default → undefined', () => {
    expect(resolveLaunchModel('codex', 'opus', undefined)).toBeUndefined();
  });
  it('codex + opus + compatible default → default', () => {
    expect(resolveLaunchModel('codex', 'opus', 'gpt-5.3-codex')).toBe('gpt-5.3-codex');
  });
  it('codex + opus + incompatible default (sonnet) → undefined', () => {
    expect(resolveLaunchModel('codex', 'opus', 'sonnet')).toBeUndefined();
  });
  it('claude + opus → opus', () => {
    expect(resolveLaunchModel('claude', 'opus')).toBe('opus');
  });
});

describe('Phase 6-M — codex command never emits opus', () => {
  const codex = new CodexProvider();
  const base = { binaryPath: '/usr/bin/codex', prompt: 'x', verbose: false, permissionMode: 'bypass' as const, skills: [], isSuperAgent: false };
  it('interactive codex+opus omits --model', () => {
    const cmd = codex.buildInteractiveCommand({ ...base, model: 'opus' } as Parameters<typeof codex.buildInteractiveCommand>[0]);
    expect(cmd).not.toContain('opus');
    expect(cmd).not.toContain('--model');
  });
  it('oneshot codex+opus omits --model', () => {
    const cmd = codex.buildOneShotCommand({ binaryPath: '/usr/bin/codex', prompt: 'x', model: 'opus' } as Parameters<typeof codex.buildOneShotCommand>[0]);
    expect(cmd).not.toContain('opus');
  });
});

describe('Phase 6-M — stale session detection', () => {
  function sess(id: string, agentId: string, exited = false): AgentSession {
    return { id, agentId, provider: 'codex', startedAt: '2026-06-01T00:00:00Z', exitedAt: exited ? '2026-06-01T01:00:00Z' : null };
  }
  const configured = [
    { id: 'uuid-codex-opus', name: 'QA', provider: 'codex', model: 'opus' },
    { id: 'uuid-codex-ok', name: 'Ops', provider: 'codex', model: 'gpt-5.3-codex' },
    { id: 'uuid-claude', name: 'FE', provider: 'claude', model: 'opus' },
  ];

  it('flags an active codex+opus session', () => {
    const flags = detectStaleProviderModelSessions({
      sessions: [sess('s1', 'uuid-codex-opus')],
      configuredAgents: configured,
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].reason).toBe('stale_session_model_mismatch');
    expect(flags[0].sessionId).toBe('s1');
  });

  it('does NOT flag a compatible codex session', () => {
    const flags = detectStaleProviderModelSessions({ sessions: [sess('s2', 'uuid-codex-ok')], configuredAgents: configured });
    expect(flags).toHaveLength(0);
  });

  it('does NOT flag a claude+opus session', () => {
    const flags = detectStaleProviderModelSessions({ sessions: [sess('s3', 'uuid-claude')], configuredAgents: configured });
    expect(flags).toHaveLength(0);
  });

  it('does NOT flag an exited session (active only)', () => {
    const flags = detectStaleProviderModelSessions({ sessions: [sess('s4', 'uuid-codex-opus', true)], configuredAgents: configured });
    expect(flags).toHaveLength(0);
  });
});

describe('Phase 6-M — codex runtime readiness', () => {
  it('parseCodexConfigModel reads a top-level model, ignores section keys', () => {
    expect(parseCodexConfigModel('model = "opus"\n[tui]\nx = 1')).toBe('opus');
    expect(parseCodexConfigModel('[projects.x]\nmodel = "opus"')).toBeNull();
    expect(parseCodexConfigModel('[tui]\nfoo = 1')).toBeNull();
  });

  it('detects persistent opus + incompatible configured agents', () => {
    const cfgPath = `${HOME}/.codex/config.toml`;
    const r = getCodexRuntimeReadiness({
      homeDir: HOME,
      fsImpl: mockFs([`${HOME}/.npm-global/bin/codex`], { [cfgPath]: 'model = "opus"\n' }),
      configuredAgents: [{ id: 'a1', name: 'QA', provider: 'codex', model: 'opus' }],
    });
    expect(r.binaryFound).toBe(true);
    expect(r.persistentModelOpus).toBe(true);
    expect(r.incompatibleConfiguredAgents).toHaveLength(1);
    expect(r.opusBlocked).toBe(true);
    expect(r.autoRewrite).toBe(false);
  });

  it('defaultCodexModel compatibility is reported', () => {
    const r = getCodexRuntimeReadiness({
      homeDir: HOME, fsImpl: mockFs([`${HOME}/.npm-global/bin/codex`]),
      configuredAgents: [], defaultCodexModel: 'gpt-5.3-codex',
    });
    expect(r.defaultCodexModelOk).toBe(true);
    const r2 = getCodexRuntimeReadiness({
      homeDir: HOME, fsImpl: mockFs([`${HOME}/.npm-global/bin/codex`]),
      configuredAgents: [], defaultCodexModel: 'opus',
    });
    expect(r2.defaultCodexModelOk).toBe(false);
  });
});
