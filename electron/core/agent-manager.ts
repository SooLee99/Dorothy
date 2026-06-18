import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import { BrowserWindow, Notification } from 'electron';
import { AgentStatus, AppSettings } from '../types';
import { broadcastToAllWindows } from '../utils/broadcast';
import { AGENTS_FILE, DATA_DIR } from '../constants';
import { ensureDataDir, isSuperAgent } from '../utils';
import { ptyProcesses } from './pty-manager';
import { buildFullPath } from '../utils/path-builder';
import { getProvider } from '../providers';
import { extractStatusLine } from '../utils/ansi';
import { scheduleTick } from '../utils/agents-tick';
import { recordStart, recordOutput, recordExit } from './observability/session-metrics';

export const agents: Map<string, AgentStatus> = new Map();

export let agentsLoaded = false;
export let superAgentTelegramTask = false;
export let superAgentOutputBuffer: string[] = [];

export function setSuperAgentTelegramTask(value: boolean) {
  superAgentTelegramTask = value;
}

export function getSuperAgentOutputBuffer(): string[] {
  return superAgentOutputBuffer;
}

export function clearSuperAgentOutputBuffer() {
  superAgentOutputBuffer = [];
}

const previousAgentStatus: Map<string, string> = new Map();

const pendingStatusChanges: Map<string, {
  newStatus: string;
  scheduledAt: number;
  timeoutId: NodeJS.Timeout;
}> = new Map();

export function handleStatusChangeNotification(
  agent: AgentStatus,
  newStatus: string,
  appSettings: AppSettings,
  sendNotification: (title: string, body: string, agentId?: string, settings?: { notificationsEnabled: boolean }) => void,
  sendTelegramMessage?: (text: string) => void,
  sendSuperAgentResponseToTelegram?: (agent: AgentStatus) => void
) {
  const prevStatus = previousAgentStatus.get(agent.id);

  if (!prevStatus) {
    previousAgentStatus.set(agent.id, newStatus);
    return;
  }

  if (prevStatus === newStatus) {
    return;
  }

  if (newStatus === 'running') {
    const pending = pendingStatusChanges.get(agent.id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingStatusChanges.delete(agent.id);
    }
    previousAgentStatus.set(agent.id, newStatus);
    return;
  }

  const pending = pendingStatusChanges.get(agent.id);

  if (pending && pending.newStatus === newStatus) {
    return;
  }

  if (pending) {
    clearTimeout(pending.timeoutId);
  }

  const timeoutId = setTimeout(() => {
    pendingStatusChanges.delete(agent.id);

    const currentAgent = agents.get(agent.id);
    if (!currentAgent || currentAgent.status !== newStatus) {
      return;
    }

    previousAgentStatus.set(agent.id, newStatus);

    const agentName = currentAgent.name || `Agent ${currentAgent.id.slice(0, 6)}`;
    const isSuper = isSuperAgent(currentAgent);

    if (newStatus === 'waiting') {
      if (!isSuper && appSettings.notifyOnWaiting) {
        sendNotification(
          `${agentName} — 확인이 필요합니다`,
          '에이전트가 입력을 기다리고 있습니다.',
          currentAgent.id,
          appSettings
        );
      }
      if (isSuper && superAgentTelegramTask && sendSuperAgentResponseToTelegram) {
        sendSuperAgentResponseToTelegram(currentAgent);
        superAgentTelegramTask = false;
      }
    } else if (newStatus === 'completed' && appSettings.notifyOnComplete) {
      if (!isSuper) {
        sendNotification(
          `${agentName} — 작업 완료`,
          currentAgent.currentTask ? `완료: ${currentAgent.currentTask.slice(0, 50)}...` : '작업을 성공적으로 완료했습니다.',
          currentAgent.id,
          appSettings
        );
      }
      if (isSuper && superAgentTelegramTask && sendSuperAgentResponseToTelegram) {
        sendSuperAgentResponseToTelegram(currentAgent);
        superAgentTelegramTask = false;
      }
    } else if (newStatus === 'error' && appSettings.notifyOnError) {
      if (!isSuper) {
        sendNotification(
          `${agentName} — 오류 발생`,
          currentAgent.error || '실행 중 오류가 발생했습니다.',
          currentAgent.id,
          appSettings
        );
      }
      if (isSuper && superAgentTelegramTask && sendTelegramMessage) {
        sendTelegramMessage(`🔴 슈퍼 에이전트 오류: ${currentAgent.error || '오류가 발생했습니다.'}`);
        superAgentTelegramTask = false;
      }
    }
  }, 5000);

  pendingStatusChanges.set(agent.id, {
    newStatus,
    scheduledAt: Date.now(),
    timeoutId,
  });
}

