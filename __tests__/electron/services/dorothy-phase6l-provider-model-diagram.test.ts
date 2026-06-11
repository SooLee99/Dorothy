/**
 * Dorothy MVP Phase 6-L — provider/model compatibility + process diagrams.
 *
 * All pure / injected — no startAgent, no PTY, no Claude/Codex token.
 */

import { describe, it, expect } from 'vitest';
import {
  checkProviderModelCompatibility,
  resolveLaunchModel,
  isClaudeModel,
  isCodexModel,
} from '../../../electron/core/provider-model-compatibility';
import { buildAgentRegistry } from '../../../electron/services/dorothy/agent-definition-registry';
import { computeDispatchReadiness } from '../../../electron/services/dorothy/agent-dispatch-readiness-service';
import { CodexProvider } from '../../../electron/providers/codex-provider';
import type { AgentDefinition } from '../../../electron/services/dorothy/agent-definition-registry';
import type { Run, RunStep } from '../../../electron/types/dorothy';

describe('Phase 6-L — provider/model compatibility', () => {
  it('claude + opus → ok', () => {
    const r = checkProviderModelCompatibility({ provider: 'claude', model: 'opus' });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('ok');
  });

  it('codex + opus → model_not_supported (with message)', () => {
    const r = checkProviderModelCompatibility({ provider: 'codex', model: 'opus' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('model_not_supported');
    expect(r.message.toLowerCase()).toContain('codex');
  });

  it('codex + undefined model → ok (provider default)', () => {
    const r = checkProviderModelCompatibility({ provider: 'codex', model: undefined });
    expect(r.ok).toBe(true);
  });

  it('codex + gpt-5.3-codex → ok', () => {
    const r = checkProviderModelCompatibility({ provider: 'codex', model: 'gpt-5.3-codex' });
    expect(r.ok).toBe(true);
  });

  it('unknown provider → provider_unknown', () => {
    const r = checkProviderModelCompatibility({ provider: 'wat', model: 'x' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('provider_unknown');
  });

  it('isClaudeModel / isCodexModel helpers', () => {
    expect(isClaudeModel('opus')).toBe(true);
    expect(isClaudeModel('sonnet[1m]')).toBe(true);
    expect(isCodexModel('gpt-5.3-codex')).toBe(true);
    expect(isCodexModel('opus')).toBe(false);
  });

  it('resolveLaunchModel omits incompatible model (codex+opus → undefined)', () => {
    expect(resolveLaunchModel('codex', 'opus')).toBeUndefined();
    expect(resolveLaunchModel('claude', 'opus')).toBe('opus');
    expect(resolveLaunchModel('codex', 'gpt-5.3-codex')).toBe('gpt-5.3-codex');
    expect(resolveLaunchModel('codex', undefined)).toBeUndefined();
  });
});

describe('Phase 6-L — codex launch command never emits opus', () => {
  const codex = new CodexProvider();
  const params = {
    binaryPath: '/usr/bin/codex', prompt: 'hi', model: 'opus',
    verbose: false, permissionMode: 'bypass' as const, skills: [], isSuperAgent: false,
  };

  it('interactive command with model=opus omits --model', () => {
    const cmd = codex.buildInteractiveCommand(params as Parameters<typeof codex.buildInteractiveCommand>[0]);
    expect(cmd).not.toContain('opus');
    expect(cmd).not.toContain('--model');
  });

  it('interactive command keeps a compatible codex model', () => {
    const cmd = codex.buildInteractiveCommand({ ...params, model: 'gpt-5.3-codex' } as Parameters<typeof codex.buildInteractiveCommand>[0]);
    expect(cmd).toContain("--model 'gpt-5.3-codex'");
  });
});

describe('Phase 6-L — registry attaches provider/model compatibility', () => {
  it('configured codex+opus agent → modelCompatibility.ok=false', () => {
    const snap = buildAgentRegistry({
      configuredAgents: [{ id: 'uuid-cost', name: '비용 최적화', provider: 'codex', model: 'opus' }],
      fileAgents: [], sessions: [], scanRoots: [], includeUserDir: false,
    });
    const d = snap.definitions.find(x => x.id === 'uuid-cost')!;
    expect(d.provider).toBe('codex');
    expect(d.model).toBe('opus');
    expect(d.modelCompatibility?.ok).toBe(false);
  });

  it('configured claude+opus agent → modelCompatibility.ok=true', () => {
    const snap = buildAgentRegistry({
      configuredAgents: [{ id: 'uuid-fe', name: 'FE', provider: 'claude', model: 'opus' }],
      fileAgents: [], sessions: [], scanRoots: [], includeUserDir: false,
    });
    const d = snap.definitions.find(x => x.id === 'uuid-fe')!;
    expect(d.modelCompatibility?.ok).toBe(true);
  });
});

describe('Phase 6-L — dispatch readiness provider_model_mismatch', () => {
  const RUN: Run = { id: 'run1', title: 't', source: 'user', priority: 'medium', state: 'running', createdAt: '2026-06-01T00:00:00Z', mode: 'team' };
  const step: RunStep = { id: 'st1', runId: 'run1', order: 0, agentId: 'codexbot', state: 'pending', retryCount: 0 };
  function def(over: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
      id: 'codexbot', displayName: 'codexbot', source: 'configured',
      existsOnDisk: false, hasLiveSession: false, activeSessionCount: 0,
      canSpawn: true, isRegistered: true, isLiveLoaded: true, isSpawnable: true,
      provider: 'codex', model: 'opus',
      modelCompatibility: { ok: false, reason: 'model_not_supported', message: 'Codex cannot use opus' },
      ...over,
    };
  }
  const base = {
    agentIds: ['codexbot'], sessions: [], runs: [RUN], runSteps: [step],
    approvals: [], rateLimitEvents: [], handoffs: [], plans: [],
    autoSpawnEnabled: true, autoResumeMode: 'live' as const,
  };

  it('codex+opus pending step → provider_model_mismatch', () => {
    const [r] = computeDispatchReadiness({ ...base, definitions: [def()] });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('provider_model_mismatch');
  });

  it('compatible agent → ready', () => {
    const [r] = computeDispatchReadiness({
      ...base,
      definitions: [def({ model: 'gpt-5.3-codex', modelCompatibility: { ok: true, reason: 'ok', message: 'ok' } })],
    });
    expect(r.ready).toBe(true);
  });
});

describe('Phase 6-L — process diagrams', () => {
  // Diagram data is frontend-only; import via the source module path.
  it('global diagram contains the required core nodes', async () => {
    const mod = await import('../../../src/components/AgentWorkflowDiagrams/processDefinitions');
    const g = mod.getGlobalDiagram();
    const labels = g.nodes.map(n => n.id);
    for (const id of ['request', 'intake', 'architect', 'orchestrator', 'validator', 'contract', 'database', 'frontend', 'backend', 'qa', 'devops', 'diagnostics', 'skill']) {
      expect(labels).toContain(id);
    }
    expect(g.scope).toBe('global');
  });

  it('each core agent has an agent-scoped diagram with an agentId', async () => {
    const mod = await import('../../../src/components/AgentWorkflowDiagrams/processDefinitions');
    const diagrams = mod.getAgentDiagrams();
    const ids = diagrams.map(d => d.agentId);
    for (const a of ['intake-planner', 'architect-plan', 'plan-validator', 'orchestrator', 'contract-agent', 'database-agent', 'frontend', 'backend', 'qa-reviewer', 'devops-reporter']) {
      expect(ids).toContain(a);
    }
    for (const d of diagrams) {
      expect(d.scope).toBe('agent');
      expect(d.nodes.length).toBeGreaterThan(0);
    }
  });
});
