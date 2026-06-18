/**
 * Phase 6-Z — agent terminal/session status helpers.
 *
 * Verifies the Dashboard "Agent Terminal Overview" classification + masking:
 *   - hasTerminal: PTY or active status
 *   - computeAgentTerminalStatus buckets (terminal / waiting / none)
 *   - summarizeTerminals counts + autoState
 *   - outputPreview masks secrets and strips ANSI
 */

import { describe, it, expect } from 'vitest';
import {
  hasTerminal,
  maskLine,
  maskLines,
  outputPreview,
  terminalLines,
  computeAgentTerminalStatus,
  summarizeTerminals,
  terminalSlotStatus,
  buildTerminalSlots,
  summarizeSlots,
  pickTerminalAgentId,
} from '../../src/lib/agentTerminalStatus';
import {
  PROCESS_BASELINE_IDS,
  CORE_PROCESS_AGENT_IDS,
  AUXILIARY_AGENT_IDS,
  ALL_OPERATION_AGENT_IDS,
  isCoreProcessAgent,
  isAuxiliaryAgent,
  isOperationAgent,
} from '../../src/lib/agentProcessDisplay';

describe('Phase 6-Z — hasTerminal', () => {
  it('true when a PTY is present', () => {
    expect(hasTerminal({ ptyId: 'pty-1', status: 'idle' })).toBe(true);
  });
  it('true for running / waiting status', () => {
    expect(hasTerminal({ status: 'running' })).toBe(true);
    expect(hasTerminal({ status: 'waiting' })).toBe(true);
  });
  it('false for idle with no PTY', () => {
    expect(hasTerminal({ status: 'idle' })).toBe(false);
    expect(hasTerminal({})).toBe(false);
    expect(hasTerminal({ ptyId: '' })).toBe(false);
  });
});

describe('Phase 6-Z — computeAgentTerminalStatus buckets', () => {
  it('terminal bucket when it has a terminal', () => {
    expect(computeAgentTerminalStatus({ status: 'running' }).bucket).toBe('terminal');
  });
  it('waiting bucket when idle but has a currentTask', () => {
    expect(computeAgentTerminalStatus({ status: 'idle', currentTask: 'QG-30 ...' }).bucket).toBe('waiting');
  });
  it('none bucket when idle and no task', () => {
    expect(computeAgentTerminalStatus({ status: 'idle' }).bucket).toBe('none');
    expect(computeAgentTerminalStatus({ status: 'idle', currentTask: '   ' }).bucket).toBe('none');
  });
});

describe('Phase 6-Z — summarizeTerminals', () => {
  it('counts buckets + autoState (no live terminals → 유휴/대기)', () => {
    const agents = [
      { id: 'a', status: 'idle' },
      { id: 'b', status: 'idle', currentTask: 'work' },
      { id: 'c', status: 'idle' },
    ];
    const s = summarizeTerminals(agents);
    expect(s).toMatchObject({ total: 3, terminal: 0, waiting: 1, none: 2 });
    expect(s.autoState).toBe('대기(작업 보유)');
  });
  it('autoState 활성 when any terminal is live', () => {
    const s = summarizeTerminals([{ id: 'a', status: 'running' }, { id: 'b', status: 'idle' }]);
    expect(s.terminal).toBe(1);
    expect(s.autoState).toBe('활성');
  });
  it('autoState 유휴 when nothing running and no tasks', () => {
    expect(summarizeTerminals([{ id: 'a', status: 'idle' }]).autoState).toBe('유휴');
  });
  it('empty agent list → all zero, 유휴', () => {
    expect(summarizeTerminals([])).toMatchObject({ total: 0, terminal: 0, waiting: 0, none: 0, autoState: '유휴' });
  });
});