export function saveAgents() {
  try {
    if (!agentsLoaded) {
      console.log('Skipping save - agents not loaded yet');
      return;
    }

    ensureDataDir();
    const agentsArray = Array.from(agents.values()).map(agent => ({
      ...agent,
      ptyId: undefined,
      pathMissing: undefined,
      // Phase 6-V — slug/file-based agents may load without an output array;
      // never assume it exists or saveAgents() throws and persistence is lost.
      output: (agent.output ?? []).slice(-100),
      status: agent.status === 'running' ? 'idle' : agent.status,
    }));

    if (fs.existsSync(AGENTS_FILE)) {
      const existingContent = fs.readFileSync(AGENTS_FILE, 'utf-8');
      if (existingContent.trim().length > 2) {
        const backupFile = path.join(DATA_DIR, 'agents.backup.json');
        fs.writeFileSync(backupFile, existingContent);
      }
    }

    fs.writeFileSync(AGENTS_FILE, JSON.stringify(agentsArray, null, 2));
    console.log(`Saved ${agentsArray.length} agents to disk`);
  } catch (err) {
    console.error('Failed to save agents:', err);
  }
}

export function loadAgents() {
  try {
    if (!fs.existsSync(AGENTS_FILE)) {
      console.log('No agents file found, starting fresh');
      agentsLoaded = true;
      return;
    }

    const data = fs.readFileSync(AGENTS_FILE, 'utf-8');

    if (!data.trim() || data.trim() === '[]') {
      console.log('Agents file is empty, checking for backup...');
      const backupFile = path.join(DATA_DIR, 'agents.backup.json');
      if (fs.existsSync(backupFile)) {
        const backupData = fs.readFileSync(backupFile, 'utf-8');
        if (backupData.trim() && backupData.trim() !== '[]') {
          console.log('Restoring agents from backup...');
          fs.writeFileSync(AGENTS_FILE, backupData);
          loadAgents();
          return;
        }
      }
      agentsLoaded = true;
      return;
    }

    const agentsArray = JSON.parse(data) as AgentStatus[];

    for (const agent of agentsArray) {
      const workingPath = agent.worktreePath || agent.projectPath;
      if (!fs.existsSync(workingPath)) {
        console.warn(`Agent ${agent.id} has missing path: ${workingPath} - marking as pathMissing`);
        agent.pathMissing = true;
      } else {
        agent.pathMissing = false;
      }

      agent.status = 'idle';
      agent.ptyId = undefined;
      agent.pid = undefined; // 순서3 — load/reset 시 stale pid 제거.

      // Phase 6-V — slug/file-based records have no `output`; initialize it so
      // saveAgents()/the /output endpoint never call .slice on undefined.
      if (!Array.isArray(agent.output)) agent.output = [];
      // Phase 6-X — same for `skills` (the /agents cards call agent.skills.length).
      if (!Array.isArray(agent.skills)) agent.skills = [];

      // Migrate legacy skipPermissions boolean → permissionMode
      if (!agent.permissionMode) {
        agent.permissionMode = agent.skipPermissions ? 'auto' : 'normal';
      }

      // Backfill createdAt for legacy agents using lastActivity
      if (!agent.createdAt) {
        agent.createdAt = agent.lastActivity || new Date().toISOString();
      }

      agents.set(agent.id, agent);
    }

    console.log(`Loaded ${agents.size} agents from disk`);
    agentsLoaded = true;
  } catch (err) {
    console.error('Failed to load agents:', err);
    agentsLoaded = true;
  }
}

export interface ReloadAgentsResult {
  ok: boolean;
  beforeCount: number;
  afterCount: number;
  addedAgentIds: string[];
  removedAgentIds: string[];
  updatedAgentIds?: string[];
  preservedActiveSessionIds?: string[];
  warnings?: string[];
  error?: string;
  /** Phase 6-I — set when this call coalesced onto an in-flight reload. */
  alreadyInProgress?: boolean;
}

export interface ReloadAgentsOptions {
  /** Always true in practice — runtime fields are never clobbered. */
  preserveRuntimeState?: boolean;
  /**
   * Phase 6-I — when true, refresh *safe* metadata fields (name, provider,
   * model, skills, definitionPath, workflowKind, enabled, permissionMode) on
   * agents that already exist in memory. Runtime fields (status, ptyId,
   * processId, waitingForUserInput, output, timestamps) are ALWAYS preserved.
   * Default false (Phase 6-H behavior: existing agents untouched).
   */
  mergeMetadataForExisting?: boolean;
  reason?: string;
}

