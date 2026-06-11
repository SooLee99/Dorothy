/**
 * Phase 6-Z / 6-AA — pure, read-only agent terminal/session status helpers.
 *
 * No React / no path aliases (only the alias-free agentProcessDisplay) →
 * unit-testable in a node env. These never kill sessions or mutate state; they
 * only classify what the live agent-manager already reports so the dashboard
 * can show terminal visibility honestly — and, for 6-AA, always materialize the
 * 11 process-baseline terminal slots even when an agent has no live PTY.
 */

import {
  PROCESS_BASELINE_IDS,
  ALL_OPERATION_AGENT_IDS,
  lookupProcessDisplay,
  processDisplayName,
} from './agentProcessDisplay';

export interface TerminalAgentLike {
  id?: string;
  status?: string;
  ptyId?: string;
  output?: unknown;
  currentTask?: string;
  name?: string;
  lastActivity?: string;
}

/** True when the agent has (or is) a live terminal: a PTY or an active status. */
export function hasTerminal(agent: TerminalAgentLike): boolean {
  if (typeof agent.ptyId === 'string' && agent.ptyId.length > 0) return true;
  return agent.status === 'running' || agent.status === 'waiting';
}

/** Light secret masking — never surface raw tokens in output/preview. */
export function maskLine(s: string): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|api[_-]?key|apikey|token|secret|password|client_secret|access_token|private_key)["']?\s*[:=]\s*["']?)[^\s"',]+/gi, '$1[REDACTED]')
    .replace(/\b(sk-|ghp_|gho_|xox[baprs]-)[A-Za-z0-9._\-]+/g, '$1[REDACTED]');
}

/** Mask + cap an array of output lines (read-only terminal rendering). */
export function maskLines(lines: unknown, cap = 2000): string[] {
  if (!Array.isArray(lines)) return [];
  const out = lines.filter((l): l is string => typeof l === 'string').map(maskLine);
  return out.length > cap ? out.slice(-cap) : out;
}

/**
 * Turn a raw PTY output buffer (array of chunks, possibly with ANSI codes) into
 * clean, masked, newline-split lines for read-only terminal rendering.
 */
export function terminalLines(output: unknown, cap = 1000): string[] {
  if (!Array.isArray(output) || output.length === 0) return [];
  const lines = (output as unknown[])
    .filter((l): l is string => typeof l === 'string')
    .join('')
    .split('\n')
    .map(l => maskLine(l.replace(ANSI_RE, '').replace(/\r/g, '')))
    .filter(l => l.length > 0);
  return lines.length > cap ? lines.slice(-cap) : lines;
}

const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g');

/** Masked, ANSI-stripped, last-N-line preview of an agent's output buffer. */
export function outputPreview(output: unknown, max = 2): string {
  if (!Array.isArray(output) || output.length === 0) return '';
  const lines = (output as unknown[])
    .filter((l): l is string => typeof l === 'string')
    .join('')
    .split('\n')
    .map(l => l.replace(ANSI_RE, '').trim())
    .filter(Boolean);
  return lines
    .slice(-max)
    .map(maskLine)
    .map(l => (l.length > 120 ? l.slice(0, 120) + '…' : l))
    .join('  ·  ');
}

export type TerminalBucket = 'terminal' | 'waiting' | 'none';

/** Classify a single agent into a terminal bucket (read-only). */
export function computeAgentTerminalStatus(agent: TerminalAgentLike): {
  hasTerminal: boolean;
  bucket: TerminalBucket;
} {
  const t = hasTerminal(agent);
  if (t) return { hasTerminal: true, bucket: 'terminal' };
  if (typeof agent.currentTask === 'string' && agent.currentTask.trim().length > 0) {
    return { hasTerminal: false, bucket: 'waiting' };
  }
  return { hasTerminal: false, bucket: 'none' };
}

export interface TerminalSummary {
  total: number;
  terminal: number;
  waiting: number;
  none: number;
  autoState: '활성' | '대기(작업 보유)' | '유휴';
}

/** Aggregate counts + an auto-execution state label across all agents. */
export function summarizeTerminals(agents: TerminalAgentLike[]): TerminalSummary {
  let terminal = 0, waiting = 0, none = 0;
  for (const a of agents) {
    const { bucket } = computeAgentTerminalStatus(a);
    if (bucket === 'terminal') terminal++;
    else if (bucket === 'waiting') waiting++;
    else none++;
  }
  const autoState = terminal > 0 ? '활성' : waiting > 0 ? '대기(작업 보유)' : '유휴';
  return { total: agents.length, terminal, waiting, none, autoState };
}

/* ============================================================================
 * Phase 6-AA — Process Agent Terminal Board (always 11 baseline slots)
 * ========================================================================== */

export type TerminalSlotStatus = 'live' | 'waiting' | 'none' | 'failed' | 'stale';

