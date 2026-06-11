/**
 * Phase 6-AE — renderer-side AgentTerminalSnapshot model + pure builder.
 *
 * Mirrors `electron/core/terminal-output-mask.ts` so the dashboard can build the
 * same read-only, masked snapshot locally from a live agent record (useElectron)
 * OR consume one fetched from the electron API / IPC bridge. No React, no path
 * aliases beyond the alias-free agentTerminalStatus/agentProcessDisplay helpers
 * → unit-testable in a node env.
 *
 * Safety: read-only, masked, `inputEnabled` is ALWAYS false, baseline-11 only.
 */

import { terminalLines, outputPreview, hasTerminal, type TerminalAgentLike } from './agentTerminalStatus';
import {
  ALL_OPERATION_AGENT_IDS,
  isOperationAgent,
  lookupProcessDisplay,
  processDisplayName,
} from './agentProcessDisplay';

export interface AgentTerminalSnapshot {
  agentId: string;
  processName?: string;
  role?: string;
  status: string;
  hasPty: boolean;
  ptyId?: string;
  outputLines: string[];
  outputPreview: string;
  lastActivity?: string;
  currentTask?: string;
  streamAvailable: boolean;
  inputEnabled: false;
  masked: boolean;
  updatedAt: string;
}

export interface AgentTerminalEvent {
  agentId: string;
  type: 'output' | 'status' | 'closed' | 'error';
  line?: string;
  chunk?: string;
  status?: string;
  createdAt: string;
}

/** Build a read-only, masked snapshot for one agent. Caller passes updatedAt. */
export function buildAgentTerminalSnapshot(
  agentId: string,
  agent: TerminalAgentLike | undefined,
  updatedAt: string,
  lineCap = 200,
): AgentTerminalSnapshot {
  const disp = lookupProcessDisplay(agentId);
  const hasPty = typeof agent?.ptyId === 'string' && agent.ptyId.length > 0;
  const live = !!agent && hasTerminal(agent);
  return {
    agentId,
    processName: processDisplayName(agentId, agent?.name),
    role: disp?.roleKo,
    status: agent?.status ?? 'unknown',
    hasPty,
    ptyId: agent?.ptyId,
    outputLines: terminalLines(agent?.output, lineCap),
    outputPreview: outputPreview(agent?.output),
    lastActivity: agent?.lastActivity,
    currentTask: agent?.currentTask,
    streamAvailable: live,
    inputEnabled: false,
    masked: true,
    updatedAt,
  };
}

/**
 * Build snapshots for ALL 11 baseline operation agents from a live agent list.
 * Non-baseline agents (legacy UUID, codex+opus, ad-hoc) are NEVER included;
 * missing baseline agents still get an 'unknown'/no-terminal placeholder.
 */
export function buildBaselineSnapshots(
  agents: TerminalAgentLike[],
  updatedAt: string,
  lineCap = 200,
): AgentTerminalSnapshot[] {
  const byId = new Map<string, TerminalAgentLike>();
  for (const a of agents) {
    if (typeof a.id === 'string' && a.id && isOperationAgent(a.id)) byId.set(a.id, a);
  }
  return ALL_OPERATION_AGENT_IDS.map(id =>
    buildAgentTerminalSnapshot(id, byId.get(id), updatedAt, lineCap),
  );
}
