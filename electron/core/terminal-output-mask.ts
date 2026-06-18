/**
 * Phase 6-AE — electron-side, read-only terminal output masking + snapshot.
 *
 * Pure module (no electron/IPC imports) so it is unit-testable and safe to call
 * from API routes and IPC handlers. Mirrors the renderer's masking regexes in
 * `src/lib/agentTerminalStatus.ts` — both layers must redact identically so a
 * secret never reaches the UI from either path. NEVER mutates the agent.
 *
 * Safety contract:
 *   - read-only: only reads an agent's in-memory output buffer
 *   - masked: every line passes through maskLine()
 *   - inputEnabled is ALWAYS false (MVP — no PTY input from snapshots)
 *   - baseline only: snapshots are limited to the 11 managed operation agents
 *     (legacy UUID + codex/opus ad-hoc agents are excluded)
 */

/** The 11 managed operation agents (8 core process + 3 dev/verify auxiliary). */
export const SNAPSHOT_BASELINE_IDS: readonly string[] = [
  'intake-planner', 'architect-plan', 'orchestrator', 'plan-validator',
  'contract-agent', 'database-agent', 'qa-reviewer', 'devops-reporter',
  'backend', 'frontend', 'security-reviewer',
];

const BASELINE_SET = new Set(SNAPSHOT_BASELINE_IDS);

/** KO display + role labels for the 11 baseline (display-only). */
const DISPLAY: Record<string, { name: string; role: string }> = {
  'intake-planner': { name: 'Intake Planner', role: '요구 분해·계획' },
  'architect-plan': { name: 'Architect / Plan', role: '아키텍처·ADR' },
  'orchestrator': { name: 'Orchestrator', role: '위임·조율' },
  'plan-validator': { name: 'Plan Validator', role: '위험·승인 게이트' },
  'contract-agent': { name: 'Contract Agent', role: 'API 계약' },
  'database-agent': { name: 'Database Agent', role: 'DB 영향·마이그레이션' },
  'qa-reviewer': { name: 'QA / Reviewer', role: '품질·보안 검토' },
  'devops-reporter': { name: 'DevOps / Reporter', role: '빌드·리포트' },
  'backend': { name: 'Backend', role: '백엔드 구현' },
  'frontend': { name: 'Frontend', role: '프론트 구현' },
  'security-reviewer': { name: 'Security Reviewer', role: '보안 검토' },
};

export function isSnapshotBaselineAgent(id: string | null | undefined): boolean {
  return typeof id === 'string' && BASELINE_SET.has(id);
}

const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g');

/** Redact secrets/tokens from a single line. Mirrors renderer maskLine(). */
export function maskLine(s: string): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|api[_-]?key|apikey|token|secret|password|client_secret|access_token|private_key)["']?\s*[:=]\s*["']?)[^\s"',]+/gi, '$1[REDACTED]')
    .replace(/\b(sk-|ghp_|gho_|xox[baprs]-)[A-Za-z0-9._\-]+/g, '$1[REDACTED]');
}

/** Raw PTY output buffer → clean, masked, ANSI-stripped, last-N lines. */
export function terminalLines(output: unknown, cap = 200): string[] {
  if (!Array.isArray(output) || output.length === 0) return [];
  const lines = (output as unknown[])
    .filter((l): l is string => typeof l === 'string')
    .join('')
    .split('\n')
    .map(l => maskLine(l.replace(ANSI_RE, '').replace(/\r/g, '')))
    .filter(l => l.length > 0);
  return lines.length > cap ? lines.slice(-cap) : lines;
}

/** Masked, single-string last-N-line preview. */
export function outputPreview(output: unknown, max = 2): string {
  const lines = terminalLines(output, max);
  return lines
    .slice(-max)
    .map(l => (l.length > 120 ? l.slice(0, 120) + '…' : l))
    .join('  ·  ');
}

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

/** Minimal shape we read from an in-memory agent record. */
export interface AgentLike {
  id?: string;
  name?: string;
  status?: string;
  ptyId?: string;
  output?: unknown;
  currentTask?: string;
  lastActivity?: string;
}

/**
 * Build a read-only, masked snapshot for one baseline agent. `updatedAt` is
 * injected by the caller (avoid Date.now() in pure code paths/tests).
 */
export function buildAgentTerminalSnapshot(
  agentId: string,
  agent: AgentLike | undefined,
  updatedAt: string,
  lineCap = 200,
): AgentTerminalSnapshot {
  const disp = DISPLAY[agentId];
  const hasPty = typeof agent?.ptyId === 'string' && agent.ptyId.length > 0;
  const live = hasPty || agent?.status === 'running' || agent?.status === 'waiting';
  const outputLines = terminalLines(agent?.output, lineCap);
  return {
    agentId,
    processName: disp?.name ?? agent?.name ?? agentId,
    role: disp?.role,
    status: agent?.status ?? 'unknown',
    hasPty,
    ptyId: agent?.ptyId,
    outputLines,
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
 * Build snapshots for ALL 11 baseline agents (missing ones get an
 * 'unknown'/no-terminal placeholder so the board is never empty). Non-baseline
 * agents (legacy UUID, codex+opus, ad-hoc) are never included.
 */
export function buildBaselineSnapshots(
  byId: Map<string, AgentLike>,
  updatedAt: string,
  lineCap = 200,
): AgentTerminalSnapshot[] {
  return SNAPSHOT_BASELINE_IDS.map(id =>
    buildAgentTerminalSnapshot(id, byId.get(id), updatedAt, lineCap),
  );
}
