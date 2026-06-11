/**
 * Dorothy MVP Phase 6-K — Claude binary resolution + launch readiness.
 *
 * Coverage:
 *   resolveClaudeBinaryPath — configured / PATH / homebrew / npm_global / none
 *   checkClaudeLaunchReadiness — binary/project/addDir/mcp blockers + suggestion
 *   computeDispatchReadiness — claude_binary_missing + per-agent launch blocker
 *
 * Everything is injected (fsImpl / envPath / homeDir / definitions) — no real
 * filesystem dependency, no startAgent, no PTY, no Claude token.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveClaudeBinaryPath,
} from '../../../electron/core/claude-binary-resolver';
import {
  checkClaudeLaunchReadiness,
  suggestPathCorrection,
} from '../../../electron/core/claude-launch-readiness';
import {
  computeDispatchReadiness,
} from '../../../electron/services/dorothy/agent-dispatch-readiness-service';
import type { AgentDefinition } from '../../../electron/services/dorothy/agent-definition-registry';
import type { Run, RunStep } from '../../../electron/types/dorothy';

/** Build a mock fs that reports a fixed set of existing paths. */
function mockFs(existing: string[]) {
  const set = new Set(existing);
  return {
    existsSync: (p: string) => set.has(p),
    statSync: () => ({ isDirectory: () => false }) as ReturnType<typeof import('fs').statSync>,
    accessSync: () => undefined,
  } as Pick<typeof import('fs'), 'existsSync' | 'statSync' | 'accessSync'>;
}

const HOME = '/Users/soo';