/** Runtime fields that must NEVER be overwritten by a metadata merge. */
const RUNTIME_PRESERVED_FIELDS = [
  'status', 'ptyId', 'processId', 'pid', 'waitingForUserInput',
  'output', 'lastActivity', 'createdAt', 'statusLine', 'lastCleanOutput',
  'currentTask', 'pathMissing',
] as const;

/** Metadata fields safe to refresh from disk when mergeMetadataForExisting. */
const SAFE_MERGE_FIELDS = [
  'name', 'provider', 'model', 'localModel', 'skills', 'definitionPath',
  'workflowKind', 'enabled', 'permissionMode', 'character', 'effort',
  'projectPath', 'secondaryProjectPath', 'obsidianVaultPaths', 'savedPrompt',
  'source', 'branchName',
] as const;

// Phase 6-I — concurrency guard. Concurrent callers coalesce onto one reload so
// the file is read + merged exactly once; later callers get the same result
// flagged `alreadyInProgress`.
let reloadInFlight: Promise<ReloadAgentsResult> | null = null;

/**
 * Phase 6-H — re-read agents.json into the live in-memory map WITHOUT
 * disturbing running agents.
 *
 * Unlike `loadAgents()` (which resets status/ptyId on every record), this:
 *   - ADDS records that are new on disk but absent in memory.
 *   - LEAVES existing in-memory agents fully intact (status, ptyId, PTY,
 *     output, runtime flags) so active sessions are never reset or killed.
 *   - NEVER removes agents that vanished from disk while a session is live;
 *     it only reports them as `removedAgentIds` + a warning (no kill here).
 *   - On read/parse failure, leaves the in-memory map untouched.
 *
 * Because newly-registered agents land in the live map, the next periodic
 * `saveAgents()` will *persist* them rather than clobbering agents.json with a
 * stale snapshot — this is what closes the Phase 6-G overwrite gap.
 *
 * This function only reads agents.json + mutates the in-memory map. It never
 * writes agents.json, never touches `.md` definitions, never touches skills,
 * and never logs secret/token values.
 */
export async function reloadAgentsFromDisk(options?: ReloadAgentsOptions): Promise<ReloadAgentsResult> {
  // Concurrency guard — coalesce concurrent reloads onto one file read/merge.
  if (reloadInFlight) {
    const shared = await reloadInFlight;
    return { ...shared, alreadyInProgress: true };
  }
  reloadInFlight = _doReloadAgentsFromDisk(options);
  try {
    return await reloadInFlight;
  } finally {
    reloadInFlight = null;
  }
}

