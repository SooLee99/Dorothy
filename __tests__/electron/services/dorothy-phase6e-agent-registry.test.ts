/**
 * Dorothy MVP Phase 6-E — Agent Definition Registry + Idle Reason + Communication.
 *
 * Coverage:
 *   Agent Definition Registry
 *     - scans .claude/agents/*.md from disk (real temp dir)
 *     - detects contract-agent / database-agent + MVP new agents
 *     - merges agents.json configured agents
 *     - merges live AgentSessions (active count, hasLiveSession)
 *     - missing-definition warning (session without file)
 *     - canSpawn computation (configured vs file-only)
 *     - graceful on unreadable dir
 *     - extractRoleSummary frontmatter + heading fallback
 *   Idle Reason
 *     - active session → active
 *     - no assigned runstep → no_assigned_runstep
 *     - pending approval → waiting_for_approval
 *     - rate limit scheduled → blocked_by_rate_limit / auto_resume_dry_run
 *     - pipeline policy limit → blocked_by_runmode_policy
 *     - dependency incomplete → waiting_for_dependency
 *     - autospawn disabled → orchestrator_autospawn_disabled
 *   Communication
 *     - handoff / artifact / hook event / diagnostic / approval → events
 *     - listByRun / listByAgent
 *     - sensitive value masking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { initDorothyDb, closeDorothyDb } from '../../../electron/services/dorothy/db';
import { createRun, createRunStep } from '../../../electron/services/dorothy/run-service';
import { createAgentSession } from '../../../electron/services/dorothy/agent-session-service';
import { createArtifact, createHandoff } from '../../../electron/services/dorothy/artifact-service';
import {
  buildAgentRegistry,
  extractRoleSummary,
  normalizeAgentKey,
} from '../../../electron/services/dorothy/agent-definition-registry';
import {
  computeIdleStatuses,
} from '../../../electron/services/dorothy/agent-idle-reason-service';
import {
  listCommunicationByRun,
  listCommunicationByAgent,
} from '../../../electron/services/dorothy/agent-communication-service';
import type {
  AgentSession,
  Run,
  RunStep,
  ApprovalRequest,
  RateLimitEvent,
  Handoff,
  Artifact,
  HookEvent,
  Diagnostic,
} from '../../../electron/types/dorothy';

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase6e-${process.pid}`);
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let dbPath = '';

beforeEach(() => {
  dbPath = path.join(TEST_DIR, `dorothy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const r = initDorothyDb({ filePath: dbPath });
  if (!r.ok) throw new Error(`initDorothyDb failed: ${r.reason}`);
});

afterEach(() => {
  closeDorothyDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
});

/* ----------------------------------------------------------------- helpers */

const NEW_AGENTS = [
  'intake-planner', 'architect-plan', 'orchestrator', 'plan-validator',
  'qa-reviewer', 'devops-reporter', 'contract-agent', 'database-agent',
];

function makeAgentDir(): string {
  const project = path.join(TEST_DIR, `proj-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const agentsDir = path.join(project, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const id of NEW_AGENTS) {
    fs.writeFileSync(
      path.join(agentsDir, `${id}.md`),
      `---\nname: ${id}\ndescription: ${id} role summary line.\n---\n\n# ${id}\n\nBody text.\n`,
    );
  }
  return project;
}

/* ============================================================================
 * Agent Definition Registry
 * ========================================================================== */

