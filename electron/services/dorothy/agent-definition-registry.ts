/**
 * Dorothy MVP Phase 6-E — Agent Definition Registry.
 *
 * The dashboard `/agents` screen historically only renders the *configured*
 * agents stored in `~/.dorothy/agents.json`. Role-definition files that live in
 * a project's `.claude/agents/*.md` (e.g. intake-planner, architect-plan,
 * orchestrator, plan-validator, qa-reviewer, devops-reporter, contract-agent,
 * database-agent) were therefore invisible, even though the orchestrator routes
 * work to them. Live `AgentSession` rows in dorothy.db were also only surfaced
 * on `/sessions`, never merged with the definition view.
 *
 * This service reconciles three sources into a single read-only registry:
 *
 *   1. configured        — entries in `~/.dorothy/agents.json`
 *   2. claude_project_file — `<projectPath>/.claude/agents/*.md`
 *   3. claude_user_file    — `~/.claude/agents/*.md`
 *   + live_session merge   — `AgentSession` rows from dorothy.db
 *
 * STRICT read-only contract:
 *   - `.md` files are *read* only; their bodies are never modified.
 *   - `agents.json` is never written.
 *   - Only a short `roleSummary` (frontmatter description / first heading) is
 *     extracted; raw file bodies are never returned.
 *   - All file access is wrapped so a missing dir / unreadable file degrades
 *     gracefully to an empty contribution.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DATA_DIR } from '../../constants';
import { listAgentSessions } from './agent-session-service';
import { resolveWorkflowKindForAgent } from './agent-workflow-templates';
import { checkProviderModelCompatibility } from '../../core/provider-model-compatibility';
import type { AgentWorkflowKind, AgentSession } from '../../types/dorothy';

export interface AgentModelCompatibility {
  ok: boolean;
  reason: 'ok' | 'model_not_supported' | 'model_missing' | 'provider_unknown';
  message: string;
  suggestedModel?: string;
}

/* ============================================================================
 * Types
 * ========================================================================== */

export type AgentDefinitionSource =
  | 'configured'
  | 'claude_project_file'
  | 'claude_user_file'
  | 'live_session'
  | 'generated';

export type SpawnBlockReason =
  | 'not_registered'
  | 'not_live_loaded'
  | 'disabled'
  | 'provider_unavailable'
  | 'missing_definition'
  | 'unknown';

export interface AgentDefinition {
  id: string;
  displayName: string;
  source: AgentDefinitionSource;
  filePath?: string;
  configuredAgentId?: string;
  workflowKind?: AgentWorkflowKind;
  roleSummary?: string;
  existsOnDisk: boolean;
  hasLiveSession: boolean;
  activeSessionCount: number;
  lastSessionAt?: string;
  canSpawn: boolean;
  spawnReason?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Phase 6-I — explicit registration / live-load / spawnability status. */
  enabled?: boolean;
  isRegistered: boolean;
  isLiveLoaded: boolean;
  isSpawnable: boolean;
  spawnBlockReason?: SpawnBlockReason;
  /** Phase 6-L — provider / model compatibility (configured agents only). */
  provider?: string;
  model?: string;
  modelCompatibility?: AgentModelCompatibility;
}

export type AgentRegistryMismatchKind =
  | 'definition_file_not_configured'
  | 'session_without_definition'
  | 'unknown_workflow_kind'
  | 'cannot_spawn';

export interface AgentRegistryMismatch {
  kind: AgentRegistryMismatchKind;
  agentId: string;
  summary: string;
}

export interface AgentRegistrySnapshot {
  definitions: AgentDefinition[];
  warnings: AgentRegistryMismatch[];
  scanRoots: string[];
  configuredCount: number;
  fileCount: number;
  liveSessionAgentCount: number;
}

/* ============================================================================
 * Helpers
 * ========================================================================== */

/** Normalize an agent identifier so `qa-reviewer`, `qa_reviewer`, `QA.Reviewer`
 * all collapse to the same key for cross-source merging. */
