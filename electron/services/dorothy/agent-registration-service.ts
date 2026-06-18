/**
 * Dorothy MVP Phase 6-G — Agent Definition manual registration.
 *
 * Lets an operator promote a file-based agent definition
 * (`<project>/.claude/agents/<id>.md`) into a *configured* agent in
 * `~/.dorothy/agents.json`. This is strictly a manual, confirm-gated action:
 *
 *   - Only file-based definitions can be registered.
 *   - A configured / live-session-only / missing-file agent cannot be registered.
 *   - agents.json is backed up before every mutation; on write failure the
 *     original content is restored.
 *   - The existing array / `{ agents: [] }` structure is preserved; an
 *     unrecognized structure is left untouched and an error is returned.
 *   - Existing records are never overwritten or deleted; duplicates are refused.
 *   - No secrets / tokens are ever written into the record.
 *
 * There is intentionally NO "register all" path — callers register one
 * definition at a time after a preview + explicit confirm.
 */

import * as fs from 'fs';
import { AGENTS_FILE } from '../../constants';
import {
  buildAgentRegistry,
  normalizeAgentKey,
  type AgentDefinition,
  type AgentDefinitionSource,
  type AgentRegistryOptions,
} from './agent-definition-registry';
import { safeCreateHookEvent } from './hook-event-service';
import { resolveWorkflowKindForAgent } from './agent-workflow-templates';
import type { AgentWorkflowKind } from '../../types/dorothy';

/* ============================================================================
 * Types
 * ========================================================================== */

export type RegistrationProvider = 'claude' | 'codex' | 'gemini' | 'opencode' | 'local';

export interface RegisterAgentDefinitionOptions {
  provider?: RegistrationProvider;
  model?: string;
  enabled?: boolean;
  dryRun?: boolean;
}

export interface AgentRegistrationPreview {
  agentDefinitionId: string;
  displayName: string;
  source: AgentDefinitionSource;
  filePath?: string;
  workflowKind?: AgentWorkflowKind;
  roleSummary?: string;
  proposedAgentRecord: Record<string, unknown>;
  warnings: string[];
  canRegister: boolean;
  reason?: string;
}

export interface RegisterAgentDefinitionResult {
  ok: boolean;
  reason?: string;
  dryRun?: boolean;
  backupPath?: string | null;
  proposedAgentRecord?: Record<string, unknown>;
  hookEventId?: string | null;
}

/** Test / call-site injection seam — overrides where we read the registry from
 *  and which agents.json file we mutate. */
export interface RegistrationDeps {
  agentsFilePath?: string;
  registryOptions?: AgentRegistryOptions;
  /** Override timestamp for deterministic tests. */
  now?: string;
}

/* ============================================================================
 * agents.json structure handling
 * ========================================================================== */

type AgentsFileStructure = 'array' | 'object' | 'unknown' | 'missing';

interface AgentsFileState {
  structure: AgentsFileStructure;
  raw: string | null;
  parsed: unknown;
  list: Array<Record<string, unknown>> | null;
}

function readAgentsFile(filePath: string): AgentsFileState {
  if (!fs.existsSync(filePath)) {
    return { structure: 'missing', raw: null, parsed: null, list: null };
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { structure: 'unknown', raw, parsed: null, list: null };
  }
  if (Array.isArray(parsed)) {
    return { structure: 'array', raw, parsed, list: parsed as Array<Record<string, unknown>> };
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { agents?: unknown }).agents)
  ) {
    return {
      structure: 'object',
      raw,
      parsed,
      list: (parsed as { agents: Array<Record<string, unknown>> }).agents,
    };
  }
  return { structure: 'unknown', raw, parsed, list: null };
}

/* ============================================================================
 * Helpers
 * ========================================================================== */

function findDefinition(
  agentDefinitionId: string,
  deps: RegistrationDeps,
): AgentDefinition | null {
  const key = normalizeAgentKey(agentDefinitionId);
  const snap = buildAgentRegistry(deps.registryOptions ?? {});
  return snap.definitions.find(d => normalizeAgentKey(d.id) === key) ?? null;
}