describe('Phase 6-K — resolveClaudeBinaryPath', () => {
  it('uses a valid configured absolute path → configured', () => {
    const cfg = '/custom/bin/claude';
    const r = resolveClaudeBinaryPath({ configuredPath: cfg, envPath: '', homeDir: HOME, fsImpl: mockFs([cfg]) });
    expect(r.ok).toBe(true);
    expect(r.path).toBe(cfg);
    expect(r.source).toBe('configured');
  });

  it('falls back when configured path is invalid', () => {
    const r = resolveClaudeBinaryPath({
      configuredPath: '/bad/claude',
      envPath: '/usr/bin',
      homeDir: HOME,
      fsImpl: mockFs([`${HOME}/.npm-global/bin/claude`]),
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('npm_global');
  });

  it('finds claude on PATH → path', () => {
    const r = resolveClaudeBinaryPath({
      envPath: '/opt/x/bin:/usr/bin',
      homeDir: HOME,
      fsImpl: mockFs(['/usr/bin/claude']),
    });
    expect(r.ok).toBe(true);
    expect(r.path).toBe('/usr/bin/claude');
    expect(r.source).toBe('path');
  });

  it('falls back to /opt/homebrew/bin/claude', () => {
    const r = resolveClaudeBinaryPath({ envPath: '', homeDir: HOME, fsImpl: mockFs(['/opt/homebrew/bin/claude']) });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('homebrew');
  });

  it('finds the real-world ~/.npm-global/bin/claude', () => {
    const r = resolveClaudeBinaryPath({ envPath: '', homeDir: HOME, fsImpl: mockFs([`${HOME}/.npm-global/bin/claude`]) });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('npm_global');
    expect(r.path).toBe(`${HOME}/.npm-global/bin/claude`);
  });

  it('none found → ok false + checkedPaths', () => {
    const r = resolveClaudeBinaryPath({ envPath: '/usr/bin', homeDir: HOME, fsImpl: mockFs([]) });
    expect(r.ok).toBe(false);
    expect(r.checkedPaths.length).toBeGreaterThan(0);
    expect(r.error).toBeTruthy();
  });
});

describe('Phase 6-K — checkClaudeLaunchReadiness', () => {
  const binPath = `${HOME}/.npm-global/bin/claude`;
  const project = `${HOME}/workspace/source-code/triplan`;
  const addDir = `${HOME}/.dorothy`;

  it('ready when binary + project + addDir all exist', () => {
    const r = checkClaudeLaunchReadiness({
      agentId: 'frontend', projectPath: project,
      homeDir: HOME, fsImpl: mockFs([binPath, project, addDir]),
    });
    expect(r.ready).toBe(true);
    expect(r.launchBlockReason).toBeUndefined();
    expect(r.claudeBinary.found).toBe(true);
  });

  it('missing binary → claude_binary_missing', () => {
    const r = checkClaudeLaunchReadiness({
      agentId: 'frontend', projectPath: project,
      homeDir: HOME, fsImpl: mockFs([project, addDir]),
    });
    expect(r.ready).toBe(false);
    expect(r.launchBlockReason).toBe('claude_binary_missing');
  });

  it('missing projectPath → project_path_missing + typo suggestion', () => {
    const typo = `${HOME}/workspace/sourc-code/triplan`;
    const r = checkClaudeLaunchReadiness({
      agentId: 'frontend', projectPath: typo,
      homeDir: HOME, fsImpl: mockFs([binPath, addDir, project]), // real `project` exists, typo doesn't
    });
    expect(r.ready).toBe(false);
    expect(r.launchBlockReason).toBe('project_path_missing');
    expect(r.projectPath.suggestion).toBe(project);
  });

  it('missing add-dir → add_dir_missing', () => {
    const r = checkClaudeLaunchReadiness({
      agentId: 'frontend', projectPath: project,
      homeDir: HOME, fsImpl: mockFs([binPath, project]), // ~/.dorothy absent
    });
    expect(r.ready).toBe(false);
    expect(r.launchBlockReason).toBe('add_dir_missing');
  });

  it('missing required mcp config → mcp_config_missing', () => {
    const r = checkClaudeLaunchReadiness({
      agentId: 'frontend', projectPath: project, mcpConfigPath: '/x/mcp.json', mcpRequired: true,
      homeDir: HOME, fsImpl: mockFs([binPath, project, addDir]),
    });
    expect(r.launchBlockReason).toBe('mcp_config_missing');
  });

  it('suggestPathCorrection maps /sers/ → /Users/ when the corrected path exists', () => {
    const bad = '/sers/soo/.dorothy';
    const good = '/Users/soo/.dorothy';
    expect(suggestPathCorrection(bad, mockFs([good]))).toBe(good);
  });
});

describe('Phase 6-K — dispatch readiness launch blockers', () => {
  const RUN: Run = { id: 'run1', title: 't', source: 'user', priority: 'medium', state: 'running', createdAt: '2026-06-01T00:00:00Z', mode: 'team' };
  const step: RunStep = { id: 'st1', runId: 'run1', order: 0, agentId: 'backend', state: 'pending', retryCount: 0 };
  function def(): AgentDefinition {
    return {
      id: 'backend', displayName: 'backend', source: 'claude_project_file',
      existsOnDisk: true, hasLiveSession: false, activeSessionCount: 0,
      canSpawn: true, isRegistered: true, isLiveLoaded: true, isSpawnable: true,
    };
  }
  const base = {
    agentIds: ['backend'], sessions: [], runs: [RUN], runSteps: [step],
    approvals: [], rateLimitEvents: [], handoffs: [], plans: [],
    autoSpawnEnabled: true, autoResumeMode: 'live' as const, definitions: [def()],
  };

  it('claude binary missing → claude_binary_missing blocker (overrides ready)', () => {
    const [r] = computeDispatchReadiness({ ...base, claudeBinaryMissing: true });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('claude_binary_missing');
  });

  it('per-agent launch block (project_path_missing) applied', () => {
    const [r] = computeDispatchReadiness({
      ...base,
      launchBlockByAgent: new Map([['backend', 'project_path_missing']]),
    });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('project_path_missing');
  });

  it('ready when binary present + no launch block', () => {
    const [r] = computeDispatchReadiness({ ...base });
    expect(r.ready).toBe(true);
  });
});