describe('Phase 6-E — Agent Definition Registry', () => {
  it('scans .claude/agents/*.md from disk and detects all MVP new agents', () => {
    const project = makeAgentDir();
    const snap = buildAgentRegistry({
      configuredAgents: [],
      sessions: [],
      extraProjectPaths: [project],
      includeUserDir: false,
    });
    const ids = snap.definitions.map(d => d.id).sort();
    for (const id of NEW_AGENTS) expect(ids).toContain(id);
    expect(ids).toContain('contract-agent');
    expect(ids).toContain('database-agent');
    expect(snap.fileCount).toBe(NEW_AGENTS.length);
  });

  it('extracts roleSummary + resolves workflowKind for contract/database agents', () => {
    const project = makeAgentDir();
    const snap = buildAgentRegistry({
      configuredAgents: [],
      sessions: [],
      extraProjectPaths: [project],
      includeUserDir: false,
    });
    const contract = snap.definitions.find(d => d.id === 'contract-agent');
    const database = snap.definitions.find(d => d.id === 'database-agent');
    expect(contract?.roleSummary).toContain('contract-agent role summary');
    expect(contract?.workflowKind).toBe('contract');
    expect(database?.workflowKind).toBe('database');
    expect(contract?.source).toBe('claude_project_file');
    expect(contract?.existsOnDisk).toBe(true);
    expect(contract?.canSpawn).toBe(false); // file present but not in agents.json
  });

  it('merges agents.json configured agents (canSpawn true)', () => {
    const snap = buildAgentRegistry({
      configuredAgents: [
        { id: 'uuid-1', name: '백엔드 개발자', projectPath: '/x', roleId: 'backend' },
      ],
      fileAgents: [],
      sessions: [],
      includeUserDir: false,
      scanRoots: [],
    });
    const cfg = snap.definitions.find(d => d.id === 'uuid-1');
    expect(cfg).toBeTruthy();
    expect(cfg?.source).toBe('configured');
    expect(cfg?.displayName).toBe('백엔드 개발자');
    expect(cfg?.canSpawn).toBe(true);
    expect(cfg?.workflowKind).toBe('backend');
    expect(snap.configuredCount).toBe(1);
  });

  it('merges live AgentSessions into a matching file definition', () => {
    const project = makeAgentDir();
    const sessions: AgentSession[] = [
      { id: 's1', agentId: 'qa-reviewer', provider: 'claude', startedAt: '2026-06-01T00:00:00Z', exitedAt: null },
      { id: 's2', agentId: 'qa-reviewer', provider: 'claude', startedAt: '2026-06-01T01:00:00Z', exitedAt: '2026-06-01T02:00:00Z' },
    ];
    const snap = buildAgentRegistry({
      configuredAgents: [],
      sessions,
      extraProjectPaths: [project],
      includeUserDir: false,
    });
    const qa = snap.definitions.find(d => d.id === 'qa-reviewer');
    expect(qa?.hasLiveSession).toBe(true);
    expect(qa?.activeSessionCount).toBe(1);
    expect(qa?.lastSessionAt).toBe('2026-06-01T01:00:00Z');
  });

  it('flags a session with no definition file (session_without_definition)', () => {
    const snap = buildAgentRegistry({
      configuredAgents: [],
      fileAgents: [],
      sessions: [
        { id: 's1', agentId: 'mystery-agent', provider: 'claude', startedAt: '2026-06-01T00:00:00Z', exitedAt: null },
      ],
      includeUserDir: false,
      scanRoots: [],
    });
    const mystery = snap.definitions.find(d => d.id === 'mystery-agent');
    expect(mystery?.source).toBe('live_session');
    expect(mystery?.existsOnDisk).toBe(false);
    expect(mystery?.canSpawn).toBe(false);
    expect(snap.warnings.some(w => w.kind === 'session_without_definition' && w.agentId === 'mystery-agent')).toBe(true);
  });

  it('emits definition_file_not_configured warning for file-only agents', () => {
    const project = makeAgentDir();
    const snap = buildAgentRegistry({
      configuredAgents: [],
      sessions: [],
      extraProjectPaths: [project],
      includeUserDir: false,
    });
    expect(snap.warnings.some(w => w.kind === 'definition_file_not_configured' && w.agentId === 'contract-agent')).toBe(true);
  });

  it('degrades gracefully on an unreadable / missing dir', () => {
    const snap = buildAgentRegistry({
      configuredAgents: [],
      sessions: [],
      extraProjectPaths: ['/nonexistent/path/zzz'],
      includeUserDir: false,
    });
    expect(snap.definitions).toEqual([]);
    expect(snap.fileCount).toBe(0);
  });

  it('extractRoleSummary prefers frontmatter description, falls back to heading', () => {
    expect(extractRoleSummary('---\ndescription: hello world\n---\n# Title\nbody')).toBe('hello world');
    expect(extractRoleSummary('# Only Heading\n\nparagraph')).toBe('Only Heading');
    expect(extractRoleSummary('')).toBeUndefined();
  });

  it('normalizeAgentKey collapses separators', () => {
    expect(normalizeAgentKey('qa-reviewer')).toBe('qa_reviewer');
    expect(normalizeAgentKey('QA.Reviewer')).toBe('qa_reviewer');
    expect(normalizeAgentKey(undefined)).toBe('');
  });
});