export function normalizeAgentKey(id: string | null | undefined): string {
  if (!id) return '';
  return id.toLowerCase().replace(/[\s\-./]+/g, '_').replace(/^_+|_+$/g, '');
}

interface ConfiguredAgentRaw {
  id?: string;
  name?: string;
  projectPath?: string;
  status?: string;
  roleId?: string;
  character?: string;
  createdAt?: string;
  lastActivity?: string;
  enabled?: boolean;
  provider?: string;
  model?: string;
}

/** Phase 6-L — compute provider/model compatibility for a configured agent. */
function computeModelCompatibility(c: ConfiguredAgentRaw): AgentModelCompatibility | undefined {
  if (!c.provider) return undefined;
  const r = checkProviderModelCompatibility({ provider: c.provider, model: c.model });
  return {
    ok: r.ok,
    reason: r.reason,
    message: r.message,
    suggestedModel: r.suggestedModel,
  };
}

function safeReadJsonArray(file: string): unknown[] {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray((parsed as { agents?: unknown[] }).agents)) {
      return (parsed as { agents: unknown[] }).agents;
    }
    if (parsed && typeof parsed === 'object') return Object.values(parsed as object);
    return [];
  } catch {
    return [];
  }
}

function readConfiguredAgents(): ConfiguredAgentRaw[] {
  const file = path.join(DATA_DIR, 'agents.json');
  return safeReadJsonArray(file).filter(
    (x): x is ConfiguredAgentRaw => !!x && typeof x === 'object',
  );
}

/**
 * Project root paths from `companies.json` (`projects[].rootPath`). These let a
 * project keep all of its agent `.md` definitions in a single `<root>/.claude/
 * agents` folder instead of scattering them under each sub-project's working
 * dir. Degrades to `[]` on any read/parse error.
 */
function readProjectRootPaths(): string[] {
  try {
    const file = path.join(DATA_DIR, 'companies.json');
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { projects?: unknown };
    const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
    const roots: string[] = [];
    for (const p of projects) {
      const rp = p && typeof p === 'object' ? (p as { rootPath?: unknown }).rootPath : undefined;
      if (typeof rp === 'string' && rp) roots.push(rp);
    }
    return roots;
  } catch {
    return [];
  }
}

/**
 * Extract a short role summary from an agent `.md` file *without* returning the
 * body. Prefers a frontmatter `description:`; falls back to the first non-empty
 * paragraph after the optional frontmatter / first heading. Capped at 240 chars.
 */
