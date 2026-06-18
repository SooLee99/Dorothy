/**
 * Dorothy MVP Phase 6-H — agent-manager reload + live registry refresh.
 *
 * Coverage:
 *   reloadAgentsFromDisk
 *     - appending to agents.json then reloading raises the in-memory count
 *     - addedAgentIds reflects only the new records
 *     - existing in-memory agents (incl. a live/running one) are preserved
 *     - removed-from-disk agents are NOT killed; reported as warning + id
 *     - invalid JSON / unknown structure → ok:false, map untouched
 *     - saveAgents() after reload persists the newly-added agent (no clobber)
 *   integration shape
 *     - reload result envelope fields
 *
 * agents.json is redirected to a temp file by pointing HOME at an isolated dir
 * BEFORE importing the agent-manager module (AGENTS_FILE is computed from HOME
 * at import time in constants.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';

// Redirect AGENTS_FILE / DATA_DIR to an isolated temp dir BEFORE the module
// graph loads. vi.hoisted + vi.mock are hoisted above the imports, so the real
// ~/.dorothy/agents.json is never read or written by this test.
const H = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const fsm = require('fs') as typeof import('fs');
  const dataDir = path.join(os.tmpdir(), `dorothy-phase6h-${process.pid}-${Date.now()}`, '.dorothy');
  fsm.mkdirSync(dataDir, { recursive: true });
  return { dataDir, agentsFile: path.join(dataDir, 'agents.json'), tmpHome: path.dirname(dataDir) };
});

vi.mock('../../../electron/constants', async (importActual) => {
  const actual = await importActual<typeof import('../../../electron/constants')>();
  return { ...actual, DATA_DIR: H.dataDir, AGENTS_FILE: H.agentsFile };
});

// node-pty is a native dep the agent-manager imports; stub it so the module
// loads under vitest without the prebuilt binary.
vi.mock('node-pty', () => ({ spawn: () => ({ onData() {}, onExit() {}, write() {}, kill() {}, resize() {} }) }));

const AGENTS_FILE = H.agentsFile;

import { agents, loadAgents, saveAgents, reloadAgentsFromDisk } from '../../../electron/core/agent-manager';

function writeAgents(list: unknown) {
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(list, null, 2));
}

function baseAgent(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    status: 'idle',
    projectPath: H.tmpHome, // exists, so pathMissing=false
    skills: [],
    output: [],
    createdAt: '2026-06-01T00:00:00Z',
    ...extra,
  };
}

beforeEach(() => {
  agents.clear();
  writeAgents([baseAgent('frontend'), baseAgent('backend')]);
  loadAgents();
});

afterEach(() => {
  agents.clear();
});


describe('Phase 6-H — reloadAgentsFromDisk', () => {
  it('raises in-memory count after an append and reports addedAgentIds', async () => {
    expect(agents.size).toBe(2);
    writeAgents([baseAgent('frontend'), baseAgent('backend'), baseAgent('contract-agent')]);
    const res = await reloadAgentsFromDisk({ reason: 'test' });
    expect(res.ok).toBe(true);
    expect(res.beforeCount).toBe(2);
    expect(res.afterCount).toBe(3);
    expect(res.addedAgentIds).toEqual(['contract-agent']);
    expect(agents.has('contract-agent')).toBe(true);
  });

  it('preserves an existing running agent (status + ptyId untouched)', async () => {
    // Simulate a live session on an existing agent.
    const fe = agents.get('frontend')!;
    fe.status = 'running';
    fe.ptyId = 'pty-123';
    writeAgents([baseAgent('frontend'), baseAgent('backend'), baseAgent('database-agent')]);

    const res = await reloadAgentsFromDisk({ reason: 'test' });
    expect(res.ok).toBe(true);
    // running agent must be untouched, not reset to idle by the reload
    const after = agents.get('frontend')!;
    expect(after.status).toBe('running');
    expect(after.ptyId).toBe('pty-123');
    expect(res.preservedActiveSessionIds).toContain('frontend');
    expect(res.addedAgentIds).toEqual(['database-agent']);
  });

  it('does NOT kill / remove an agent that vanished from disk; warns instead', async () => {
    // backend dropped from disk, but it's running in memory.
    const be = agents.get('backend')!;
    be.status = 'running';
    be.ptyId = 'pty-be';
    writeAgents([baseAgent('frontend')]);

    const res = await reloadAgentsFromDisk({ reason: 'test' });
    expect(res.ok).toBe(true);
    expect(res.removedAgentIds).toContain('backend');
    // still present in memory (not killed)
    expect(agents.has('backend')).toBe(true);
    expect(agents.get('backend')!.status).toBe('running');
    expect(res.warnings && res.warnings.length).toBeGreaterThan(0);
  });

  it('invalid JSON → ok:false, in-memory map untouched', async () => {
    fs.writeFileSync(AGENTS_FILE, '{ this is not json');
    const before = agents.size;
    const res = await reloadAgentsFromDisk();
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(agents.size).toBe(before);
  });

  it('unknown structure → ok:false, map untouched', async () => {
    writeAgents({ notAgents: true });
    const before = agents.size;
    const res = await reloadAgentsFromDisk();
    expect(res.ok).toBe(false);
    expect(agents.size).toBe(before);
  });

  it('tolerates an { agents: [] } wrapper structure', async () => {
    writeAgents({ agents: [baseAgent('frontend'), baseAgent('backend'), baseAgent('qa-reviewer')] });
    const res = await reloadAgentsFromDisk();
    expect(res.ok).toBe(true);
    expect(res.addedAgentIds).toEqual(['qa-reviewer']);
  });

  it('saveAgents() after reload persists the newly-added agent (no clobber)', async () => {
    writeAgents([baseAgent('frontend'), baseAgent('backend'), baseAgent('contract-agent')]);
    await reloadAgentsFromDisk({ reason: 'test' });
    // Now the live map has 3 agents; saveAgents must write all 3 back.
    saveAgents();
    const onDisk = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8')) as Array<{ id: string }>;
    expect(onDisk.map(a => a.id).sort()).toEqual(['backend', 'contract-agent', 'frontend']);
  });

  it('returns the full result envelope shape', async () => {
    writeAgents([baseAgent('frontend'), baseAgent('backend'), baseAgent('orchestrator')]);
    const res = await reloadAgentsFromDisk();
    expect(res).toHaveProperty('ok');
    expect(res).toHaveProperty('beforeCount');
    expect(res).toHaveProperty('afterCount');
    expect(res).toHaveProperty('addedAgentIds');
    expect(res).toHaveProperty('removedAgentIds');
    expect(res).toHaveProperty('preservedActiveSessionIds');
  });
});