/* ============================================================================
 * Idle Reason
 * ========================================================================== */

describe('Phase 6-E — Agent Idle Reason', () => {
  const baseRun: Run = {
    id: 'run1', title: 't', source: 'user', priority: 'medium',
    state: 'running', createdAt: '2026-06-01T00:00:00Z', mode: 'team',
  };

  it('active session → active', () => {
    const statuses = computeIdleStatuses({
      agentIds: ['backend'],
      sessions: [{ id: 's1', agentId: 'backend', provider: 'claude', startedAt: '2026-06-01T00:00:00Z', exitedAt: null }],
      runs: [], runSteps: [], approvals: [], rateLimitEvents: [], handoffs: [], plans: [],
      autoSpawnEnabled: true, autoResumeMode: 'live',
    });
    expect(statuses[0].reason).toBe('active');
  });

  it('no assigned runstep → no_assigned_runstep', () => {
    const statuses = computeIdleStatuses({
      agentIds: ['backend'],
      sessions: [], runs: [], runSteps: [], approvals: [], rateLimitEvents: [], handoffs: [], plans: [],
      autoSpawnEnabled: true, autoResumeMode: 'live',
    });
    expect(statuses[0].reason).toBe('no_assigned_runstep');
  });

  it('pending approval on the run → waiting_for_approval', () => {
    const step: RunStep = { id: 'st1', runId: 'run1', order: 0, agentId: 'backend', state: 'pending', retryCount: 0 };
    const approval: ApprovalRequest = {
      id: 'a1', runId: 'run1', riskLevel: 'high', state: 'pending', createdAt: '2026-06-01T00:00:00Z', attachedArtifactIds: [] as never,
    } as ApprovalRequest;
    const statuses = computeIdleStatuses({
      agentIds: ['backend'], sessions: [], runs: [baseRun], runSteps: [step],
      approvals: [approval], rateLimitEvents: [], handoffs: [], plans: [],
      autoSpawnEnabled: true, autoResumeMode: 'live',
    });
    expect(statuses[0].reason).toBe('waiting_for_approval');
  });

  it('scheduled rate limit (live) → blocked_by_rate_limit', () => {
    const step: RunStep = { id: 'st1', runId: 'run1', order: 0, agentId: 'backend', state: 'pending', retryCount: 0 };
    const rl: RateLimitEvent = {
      id: 'rl1', engine: 'claude', detectedAt: '2026-06-01T00:00:00Z', source: 'usage_scan', affectedRunIds: ['run1'],
    } as RateLimitEvent;
    const statuses = computeIdleStatuses({
      agentIds: ['backend'], sessions: [], runs: [baseRun], runSteps: [step],
      approvals: [], rateLimitEvents: [rl], handoffs: [], plans: [],
      autoSpawnEnabled: true, autoResumeMode: 'live',
    });
    expect(statuses[0].reason).toBe('blocked_by_rate_limit');
  });

  it('scheduled rate limit (dry-run) → auto_resume_dry_run', () => {
    const rl: RateLimitEvent = {
      id: 'rl1', engine: 'claude', detectedAt: '2026-06-01T00:00:00Z', source: 'usage_scan',
    } as RateLimitEvent;
    const statuses = computeIdleStatuses({
      agentIds: ['backend'], sessions: [], runs: [], runSteps: [],
      approvals: [], rateLimitEvents: [rl], handoffs: [], plans: [],
      autoSpawnEnabled: true, autoResumeMode: 'dry-run',
    });
    expect(statuses[0].reason).toBe('auto_resume_dry_run');
  });

  it('pipeline mode with a parallel running sibling → blocked_by_runmode_policy', () => {
    const run: Run = { ...baseRun, mode: 'pipeline' };
    // Both steps at order 0 (no dependency between them); a sibling is running
    // while pipeline mode forbids parallelism.
    const steps: RunStep[] = [
      { id: 'st0', runId: 'run1', order: 0, agentId: 'frontend', state: 'running', retryCount: 0 },
      { id: 'st1', runId: 'run1', order: 0, agentId: 'backend', state: 'pending', retryCount: 0 },
    ];
    const statuses = computeIdleStatuses({
      agentIds: ['backend'], sessions: [], runs: [run], runSteps: steps,
      approvals: [], rateLimitEvents: [], handoffs: [], plans: [],
      autoSpawnEnabled: true, autoResumeMode: 'live',
    });
    expect(statuses[0].reason).toBe('blocked_by_runmode_policy');
  });

  it('prior-order step incomplete → waiting_for_dependency', () => {
    const steps: RunStep[] = [
      { id: 'st0', runId: 'run1', order: 0, agentId: 'frontend', state: 'pending', retryCount: 0 },
      { id: 'st1', runId: 'run1', order: 1, agentId: 'backend', state: 'pending', retryCount: 0 },
    ];
    const statuses = computeIdleStatuses({
      agentIds: ['backend'], sessions: [], runs: [baseRun], runSteps: steps,
      approvals: [], rateLimitEvents: [], handoffs: [], plans: [],
      autoSpawnEnabled: true, autoResumeMode: 'live',
    });
    expect(statuses[0].reason).toBe('waiting_for_dependency');
  });

  it('autospawn disabled with a ready step → orchestrator_autospawn_disabled', () => {
    const step: RunStep = { id: 'st1', runId: 'run1', order: 0, agentId: 'backend', state: 'pending', retryCount: 0 };
    const statuses = computeIdleStatuses({
      agentIds: ['backend'], sessions: [], runs: [baseRun], runSteps: [step],
      approvals: [], rateLimitEvents: [], handoffs: [], plans: [],
      autoSpawnEnabled: false, autoResumeMode: 'live',
    });
    expect(statuses[0].reason).toBe('orchestrator_autospawn_disabled');
  });
});

