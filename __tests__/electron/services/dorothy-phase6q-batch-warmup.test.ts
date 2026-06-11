/**
 * Dorothy MVP Phase 6-Q — batch warm-up target selection + Codex normalization.
 *
 * Pure / injected — no startAgent (start is the IPC layer's job via the
 * internal adapter), no PTY, no token.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  listWarmupTargets,
  buildWarmupPrompt,
  WARMUP_PROMPT_BASE,
  previewCodexModelNormalization,
  normalizeCodexModels,
} from '../../../electron/services/dorothy/agent-warmup-service';
import type { AgentDefinition } from '../../../electron/services/dorothy/agent-definition-registry';

function def(id: string, over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id, displayName: id, source: 'configured',
    existsOnDisk: true, hasLiveSession: false, activeSessionCount: 0,
    canSpawn: true, isRegistered: true, isLiveLoaded: true, isSpawnable: true,
    provider: 'claude',
    ...over,
  };
}

describe('Phase 6-Q — warm-up target selection', () => {
  it('spawnable claude agent → canWarmup true', () => {
    const [t] = listWarmupTargets({ agentIds: ['backend'], definitions: [def('backend')], liveAgents: [] });
    expect(t.canWarmup).toBe(true);
  });

  it('already running → skipped', () => {
    const [t] = listWarmupTargets({ agentIds: ['backend'], definitions: [def('backend')], liveAgents: [{ id: 'backend', status: 'running' }] });
    expect(t.canWarmup).toBe(false);
    expect(t.alreadyRunning).toBe(true);
    expect(t.reason).toContain('running');
  });

  it('provider/model mismatch → skipped', () => {
    const [t] = listWarmupTargets({
      agentIds: ['codexbot'],
      definitions: [def('codexbot', { provider: 'codex', model: 'opus', isSpawnable: false, modelCompatibility: { ok: false, reason: 'model_not_supported', message: 'x' } })],
      liveAgents: [],
    });
    expect(t.canWarmup).toBe(false);
    expect(t.reason).toContain('mismatch');
  });

  it('not live-loaded → skipped', () => {
    const [t] = listWarmupTargets({ agentIds: ['x'], definitions: [def('x', { isLiveLoaded: false, isSpawnable: false })], liveAgents: [] });
    expect(t.canWarmup).toBe(false);
    expect(t.reason).toContain('live-loaded');
  });

  it('disabled → skipped', () => {
    const [t] = listWarmupTargets({ agentIds: ['x'], definitions: [def('x', { enabled: false })], liveAgents: [] });
    expect(t.canWarmup).toBe(false);
    expect(t.reason).toContain('disabled');
  });

  it('default roster is the 8 process agents', () => {
    const targets = listWarmupTargets({ definitions: [], liveAgents: [] });
    expect(targets.map(t => t.agentId)).toEqual([
      'intake-planner', 'architect-plan', 'orchestrator', 'plan-validator',
      'contract-agent', 'database-agent', 'qa-reviewer', 'devops-reporter',
    ]);
  });
});

describe('Phase 6-Q — warm-up prompt', () => {
  it('is file-modification-free + ends with WARMUP_READY', () => {
    const p = buildWarmupPrompt('backend');
    expect(p).toContain('Do not modify files');
    expect(p).toContain('WARMUP_READY: true');
    expect(WARMUP_PROMPT_BASE).toContain('Do not edit agent definitions or skills');
  });

  it('includes role context for known agents', () => {
    expect(buildWarmupPrompt('backend')).toContain('백엔드 개발 에이전트');
    expect(buildWarmupPrompt('contract-agent')).toContain('api-contract.md');
  });
});

describe('Phase 6-Q — Codex model normalization', () => {
  const TMP = path.join(os.tmpdir(), `dorothy-phase6q-${process.pid}`);
  let file = '';
  beforeEach(() => {
    fs.mkdirSync(TMP, { recursive: true });
    file = path.join(TMP, `agents-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  });
  afterEach(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

  const data = () => ([
    { id: 'cost', name: '비용', provider: 'codex', model: 'opus' },
    { id: 'qa', name: 'QA', provider: 'codex', model: 'opus' },
    { id: 'be', name: 'BE', provider: 'claude', model: 'opus' },     // claude — must NOT change
    { id: 'noModel', name: 'NM', provider: 'codex' },                 // codex no model — unchanged
  ]);

  it('preview finds only codex + claude-family-model agents', () => {
    fs.writeFileSync(file, JSON.stringify(data(), null, 2));
    const p = previewCodexModelNormalization(file);
    expect(p.structure).toBe('array');
    expect(p.targets.map(t => t.id).sort()).toEqual(['cost', 'qa']);
  });

  it('normalize removes only the model field on codex agents + backup', () => {
    fs.writeFileSync(file, JSON.stringify(data(), null, 2));
    const res = normalizeCodexModels({ agentsFilePath: file });
    expect(res.ok).toBe(true);
    expect(res.changedAgentIds.sort()).toEqual(['cost', 'qa']);
    expect(res.backupPath && fs.existsSync(res.backupPath)).toBe(true);
    const after = JSON.parse(fs.readFileSync(file, 'utf-8')) as Array<Record<string, unknown>>;
    const cost = after.find(a => a.id === 'cost')!;
    expect('model' in cost).toBe(false);       // model removed
    expect(cost.provider).toBe('codex');       // provider unchanged
    const be = after.find(a => a.id === 'be')!;
    expect(be.model).toBe('opus');             // claude agent untouched
    const nm = after.find(a => a.id === 'noModel')!;
    expect(nm.provider).toBe('codex');         // untouched
  });

  it('no-op when no codex+opus agents (no backup, ok)', () => {
    fs.writeFileSync(file, JSON.stringify([{ id: 'be', provider: 'claude', model: 'opus' }], null, 2));
    const res = normalizeCodexModels({ agentsFilePath: file });
    expect(res.ok).toBe(true);
    expect(res.changedAgentIds).toEqual([]);
    expect(res.backupPath).toBeNull();
  });

  it('unknown structure → not modified', () => {
    fs.writeFileSync(file, JSON.stringify({ weird: true }, null, 2));
    const before = fs.readFileSync(file, 'utf-8');
    const res = normalizeCodexModels({ agentsFilePath: file });
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });
});