describe('Phase 6-Z/6-AE — maskLine / outputPreview / terminalLines', () => {
  it('masks bearer tokens / api keys / secret-like values', () => {
    const a = maskLine('Authorization: Bearer abc123XYZ.tok');
    expect(a).not.toContain('abc123XYZ.tok');
    expect(a).toContain('[REDACTED]');
    expect(maskLine('api_key=supersecretvalue')).toContain('api_key=[REDACTED]');
    expect(maskLine('api_key=supersecretvalue')).not.toContain('supersecretvalue');
    expect(maskLine('token: ghp_abcDEF123')).not.toContain('ghp_abcDEF123');
    expect(maskLine('apikey=zzz999')).toContain('[REDACTED]');
  });
  it('terminalLines: undefined/empty → [], strips ANSI, masks, splits', () => {
    expect(terminalLines(undefined)).toEqual([]);
    expect(terminalLines([])).toEqual([]);
    const esc = String.fromCharCode(27);
    const out = [`${esc}[32mstarting${esc}[0m\n`, 'Authorization: Bearer SECRET1\nline3\n'];
    const lines = terminalLines(out);
    expect(lines).toContain('starting');
    expect(lines).toContain('line3');
    expect(lines.join('\n')).not.toContain('SECRET1');
    expect(lines.join('\n')).not.toContain(esc);
  });
  it('maskLines: non-array → [], masks each, caps', () => {
    expect(maskLines(undefined)).toEqual([]);
    expect(maskLines(['Bearer abc123', 'ok'])).toEqual(['Bearer [REDACTED]', 'ok']);
    expect(maskLines(Array.from({ length: 50 }, (_, i) => `l${i}`), 10).length).toBe(10);
  });
  it('outputPreview returns "" for empty/non-array', () => {
    expect(outputPreview(undefined)).toBe('');
    expect(outputPreview([])).toBe('');
    expect(outputPreview('not-array' as unknown)).toBe('');
  });
  it('outputPreview keeps last N lines and masks them', () => {
    const out = ['line one\n', 'line two with Bearer SECRETTOKEN1\n', 'line three\n'];
    const p = outputPreview(out, 2);
    expect(p).toContain('line three');
    expect(p).not.toContain('SECRETTOKEN1');
    expect(p).toContain('[REDACTED]');
  });
  it('outputPreview strips ANSI escape codes', () => {
    const esc = String.fromCharCode(27);
    const out = [`${esc}[31mred${esc}[0m text\n`];
    const p = outputPreview(out, 1);
    expect(p).toContain('red');
    expect(p).not.toContain(esc);
  });
});

describe('Phase 6-AA — terminalSlotStatus', () => {
  it('failed for error status', () => {
    expect(terminalSlotStatus({ status: 'error' })).toBe('failed');
  });
  it('live for running/pty', () => {
    expect(terminalSlotStatus({ status: 'running' })).toBe('live');
    expect(terminalSlotStatus({ status: 'idle', ptyId: 'p' })).toBe('stale'); // pty but idle = leftover
  });
  it('waiting when idle with task, none when idle empty', () => {
    expect(terminalSlotStatus({ status: 'idle', currentTask: 'x' })).toBe('waiting');
    expect(terminalSlotStatus({ status: 'idle' })).toBe('none');
    expect(terminalSlotStatus(undefined)).toBe('none');
  });
});

describe('Phase 6-AB — roster constants (8 core + 3 aux = 11)', () => {
  it('CORE=8, AUX=3, ALL=11, PROCESS_BASELINE_IDS=CORE(8)', () => {
    expect(CORE_PROCESS_AGENT_IDS.length).toBe(8);
    expect(AUXILIARY_AGENT_IDS.length).toBe(3);
    expect(ALL_OPERATION_AGENT_IDS.length).toBe(11);
    expect(PROCESS_BASELINE_IDS.length).toBe(8);
    expect([...PROCESS_BASELINE_IDS]).toEqual([...CORE_PROCESS_AGENT_IDS]);
  });
  it('backend/frontend/security-reviewer are auxiliary, not core', () => {
    for (const id of ['backend', 'frontend', 'security-reviewer']) {
      expect(isAuxiliaryAgent(id)).toBe(true);
      expect(isCoreProcessAgent(id)).toBe(false);
      expect(isOperationAgent(id)).toBe(true); // still a managed operation agent
    }
  });
  it('orchestrator is core', () => {
    expect(isCoreProcessAgent('orchestrator')).toBe(true);
    expect(isAuxiliaryAgent('orchestrator')).toBe(false);
  });
});