async function _doReloadAgentsFromDisk(options?: ReloadAgentsOptions): Promise<ReloadAgentsResult> {
  const beforeIds = new Set(agents.keys());
  const beforeCount = agents.size;
  const warnings: string[] = [];
  const mergeMeta = options?.mergeMetadataForExisting === true;

  try {
    if (!fs.existsSync(AGENTS_FILE)) {
      return {
        ok: false,
        beforeCount,
        afterCount: beforeCount,
        addedAgentIds: [],
        removedAgentIds: [],
        error: 'agents.json not found',
      };
    }

    const data = fs.readFileSync(AGENTS_FILE, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return {
        ok: false,
        beforeCount,
        afterCount: beforeCount,
        addedAgentIds: [],
        removedAgentIds: [],
        error: 'agents.json is not valid JSON; in-memory state left untouched',
      };
    }

    // Tolerate both the array form and a `{ agents: [] }` wrapper.
    const list: AgentStatus[] = Array.isArray(parsed)
      ? (parsed as AgentStatus[])
      : Array.isArray((parsed as { agents?: unknown }).agents)
        ? ((parsed as { agents: AgentStatus[] }).agents)
        : [];

    if (!Array.isArray(parsed) && !Array.isArray((parsed as { agents?: unknown }).agents)) {
      return {
        ok: false,
        beforeCount,
        afterCount: beforeCount,
        addedAgentIds: [],
        removedAgentIds: [],
        error: 'Unrecognized agents.json structure; in-memory state left untouched',
      };
    }

    const fileIds = new Set<string>();
    const addedAgentIds: string[] = [];
    const updatedAgentIds: string[] = [];

    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || !raw.id) continue;
      fileIds.add(raw.id);

      // Existing in-memory agent.
      const existing = agents.get(raw.id);
      if (existing) {
        // Phase 6-I — optional safe-metadata merge. Runtime fields are never
        // touched; only whitelisted metadata fields are refreshed.
        if (mergeMeta) {
          let changed = false;
          const rawRec = raw as unknown as Record<string, unknown>;
          const existRec = existing as unknown as Record<string, unknown>;
          for (const f of SAFE_MERGE_FIELDS) {
            if ((RUNTIME_PRESERVED_FIELDS as readonly string[]).includes(f)) continue;
            if (!(f in rawRec)) continue;
            const next = rawRec[f];
            if (JSON.stringify(existRec[f]) !== JSON.stringify(next)) {
              existRec[f] = next;
              changed = true;
            }
          }
          if (changed) updatedAgentIds.push(existing.id);
        }
        // Always preserve runtime state — never reset status/ptyId here.
        continue;
      }

      // New agent → add it, mirroring loadAgents()'s per-record hygiene but
      // starting clean (no PTY).
      const agent = { ...raw } as AgentStatus;
      const workingPath = agent.worktreePath || agent.projectPath;
      agent.pathMissing = workingPath ? !fs.existsSync(workingPath) : true;
      agent.status = 'idle';
      agent.ptyId = undefined;
      agent.pid = undefined; // 순서3 — load/reset 시 stale pid 제거.
      // Phase 6-V/6-X — ensure output + skills arrays exist (see loadAgents()).
      if (!Array.isArray(agent.output)) agent.output = [];
      if (!Array.isArray(agent.skills)) agent.skills = [];
      if (!agent.permissionMode) {
        agent.permissionMode = agent.skipPermissions ? 'auto' : 'normal';
      }
      if (!agent.createdAt) {
        agent.createdAt = agent.lastActivity || new Date().toISOString();
      }
      agents.set(agent.id, agent);
      addedAgentIds.push(agent.id);
    }

    // Agents present in memory but gone from disk — do NOT remove here.
    const removedAgentIds: string[] = [];
    for (const id of beforeIds) {
      if (!fileIds.has(id)) removedAgentIds.push(id);
    }
    if (removedAgentIds.length > 0) {
      warnings.push(
        `${removedAgentIds.length} agent(s) are in memory but absent from agents.json; not removed (Phase 6-H keeps them).`,
      );
    }

    // Sessions we are explicitly preserving (anything with a live PTY or a
    // non-idle status).
    const preservedActiveSessionIds = Array.from(agents.values())
      .filter(a => a.ptyId || a.status === 'running' || a.status === 'waiting')
      .map(a => a.id);

    // agentsLoaded must stay true so the next saveAgents() persists the
    // freshly-added agents instead of skipping.
    agentsLoaded = true;

    // Nudge the renderer's live agent list.
    try { scheduleTick(); } catch { /* tick is best-effort */ }

    if (options?.reason) {
      console.log(`[agent-manager] reloadAgentsFromDisk (${options.reason}): +${addedAgentIds.length} added, ${updatedAgentIds.length} updated, ${removedAgentIds.length} missing-from-disk`);
    }

    return {
      ok: true,
      beforeCount,
      afterCount: agents.size,
      addedAgentIds,
      removedAgentIds,
      updatedAgentIds: updatedAgentIds.length ? updatedAgentIds : undefined,
      preservedActiveSessionIds,
      warnings: warnings.length ? warnings : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      beforeCount,
      afterCount: agents.size,
      addedAgentIds: [],
      removedAgentIds: [],
      error: err instanceof Error ? err.message : 'reload failed',
    };
  }
}