function isFileSource(s: AgentDefinitionSource): boolean {
  return s === 'claude_project_file' || s === 'claude_user_file';
}

function existingRecordFor(
  list: Array<Record<string, unknown>>,
  id: string,
): Record<string, unknown> | undefined {
  const key = normalizeAgentKey(id);
  return list.find(r => normalizeAgentKey(String(r.id ?? '')) === key);
}

/**
 * Phase 6-V — resolve a projectPath for a newly-registered slug agent so the
 * runtime `/api/agents/:id/start` handler (which builds the working dir from
 * `agent.projectPath`) never receives undefined. Prefers the agent .md
 * frontmatter `projectPath:`; otherwise infers the project root from the
 * definition file path (strip the trailing `/.claude/agents/<file>.md`).
 * Returns undefined only when nothing can be resolved (UI guards handle that).
 */
function resolveProjectPathForDef(def: AgentDefinition): string | undefined {
  const filePath = def.filePath;
  if (!filePath) return undefined;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      const m = fm[1].match(/^projectPath:\s*(.+)$/m);
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, '');
        if (v) return v;
      }
    }
  } catch {
    /* fall through to path inference */
  }
  // Infer from the definition file location: <root>/.claude/agents/<file>.md
  const marker = '/.claude/agents/';
  const idx = filePath.lastIndexOf(marker);
  if (idx > 0) return filePath.slice(0, idx);
  return undefined;
}

function buildProposedRecord(
  def: AgentDefinition,
  opts: RegisterAgentDefinitionOptions,
  now: string,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    id: def.id,
    name: def.displayName,
    provider: opts.provider ?? 'claude',
    source: def.source,
    definitionPath: def.filePath,
    workflowKind: def.workflowKind ?? resolveWorkflowKindForAgent(def.id),
    enabled: opts.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  // Phase 6-V — persist a projectPath so the start handler has a working dir.
  const projectPath = resolveProjectPathForDef(def);
  if (projectPath) record.projectPath = projectPath;
  // model only when explicitly provided — never invent one, never persist secrets.
  if (opts.model && opts.model !== 'default') record.model = opts.model;
  return record;
}

/* ============================================================================
 * Public surface
 * ========================================================================== */

export function previewAgentRegistration(
  agentDefinitionId: string,
  opts: RegisterAgentDefinitionOptions = {},
  deps: RegistrationDeps = {},
): AgentRegistrationPreview | null {
  const def = findDefinition(agentDefinitionId, deps);
  if (!def) return null;

  const now = deps.now ?? new Date().toISOString();
  const warnings: string[] = [];
  let canRegister = true;
  let reason: string | undefined;

  if (def.source === 'configured') {
    canRegister = false;
    reason = 'Already a configured agent in agents.json.';
  } else if (def.source === 'live_session') {
    canRegister = false;
    reason = 'Live session has no definition file — cannot register.';
  } else if (!isFileSource(def.source)) {
    canRegister = false;
    reason = `Source "${def.source}" is not registerable.`;
  } else if (!def.existsOnDisk) {
    canRegister = false;
    reason = 'Definition file is missing on disk.';
  }

  // Duplicate check against the on-disk agents.json (even when the merged
  // registry already shows it linked).
  const filePath = deps.agentsFilePath ?? AGENTS_FILE;
  const state = readAgentsFile(filePath);
  if (state.structure === 'unknown') {
    warnings.push('agents.json has an unrecognized structure; registration will be refused.');
    canRegister = false;
    reason = reason ?? 'Unrecognized agents.json structure.';
  } else if (state.list) {
    const dup = existingRecordFor(state.list, def.id);
    if (dup) {
      canRegister = false;
      reason = reason ?? `An agent with id "${def.id}" already exists in agents.json.`;
      warnings.push('Duplicate id — already registered.');
    }
  }

  if (def.workflowKind === 'generic' || !def.workflowKind) {
    warnings.push('Agent maps to the generic workflow (no named role template).');
  }
  if (def.configuredAgentId) {
    warnings.push('Definition is already linked to a configured agent.');
    canRegister = false;
    reason = reason ?? 'Already linked to a configured agent.';
  }

  return {
    agentDefinitionId: def.id,
    displayName: def.displayName,
    source: def.source,
    filePath: def.filePath,
    workflowKind: def.workflowKind,
    roleSummary: def.roleSummary,
    proposedAgentRecord: buildProposedRecord(def, opts, now),
    warnings,
    canRegister,
    reason,
  };
}

