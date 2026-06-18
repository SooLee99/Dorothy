/**
 * Dorothy MVP Phase 6-I — live spawn verification + reload hardening.
 *
 * Coverage:
 *   reload concurrency      — coalesced result, alreadyInProgress, lock release
 *   metadata merge          — off=unchanged, on=safe fields updated, runtime preserved
 *   spawnable status        — not_registered / not_live_loaded / spawnable / disabled
 *   registration integration— buildAgentRegistry reflects spawnable after live load
 *   E2E mock spawn          — registered file-agent dispatched to startAgent by
 *                             ownerAgentId after reload; pending approval blocks;
 *                             no real Claude / PTY invoked.
 *
 * AGENTS_FILE / DATA_DIR are redirected to a temp dir via vi.mock so the real
 * ~/.dorothy/agents.json is never read or written.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';

const H = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const fsm = require('fs') as typeof import('fs');
  const dataDir = path.join(os.tmpdir(), `dorothy-phase6i-${process.pid}-${Date.now()}`, '.dorothy');
  fsm.mkdirSync(dataDir, { recursive: true });
  return { dataDir, agentsFile: path.join(dataDir, 'agents.json'), tmpHome: path.dirname(dataDir) };
});

vi.mock('../../../electron/constants', async (importActual) => {
  const actual = await importActual<typeof import('../../../electron/constants')>();
  return { ...actual, DATA_DIR: H.dataDir, AGENTS_FILE: H.agentsFile };
});
vi.mock('node-pty', () => ({ spawn: () => ({ onData() {}, onExit() {}, write() {}, kill() {}, resize() {} }) }));

const AGENTS_FILE = H.agentsFile;

import { agents, reloadAgentsFromDisk } from '../../../electron/core/agent-manager';
import { buildAgentRegistry } from '../../../electron/services/dorothy/agent-definition-registry';
import { initDorothyDb, closeDorothyDb } from '../../../electron/services/dorothy/db';
import { createRun, updateRunState } from '../../../electron/services/dorothy/run-service';
import { createPlan } from '../../../electron/services/dorothy/plan-service';
import {
  configureOrchestrator,
  advanceRun,
} from '../../../electron/services/dorothy/orchestrator-service';
import { createApprovalRequest } from '../../../electron/services/dorothy/approval-request-service';
import type { AgentStatus } from '../../../electron/types';

function writeAgents(list: unknown) {
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(list, null, 2));
}
function rec(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id, status: 'idle', projectPath: H.tmpHome, skills: [], output: [], createdAt: '2026-06-01T00:00:00Z', ...extra };
}

beforeEach(() => {
  agents.clear();
  writeAgents([]);
});
afterEach(() => {
  agents.clear();
});

/* ---------------------------------------------------------------- concurrency */

