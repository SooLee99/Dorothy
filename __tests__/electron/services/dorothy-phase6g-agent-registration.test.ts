/**
 * Dorothy MVP Phase 6-G — Agent Definition manual registration.
 *
 * Coverage:
 *   Preview
 *     - file-based agent preview + proposedAgentRecord
 *     - configured agent → canRegister=false
 *     - missing file → canRegister=false
 *   Register
 *     - append to array-structured agents.json
 *     - append to { agents: [] }-structured agents.json
 *     - never overwrites an existing record
 *     - refuses duplicate registration
 *     - writes a timestamped backup
 *     - unknown structure → failure, original preserved
 *     - dryRun=true → no file write
 *     - no secret/token persisted
 *   HookEvent / Communication
 *     - register emits a system_note HookEvent
 *     - registration shows up on the communication timeline as system → agent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { initDorothyDb, closeDorothyDb } from '../../../electron/services/dorothy/db';
import {
  previewAgentRegistration,
  registerAgentDefinition,
  listRegistrationCandidates,
} from '../../../electron/services/dorothy/agent-registration-service';
import { buildAgentRegistry } from '../../../electron/services/dorothy/agent-definition-registry';
import { listRecentHookEvents } from '../../../electron/services/dorothy/hook-event-service';
import { listRecentCommunication } from '../../../electron/services/dorothy/agent-communication-service';

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase6g-${process.pid}`);
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let dbPath = '';
let projectDir = '';
let agentsFile = '';

const FILE_AGENTS = ['contract-agent', 'database-agent', 'qa-reviewer'];

function makeProject(): string {
  const project = path.join(TEST_DIR, `proj-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const agentsDir = path.join(project, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const id of FILE_AGENTS) {
    fs.writeFileSync(
      path.join(agentsDir, `${id}.md`),
      `---\nname: ${id}\ndescription: ${id} role summary.\n---\n# ${id}\nbody\n`,
    );
  }
  return project;
}

function regOpts() {
  return { configuredAgents: [], sessions: [], extraProjectPaths: [projectDir], includeUserDir: false };
}

function deps(extra: Record<string, unknown> = {}) {
  return { agentsFilePath: agentsFile, registryOptions: regOpts(), ...extra };
}

function readAgents(): unknown {
  return JSON.parse(fs.readFileSync(agentsFile, 'utf-8'));
}

beforeEach(() => {
  dbPath = path.join(TEST_DIR, `db-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const r = initDorothyDb({ filePath: dbPath });
  if (!r.ok) throw new Error(`initDorothyDb failed: ${r.reason}`);
  projectDir = makeProject();
  agentsFile = path.join(TEST_DIR, `agents-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
});

afterEach(() => {
  closeDorothyDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
});

/* ============================================================================
 * Preview
 * ========================================================================== */

describe('Phase 6-G — preview', () => {
  it('builds a preview + proposedAgentRecord for a file-based agent', () => {
    fs.writeFileSync(agentsFile, JSON.stringify([], null, 2));
    const p = previewAgentRegistration('contract-agent', {}, deps());
    expect(p).toBeTruthy();
    expect(p!.canRegister).toBe(true);
    expect(p!.source).toBe('claude_project_file');
    expect(p!.workflowKind).toBe('contract');
    const rec = p!.proposedAgentRecord;
    expect(rec.id).toBe('contract-agent');
    expect(rec.provider).toBe('claude');
    expect(rec.source).toBe('claude_project_file');
    expect(rec.definitionPath).toContain('contract-agent.md');
    expect(rec.enabled).toBe(true);
    expect(rec.createdAt).toBeTruthy();
  });

  it('configured agent preview → canRegister=false', () => {
    fs.writeFileSync(agentsFile, JSON.stringify([], null, 2));
    const p = previewAgentRegistration('uuid-x', {}, {
      agentsFilePath: agentsFile,
      registryOptions: {
        configuredAgents: [{ id: 'uuid-x', name: 'X', roleId: 'backend' }],
        sessions: [], scanRoots: [], includeUserDir: false,
      },
    });
    expect(p!.canRegister).toBe(false);
    expect(p!.source).toBe('configured');
  });

  it('missing definition → preview null', () => {
    fs.writeFileSync(agentsFile, JSON.stringify([], null, 2));
    const p = previewAgentRegistration('does-not-exist', {}, deps());
    expect(p).toBeNull();
  });

  it('listRegistrationCandidates returns only eligible file agents', () => {
    fs.writeFileSync(agentsFile, JSON.stringify([], null, 2));
    const cands = listRegistrationCandidates(deps());
    expect(cands.map(c => c.id).sort()).toEqual([...FILE_AGENTS].sort());
  });
});

/* ============================================================================
 * Register
 * ========================================================================== */