/* ============================================================================
 * Communication
 * ========================================================================== */

describe('Phase 6-E — Agent Communication Timeline', () => {
  it('synthesizes handoff / artifact / diagnostic / approval / hook events', () => {
    const steps: RunStep[] = [
      { id: 'st0', runId: 'run1', order: 0, agentId: 'backend', state: 'completed', retryCount: 0 },
      { id: 'st1', runId: 'run1', order: 1, agentId: 'qa-reviewer', state: 'pending', retryCount: 0 },
    ];
    const handoffs: Handoff[] = [
      { id: 'h1', runId: 'run1', fromRunStepId: 'st0', toRunStepId: 'st1', summary: 'backend done', attachedArtifactIds: [], createdAt: '2026-06-01T03:00:00Z' },
    ];
    const artifacts: Artifact[] = [
      { id: 'a1', runId: 'run1', type: 'patch', producedByAgentId: 'backend', path: 'src/x.ts', createdAt: '2026-06-01T02:00:00Z' },
    ];
    const diagnostics: Diagnostic[] = [
      { id: 'd1', runId: 'run1', source: 'qa_failure', severity: 'high', status: 'open', title: 'fail', summary: 'qa failed', evidenceHookEventIds: [], createdAt: '2026-06-01T01:30:00Z', updatedAt: '2026-06-01T01:30:00Z' },
    ];
    const approvals: ApprovalRequest[] = [
      { id: 'ap1', runId: 'run1', riskLevel: 'high', state: 'pending', topic: 'deploy', createdAt: '2026-06-01T01:00:00Z' } as ApprovalRequest,
    ];
    const hookEvents: HookEvent[] = [
      { id: 'he1', type: 'run_state_changed', severity: 'info', source: 'orchestrator', runId: 'run1', agentId: 'orchestrator', title: 'state moved', createdAt: '2026-06-01T00:30:00Z' } as HookEvent,
    ];
    const events = listCommunicationByRun('run1', {
      steps, handoffs, artifacts, diagnostics, approvals, hookEvents,
    });
    const types = events.map(e => e.type);
    expect(types).toContain('handoff');
    expect(types).toContain('artifact');
    expect(types).toContain('diagnostic');
    expect(types).toContain('approval');
    expect(types).toContain('hook_event');
    // newest first
    expect(events[0].createdAt >= events[events.length - 1].createdAt).toBe(true);
    // handoff resolves from/to agent via steps
    const handoff = events.find(e => e.type === 'handoff');
    expect(handoff?.fromAgentId).toBe('backend');
    expect(handoff?.toAgentId).toBe('qa-reviewer');
  });

  it('dedups a hook event that mirrors an included handoff', () => {
    const steps: RunStep[] = [
      { id: 'st0', runId: 'run1', order: 0, agentId: 'backend', state: 'completed', retryCount: 0 },
      { id: 'st1', runId: 'run1', order: 1, agentId: 'qa', state: 'pending', retryCount: 0 },
    ];
    const handoffs: Handoff[] = [
      { id: 'h1', runId: 'run1', fromRunStepId: 'st0', toRunStepId: 'st1', summary: 's', attachedArtifactIds: [], createdAt: '2026-06-01T03:00:00Z' },
    ];
    const hookEvents: HookEvent[] = [
      { id: 'he1', type: 'handoff_created', severity: 'info', source: 'hook', runId: 'run1', handoffId: 'h1', title: 'handoff', createdAt: '2026-06-01T03:00:01Z' } as HookEvent,
    ];
    const events = listCommunicationByRun('run1', { steps, handoffs, artifacts: [], diagnostics: [], approvals: [], hookEvents });
    expect(events.filter(e => e.handoffId === 'h1').length).toBe(1);
  });

  it('masks sensitive values in summaries', () => {
    const handoffs: Handoff[] = [
      { id: 'h1', runId: 'run1', fromRunStepId: 'st0', toRunStepId: 'st1', summary: 'use access_token=supersecretvalue123 to login', attachedArtifactIds: [], createdAt: '2026-06-01T03:00:00Z' },
    ];
    const events = listCommunicationByRun('run1', {
      steps: [], handoffs, artifacts: [], diagnostics: [], approvals: [], hookEvents: [],
    });
    const handoff = events.find(e => e.type === 'handoff');
    expect(handoff?.summary).toContain('access_token=***');
    expect(handoff?.summary).not.toContain('supersecretvalue123');
  });

  it('listByAgent filters to events involving the agent', () => {
    const steps: RunStep[] = [
      { id: 'st0', runId: 'run1', order: 0, agentId: 'backend', state: 'completed', retryCount: 0 },
      { id: 'st1', runId: 'run1', order: 1, agentId: 'qa-reviewer', state: 'pending', retryCount: 0 },
    ];
    const handoffs: Handoff[] = [
      { id: 'h1', runId: 'run1', fromRunStepId: 'st0', toRunStepId: 'st1', summary: 's', attachedArtifactIds: [], createdAt: '2026-06-01T03:00:00Z' },
    ];
    // build via run scan injection is not available for listByAgent; use DB path instead.
    // Here we directly validate the run-level events filter logic.
    const all = listCommunicationByRun('run1', { steps, handoffs, artifacts: [], diagnostics: [], approvals: [], hookEvents: [] });
    const backendEvents = all.filter(e => e.fromAgentId === 'backend' || e.toAgentId === 'backend');
    expect(backendEvents.length).toBe(1);
  });

  it('DB-backed listByRun + listByAgent round trip', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    const s0 = createRunStep({ runId: run.id, order: 0, agentId: 'backend' })!;
    const s1 = createRunStep({ runId: run.id, order: 1, agentId: 'qa-reviewer' })!;
    createArtifact({ runId: run.id, runStepId: s0.id, type: 'patch', producedByAgentId: 'backend', path: 'a.ts' });
    createHandoff({ runId: run.id, fromRunStepId: s0.id, toRunStepId: s1.id, summary: 'done' });
    createAgentSession({ runId: run.id, runStepId: s0.id, agentId: 'backend', provider: 'claude' });

    const byRun = listCommunicationByRun(run.id, { limit: 100 });
    expect(byRun.some(e => e.type === 'handoff')).toBe(true);
    expect(byRun.some(e => e.type === 'artifact')).toBe(true);

    const byAgent = listCommunicationByAgent('backend', { runIds: [run.id], limit: 100 });
    expect(byAgent.length).toBeGreaterThan(0);
    expect(byAgent.every(e => e.fromAgentId === 'backend' || e.toAgentId === 'backend')).toBe(true);
  });

  it('registry merges DB-backed live sessions', () => {
    const run = createRun({ title: 'r', source: 'user' })!;
    createAgentSession({ runId: run.id, agentId: 'backend', provider: 'claude' });
    const snap = buildAgentRegistry({
      configuredAgents: [{ id: 'uuid-be', name: 'BE', projectPath: '/x', roleId: 'backend' }],
      includeUserDir: false,
      scanRoots: [],
    });
    // live "backend" session has no file/config key match (configured id is uuid),
    // so it appears as a live_session entry.
    expect(snap.definitions.some(d => normalizeAgentKey(d.id) === 'backend' && d.hasLiveSession)).toBe(true);
  });
});