describe('Phase 6-I — reload concurrency guard', () => {
  it('coalesces concurrent reloads (one shares alreadyInProgress, same counts)', async () => {
    writeAgents([rec('frontend'), rec('backend')]);
    const [a, b] = await Promise.all([
      reloadAgentsFromDisk({ reason: 'c1' }),
      reloadAgentsFromDisk({ reason: 'c2' }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.afterCount).toBe(b.afterCount);
    expect([a.alreadyInProgress, b.alreadyInProgress].some(Boolean)).toBe(true);
    expect(agents.size).toBe(2);
  });

  it('a failed reload releases the lock; a subsequent reload succeeds', async () => {
    fs.writeFileSync(AGENTS_FILE, '{ not valid json');
    const failed = await reloadAgentsFromDisk();
    expect(failed.ok).toBe(false);
    // lock must be released — next reload runs for real
    writeAgents([rec('frontend')]);
    const okRes = await reloadAgentsFromDisk();
    expect(okRes.ok).toBe(true);
    expect(okRes.addedAgentIds).toEqual(['frontend']);
  });
});

/* ---------------------------------------------------------------- metadata merge */

describe('Phase 6-I — metadata merge', () => {
  it('mergeMetadataForExisting=false leaves existing metadata unchanged', async () => {
    writeAgents([rec('frontend', { model: 'old' })]);
    await reloadAgentsFromDisk();
    // change metadata on disk
    writeAgents([rec('frontend', { model: 'new' })]);
    const res = await reloadAgentsFromDisk({ mergeMetadataForExisting: false });
    expect(res.ok).toBe(true);
    expect((agents.get('frontend') as AgentStatus & { model?: string }).model).toBe('old');
    expect(res.updatedAgentIds).toBeUndefined();
  });

  it('mergeMetadataForExisting=true updates safe metadata but preserves runtime state', async () => {
    writeAgents([rec('frontend', { model: 'old' })]);
    await reloadAgentsFromDisk();
    // simulate a live running session
    const fe = agents.get('frontend')! as AgentStatus & { model?: string };
    fe.status = 'running';
    fe.ptyId = 'pty-1';
    // disk metadata changes
    writeAgents([rec('frontend', { model: 'new', name: 'Frontend Renamed', status: 'idle' })]);
    const res = await reloadAgentsFromDisk({ mergeMetadataForExisting: true });
    expect(res.ok).toBe(true);
    expect(res.updatedAgentIds).toContain('frontend');
    const after = agents.get('frontend')! as AgentStatus & { model?: string };
    expect(after.model).toBe('new');           // safe metadata updated
    expect(after.name).toBe('Frontend Renamed');
    expect(after.status).toBe('running');       // runtime preserved (not reset to idle)
    expect(after.ptyId).toBe('pty-1');          // runtime preserved
  });
});

/* ---------------------------------------------------------------- spawnable */

describe('Phase 6-I — spawnable status', () => {
  const fileAgent = {
    id: 'qa-reviewer', displayName: 'qa-reviewer', filePath: '/p/.claude/agents/qa-reviewer.md',
    source: 'claude_project_file' as const, roleSummary: 'qa', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  };

  it('file only, not registered → not_registered', () => {
    const snap = buildAgentRegistry({ configuredAgents: [], fileAgents: [fileAgent], sessions: [], scanRoots: [], includeUserDir: false });
    const d = snap.definitions.find(x => x.id === 'qa-reviewer')!;
    expect(d.isRegistered).toBe(false);
    expect(d.isSpawnable).toBe(false);
    expect(d.spawnBlockReason).toBe('not_registered');
  });

  it('registered but not live-loaded → not_live_loaded', () => {
    const snap = buildAgentRegistry({
      configuredAgents: [{ id: 'qa-reviewer', name: 'qa-reviewer', enabled: true }],
      fileAgents: [fileAgent], sessions: [], scanRoots: [], includeUserDir: false,
      liveLoadedAgentIds: [], // not loaded yet
    });
    const d = snap.definitions.find(x => x.id === 'qa-reviewer')!;
    expect(d.isRegistered).toBe(true);
    expect(d.isLiveLoaded).toBe(false);
    expect(d.isSpawnable).toBe(false);
    expect(d.spawnBlockReason).toBe('not_live_loaded');
  });

  it('registered + live-loaded + enabled → spawnable', () => {
    const snap = buildAgentRegistry({
      configuredAgents: [{ id: 'qa-reviewer', name: 'qa-reviewer', enabled: true }],
      fileAgents: [fileAgent], sessions: [], scanRoots: [], includeUserDir: false,
      liveLoadedAgentIds: ['qa-reviewer'],
    });
    const d = snap.definitions.find(x => x.id === 'qa-reviewer')!;
    expect(d.isRegistered).toBe(true);
    expect(d.isLiveLoaded).toBe(true);
    expect(d.isSpawnable).toBe(true);
    expect(d.spawnBlockReason).toBeUndefined();
  });

  it('registered + disabled → disabled', () => {
    const snap = buildAgentRegistry({
      configuredAgents: [{ id: 'qa-reviewer', name: 'qa-reviewer', enabled: false }],
      fileAgents: [fileAgent], sessions: [], scanRoots: [], includeUserDir: false,
      liveLoadedAgentIds: ['qa-reviewer'],
    });
    const d = snap.definitions.find(x => x.id === 'qa-reviewer')!;
    expect(d.isSpawnable).toBe(false);
    expect(d.spawnBlockReason).toBe('disabled');
  });
});

/* ---------------------------------------------------------------- E2E mock spawn */

describe('Phase 6-I — E2E mock spawn (no real Claude/PTY)', () => {
  let dbPath = '';
  beforeEach(() => {
    dbPath = `${H.dataDir}/dorothy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
    const r = initDorothyDb({ filePath: dbPath });
    if (!r.ok) throw new Error(`initDorothyDb failed: ${r.reason}`);
  });
  afterEach(() => {
    closeDorothyDb();
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ } }
    configureOrchestrator({ getLiveAgents: () => [] });
  });

  function liveSlim() {
    return Array.from(agents.values()).map(a => ({
      id: a.id, status: a.status, name: a.name, projectPath: a.projectPath, skills: a.skills,
    }));
  }

  it('registered file agent can be selected by ownerAgentId after live reload', async () => {
    // Register qa-reviewer into agents.json + reload into the live map.
    writeAgents([rec('qa-reviewer')]);
    const reload = await reloadAgentsFromDisk({ reason: 'register' });
    expect(reload.ok).toBe(true);
    expect(agents.has('qa-reviewer')).toBe(true);

    const startSpy = vi.fn().mockResolvedValue(undefined);
    configureOrchestrator({ getLiveAgents: liveSlim, startAgent: startSpy });

    const run = createRun({ title: 'qa run', source: 'user', priority: 'low' })!;
    createPlan({
      runId: run.id, title: 'qa', description: 'qa', state: 'approved',
      tasks: [{ taskId: 'qa', title: 'qa', description: 'qa', ownerAgentId: 'qa-reviewer', dependsOn: [], acceptanceCriteria: ['ok'] }],
    });
    updateRunState(run.id, 'planned');
    updateRunState(run.id, 'approved');

    const out = await advanceRun(run.id);
    expect(out.action).toBe('started_worker_step');
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0][0].agentId).toBe('qa-reviewer');
  });

  it('pending approval blocks dispatch (startAgent not called)', async () => {
    writeAgents([rec('qa-reviewer')]);
    await reloadAgentsFromDisk();
    const startSpy = vi.fn().mockResolvedValue(undefined);
    configureOrchestrator({ getLiveAgents: liveSlim, startAgent: startSpy });

    const run = createRun({ title: 'needs approval', source: 'user', priority: 'high' })!;
    createPlan({
      runId: run.id, title: 'p', description: 'p', state: 'approved',
      tasks: [{ taskId: 'qa', title: 'qa', description: 'qa', ownerAgentId: 'qa-reviewer', dependsOn: [], acceptanceCriteria: ['ok'] }],
    });
    updateRunState(run.id, 'planned');
    // A pending ApprovalRequest keeps the run gated in approval_required.
    createApprovalRequest({ runId: run.id, riskLevel: 'high', state: 'pending' });
    updateRunState(run.id, 'approval_required');

    await advanceRun(run.id);
    expect(startSpy).not.toHaveBeenCalled();
  });
});