describe('Phase 6-G — register', () => {
  it('appends to an array-structured agents.json + backup', () => {
    fs.writeFileSync(agentsFile, JSON.stringify([{ id: 'existing-1', name: 'E1' }], null, 2));
    const res = registerAgentDefinition('contract-agent', {}, deps());
    expect(res.ok).toBe(true);
    expect(res.backupPath).toBeTruthy();
    expect(fs.existsSync(res.backupPath!)).toBe(true);
    const arr = readAgents() as Array<{ id: string }>;
    expect(arr.map(a => a.id)).toEqual(['existing-1', 'contract-agent']);
  });

  it('appends to an { agents: [] } object structure', () => {
    fs.writeFileSync(agentsFile, JSON.stringify({ version: 1, agents: [{ id: 'e1' }] }, null, 2));
    const res = registerAgentDefinition('database-agent', {}, deps());
    expect(res.ok).toBe(true);
    const obj = readAgents() as { version: number; agents: Array<{ id: string }> };
    expect(obj.version).toBe(1);
    expect(obj.agents.map(a => a.id)).toEqual(['e1', 'database-agent']);
  });

  it('never overwrites an existing record', () => {
    fs.writeFileSync(agentsFile, JSON.stringify([{ id: 'contract-agent', name: 'PRE-EXISTING', custom: 42 }], null, 2));
    const res = registerAgentDefinition('contract-agent', {}, deps());
    expect(res.ok).toBe(false);
    const arr = readAgents() as Array<{ id: string; name: string; custom: number }>;
    expect(arr.length).toBe(1);
    expect(arr[0].name).toBe('PRE-EXISTING');
    expect(arr[0].custom).toBe(42);
  });

  it('refuses duplicate registration (second call)', () => {
    fs.writeFileSync(agentsFile, JSON.stringify([], null, 2));
    const first = registerAgentDefinition('qa-reviewer', {}, deps());
    expect(first.ok).toBe(true);
    const second = registerAgentDefinition('qa-reviewer', {}, deps());
    expect(second.ok).toBe(false);
    const arr = readAgents() as Array<{ id: string }>;
    expect(arr.filter(a => a.id === 'qa-reviewer').length).toBe(1);
  });

  it('unknown structure → failure, original preserved', () => {
    fs.writeFileSync(agentsFile, JSON.stringify({ notAgents: 'weird' }, null, 2));
    const before = fs.readFileSync(agentsFile, 'utf-8');
    const res = registerAgentDefinition('contract-agent', {}, deps());
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(agentsFile, 'utf-8')).toBe(before);
  });

  it('dryRun=true does not modify the file', () => {
    fs.writeFileSync(agentsFile, JSON.stringify([], null, 2));
    const before = fs.readFileSync(agentsFile, 'utf-8');
    const res = registerAgentDefinition('contract-agent', { dryRun: true }, deps());
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.backupPath).toBeNull();
    expect(fs.readFileSync(agentsFile, 'utf-8')).toBe(before);
  });

  it('does not persist secret/token fields', () => {
    fs.writeFileSync(agentsFile, JSON.stringify([], null, 2));
    registerAgentDefinition('contract-agent', { provider: 'claude' }, deps());
    const raw = fs.readFileSync(agentsFile, 'utf-8').toLowerCase();
    for (const s of ['token', 'secret', 'password', 'api_key', 'private_key', 'bearer', 'client_secret', 'access_token']) {
      expect(raw.includes(s)).toBe(false);
    }
  });

  it('after registration the registry shows it linked (configured)', () => {
    fs.writeFileSync(agentsFile, JSON.stringify([], null, 2));
    registerAgentDefinition('contract-agent', {}, deps());
    // Re-scan with the just-written agents.json as the configured source.
    const configured = readAgents() as Array<Record<string, unknown>>;
    const snap = buildAgentRegistry({
      configuredAgents: configured,
      sessions: [],
      extraProjectPaths: [projectDir],
      includeUserDir: false,
    });
    const def = snap.definitions.find(d => d.id === 'contract-agent');
    expect(def).toBeTruthy();
    expect(def!.configuredAgentId).toBe('contract-agent');
    expect(def!.canSpawn).toBe(true);
    expect(def!.existsOnDisk).toBe(true); // file linkage retained
  });
});

/* ============================================================================
 * HookEvent / Communication
 * ========================================================================== */

describe('Phase 6-G — timeline', () => {
  it('emits a system_note HookEvent on register', () => {
    fs.writeFileSync(agentsFile, JSON.stringify([], null, 2));
    const res = registerAgentDefinition('contract-agent', {}, deps());
    expect(res.ok).toBe(true);
    expect(res.hookEventId).toBeTruthy();
    const events = listRecentHookEvents({ limit: 20 });
    const ev = events.find(e => e.id === res.hookEventId);
    expect(ev).toBeTruthy();
    expect(ev!.type).toBe('system_note');
    expect((ev!.metadata as Record<string, unknown>).kind).toBe('agent_definition_registered');
    expect(ev!.agentId).toBe('contract-agent');
  });

  it('registration appears on the communication timeline as system → agent', () => {
    fs.writeFileSync(agentsFile, JSON.stringify([], null, 2));
    registerAgentDefinition('database-agent', {}, deps());
    const comms = listRecentCommunication({ limit: 50 });
    const reg = comms.find(c => c.toAgentId === 'database-agent' && c.fromAgentId === 'system');
    expect(reg).toBeTruthy();
    expect(reg!.type).toBe('comment');
  });
});
