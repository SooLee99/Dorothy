/**
 * Dorothy MVP Phase 6-Q — batch warm-up target selection + Codex model
 * normalization (read-only selection + file mutation with backup).
 *
 * The actual agent start is performed by the IPC layer via the SAME internal
 * `/api/agents/:id/start` adapter the orchestrator uses (in-process fetch with
 * the local API token — NOT a shell curl). This service only:
 *   - decides which agents are eligible for a safe warm-up,
 *   - builds the fixed file-modification-free warm-up prompt,
 *   - previews + applies Codex model normalization (drop model='opus').
 *
 * Never spawns, never edits .md / skills, never touches ~/.codex.
 */

import * as fs from 'fs';
import { AGENTS_FILE } from '../../constants';
import {
  buildAgentRegistry,
  normalizeAgentKey,
  type AgentDefinition,
  type AgentRegistryOptions,
} from './agent-definition-registry';
import { isClaudeModel } from '../../core/provider-model-compatibility';

/* ============================================================================
 * Types
 * ========================================================================== */

export interface AgentWarmupTarget {
  agentId: string;
  displayName: string;
  canWarmup: boolean;
  reason?: string;
  alreadyRunning?: boolean;
  provider?: string;
  model?: string;
}

export interface AgentWarmupResult {
  ok: boolean;
  requestedAgentIds: string[];
  startedAgentIds: string[];
  skipped: Array<{ agentId: string; reason: string }>;
  failed: Array<{ agentId: string; error: string }>;
}

export interface LiveAgentStatus {
  id: string;
  status: string;
}

/** Default warm-up roster: the 8 registered process agents (+ optional fe/be). */
export const DEFAULT_WARMUP_AGENT_IDS = [
  'intake-planner', 'architect-plan', 'orchestrator', 'plan-validator',
  'contract-agent', 'database-agent', 'qa-reviewer', 'devops-reporter',
];
export const OPTIONAL_WARMUP_AGENT_IDS = ['backend', 'frontend'];

const RUNNING_STATUSES = new Set(['running', 'waiting']);

/* ============================================================================
 * Warm-up prompt (FIXED — file-modification-free)
 * ========================================================================== */

export const WARMUP_PROMPT_BASE =
  'You are running a Dorothy safe warm-up session.\n\n' +
  'Do not modify files.\n' +
  'Do not run destructive commands.\n' +
  'Do not create commits.\n' +
  'Do not push.\n' +
  'Do not change secrets.\n' +
  'Do not edit agent definitions or skills.\n\n' +
  'Your task:\n' +
  '1. Read your assigned agent role.\n' +
  '2. Confirm your provider/runtime is working.\n' +
  '3. Summarize what kind of RunStep you can handle.\n' +
  '4. Report whether you are ready for real Dorothy Kanban/RunStep assignments.\n' +
  '5. If you see missing context, write a short readiness note only.\n\n' +
  'End with:\n' +
  'WARMUP_READY: true';

/** Per-agent role context appended to the fixed warm-up prompt. */
const ROLE_CONTEXT: Record<string, { name: string; inputs: string; outputs: string }> = {
  'intake-planner':  { name: '요청 접수·기획 에이전트', inputs: 'user request, Kanban card', outputs: 'requirement summary, task draft' },
  'architect-plan':  { name: '설계·계획 에이전트', inputs: 'requirement summary', outputs: 'design.md, task list' },
  'orchestrator':    { name: '실행 오케스트레이터', inputs: 'approved Plan', outputs: 'RunStep dispatch, handoff routing' },
  'plan-validator':  { name: '계획 검증 에이전트', inputs: 'Plan', outputs: 'approval/conditional/reject verdict' },
  'contract-agent':  { name: '계약/API 설계 에이전트', inputs: 'requirements, acceptanceCriteria', outputs: 'api-contract.md, dto-schema.json' },
  'database-agent':  { name: '데이터베이스 에이전트', inputs: 'requirements, design.md', outputs: 'db-impact-report.md, migration-plan.md' },
  'frontend':        { name: '프론트엔드 개발 에이전트', inputs: 'api-contract.md, RunStep', outputs: 'frontend-handoff.md, changed files' },
  'backend':         { name: '백엔드 개발 에이전트', inputs: 'API contract, DB handoff, RunStep', outputs: 'backend-handoff.md, validation result' },
  'qa-reviewer':     { name: 'QA·리뷰 에이전트', inputs: 'frontend/backend handoffs', outputs: 'qa-review-report.md' },
  'devops-reporter': { name: '문서·보고/DevOps 에이전트', inputs: 'QA handoff', outputs: 'result-report.md, PR body' },
};

export function buildWarmupPrompt(agentId: string): string {
  const ctx = ROLE_CONTEXT[normalizeAgentKey(agentId).replace(/_/g, '-')] ?? ROLE_CONTEXT[agentId];
  const header = ctx
    ? `Agent: ${ctx.name}\nagentId: ${agentId}\nExpected inputs: ${ctx.inputs}\nExpected outputs: ${ctx.outputs}\nDo not edit files during warm-up.\n\n`
    : `agentId: ${agentId}\nDo not edit files during warm-up.\n\n`;
  return header + WARMUP_PROMPT_BASE;
}

/** A marker the renderer can detect to classify a session as warm-up. */
export const WARMUP_MARKER = '[DOROTHY_WARMUP]';

/* ============================================================================
 * Target selection
 * ========================================================================== */

export interface WarmupTargetOptions {
  agentIds?: string[];
  liveAgents?: LiveAgentStatus[];
  liveLoadedAgentIds?: string[];
  registryOptions?: AgentRegistryOptions;
  /** Inject definitions for tests. */
  definitions?: AgentDefinition[];
}