export interface ProcessAgentTerminalSlot {
  agentId: string;
  processName: string;
  role: string;
  status: string;                 // raw agent status (idle/running/...) or 'unknown'
  terminalStatus: TerminalSlotStatus;
  hasPty: boolean;
  ptyId?: string;
  currentTask?: string;
  idleReason?: string;
  dispatchBlocker?: string;
  outputPreview?: string;
  lastActivity?: string;
}

/** Per-agent terminal status for the board (richer than the bucket). */
export function terminalSlotStatus(agent: TerminalAgentLike | undefined): TerminalSlotStatus {
  if (!agent) return 'none';
  if (agent.status === 'error') return 'failed';
  if (agent.status === 'running' || agent.status === 'waiting') return 'live';
  // PTY present but status is idle/completed → a leftover (stale) slot.
  if (typeof agent.ptyId === 'string' && agent.ptyId.length > 0) return 'stale';
  if (typeof agent.currentTask === 'string' && agent.currentTask.trim().length > 0) return 'waiting';
  return 'none';
}

export interface BuildTerminalSlotsInput {
  /** Live agents from useElectronAgents (any superset; only baseline ids used). */
  agents: TerminalAgentLike[];
  /** agentId → idle reason label (already KO-mapped by the caller). */
  idleReasonByAgent?: Map<string, string>;
  /** agentId → dispatch blocker label. */
  dispatchBlockerByAgent?: Map<string, string>;
  /** Override the baseline list (defaults to PROCESS_BASELINE_IDS). */
  baseline?: readonly string[];
}

/**
 * Always returns exactly one slot per baseline process agent (11), merging live
 * agent-manager data when present. Agents not in the baseline (legacy UUID,
 * codex+opus, ad-hoc) are NEVER included. Missing agents still get a slot
 * (status 'unknown', terminalStatus 'none') so the board is never empty.
 */
export function buildTerminalSlots(input: BuildTerminalSlotsInput): ProcessAgentTerminalSlot[] {
  const baseline = input.baseline ?? PROCESS_BASELINE_IDS;
  const byId = new Map<string, TerminalAgentLike>();
  for (const a of input.agents) {
    if (typeof a.id === 'string' && a.id) byId.set(a.id, a);
  }
  return baseline.map((agentId) => {
    const a = byId.get(agentId);
    const disp = lookupProcessDisplay(agentId);
    const term = terminalSlotStatus(a);
    return {
      agentId,
      processName: processDisplayName(agentId, a?.name),
      role: disp?.roleKo ?? '',
      status: a?.status ?? 'unknown',
      terminalStatus: term,
      hasPty: typeof a?.ptyId === 'string' && a.ptyId.length > 0,
      ptyId: a?.ptyId,
      currentTask: a?.currentTask,
      idleReason: input.idleReasonByAgent?.get(agentId),
      dispatchBlocker: input.dispatchBlockerByAgent?.get(agentId),
      outputPreview: term === 'live' ? outputPreview(a?.output) : '',
      lastActivity: a?.lastActivity,
    };
  });
}

export interface TerminalBoardSummary {
  total: number;
  live: number;
  waiting: number;
  none: number;
  failed: number;
  stale: number;
}

export function summarizeSlots(slots: ProcessAgentTerminalSlot[]): TerminalBoardSummary {
  const s: TerminalBoardSummary = { total: slots.length, live: 0, waiting: 0, none: 0, failed: 0, stale: 0 };
  for (const slot of slots) s[slot.terminalStatus]++;
  return s;
}

/**
 * Phase 6-AG — pick the single most-relevant agent to show a terminal for:
 *   1) a live agent (running/waiting/PTY),
 *   2) else the most-recently-active operation agent that has output,
 *   3) else orchestrator (if present), else the first available operation agent.
 * Used by the dashboard to always surface a real terminal instead of an empty
 * grid. Returns null only when there are no operation agents at all.
 */
export function pickTerminalAgentId(
  agents: TerminalAgentLike[],
  baseline: readonly string[] = ALL_OPERATION_AGENT_IDS,
): string | null {
  const byId = new Map<string, TerminalAgentLike>();
  for (const a of agents) if (typeof a.id === 'string' && a.id) byId.set(a.id, a);
  const inBase = baseline.map(id => byId.get(id)).filter((a): a is TerminalAgentLike => !!a);

  const live = inBase.find(a => hasTerminal(a));
  if (live?.id) return live.id;

  const withOutput = inBase
    .filter(a => Array.isArray(a.output) && a.output.length > 0)
    .sort((a, b) => new Date(b.lastActivity ?? 0).getTime() - new Date(a.lastActivity ?? 0).getTime());
  if (withOutput[0]?.id) return withOutput[0].id;

  if (byId.has('orchestrator')) return 'orchestrator';
  if (inBase[0]?.id) return inBase[0].id;
  return baseline[0] ?? null;
}