export function extractRoleSummary(content: string): string | undefined {
  if (!content) return undefined;
  const MAX = 240;
  // Frontmatter description
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const desc = fm[1].match(/^description:\s*(.+)$/m);
    if (desc) {
      const v = desc[1].trim().replace(/^["']|["']$/g, '');
      if (v) return v.slice(0, MAX);
    }
  }
  // Strip frontmatter, then find first meaningful line that isn't a heading.
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      const h = t.replace(/^#+\s*/, '').trim();
      if (h) return h.slice(0, MAX);
      continue;
    }
    return t.replace(/[*_`>]/g, '').slice(0, MAX);
  }
  return undefined;
}

interface FileAgentRaw {
  id: string;
  displayName: string;
  filePath: string;
  source: 'claude_project_file' | 'claude_user_file';
  roleSummary?: string;
  createdAt?: string;
  updatedAt?: string;
}

function scanAgentDir(
  dir: string,
  source: 'claude_project_file' | 'claude_user_file',
): FileAgentRaw[] {
  const out: FileAgentRaw[] = [];
  try {
    if (!fs.existsSync(dir)) return out;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.md')) continue;
      const full = path.join(dir, entry);
      const id = entry.replace(/\.md$/i, '');
      let roleSummary: string | undefined;
      let createdAt: string | undefined;
      let updatedAt: string | undefined;
      try {
        const content = fs.readFileSync(full, 'utf-8');
        roleSummary = extractRoleSummary(content);
        const stat = fs.statSync(full);
        createdAt = stat.birthtime?.toISOString?.();
        updatedAt = stat.mtime?.toISOString?.();
      } catch {
        /* unreadable file — still surface its existence */
      }
      out.push({
        id,
        displayName: id,
        filePath: full,
        source,
        roleSummary,
        createdAt,
        updatedAt,
      });
    }
  } catch {
    /* unreadable directory — degrade to empty */
  }
  return out;
}

/* ============================================================================
 * Scan-root resolution
 * ========================================================================== */

export interface AgentRegistryOptions {
  /** Extra project paths to scan `<path>/.claude/agents` under. */
  extraProjectPaths?: string[];
  /** Override the configured-agents source for tests. */
  configuredAgents?: ConfiguredAgentRaw[];
  /** Override the file-agent sources for tests (skips disk scan). */
  fileAgents?: FileAgentRaw[];
  /** Override the live sessions source for tests (skips DB read). */
  sessions?: AgentSession[];
  /** Include the user-level `~/.claude/agents` scan. Default true. */
  includeUserDir?: boolean;
  /** Override scan roots entirely for tests. */
  scanRoots?: string[];
  /**
   * Phase 6-I — ids currently present in the agent-manager in-memory map.
   * Injected by the IPC layer so `isLiveLoaded` / `isSpawnable` reflect the
   * running process. When omitted, configured agents are assumed loaded.
   */
  liveLoadedAgentIds?: string[];
}

function resolveScanRoots(
  configured: ConfiguredAgentRaw[],
  opts: AgentRegistryOptions,
): { projectAgentDirs: string[]; userAgentDir: string | null } {
  if (opts.scanRoots) {
    return { projectAgentDirs: opts.scanRoots, userAgentDir: null };
  }
  const projectPaths = new Set<string>();
  for (const a of configured) {
    if (a.projectPath) projectPaths.add(a.projectPath);
  }
  for (const p of opts.extraProjectPaths ?? []) projectPaths.add(p);
  // Also scan each registered project's ROOT `.claude/agents` (companies.json),
  // so definitions kept in one folder at the project root are discovered too —
  // not just the ones under each agent's sub-project working dir. Skipped when
  // `fileAgents` are injected (tests) so the build stays disk-free.
  if (!opts.fileAgents) {
    for (const root of readProjectRootPaths()) projectPaths.add(root);
  }

  const projectAgentDirs = Array.from(projectPaths).map(p =>
    path.join(p, '.claude', 'agents'),
  );
  const userAgentDir =
    opts.includeUserDir === false
      ? null
      : path.join(os.homedir(), '.claude', 'agents');
  return { projectAgentDirs, userAgentDir };
}

/* ============================================================================
 * Public surface
 * ========================================================================== */

/**
 * Build the merged registry snapshot. Pure-ish: with all three sources passed
 * via `opts` it touches neither disk nor DB (used by tests).
 */
export function buildAgentRegistry(opts: AgentRegistryOptions = {}): AgentRegistrySnapshot {
  const configured = opts.configuredAgents ?? readConfiguredAgents();

  // --- file agents
  const { projectAgentDirs, userAgentDir } = resolveScanRoots(configured, opts);
  const scanRoots = [...projectAgentDirs, ...(userAgentDir ? [userAgentDir] : [])];
  let fileAgents: FileAgentRaw[];
  if (opts.fileAgents) {
    fileAgents = opts.fileAgents;
  } else {
    fileAgents = [];
    for (const dir of projectAgentDirs) {
      fileAgents.push(...scanAgentDir(dir, 'claude_project_file'));
    }
    if (userAgentDir) {
      fileAgents.push(...scanAgentDir(userAgentDir, 'claude_user_file'));
    }
  }

  // --- live sessions
  const sessions = opts.sessions ?? safeListSessions();

  // --- merge ---------------------------------------------------------------
  const defs = new Map<string, AgentDefinition>();

  // 1) file agents (keyed by normalized slug). The first wins on duplicate
  //    slugs across project + user dirs; later ones are ignored but counted.
  for (const fa of fileAgents) {
    const key = normalizeAgentKey(fa.id);
    if (defs.has(key)) continue;
    defs.set(key, {
      id: fa.id,
      displayName: fa.displayName,
      source: fa.source,
      filePath: fa.filePath,
      workflowKind: resolveWorkflowKindForAgent(fa.id),
      roleSummary: fa.roleSummary,
      existsOnDisk: true,
      hasLiveSession: false,
      activeSessionCount: 0,
      canSpawn: false,
      spawnReason:
        'Definition file present but not registered in agents.json (auto-registration disabled this phase).',
      createdAt: fa.createdAt,
      updatedAt: fa.updatedAt,
      isRegistered: false,
      isLiveLoaded: false,
      isSpawnable: false,
    });
  }

  // 2) configured agents (keyed by their own id — UUIDs won't collide with
  //    slugs). These are spawnable because the dashboard knows how to start
  //    them. We try to link a matching file definition by workflowKind/name.
  for (const c of configured) {
    if (!c.id) continue;
    const key = normalizeAgentKey(c.id);
    const wfFromRole = resolveWorkflowKindForAgent(c.roleId ?? c.id);

    // Phase 6-G — a configured record whose id matches an already-scanned file
    // definition (i.e. a manually-registered file agent) MERGES into that
    // file def: keep its file source / path / roleSummary, but mark it linked
    // + spawnable. Never overwrite the richer file entry with a bare record.
    const modelCompatibility = computeModelCompatibility(c);
    const existing = defs.get(key);
    if (existing && (existing.source === 'claude_project_file' || existing.source === 'claude_user_file')) {
      existing.configuredAgentId = c.id;
      existing.canSpawn = true;
      existing.spawnReason = undefined;
      if (typeof c.enabled === 'boolean') existing.enabled = c.enabled;
      existing.provider = c.provider;
      existing.model = c.model;
      existing.modelCompatibility = modelCompatibility;
      continue;
    }

    defs.set(key, {
      id: c.id,
      displayName: c.name?.trim() || c.id,
      source: 'configured',
      configuredAgentId: c.id,
      workflowKind: wfFromRole,
      roleSummary: undefined,
      existsOnDisk: false,
      hasLiveSession: false,
      activeSessionCount: 0,
      canSpawn: true,
      createdAt: c.createdAt,
      updatedAt: c.lastActivity,
      enabled: typeof c.enabled === 'boolean' ? c.enabled : undefined,
      isRegistered: false,
      isLiveLoaded: false,
      isSpawnable: false,
      provider: c.provider,
      model: c.model,
      modelCompatibility,
    });
  }

  // 3) merge live sessions, grouped by normalized agentId.
  const sessionGroups = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    const key = normalizeAgentKey(s.agentId);
    if (!key) continue;
    const arr = sessionGroups.get(key) ?? [];
    arr.push(s);
    sessionGroups.set(key, arr);
  }

  for (const [key, group] of sessionGroups) {
    const active = group.filter(s => !s.exitedAt).length;
    const lastSessionAt = group
      .map(s => s.startedAt)
      .filter(Boolean)
      .sort()
      .at(-1);
    const existing = defs.get(key);
    if (existing) {
      existing.hasLiveSession = active > 0;
      existing.activeSessionCount = active;
      existing.lastSessionAt = lastSessionAt;
    } else {
      // AgentSession exists but no definition file / configured entry.
      const sampleId = group[0]?.agentId ?? key;
      defs.set(key, {
        id: sampleId,
        displayName: sampleId,
        source: 'live_session',
        workflowKind: resolveWorkflowKindForAgent(sampleId),
        existsOnDisk: false,
        hasLiveSession: active > 0,
        activeSessionCount: active,
        lastSessionAt,
        canSpawn: false,
        spawnReason: 'Running session has no definition file or configured entry.',
        isRegistered: false,
        isLiveLoaded: false,
        isSpawnable: false,
      });
    }
  }

  // Phase 6-I — compute registration / live-load / spawnability for each def.
  // `liveLoadedAgentIds` is the agent-manager in-memory map (injected by the
  // IPC layer). When absent (tests / no live process), we assume a configured
  // agent is loaded so the field stays meaningful.
  const liveSet = opts.liveLoadedAgentIds
    ? new Set(opts.liveLoadedAgentIds.map(normalizeAgentKey))
    : null;
  for (const [key, d] of defs) {
    d.isRegistered = d.source === 'configured' || !!d.configuredAgentId;
    d.isLiveLoaded = liveSet ? liveSet.has(key) : d.isRegistered;
    if (!d.isRegistered) {
      d.isSpawnable = false;
      d.spawnBlockReason = d.existsOnDisk ? 'not_registered' : 'missing_definition';
    } else if (d.enabled === false) {
      d.isSpawnable = false;
      d.spawnBlockReason = 'disabled';
    } else if (!d.isLiveLoaded) {
      d.isSpawnable = false;
      d.spawnBlockReason = 'not_live_loaded';
    } else {
      // provider availability is not verified here (TODO) — treat as spawnable.
      d.isSpawnable = true;
      d.spawnBlockReason = undefined;
    }
  }

  const definitions = Array.from(defs.values()).sort((a, b) => {
    // Live sessions first, then configured, then file-only; alpha within.
    const rank = (d: AgentDefinition) =>
      d.hasLiveSession ? 0 : d.source === 'configured' ? 1 : 2;
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return a.displayName.localeCompare(b.displayName);
  });

  const warnings = computeMismatches(definitions);

  return {
    definitions,
    warnings,
    scanRoots,
    configuredCount: configured.length,
    fileCount: fileAgents.length,
    liveSessionAgentCount: sessionGroups.size,
  };
}

function safeListSessions(): AgentSession[] {
  try {
    return listAgentSessions({ limit: 500 });
  } catch {
    return [];
  }
}

export function computeMismatches(definitions: AgentDefinition[]): AgentRegistryMismatch[] {
  const warnings: AgentRegistryMismatch[] = [];
  for (const d of definitions) {
    if (
      (d.source === 'claude_project_file' || d.source === 'claude_user_file') &&
      !d.configuredAgentId
    ) {
      warnings.push({
        kind: 'definition_file_not_configured',
        agentId: d.id,
        summary: `Definition file "${d.id}" exists on disk but is not registered in agents.json.`,
      });
    }
    if (d.source === 'live_session') {
      warnings.push({
        kind: 'session_without_definition',
        agentId: d.id,
        summary: `Agent "${d.id}" has a session but no definition file or configured entry.`,
      });
    }
    if (d.workflowKind === 'generic' || !d.workflowKind) {
      warnings.push({
        kind: 'unknown_workflow_kind',
        agentId: d.id,
        summary: `Agent "${d.id}" maps to the generic workflow (no named role template).`,
      });
    }
    if (!d.canSpawn) {
      warnings.push({
        kind: 'cannot_spawn',
        agentId: d.id,
        summary: d.spawnReason ?? `Agent "${d.id}" cannot be spawned.`,
      });
    }
  }
  return warnings;
}

/** Convenience single-agent lookup (by id or normalized key). */
export function getAgentDefinition(
  agentId: string,
  opts: AgentRegistryOptions = {},
): AgentDefinition | null {
  const key = normalizeAgentKey(agentId);
  const snap = buildAgentRegistry(opts);
  return snap.definitions.find(d => normalizeAgentKey(d.id) === key) ?? null;
}

export function listAgentDefinitions(opts: AgentRegistryOptions = {}): AgentDefinition[] {
  return buildAgentRegistry(opts).definitions;
}