describe('Phase 6-AB — buildTerminalSlots (core 8 default, all 11)', () => {
  it('empty agents → exactly 8 core slots (default), all none/unknown', () => {
    const slots = buildTerminalSlots({ agents: [] });
    expect(slots.length).toBe(8);
    expect(slots.map(s => s.agentId)).toEqual([...CORE_PROCESS_AGENT_IDS]);
    for (const s of slots) {
      expect(s.terminalStatus).toBe('none');
      expect(s.status).toBe('unknown');
      expect(s.hasPty).toBe(false);
      expect(s.processName.length).toBeGreaterThan(0);
    }
  });

  it('baseline=ALL_OPERATION → 11 slots', () => {
    const slots = buildTerminalSlots({ agents: [], baseline: ALL_OPERATION_AGENT_IDS });
    expect(slots.length).toBe(11);
  });

  it('baseline=AUXILIARY → 3 slots', () => {
    const slots = buildTerminalSlots({ agents: [], baseline: AUXILIARY_AGENT_IDS });
    expect(slots.map(s => s.agentId)).toEqual(['backend', 'frontend', 'security-reviewer']);
  });

  it('core idle agents → none/waiting; never live', () => {
    const agents = CORE_PROCESS_AGENT_IDS.map((id, i) => ({ id, status: 'idle', ...(i === 0 ? { currentTask: 'work' } : {}) }));
    const slots = buildTerminalSlots({ agents });
    expect(slots.length).toBe(8);
    expect(slots.filter(s => s.terminalStatus === 'live').length).toBe(0);
    expect(slots.find(s => s.agentId === CORE_PROCESS_AGENT_IDS[0])!.terminalStatus).toBe('waiting');
  });

  it('orchestrator running + ptyId → live (core board never empty)', () => {
    const slots = buildTerminalSlots({ agents: [{ id: 'orchestrator', status: 'running', ptyId: 'pty-x', output: ['hello\n'] }] });
    expect(slots.length).toBe(8);
    const orch = slots.find(s => s.agentId === 'orchestrator')!;
    expect(orch.terminalStatus).toBe('live');
    expect(orch.hasPty).toBe(true);
    expect(orch.outputPreview).toContain('hello');
  });

  it('legacy UUID + codex agents NEVER included (core or aux)', () => {
    const agents = [
      { id: '484bb96c-0cbd-4783-96f0-a6575f5d72f6', status: 'running', ptyId: 'p' },
      { id: 'some-codex-bot', status: 'running', ptyId: 'p2' },
      { id: 'backend', status: 'running', ptyId: 'p3' },
    ];
    const core = buildTerminalSlots({ agents });
    const aux = buildTerminalSlots({ agents, baseline: AUXILIARY_AGENT_IDS });
    expect(core.some(s => /^[0-9a-f]{8}-/i.test(s.agentId))).toBe(false);
    expect([...core, ...aux].some(s => s.agentId === 'some-codex-bot')).toBe(false);
    // backend is auxiliary, not in core
    expect(core.some(s => s.agentId === 'backend')).toBe(false);
    expect(aux.find(s => s.agentId === 'backend')!.terminalStatus).toBe('live');
  });

  it('merges idleReason + dispatchBlocker maps', () => {
    const slots = buildTerminalSlots({
      agents: CORE_PROCESS_AGENT_IDS.map(id => ({ id, status: 'idle' })),
      idleReasonByAgent: new Map([['qa-reviewer', '할당된 작업 없음']]),
      dispatchBlockerByAgent: new Map([['contract-agent', '승인 대기']]),
    });
    expect(slots.find(s => s.agentId === 'qa-reviewer')!.idleReason).toBe('할당된 작업 없음');
    expect(slots.find(s => s.agentId === 'contract-agent')!.dispatchBlocker).toBe('승인 대기');
  });

  it('pickTerminalAgentId: live > recent-with-output > orchestrator', () => {
    // live wins
    expect(pickTerminalAgentId([
      { id: 'backend', status: 'idle', output: ['x'], lastActivity: '2026-06-06T10:00:00Z' },
      { id: 'orchestrator', status: 'running' },
    ])).toBe('orchestrator');
    // no live → most recent with output
    expect(pickTerminalAgentId([
      { id: 'backend', status: 'idle', output: ['x'], lastActivity: '2026-06-06T10:00:00Z' },
      { id: 'qa-reviewer', status: 'idle', output: ['y'], lastActivity: '2026-06-06T11:00:00Z' },
    ])).toBe('qa-reviewer');
    // none with output → orchestrator if present
    expect(pickTerminalAgentId([{ id: 'orchestrator', status: 'idle' }])).toBe('orchestrator');
    // empty → first baseline id (non-null)
    expect(pickTerminalAgentId([])).toBeTruthy();
    // legacy/codex ignored
    expect(pickTerminalAgentId([{ id: '484bb96c-aaaa-bbbb', status: 'running' }])).not.toBe('484bb96c-aaaa-bbbb');
  });

  it('summarizeSlots counts buckets (core 8)', () => {
    const agents = [
      { id: 'orchestrator', status: 'running', ptyId: 'p' },
      { id: 'qa-reviewer', status: 'idle', currentTask: 'x' },
      { id: 'contract-agent', status: 'error' },
    ];
    const sum = summarizeSlots(buildTerminalSlots({ agents }));
    expect(sum.total).toBe(8);
    expect(sum.live).toBe(1);
    expect(sum.waiting).toBe(1);
    expect(sum.failed).toBe(1);
    expect(sum.none).toBe(5);
  });
});
