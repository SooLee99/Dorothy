/**
 * Phase 6-AE — AgentTerminalSnapshot model + builder.
 *
 * Verifies the read-only, masked snapshot contract used by the dashboard:
 *   - undefined output → outputLines []
 *   - secrets/tokens masked in outputLines + preview
 *   - hasPty / streamAvailable derived from ptyId + status
 *   - inputEnabled is ALWAYS false (MVP)
 *   - buildBaselineSnapshots returns exactly the 11 operation agents
 *   - legacy UUID + codex/opus / ad-hoc ids are excluded
 *   - unknown baseline agent → safe placeholder (status 'unknown', no terminal)
 */

import { describe, it, expect } from 'vitest';
import {
  buildAgentTerminalSnapshot,
  buildBaselineSnapshots,
} from '../../src/lib/agentTerminalSnapshot';
import { ALL_OPERATION_AGENT_IDS } from '../../src/lib/agentProcessDisplay';

const AT = '2026-06-07T00:00:00.000Z';

describe('buildAgentTerminalSnapshot', () => {
  it('returns outputLines [] when the agent has no output', () => {
    const snap = buildAgentTerminalSnapshot('orchestrator', undefined, AT);
    expect(snap.outputLines).toEqual([]);
    expect(snap.outputPreview).toBe('');
    expect(snap.status).toBe('unknown');
    expect(snap.hasPty).toBe(false);
    expect(snap.streamAvailable).toBe(false);
  });

  it('always sets inputEnabled=false and masked=true', () => {
    const snap = buildAgentTerminalSnapshot('backend', { id: 'backend', status: 'running', ptyId: 'pty-1', output: ['hello\n'] }, AT);
    expect(snap.inputEnabled).toBe(false);
    expect(snap.masked).toBe(true);
  });

  it('masks secrets/tokens in outputLines and preview', () => {
    const agent = {
      id: 'qa-reviewer',
      status: 'running',
      ptyId: 'pty-2',
      output: ['Authorization: Bearer sk-abc123SECRET\n', 'api_key=supersecretvalue\n', 'normal line\n'],
    };
    const snap = buildAgentTerminalSnapshot('qa-reviewer', agent, AT);
    const joined = snap.outputLines.join('\n');
    expect(joined).not.toContain('sk-abc123SECRET');
    expect(joined).not.toContain('supersecretvalue');
    expect(joined).toContain('[REDACTED]');
    expect(snap.outputPreview).not.toContain('supersecretvalue');
  });

  it('derives hasPty + streamAvailable from ptyId/status', () => {
    const withPty = buildAgentTerminalSnapshot('frontend', { id: 'frontend', status: 'idle', ptyId: 'pty-x', output: ['x\n'] }, AT);
    expect(withPty.hasPty).toBe(true);
    expect(withPty.streamAvailable).toBe(true); // ptyId present

    const runningNoPty = buildAgentTerminalSnapshot('frontend', { id: 'frontend', status: 'running', output: ['x\n'] }, AT);
    expect(runningNoPty.hasPty).toBe(false);
    expect(runningNoPty.streamAvailable).toBe(true); // active status

    const idleNoPty = buildAgentTerminalSnapshot('frontend', { id: 'frontend', status: 'idle', output: ['x\n'] }, AT);
    expect(idleNoPty.hasPty).toBe(false);
    expect(idleNoPty.streamAvailable).toBe(false);
  });

  it('shows outputLines when a live PTY has output', () => {
    const snap = buildAgentTerminalSnapshot('intake-planner', { id: 'intake-planner', status: 'running', ptyId: 'p', output: ['line one\nline two\n'] }, AT);
    expect(snap.outputLines).toContain('line one');
    expect(snap.outputLines).toContain('line two');
  });
});

describe('buildBaselineSnapshots', () => {
  it('returns exactly the 11 baseline operation agents', () => {
    const snaps = buildBaselineSnapshots([], AT);
    expect(snaps).toHaveLength(11);
    expect(snaps.map(s => s.agentId).sort()).toEqual([...ALL_OPERATION_AGENT_IDS].sort());
  });

  it('excludes legacy UUID, codex/opus, and ad-hoc agents', () => {
    const agents = [
      { id: 'orchestrator', status: 'running', ptyId: 'p1', output: ['ok\n'] },
      { id: '484bb96c-1234-5678-9abc-def012345678', status: 'running', ptyId: 'legacy', output: ['LEAK\n'] }, // legacy UUID
      { id: 'codex-opus-adhoc', status: 'running', ptyId: 'x', output: ['adhoc\n'] },                          // not baseline
    ];
    const snaps = buildBaselineSnapshots(agents, AT);
    const ids = snaps.map(s => s.agentId);
    expect(ids).not.toContain('484bb96c-1234-5678-9abc-def012345678');
    expect(ids).not.toContain('codex-opus-adhoc');
    expect(snaps).toHaveLength(11);
    // The legacy agent's output must never appear in any snapshot.
    expect(snaps.some(s => s.outputLines.join().includes('LEAK'))).toBe(false);
    // The baseline orchestrator IS merged.
    const orch = snaps.find(s => s.agentId === 'orchestrator');
    expect(orch?.hasPty).toBe(true);
    expect(orch?.outputLines).toContain('ok');
  });

  it('gives missing baseline agents a safe placeholder', () => {
    const snaps = buildBaselineSnapshots([{ id: 'orchestrator', status: 'running', ptyId: 'p', output: ['x\n'] }], AT);
    const missing = snaps.find(s => s.agentId === 'devops-reporter');
    expect(missing).toBeDefined();
    expect(missing?.status).toBe('unknown');
    expect(missing?.hasPty).toBe(false);
    expect(missing?.streamAvailable).toBe(false);
    expect(missing?.outputLines).toEqual([]);
    expect(missing?.inputEnabled).toBe(false);
  });
});