export function registerAgentDefinition(
  agentDefinitionId: string,
  opts: RegisterAgentDefinitionOptions = {},
  deps: RegistrationDeps = {},
): RegisterAgentDefinitionResult {
  const preview = previewAgentRegistration(agentDefinitionId, opts, deps);
  if (!preview) return { ok: false, reason: 'Agent definition not found.' };
  if (!preview.canRegister) {
    return { ok: false, reason: preview.reason ?? 'Cannot register this definition.' };
  }

  const filePath = deps.agentsFilePath ?? AGENTS_FILE;
  const state = readAgentsFile(filePath);

  if (state.structure === 'unknown' || state.structure === 'missing' || !state.list) {
    return {
      ok: false,
      reason:
        state.structure === 'missing'
          ? 'agents.json does not exist; not creating it automatically.'
          : 'Unrecognized agents.json structure; left untouched.',
    };
  }

  // Final duplicate guard (race-safe re-check right before write).
  if (existingRecordFor(state.list, preview.agentDefinitionId)) {
    return { ok: false, reason: `Agent "${preview.agentDefinitionId}" already exists; not overwriting.` };
  }

  // dry-run: never touch the file.
  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      backupPath: null,
      proposedAgentRecord: preview.proposedAgentRecord,
      hookEventId: null,
    };
  }

  // 1) Backup the original content verbatim.
  const now = deps.now ?? new Date().toISOString();
  const stamp = now.replace(/[:.]/g, '').replace(/[-T]/g, '').slice(0, 14);
  const backupPath = `${filePath}.bak.${stamp}`;
  try {
    fs.writeFileSync(backupPath, state.raw ?? '');
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to write backup: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }

  // 2) Append, preserving the detected structure.
  try {
    state.list.push(preview.proposedAgentRecord);
    const out = JSON.stringify(state.parsed, null, 2);
    fs.writeFileSync(filePath, out);
  } catch (err) {
    // Restore original on any write failure.
    try {
      if (state.raw !== null) fs.writeFileSync(filePath, state.raw);
    } catch { /* best effort */ }
    return {
      ok: false,
      reason: `Write failed, original restored: ${err instanceof Error ? err.message : 'unknown'}`,
      backupPath,
    };
  }

  // 3) Timeline — system_note HookEvent (no dedicated type exists).
  const ev = safeCreateHookEvent({
    type: 'system_note',
    severity: 'info',
    source: 'system',
    agentId: preview.agentDefinitionId,
    title: `Agent definition registered — ${preview.agentDefinitionId}`,
    summary: `Promoted file-based definition to a configured agent in agents.json.`,
    metadata: {
      kind: 'agent_definition_registered',
      agentId: preview.agentDefinitionId,
      source: preview.source,
      definitionPath: preview.filePath ?? null,
      provider: opts.provider ?? 'claude',
    },
  });

  return {
    ok: true,
    backupPath,
    proposedAgentRecord: preview.proposedAgentRecord,
    hookEventId: ev?.id ?? null,
  };
}

/**
 * The file-based definitions eligible for manual registration: a definition
 * file that exists on disk and is not yet linked to a configured agent.
 */
export function listRegistrationCandidates(deps: RegistrationDeps = {}): AgentDefinition[] {
  const snap = buildAgentRegistry(deps.registryOptions ?? {});
  return snap.definitions.filter(
    d => isFileSource(d.source) && d.existsOnDisk && !d.configuredAgentId,
  );
}