export async function initAgentPty(
  agent: AgentStatus,
  mainWindow: BrowserWindow | null,
  handleStatusChangeNotificationCallback: (agent: AgentStatus, newStatus: string) => void,
  saveAgentsCallback: () => void
): Promise<string> {
  const shell = '/bin/bash';
  let cwd = agent.worktreePath || agent.projectPath;

  if (!fs.existsSync(cwd)) {
    console.warn(`Agent ${agent.id} cwd does not exist: ${cwd} — falling back to home directory`);
    cwd = os.homedir();
  }

  console.log(`Initializing PTY for restored agent ${agent.id} in ${cwd}`);

  // Build PATH that includes user-configured paths, nvm, and other common locations for claude
  const cliExtraPaths: string[] = [];
  let savedSettings: Record<string, unknown> = {};
  try {
    const settingsFile = path.join(os.homedir(), '.dorothy', 'app-settings.json');
    if (fs.existsSync(settingsFile)) {
      savedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      const cliPaths = savedSettings.cliPaths as Record<string, unknown> | undefined;
      if (cliPaths) {
        for (const key of ['claude', 'codex', 'gemini', 'gws', 'gh', 'node']) {
          if (cliPaths[key]) {
            cliExtraPaths.push(path.dirname(cliPaths[key] as string));
          }
        }
        if (cliPaths.additionalPaths) {
          cliExtraPaths.push(...(cliPaths.additionalPaths as string[]).filter(Boolean));
        }
      }
    }
  } catch {
    // Ignore settings load errors
  }
  const fullPath = buildFullPath(cliExtraPaths);

  // For local provider, bake Tasmania env vars into the PTY process environment
  let tasmaniaEnv: Record<string, string> = {};
  if (agent.provider === 'local') {
    try {
      const { getTasmaniaStatus } = require('../services/tasmania-client') as typeof import('../services/tasmania-client');
      const tasmaniaStatus = await getTasmaniaStatus();
      if (tasmaniaStatus.status === 'running' && tasmaniaStatus.endpoint) {
        const localModel = agent.localModel || tasmaniaStatus.modelName || 'default';
        // Strip /v1 suffix — Claude Code SDK appends /v1/messages itself
        const baseUrl = tasmaniaStatus.endpoint!.replace(/\/v1\/?$/, '');
        tasmaniaEnv = {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_MODEL: localModel,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        };
      } else {
        console.warn(`Agent ${agent.id} is local provider but Tasmania is not running — PTY created without Tasmania env vars`);
      }
    } catch (err) {
      console.warn(`Failed to get Tasmania status for agent ${agent.id}:`, err);
    }
  }

  // Get provider-specific env vars
  const agentProvider = getProvider(agent.provider);
  const providerEnvVars = agentProvider.getPtyEnvVars(agent.id, agent.projectPath, agent.skills);

  const ptyProcess = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: {
      ...process.env as { [key: string]: string },
      PATH: fullPath,
      ...providerEnvVars,
      // Load CLAUDE.md from --add-dir directories (e.g. ~/.dorothy)
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      ...tasmaniaEnv,
    },
  });

  const ptyId = uuidv4();
  ptyProcesses.set(ptyId, ptyProcess);
  recordStart(ptyId, agent.id, ptyProcess.pid); // PR-0a — 세션 계측 시작(O(1), out-of-band)
  agent.pid = ptyProcess.pid; // 순서3 — pid를 레지스트리에 영속(agents.json) → 리컨실러가 프로세스↔에이전트 매핑.

  ptyProcess.onData((data) => {
    recordOutput(ptyId, data); // PR-0a — O(1) 계측(byteCount/lineCount/lastOutputAt)
    const agentData = agents.get(agent.id);
    if (agentData) {
      agentData.output.push(data);
      agentData.lastActivity = new Date().toISOString();
      agentData.statusLine = extractStatusLine(agentData.output);

      if (superAgentTelegramTask && isSuperAgent(agentData)) {
        superAgentOutputBuffer.push(data);
        if (superAgentOutputBuffer.length > 200) {
          superAgentOutputBuffer = superAgentOutputBuffer.slice(-100);
        }
      }
    }
    broadcastToAllWindows('agent:output', {
      type: 'output',
      agentId: agent.id,
      ptyId,
      data,
      timestamp: new Date().toISOString(),
    });
    scheduleTick();
  });

  ptyProcess.onExit(({ exitCode }) => {
    recordExit(ptyId, exitCode); // PR-0a — 종료 계측(exitCode)
    console.log(`Agent ${agent.id} PTY exited with code ${exitCode}`);
    const agentData = agents.get(agent.id);
    // Guard: only mutate if this PTY is still the active one (prevents race on restart/stop)
    if (agentData && agentData.ptyId === ptyId) {
      const newStatus = exitCode === 0 ? 'completed' : 'error';
      agentData.status = newStatus;
      agentData.pid = undefined; // 순서3 — 종료 시 pid 비움(dead 잔존·오매칭 방지).
      agentData.lastActivity = new Date().toISOString();
      handleStatusChangeNotificationCallback(agentData, newStatus);
      saveAgentsCallback();
    }
    ptyProcesses.delete(ptyId);
    broadcastToAllWindows('agent:complete', {
      type: 'complete',
      agentId: agent.id,
      ptyId,
      exitCode,
      timestamp: new Date().toISOString(),
    });
    scheduleTick();
  });

  return ptyId;
}