export function listWarmupTargets(opts: WarmupTargetOptions = {}): AgentWarmupTarget[] {
  const ids = opts.agentIds && opts.agentIds.length ? opts.agentIds : DEFAULT_WARMUP_AGENT_IDS;
  const defs = opts.definitions ?? buildAgentRegistry({
    ...(opts.registryOptions ?? {}),
    liveLoadedAgentIds: opts.liveLoadedAgentIds ?? opts.registryOptions?.liveLoadedAgentIds,
  }).definitions;
  const defByKey = new Map<string, AgentDefinition>();
  for (const d of defs) defByKey.set(normalizeAgentKey(d.id), d);

  const runningKeys = new Set<string>();
  for (const a of opts.liveAgents ?? []) {
    if (RUNNING_STATUSES.has(a.status)) runningKeys.add(normalizeAgentKey(a.id));
  }

  return ids.map(id => {
    const key = normalizeAgentKey(id);
    const def = defByKey.get(key);
    const base: AgentWarmupTarget = {
      agentId: id,
      displayName: def?.displayName ?? id,
      canWarmup: false,
      provider: def?.provider,
      model: def?.model,
    };
    if (!def) return { ...base, reason: 'definition not found' };
    if (runningKeys.has(key)) return { ...base, alreadyRunning: true, reason: 'already running' };
    if (def.modelCompatibility && def.modelCompatibility.ok === false) {
      return { ...base, reason: 'provider/model mismatch' };
    }
    if (!def.isRegistered) return { ...base, reason: 'not registered' };
    if (!def.isLiveLoaded) return { ...base, reason: 'not live-loaded (reload required)' };
    if (!def.isSpawnable) return { ...base, reason: def.spawnBlockReason ?? 'not spawnable' };
    if (def.enabled === false) return { ...base, reason: 'disabled' };
    return { ...base, canWarmup: true };
  });
}

/* ============================================================================
 * Codex model normalization (drop model='opus' on codex agents)
 * ========================================================================== */

export interface CodexNormalizationTarget {
  id: string;
  name?: string;
  model: string;
}

export interface CodexNormalizationPreview {
  structure: 'array' | 'object' | 'unknown' | 'missing';
  targets: CodexNormalizationTarget[];
}

export interface CodexNormalizationResult {
  ok: boolean;
  reason?: string;
  changedAgentIds: string[];
  backupPath?: string | null;
}

interface AgentsFileState {
  structure: 'array' | 'object' | 'unknown' | 'missing';
  raw: string | null;
  parsed: unknown;
  list: Array<Record<string, unknown>> | null;
}

function readAgentsFile(filePath: string): AgentsFileState {
  if (!fs.existsSync(filePath)) return { structure: 'missing', raw: null, parsed: null, list: null };
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { structure: 'unknown', raw, parsed: null, list: null }; }
  if (Array.isArray(parsed)) return { structure: 'array', raw, parsed, list: parsed as Array<Record<string, unknown>> };
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { agents?: unknown }).agents)) {
    return { structure: 'object', raw, parsed, list: (parsed as { agents: Array<Record<string, unknown>> }).agents };
  }
  return { structure: 'unknown', raw, parsed, list: null };
}

/** Codex agents whose model is a Claude-family model (e.g. opus). */
export function previewCodexModelNormalization(agentsFilePath = AGENTS_FILE): CodexNormalizationPreview {
  const state = readAgentsFile(agentsFilePath);
  if (state.structure === 'unknown' || state.structure === 'missing' || !state.list) {
    return { structure: state.structure, targets: [] };
  }
  const targets: CodexNormalizationTarget[] = [];
  for (const a of state.list) {
    if ((a.provider as string) === 'codex' && typeof a.model === 'string' && isClaudeModel(a.model)) {
      targets.push({ id: String(a.id), name: typeof a.name === 'string' ? a.name : undefined, model: a.model });
    }
  }
  return { structure: state.structure, targets };
}

/**
 * Remove the incompatible `model` field from codex agents (so Codex uses its
 * default). Only the `model` field is deleted — provider, id, everything else
 * is preserved. agents.json is backed up first.
 */
export function normalizeCodexModels(opts: { agentsFilePath?: string; now?: string } = {}): CodexNormalizationResult {
  const filePath = opts.agentsFilePath ?? AGENTS_FILE;
  const state = readAgentsFile(filePath);
  if (state.structure === 'unknown' || state.structure === 'missing' || !state.list) {
    return { ok: false, reason: 'Unrecognized agents.json structure; left untouched.', changedAgentIds: [] };
  }

  const changedAgentIds: string[] = [];
  for (const a of state.list) {
    if ((a.provider as string) === 'codex' && typeof a.model === 'string' && isClaudeModel(a.model)) {
      delete a.model;
      changedAgentIds.push(String(a.id));
    }
  }
  if (changedAgentIds.length === 0) {
    return { ok: true, changedAgentIds: [], backupPath: null };
  }

  const now = opts.now ?? new Date().toISOString();
  const stamp = now.replace(/[:.]/g, '').replace(/[-T]/g, '').slice(0, 14);
  const backupPath = `${filePath}.bak.${stamp}`;
  try {
    fs.writeFileSync(backupPath, state.raw ?? '');
  } catch (err) {
    return { ok: false, reason: `Backup failed: ${err instanceof Error ? err.message : 'unknown'}`, changedAgentIds: [] };
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(state.parsed, null, 2));
  } catch (err) {
    try { if (state.raw !== null) fs.writeFileSync(filePath, state.raw); } catch { /* best effort */ }
    return { ok: false, reason: `Write failed, original restored: ${err instanceof Error ? err.message : 'unknown'}`, changedAgentIds: [], backupPath };
  }
  return { ok: true, changedAgentIds, backupPath };
}
