/**
 * Dorothy MVP — IPC handlers for Run-centric reads/writes.
 *
 * All channels return plain JSON. Each handler defensively wraps the call
 * so a thrown error in the new code path cannot crash the renderer — the
 * renderer should treat a missing payload as "feature unavailable" and fall
 * back to the legacy views.
 *
 * Channels (matching the user spec):
 *   dorothy:runs:list
 *   dorothy:runs:get
 *   dorothy:runs:create
 *   dorothy:runs:updateState
 *   dorothy:sessions:list
 *   dorothy:artifacts:list
 *   dorothy:handoffs:list
 *   dorothy:plans:list
 *   dorothy:plans:get
 */

import { ipcMain } from 'electron';
import {
  createRun,
  getRun,
  listRuns,
  updateRunState,
  listRunStepsByRun,
  listAgentSessions,
  listArtifacts,
  getArtifact,
  listArtifactsByIds,
  listHandoffsByRun,
  getPlan,
  listPlans,
  getDorothyDb,
  // Phase 3 + 4 additions
  advanceRun,
  advanceAllRuns,
  validatePlan,
  recordRateLimitEventAndBlockRuns,
  resumeRateLimitEvent,
  listRateLimitEvents,
  // Phase 5A additions
  getPullRequest,
  listPullRequests,
  listPullRequestsByRun,
  getCIRun,
  listCIRuns,
  listCIRunsByRun,
  listCIRunsByPullRequest,
  // Phase 5C-B additions
  resumeNow as schedulerResumeNow,
  runTick as schedulerRunTick,
  normalizeAutoResumeMode,
  listImprovementSignals,
  listImprovementSignalsByRun,
  updateImprovementSignalStatus,
  convertImprovementSignalToKanbanTask,
} from '../services/dorothy';
import { updateRunMode as svcUpdateRunMode } from '../services/dorothy/run-service';
import type {
  ImprovementSignalStatus,
  HookEventType,
  HookEventSeverity,
  HookEventSource,
} from '../types/dorothy';
import { listRateLimitEvents as listRateLimitEventsExt } from '../services/dorothy/rate-limit-service';
import { RUN_MODE_POLICIES } from '../services/dorothy/run-mode-policy';
import { decideRunMode } from '../services/dorothy/run-mode-router';
import {
  listHookEvents,
  listHookEventsByRun,
  listHookEventsBySession,
  listRecentHookEvents,
} from '../services/dorothy/hook-event-service';
import {
  listDiagnostics,
  listDiagnosticsByRun,
  getDiagnostic,
  updateDiagnosticStatus,
  convertDiagnosticToImprovementSignal,
  countDiagnostics,
} from '../services/dorothy/diagnostic-service';
import {
  listWorkflowProgress,
  listWorkflowProgressByRun,
  listWorkflowProgressBySession,
  getWorkflowProgress,
  recomputeWorkflowProgressForRun,
  countWorkflowProgress,
} from '../services/dorothy/agent-workflow-progress-service';
import {
  listSkillCandidates,
  listSkillCandidatesByRun,
  getSkillCandidate,
  updateSkillCandidateStatus,
  convertImprovementSignalToSkillCandidate,
  convertDiagnosticToSkillCandidate,
  convertSkillCandidateToKanbanTask,
  countSkillCandidates,
} from '../services/dorothy/skill-candidate-service';
import {
  createAppCandidate,
  listAppCandidates,
  getAppCandidate,
  updateAppCandidateStatus,
  createAppFactoryPlan,
  listAppFactoryPlans,
  getAppFactoryPlan,
  generateAppFactoryPlanPreview,
  seedDefaultAppCandidates,
  countAppFactory,
} from '../services/dorothy/app-factory-service';
import type {
  CreateAppCandidateInput,
  AppCandidateStatus,
  AppImplementationDifficulty,
  AppFactoryPlanStatus,
} from '../types/dorothy';
import type {
  DiagnosticSource,
  DiagnosticSeverity,
  DiagnosticStatus,
  AgentWorkflowKind,
  AgentWorkflowProgressStatus,
  SkillCandidateCategory,
  SkillCandidateSource,
  SkillCandidateSeverity,
  SkillCandidateStatus,
} from '../types/dorothy';
// Phase 6-E — Agent Definition Registry + Idle Reason + Communication Timeline.
import {
  buildAgentRegistry,
  getAgentDefinition,
} from '../services/dorothy/agent-definition-registry';
import {
  computeIdleStatuses,
  getIdleStatus,
} from '../services/dorothy/agent-idle-reason-service';
import {
  listCommunicationByRun,
  listCommunicationByAgent,
  listRecentCommunication,
} from '../services/dorothy/agent-communication-service';
// Phase 6-G — Agent Definition manual registration.
import {
  previewAgentRegistration,
  registerAgentDefinition,
  listRegistrationCandidates,
  type RegisterAgentDefinitionOptions,
} from '../services/dorothy/agent-registration-service';
import { safeCreateHookEvent } from '../services/dorothy/hook-event-service';
// Phase 6-J — dispatch readiness (dry-run diagnosis).
import {
  computeDispatchReadiness,
  countDispatchReadiness,
} from '../services/dorothy/agent-dispatch-readiness-service';
// Phase 6-H — live agent-manager reload result shape.
import type { ReloadAgentsResult } from '../core/agent-manager';
// Phase 6-K — Claude binary + launch readiness.
import * as fsK from 'fs';
import * as pathK from 'path';
// Phase 6-AE — live agent map + read-only masked snapshot builders.
import { agents as liveAgentsMap } from '../core/agent-manager';
import {
  buildAgentTerminalSnapshot,
  buildBaselineSnapshots,
  isSnapshotBaselineAgent,
  type AgentLike,
} from '../core/terminal-output-mask';
import { resolveClaudeBinaryPath } from '../core/claude-binary-resolver';
import { checkClaudeLaunchReadiness } from '../core/claude-launch-readiness';
import {
  detectStaleProviderModelSessions,
  getCodexRuntimeReadiness,
} from '../services/dorothy/codex-runtime-service';
import {
  listWarmupTargets,
  buildWarmupPrompt,
  previewCodexModelNormalization,
  normalizeCodexModels,
  WARMUP_MARKER,
  type AgentWarmupResult,
} from '../services/dorothy/agent-warmup-service';
import { listAgentSessions as listAgentSessionsForCodex } from '../services/dorothy/agent-session-service';
import { DATA_DIR, APP_SETTINGS_FILE } from '../constants';

/** Phase 6-M — read app-settings defaults / cliPaths.codex, swallowing errors. */
function readCodexSettings(): { configuredCodexPath?: string; defaultCodexModel?: string } {
  try {
    if (!fsK.existsSync(APP_SETTINGS_FILE)) return {};
    const s = JSON.parse(fsK.readFileSync(APP_SETTINGS_FILE, 'utf-8'));
    return {
      configuredCodexPath: s?.cliPaths?.codex || undefined,
      defaultCodexModel: s?.defaultCodexModel || undefined,
    };
  } catch {
    return {};
  }
}

/** Phase 6-K — read the configured claude binary path (cliPaths.claude or
 *  claudeBinaryPath) from app-settings, swallowing errors. */
function readConfiguredClaudePath(): string | undefined {
  try {
    if (!fsK.existsSync(APP_SETTINGS_FILE)) return undefined;
    const s = JSON.parse(fsK.readFileSync(APP_SETTINGS_FILE, 'utf-8'));
    return (s?.cliPaths?.claude || s?.claudeBinaryPath) || undefined;
  } catch {
    return undefined;
  }
}

/** Phase 6-K — read configured agents (id + projectPath + provider) for launch
 *  readiness. Never throws. */
function readConfiguredAgentsForLaunch(): Array<{ id: string; name?: string; projectPath?: string; provider?: string; model?: string }> {
  try {
    const file = pathK.join(DATA_DIR, 'agents.json');
    if (!fsK.existsSync(file)) return [];
    const parsed = JSON.parse(fsK.readFileSync(file, 'utf-8'));
    const list = Array.isArray(parsed) ? parsed : (parsed?.agents ?? []);
    return (list as Array<Record<string, unknown>>)
      .filter(a => a && typeof a === 'object' && a.id)
      .map(a => ({
        id: String(a.id),
        name: typeof a.name === 'string' ? a.name : undefined,
        projectPath: typeof a.projectPath === 'string' ? a.projectPath : undefined,
        provider: typeof a.provider === 'string' ? a.provider : undefined,
        model: typeof a.model === 'string' ? a.model : undefined,
      }));
  } catch {
    return [];
  }
}

/** Phase 6-H/6-I — optional dependencies injected from main.ts. */
export interface DorothyRunsHandlerDeps {
  /** Re-read agents.json into the live in-memory agent map (no restart). */
  reloadLiveAgents?: (reason?: string) => Promise<ReloadAgentsResult>;
  /** Phase 6-I — ids currently in the agent-manager in-memory map (for
   *  isLiveLoaded / isSpawnable computation). */
  getLiveAgentIds?: () => string[];
  /** Phase 6-Q — live agents with status (for warm-up "already running" check). */
  getLiveAgentStatuses?: () => Array<{ id: string; status: string }>;
  /** Phase 6-Q — start an agent via the internal /api/agents/:id/start adapter
   *  (in-process fetch with the local token — never a shell curl). */
  startAgentByApi?: (params: { agentId: string; prompt: string }) => Promise<void>;
}
import type {
  CreateRunInput,
  RunState,
  RunSource,
  Priority,
  CreateRateLimitEventInput,
} from '../types/dorothy';

interface HandlerResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** True when the DB itself is unavailable — UI can show a degraded banner. */
  dbUnavailable?: boolean;
}

/** Phase 6-D — narrow Kanban column type for the convertToTask IPC. */
type KanbanColumnArg = 'backlog' | 'planned' | 'ongoing' | 'done' | undefined;

function dbAvailable(): boolean {
  return getDorothyDb() !== null;
}

function fail<T>(error: string, dbUnavailable = false): HandlerResult<T> {
  return { ok: false, error, dbUnavailable };
}

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

export function registerDorothyRunsHandlers(deps: DorothyRunsHandlerDeps = {}): void {
  const reloadLiveAgents = deps.reloadLiveAgents;
  const getLiveAgentIds = deps.getLiveAgentIds;
  const getLiveAgentStatuses = deps.getLiveAgentStatuses;
  const startAgentByApi = deps.startAgentByApi;
  /** Live-loaded ids snapshot, swallowing any error. */
  const liveIds = (): string[] => {
    try { return getLiveAgentIds?.() ?? []; } catch { return []; }
  };

  /** Phase 6-H — reload + emit a timeline HookEvent. Best-effort; never throws. */
  async function doReloadLiveAgents(reason: string): Promise<ReloadAgentsResult | undefined> {
    if (!reloadLiveAgents) return undefined;
    const result = await reloadLiveAgents(reason);
    const kind = result.alreadyInProgress
      ? 'agent_manager_reload_in_progress'
      : result.ok
        ? 'agent_manager_reloaded'
        : 'agent_manager_reload_failed';
    safeCreateHookEvent({
      type: 'system_note',
      severity: result.ok ? 'info' : 'warning',
      source: 'system',
      title: result.ok ? 'Live agent manager reloaded' : 'Live agent manager reload failed',
      summary: result.ok
        ? `Reloaded agents.json into the live agent manager (${result.beforeCount} → ${result.afterCount}).`
        : `Reload failed: ${result.error ?? 'unknown'}`,
      metadata: {
        kind,
        reason,
        beforeCount: result.beforeCount,
        afterCount: result.afterCount,
        addedAgentIds: result.addedAgentIds,
        removedAgentIds: result.removedAgentIds,
        updatedAgentIds: result.updatedAgentIds ?? [],
        alreadyInProgress: !!result.alreadyInProgress,
      },
    });
    return result;
  }

  /* ----------------------------------------------------------------- runs */

  ipcMain.handle('dorothy:runs:list', async (
    _event,
    options: { state?: RunState | RunState[]; source?: RunSource; kanbanTaskId?: string; limit?: number; offset?: number } = {}
  ) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const runs = listRuns(options);
      return ok({ runs });
    } catch (err) {
      console.error('[dorothy:runs:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:runs:get', async (_event, id: string) => {
    try {
      if (!id) return fail('id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const run = getRun(id);
      if (!run) return fail('Run not found');
      // Bundle the step list to save the renderer an extra round trip.
      const steps = listRunStepsByRun(id);
      return ok({ run, steps });
    } catch (err) {
      console.error('[dorothy:runs:get] failed', err);
      return fail(err instanceof Error ? err.message : 'get failed');
    }
  });

  ipcMain.handle('dorothy:runs:create', async (_event, input: CreateRunInput) => {
    try {
      if (!input?.title || !input?.source) {
        return fail('title and source are required');
      }
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const run = createRun(input);
      if (!run) return fail('createRun returned null');
      return ok({ run });
    } catch (err) {
      console.error('[dorothy:runs:create] failed', err);
      return fail(err instanceof Error ? err.message : 'create failed');
    }
  });

  ipcMain.handle('dorothy:runs:updateState', async (
    _event,
    params: { id: string; state: RunState; blockedReason?: string; errorReason?: string; comment?: string }
  ) => {
    try {
      if (!params?.id || !params?.state) {
        return fail('id and state are required');
      }
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const updated = updateRunState(params.id, params.state, {
        blockedReason: params.blockedReason,
        errorReason: params.errorReason,
        comment: params.comment,
      });
      if (!updated) return fail('Run not found');
      return ok({ run: updated });
    } catch (err) {
      console.error('[dorothy:runs:updateState] failed', err);
      return fail(err instanceof Error ? err.message : 'updateState failed');
    }
  });

  /* --------------------------------------------------------------- sessions */

  ipcMain.handle('dorothy:sessions:list', async (
    _event,
    options: { agentId?: string; runId?: string; runStepId?: string; active?: boolean; limit?: number } = {}
  ) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const sessions = listAgentSessions(options);
      return ok({ sessions });
    } catch (err) {
      console.error('[dorothy:sessions:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  /* --------------------------------------- agent terminal snapshots (6-AE) */
  // Read-only, masked, baseline-11 only. NOT db-gated: reads the live
  // in-memory agent-manager output buffers (the real PTY execution layer).

  ipcMain.handle('dorothy:agentTerminal:listSnapshots', async (_event, options?: { lines?: number }) => {
    try {
      const cap = Math.min(2000, Math.max(1, options?.lines ?? 200));
      const byId = new Map<string, AgentLike>();
      for (const a of liveAgentsMap.values()) {
        if (typeof a.id === 'string' && a.id) byId.set(a.id, a as AgentLike);
      }
      const updatedAt = new Date().toISOString();
      return ok({ snapshots: buildBaselineSnapshots(byId, updatedAt, cap), updatedAt });
    } catch (err) {
      console.error('[dorothy:agentTerminal:listSnapshots] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:agentTerminal:getSnapshot', async (_event, params: { agentId?: string; lines?: number } = {}) => {
    try {
      const id = params?.agentId;
      if (!id || !isSnapshotBaselineAgent(id)) return fail('Not a managed operation agent');
      const cap = Math.min(2000, Math.max(1, params?.lines ?? 200));
      const agent = liveAgentsMap.get(id) as AgentLike | undefined;
      const updatedAt = new Date().toISOString();
      return ok({ snapshot: buildAgentTerminalSnapshot(id, agent, updatedAt, cap), updatedAt });
    } catch (err) {
      console.error('[dorothy:agentTerminal:getSnapshot] failed', err);
      return fail(err instanceof Error ? err.message : 'get failed');
    }
  });

  /* -------------------------------------------------------------- artifacts */

  ipcMain.handle('dorothy:artifacts:list', async (
    _event,
    options: { runId?: string; runStepId?: string; type?: string; producedByAgentId?: string; limit?: number } = {}
  ) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const artifacts = listArtifacts(options as Parameters<typeof listArtifacts>[0]);
      return ok({ artifacts });
    } catch (err) {
      console.error('[dorothy:artifacts:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  // Phase 5C-C — fetch a single artifact (used by ImprovementSignal evidence preview).
  ipcMain.handle('dorothy:artifacts:get', async (_event, id: string) => {
    try {
      if (!id) return fail('id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const artifact = getArtifact(id);
      if (!artifact) return fail('Artifact not found');
      return ok({ artifact });
    } catch (err) {
      console.error('[dorothy:artifacts:get] failed', err);
      return fail(err instanceof Error ? err.message : 'get failed');
    }
  });

  // Bulk lookup — caller already has the id list (e.g. evidenceArtifactIds).
  ipcMain.handle('dorothy:artifacts:listByIds', async (_event, ids: string[]) => {
    try {
      if (!Array.isArray(ids)) return fail('ids array required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const artifacts = listArtifactsByIds(ids);
      return ok({ artifacts });
    } catch (err) {
      console.error('[dorothy:artifacts:listByIds] failed', err);
      return fail(err instanceof Error ? err.message : 'listByIds failed');
    }
  });

  /* --------------------------------------------------------------- handoffs */

  ipcMain.handle('dorothy:handoffs:list', async (_event, params: { runId: string }) => {
    try {
      if (!params?.runId) return fail('runId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const handoffs = listHandoffsByRun(params.runId);
      return ok({ handoffs });
    } catch (err) {
      console.error('[dorothy:handoffs:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  /* ------------------------------------------------------------------ plans */

  ipcMain.handle('dorothy:plans:list', async (
    _event,
    options: { runId?: string; state?: string; limit?: number } = {}
  ) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const plans = listPlans(options as Parameters<typeof listPlans>[0]);
      return ok({ plans });
    } catch (err) {
      console.error('[dorothy:plans:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:plans:get', async (_event, id: string) => {
    try {
      if (!id) return fail('id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const plan = getPlan(id);
      if (!plan) return fail('Plan not found');
      return ok({ plan });
    } catch (err) {
      console.error('[dorothy:plans:get] failed', err);
      return fail(err instanceof Error ? err.message : 'get failed');
    }
  });

  /* ----------------------------------------------------------- phase 3 + 4 */

  ipcMain.handle('dorothy:runs:advance', async (_event, runId: string) => {
    try {
      if (!runId) return fail('runId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const outcome = await advanceRun(runId);
      return ok({ outcome });
    } catch (err) {
      console.error('[dorothy:runs:advance] failed', err);
      return fail(err instanceof Error ? err.message : 'advance failed');
    }
  });

  ipcMain.handle('dorothy:runs:advanceAll', async () => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const outcomes = await advanceAllRuns();
      return ok({ outcomes });
    } catch (err) {
      console.error('[dorothy:runs:advanceAll] failed', err);
      return fail(err instanceof Error ? err.message : 'advanceAll failed');
    }
  });

  ipcMain.handle('dorothy:plans:validate', async (_event, planId: string) => {
    try {
      if (!planId) return fail('planId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const result = validatePlan(planId);
      if (!result) return fail('Plan not found');
      return ok({ result });
    } catch (err) {
      console.error('[dorothy:plans:validate] failed', err);
      return fail(err instanceof Error ? err.message : 'validate failed');
    }
  });

  ipcMain.handle('dorothy:rateLimit:list', async (_event, options?: { engine?: string; active?: boolean; limit?: number }) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const events = listRateLimitEvents(options as Parameters<typeof listRateLimitEvents>[0]);
      return ok({ events });
    } catch (err) {
      console.error('[dorothy:rateLimit:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:rateLimit:record', async (_event, input: CreateRateLimitEventInput) => {
    try {
      if (!input?.engine || !input?.source) return fail('engine and source are required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const result = recordRateLimitEventAndBlockRuns(input);
      return ok({ result });
    } catch (err) {
      console.error('[dorothy:rateLimit:record] failed', err);
      return fail(err instanceof Error ? err.message : 'record failed');
    }
  });

  ipcMain.handle('dorothy:rateLimit:resume', async (_event, params: { eventId: string; engine?: string }) => {
    try {
      if (!params?.eventId) return fail('eventId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const result = resumeRateLimitEvent(params.eventId, params.engine);
      return ok({ result });
    } catch (err) {
      console.error('[dorothy:rateLimit:resume] failed', err);
      return fail(err instanceof Error ? err.message : 'resume failed');
    }
  });

  /* ---------------------------------------------------------------- phase 5A */

  ipcMain.handle('dorothy:pr:list', async (_event, options?: {
    state?: string | string[];
    runId?: string;
    owner?: string;
    repo?: string;
    limit?: number;
    offset?: number;
  }) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const pullRequests = listPullRequests(options as Parameters<typeof listPullRequests>[0]);
      return ok({ pullRequests });
    } catch (err) {
      console.error('[dorothy:pr:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:pr:get', async (_event, id: string) => {
    try {
      if (!id) return fail('id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const pullRequest = getPullRequest(id);
      if (!pullRequest) return fail('PullRequest not found');
      return ok({ pullRequest });
    } catch (err) {
      console.error('[dorothy:pr:get] failed', err);
      return fail(err instanceof Error ? err.message : 'get failed');
    }
  });

  ipcMain.handle('dorothy:pr:listByRun', async (_event, runId: string) => {
    try {
      if (!runId) return fail('runId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const pullRequests = listPullRequestsByRun(runId);
      return ok({ pullRequests });
    } catch (err) {
      console.error('[dorothy:pr:listByRun] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:ci:list', async (_event, options?: {
    state?: string | string[];
    runId?: string;
    pullRequestId?: string;
    workflow?: string;
    limit?: number;
    offset?: number;
  }) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const ciRuns = listCIRuns(options as Parameters<typeof listCIRuns>[0]);
      return ok({ ciRuns });
    } catch (err) {
      console.error('[dorothy:ci:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:ci:get', async (_event, id: string) => {
    try {
      if (!id) return fail('id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const ciRun = getCIRun(id);
      if (!ciRun) return fail('CIRun not found');
      return ok({ ciRun });
    } catch (err) {
      console.error('[dorothy:ci:get] failed', err);
      return fail(err instanceof Error ? err.message : 'get failed');
    }
  });

  ipcMain.handle('dorothy:ci:listByRun', async (_event, runId: string) => {
    try {
      if (!runId) return fail('runId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const ciRuns = listCIRunsByRun(runId);
      return ok({ ciRuns });
    } catch (err) {
      console.error('[dorothy:ci:listByRun] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:ci:listByPullRequest', async (_event, pullRequestId: string) => {
    try {
      if (!pullRequestId) return fail('pullRequestId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const ciRuns = listCIRunsByPullRequest(pullRequestId);
      return ok({ ciRuns });
    } catch (err) {
      console.error('[dorothy:ci:listByPullRequest] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  /* ----------------------------------------------------------- phase 5C-B */

  ipcMain.handle('dorothy:rateLimit:listScheduled', async (_event, options?: { limit?: number }) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const events = listRateLimitEventsExt({
        resumeStatus: ['scheduled', 'pending', 'resuming', 'failed'],
        limit: options?.limit ?? 200,
      });
      return ok({ events });
    } catch (err) {
      console.error('[dorothy:rateLimit:listScheduled] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:rateLimit:resumeNow', async (_event, eventId: string) => {
    try {
      if (!eventId) return fail('eventId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const outcome = await schedulerResumeNow(eventId);
      return ok({ outcome });
    } catch (err) {
      console.error('[dorothy:rateLimit:resumeNow] failed', err);
      return fail(err instanceof Error ? err.message : 'resumeNow failed');
    }
  });

  ipcMain.handle('dorothy:rateLimit:schedulerStatus', async () => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const tick = await schedulerRunTick();
      return ok({ tick });
    } catch (err) {
      console.error('[dorothy:rateLimit:schedulerStatus] failed', err);
      return fail(err instanceof Error ? err.message : 'status failed');
    }
  });

  ipcMain.handle('dorothy:improvements:list', async (_event, options?: {
    status?: string | string[]; source?: string; runId?: string; severity?: string; limit?: number; offset?: number;
  }) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const signals = listImprovementSignals(options as Parameters<typeof listImprovementSignals>[0]);
      return ok({ signals });
    } catch (err) {
      console.error('[dorothy:improvements:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:improvements:listByRun', async (_event, runId: string) => {
    try {
      if (!runId) return fail('runId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const signals = listImprovementSignalsByRun(runId);
      return ok({ signals });
    } catch (err) {
      console.error('[dorothy:improvements:listByRun] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  /* ---------------------------------------------------------- phase 5e */

  ipcMain.handle('dorothy:runs:updateMode', async (_event, params: {
    id: string;
    mode: 'manual' | 'team' | 'persistent' | 'ultraqa' | 'pipeline';
    reason?: string;
    source?: 'manual' | 'keyword' | 'policy' | 'default';
  }) => {
    try {
      if (!params?.id || !params?.mode) return fail('id and mode are required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const updated = svcUpdateRunMode({
        id: params.id,
        mode: params.mode,
        reason: params.reason ?? null,
        source: params.source,
      });
      if (!updated) return fail('Run not found');
      return ok({ run: updated });
    } catch (err) {
      console.error('[dorothy:runs:updateMode] failed', err);
      return fail(err instanceof Error ? err.message : 'updateMode failed');
    }
  });

  ipcMain.handle('dorothy:improvements:convertToTask', async (_event, params: {
    id: string;
    column?: string;
    projectId?: string;
    projectPath?: string;
  }) => {
    try {
      if (!params?.id) return fail('id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const result = convertImprovementSignalToKanbanTask(params.id, {
        column: params.column as 'backlog' | 'planned' | 'ongoing' | 'done' | undefined,
        projectId: params.projectId,
        projectPath: params.projectPath,
      });
      return result.ok ? ok(result) : fail(result.reason ?? 'convertToTask failed');
    } catch (err) {
      console.error('[dorothy:improvements:convertToTask] failed', err);
      return fail(err instanceof Error ? err.message : 'convertToTask failed');
    }
  });

  /* ---------------------------------------------------------- phase 5d */

  ipcMain.handle('dorothy:runModes:policies', async () => {
    // Run mode policy registry never touches the DB; safe to return
    // regardless of dorothy.db state.
    return ok({ policies: RUN_MODE_POLICIES });
  });

  ipcMain.handle('dorothy:runModes:decide', async (_event, text: string) => {
    try {
      const decision = decideRunMode(text ?? '');
      return ok({ decision });
    } catch (err) {
      console.error('[dorothy:runModes:decide] failed', err);
      return fail(err instanceof Error ? err.message : 'decide failed');
    }
  });

  /* ---------------------------------------------------------- phase 5F */

  // Hook Event Bus — unified runtime timeline reads.
  ipcMain.handle('dorothy:hookEvents:list', async (_event, options?: {
    runId?: string;
    runStepId?: string;
    agentSessionId?: string;
    agentId?: string;
    type?: HookEventType | HookEventType[];
    severity?: HookEventSeverity | HookEventSeverity[];
    source?: HookEventSource | HookEventSource[];
    since?: string;
    limit?: number;
    offset?: number;
  }) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const events = listHookEvents(options ?? {});
      return ok({ events });
    } catch (err) {
      console.error('[dorothy:hookEvents:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:hookEvents:listByRun', async (_event, runId: string, options?: {
    type?: HookEventType | HookEventType[];
    severity?: HookEventSeverity | HookEventSeverity[];
    source?: HookEventSource | HookEventSource[];
    since?: string;
    limit?: number;
    offset?: number;
  }) => {
    try {
      if (!runId) return fail('runId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const events = listHookEventsByRun(runId, options ?? {});
      return ok({ events });
    } catch (err) {
      console.error('[dorothy:hookEvents:listByRun] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:hookEvents:listBySession', async (_event, agentSessionId: string, options?: {
    type?: HookEventType | HookEventType[];
    severity?: HookEventSeverity | HookEventSeverity[];
    limit?: number;
  }) => {
    try {
      if (!agentSessionId) return fail('agentSessionId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const events = listHookEventsBySession(agentSessionId, options ?? {});
      return ok({ events });
    } catch (err) {
      console.error('[dorothy:hookEvents:listBySession] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:hookEvents:listRecent', async (_event, options?: {
    severity?: HookEventSeverity | HookEventSeverity[];
    type?: HookEventType | HookEventType[];
    source?: HookEventSource | HookEventSource[];
    limit?: number;
  }) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const events = listRecentHookEvents(options ?? {});
      return ok({ events });
    } catch (err) {
      console.error('[dorothy:hookEvents:listRecent] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  /* ---------------------------------------------------------- phase 6-A */

  ipcMain.handle('dorothy:diagnostics:list', async (_event, options?: {
    runId?: string;
    runStepId?: string;
    agentSessionId?: string;
    agentId?: string;
    source?: DiagnosticSource | DiagnosticSource[];
    severity?: DiagnosticSeverity | DiagnosticSeverity[];
    status?: DiagnosticStatus | DiagnosticStatus[];
    onlyOpen?: boolean;
    minOccurrences?: number;
    limit?: number;
    offset?: number;
  }) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const diagnostics = listDiagnostics(options ?? {});
      return ok({ diagnostics });
    } catch (err) {
      console.error('[dorothy:diagnostics:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:diagnostics:listByRun', async (_event, runId: string, options?: {
    severity?: DiagnosticSeverity | DiagnosticSeverity[];
    status?: DiagnosticStatus | DiagnosticStatus[];
    onlyOpen?: boolean;
    limit?: number;
  }) => {
    try {
      if (!runId) return fail('runId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const diagnostics = listDiagnosticsByRun(runId, options ?? {});
      return ok({ diagnostics });
    } catch (err) {
      console.error('[dorothy:diagnostics:listByRun] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:diagnostics:get', async (_event, id: string) => {
    try {
      if (!id) return fail('id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const diagnostic = getDiagnostic(id);
      if (!diagnostic) return fail('Diagnostic not found');
      return ok({ diagnostic });
    } catch (err) {
      console.error('[dorothy:diagnostics:get] failed', err);
      return fail(err instanceof Error ? err.message : 'get failed');
    }
  });

  ipcMain.handle('dorothy:diagnostics:updateStatus', async (_event, params: {
    id: string;
    status: DiagnosticStatus;
    note?: string;
  }) => {
    try {
      if (!params?.id || !params?.status) return fail('id and status are required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const updated = updateDiagnosticStatus({ id: params.id, status: params.status, note: params.note ?? null });
      if (!updated) return fail('Diagnostic not found');
      return ok({ diagnostic: updated });
    } catch (err) {
      console.error('[dorothy:diagnostics:updateStatus] failed', err);
      return fail(err instanceof Error ? err.message : 'updateStatus failed');
    }
  });

  ipcMain.handle('dorothy:diagnostics:convertToImprovement', async (_event, params: { id: string }) => {
    try {
      if (!params?.id) return fail('id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const result = convertDiagnosticToImprovementSignal(params.id);
      return result.ok ? ok(result) : fail(result.reason ?? 'convertToImprovement failed');
    } catch (err) {
      console.error('[dorothy:diagnostics:convertToImprovement] failed', err);
      return fail(err instanceof Error ? err.message : 'convertToImprovement failed');
    }
  });

  /* ---------------------------------------------------------- phase 6-B */

  ipcMain.handle('dorothy:workflowProgress:list', async (_event, options?: {
    runId?: string;
    runStepId?: string;
    agentSessionId?: string;
    agentId?: string;
    workflowKind?: AgentWorkflowKind | AgentWorkflowKind[];
    status?: AgentWorkflowProgressStatus | AgentWorkflowProgressStatus[];
    limit?: number;
    offset?: number;
  }) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const rows = listWorkflowProgress(options ?? {});
      return ok({ rows });
    } catch (err) {
      console.error('[dorothy:workflowProgress:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:workflowProgress:listByRun', async (_event, runId: string, options?: {
    workflowKind?: AgentWorkflowKind | AgentWorkflowKind[];
    status?: AgentWorkflowProgressStatus | AgentWorkflowProgressStatus[];
    limit?: number;
  }) => {
    try {
      if (!runId) return fail('runId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const rows = listWorkflowProgressByRun(runId, options ?? {});
      return ok({ rows });
    } catch (err) {
      console.error('[dorothy:workflowProgress:listByRun] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:workflowProgress:listBySession', async (_event, agentSessionId: string, options?: {
    limit?: number;
  }) => {
    try {
      if (!agentSessionId) return fail('agentSessionId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const rows = listWorkflowProgressBySession(agentSessionId, options ?? {});
      return ok({ rows });
    } catch (err) {
      console.error('[dorothy:workflowProgress:listBySession] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:workflowProgress:get', async (_event, id: string) => {
    try {
      if (!id) return fail('id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const row = getWorkflowProgress(id);
      if (!row) return fail('WorkflowProgress not found');
      return ok({ row });
    } catch (err) {
      console.error('[dorothy:workflowProgress:get] failed', err);
      return fail(err instanceof Error ? err.message : 'get failed');
    }
  });

  ipcMain.handle('dorothy:workflowProgress:recomputeByRun', async (_event, runId: string) => {
    try {
      if (!runId) return fail('runId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const rows = recomputeWorkflowProgressForRun(runId);
      return ok({ rows });
    } catch (err) {
      console.error('[dorothy:workflowProgress:recomputeByRun] failed', err);
      return fail(err instanceof Error ? err.message : 'recompute failed');
    }
  });

  ipcMain.handle('dorothy:workflowProgress:counts', async () => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const counts = countWorkflowProgress();
      return ok({ counts });
    } catch (err) {
      console.error('[dorothy:workflowProgress:counts] failed', err);
      return fail(err instanceof Error ? err.message : 'counts failed');
    }
  });

  /* ---------------------------------------------------------- phase 6-D */

  ipcMain.handle('dorothy:skillCandidates:list', async (_event, options?: {
    runId?: string;
    agentId?: string;
    category?: SkillCandidateCategory | SkillCandidateCategory[];
    source?: SkillCandidateSource | SkillCandidateSource[];
    severity?: SkillCandidateSeverity | SkillCandidateSeverity[];
    status?: SkillCandidateStatus | SkillCandidateStatus[];
    onlyOpen?: boolean;
    minOccurrences?: number;
    limit?: number;
    offset?: number;
  }) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const candidates = listSkillCandidates(options ?? {});
      return ok({ candidates });
    } catch (err) {
      console.error('[dorothy:skillCandidates:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:skillCandidates:listByRun', async (_event, runId: string, options?: {
    status?: SkillCandidateStatus | SkillCandidateStatus[];
    onlyOpen?: boolean;
    limit?: number;
  }) => {
    try {
      if (!runId) return fail('runId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const candidates = listSkillCandidatesByRun(runId, options ?? {});
      return ok({ candidates });
    } catch (err) {
      console.error('[dorothy:skillCandidates:listByRun] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:skillCandidates:get', async (_event, id: string) => {
    try {
      if (!id) return fail('id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const candidate = getSkillCandidate(id);
      if (!candidate) return fail('SkillCandidate not found');
      return ok({ candidate });
    } catch (err) {
      console.error('[dorothy:skillCandidates:get] failed', err);
      return fail(err instanceof Error ? err.message : 'get failed');
    }
  });

  ipcMain.handle('dorothy:skillCandidates:updateStatus', async (_event, params: {
    id: string;
    status: SkillCandidateStatus;
    note?: string;
  }) => {
    try {
      if (!params?.id || !params?.status) return fail('id and status are required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const updated = updateSkillCandidateStatus({ id: params.id, status: params.status, note: params.note ?? null });
      if (!updated) return fail('SkillCandidate not found');
      return ok({ candidate: updated });
    } catch (err) {
      console.error('[dorothy:skillCandidates:updateStatus] failed', err);
      return fail(err instanceof Error ? err.message : 'updateStatus failed');
    }
  });

  ipcMain.handle('dorothy:skillCandidates:fromImprovementSignal', async (_event, params: { id: string }) => {
    try {
      if (!params?.id) return fail('improvementSignal id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const result = convertImprovementSignalToSkillCandidate(params.id);
      return result.ok ? ok(result) : fail(result.reason ?? 'fromImprovementSignal failed');
    } catch (err) {
      console.error('[dorothy:skillCandidates:fromImprovementSignal] failed', err);
      return fail(err instanceof Error ? err.message : 'fromImprovementSignal failed');
    }
  });

  ipcMain.handle('dorothy:skillCandidates:fromDiagnostic', async (_event, params: { id: string }) => {
    try {
      if (!params?.id) return fail('diagnostic id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const result = convertDiagnosticToSkillCandidate(params.id);
      return result.ok ? ok(result) : fail(result.reason ?? 'fromDiagnostic failed');
    } catch (err) {
      console.error('[dorothy:skillCandidates:fromDiagnostic] failed', err);
      return fail(err instanceof Error ? err.message : 'fromDiagnostic failed');
    }
  });

  ipcMain.handle('dorothy:skillCandidates:convertToTask', async (_event, params: { id: string; column?: KanbanColumnArg }) => {
    try {
      if (!params?.id) return fail('id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const result = convertSkillCandidateToKanbanTask(params.id, { column: params.column });
      return result.ok ? ok(result) : fail(result.reason ?? 'convertToTask failed');
    } catch (err) {
      console.error('[dorothy:skillCandidates:convertToTask] failed', err);
      return fail(err instanceof Error ? err.message : 'convertToTask failed');
    }
  });

  ipcMain.handle('dorothy:skillCandidates:counts', async () => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const counts = countSkillCandidates();
      return ok({ counts });
    } catch (err) {
      console.error('[dorothy:skillCandidates:counts] failed', err);
      return fail(err instanceof Error ? err.message : 'counts failed');
    }
  });

  /* ----- Phase 6-W — App Factory ---------------------------------------
   * Planning-only. Generating a plan preview NEVER creates files / repos /
   * real Kanban tasks. Seed the first sample candidate idempotently on first
   * list so the dashboard has something to show. */
  ipcMain.handle('dorothy:appFactory:listCandidates', async (_event, options?: {
    status?: AppCandidateStatus | AppCandidateStatus[];
    implementationDifficulty?: AppImplementationDifficulty | AppImplementationDifficulty[];
    limit?: number;
    offset?: number;
  }) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      try { seedDefaultAppCandidates(); } catch { /* best-effort seed */ }
      const candidates = listAppCandidates(options ?? {});
      return ok({ candidates });
    } catch (err) {
      console.error('[dorothy:appFactory:listCandidates] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:appFactory:getCandidate', async (_event, id: string) => {
    try {
      if (!id) return fail('id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const candidate = getAppCandidate(id);
      if (!candidate) return fail('AppCandidate not found');
      return ok({ candidate });
    } catch (err) {
      console.error('[dorothy:appFactory:getCandidate] failed', err);
      return fail(err instanceof Error ? err.message : 'get failed');
    }
  });

  ipcMain.handle('dorothy:appFactory:createCandidate', async (_event, input: CreateAppCandidateInput) => {
    try {
      if (!input?.title || !input?.projectSlug) return fail('title and projectSlug are required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const candidate = createAppCandidate(input);
      if (!candidate) return fail('createAppCandidate returned null');
      return ok({ candidate });
    } catch (err) {
      console.error('[dorothy:appFactory:createCandidate] failed', err);
      return fail(err instanceof Error ? err.message : 'create failed');
    }
  });

  ipcMain.handle('dorothy:appFactory:updateCandidateStatus', async (_event, params: { id: string; status: AppCandidateStatus }) => {
    try {
      if (!params?.id || !params?.status) return fail('id and status are required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const candidate = updateAppCandidateStatus({ id: params.id, status: params.status });
      if (!candidate) return fail('AppCandidate not found');
      return ok({ candidate });
    } catch (err) {
      console.error('[dorothy:appFactory:updateCandidateStatus] failed', err);
      return fail(err instanceof Error ? err.message : 'update failed');
    }
  });

  // Preview only — builds an in-memory plan, writes nothing.
  ipcMain.handle('dorothy:appFactory:generatePlanPreview', async (_event, params: { appCandidateId: string }) => {
    try {
      if (!params?.appCandidateId) return fail('appCandidateId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const plan = generateAppFactoryPlanPreview(params.appCandidateId);
      if (!plan) return fail('AppCandidate not found');
      return ok({ plan, persisted: false });
    } catch (err) {
      console.error('[dorothy:appFactory:generatePlanPreview] failed', err);
      return fail(err instanceof Error ? err.message : 'preview failed');
    }
  });

  // Persist a plan row (the kept preview). Still creates NO Kanban tasks.
  ipcMain.handle('dorothy:appFactory:createPlan', async (_event, params: { appCandidateId: string; status?: AppFactoryPlanStatus }) => {
    try {
      if (!params?.appCandidateId) return fail('appCandidateId is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const plan = createAppFactoryPlan({ appCandidateId: params.appCandidateId });
      if (!plan) return fail('AppCandidate not found');
      return ok({ plan, persisted: true });
    } catch (err) {
      console.error('[dorothy:appFactory:createPlan] failed', err);
      return fail(err instanceof Error ? err.message : 'create plan failed');
    }
  });

  ipcMain.handle('dorothy:appFactory:listPlans', async (_event, options?: {
    appCandidateId?: string;
    status?: AppFactoryPlanStatus | AppFactoryPlanStatus[];
    limit?: number;
  }) => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const plans = listAppFactoryPlans(options ?? {});
      return ok({ plans });
    } catch (err) {
      console.error('[dorothy:appFactory:listPlans] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:appFactory:getPlan', async (_event, id: string) => {
    try {
      if (!id) return fail('id is required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const plan = getAppFactoryPlan(id);
      if (!plan) return fail('AppFactoryPlan not found');
      return ok({ plan });
    } catch (err) {
      console.error('[dorothy:appFactory:getPlan] failed', err);
      return fail(err instanceof Error ? err.message : 'get failed');
    }
  });

  ipcMain.handle('dorothy:appFactory:counts', async () => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const counts = countAppFactory();
      return ok({ counts });
    } catch (err) {
      console.error('[dorothy:appFactory:counts] failed', err);
      return fail(err instanceof Error ? err.message : 'counts failed');
    }
  });

  ipcMain.handle('dorothy:diagnostics:counts', async () => {
    try {
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const counts = countDiagnostics();
      return ok({ counts });
    } catch (err) {
      console.error('[dorothy:diagnostics:counts] failed', err);
      return fail(err instanceof Error ? err.message : 'counts failed');
    }
  });

  ipcMain.handle('dorothy:improvements:updateStatus', async (_event, params: { id: string; status: ImprovementSignalStatus; note?: string }) => {
    try {
      if (!params?.id || !params?.status) return fail('id and status are required');
      if (!dbAvailable()) return fail('dorothy.db not initialized', true);
      const signal = updateImprovementSignalStatus({ id: params.id, status: params.status, note: params.note ?? null });
      if (!signal) return fail('signal not found');
      return ok({ signal });
    } catch (err) {
      console.error('[dorothy:improvements:updateStatus] failed', err);
      return fail(err instanceof Error ? err.message : 'update failed');
    }
  });

  /* ---------------------------------------------------------- phase 6-E */

  // Agent Definition Registry. Note: this intentionally does NOT hard-fail on a
  // missing DB — the `.claude/agents/*.md` + agents.json scan is still useful;
  // live-session merge just contributes nothing when the DB is absent.
  ipcMain.handle('dorothy:agentDefinitions:list', async (_event, options?: {
    extraProjectPaths?: string[];
    includeUserDir?: boolean;
  }) => {
    try {
      const snapshot = buildAgentRegistry({ ...(options ?? {}), liveLoadedAgentIds: liveIds() });
      return ok({ snapshot, dbUnavailable: !dbAvailable() });
    } catch (err) {
      console.error('[dorothy:agentDefinitions:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:agentDefinitions:get', async (_event, agentId: string) => {
    try {
      if (!agentId) return fail('agentId is required');
      const definition = getAgentDefinition(agentId, { liveLoadedAgentIds: liveIds() });
      if (!definition) return fail('Agent definition not found');
      return ok({ definition });
    } catch (err) {
      console.error('[dorothy:agentDefinitions:get] failed', err);
      return fail(err instanceof Error ? err.message : 'get failed');
    }
  });

  // Rescan is just a fresh build — there is no cache to invalidate, but the
  // channel exists so the UI can offer an explicit refresh affordance.
  ipcMain.handle('dorothy:agentDefinitions:rescan', async (_event, options?: {
    extraProjectPaths?: string[];
    includeUserDir?: boolean;
  }) => {
    try {
      const snapshot = buildAgentRegistry({ ...(options ?? {}), liveLoadedAgentIds: liveIds() });
      return ok({ snapshot, dbUnavailable: !dbAvailable() });
    } catch (err) {
      console.error('[dorothy:agentDefinitions:rescan] failed', err);
      return fail(err instanceof Error ? err.message : 'rescan failed');
    }
  });

  // Agent Idle Reason.
  ipcMain.handle('dorothy:agentIdle:list', async (_event, options?: { agentIds?: string[] }) => {
    try {
      if (!dbAvailable()) return ok({ statuses: [] });
      const statuses = computeIdleStatuses(options ?? {});
      return ok({ statuses });
    } catch (err) {
      console.error('[dorothy:agentIdle:list] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:agentIdle:get', async (_event, agentId: string) => {
    try {
      if (!agentId) return fail('agentId is required');
      if (!dbAvailable()) return ok({ status: null });
      const status = getIdleStatus(agentId);
      return ok({ status });
    } catch (err) {
      console.error('[dorothy:agentIdle:get] failed', err);
      return fail(err instanceof Error ? err.message : 'get failed');
    }
  });

  // Agent Communication Timeline.
  ipcMain.handle('dorothy:agentCommunication:listByRun', async (_event, runId: string, options?: { limit?: number }) => {
    try {
      if (!runId) return fail('runId is required');
      if (!dbAvailable()) return ok({ events: [] });
      const events = listCommunicationByRun(runId, options ?? {});
      return ok({ events });
    } catch (err) {
      console.error('[dorothy:agentCommunication:listByRun] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:agentCommunication:listByAgent', async (_event, agentId: string, options?: { limit?: number; runIds?: string[] }) => {
    try {
      if (!agentId) return fail('agentId is required');
      if (!dbAvailable()) return ok({ events: [] });
      const events = listCommunicationByAgent(agentId, options ?? {});
      return ok({ events });
    } catch (err) {
      console.error('[dorothy:agentCommunication:listByAgent] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  ipcMain.handle('dorothy:agentCommunication:listRecent', async (_event, options?: { limit?: number }) => {
    try {
      if (!dbAvailable()) return ok({ events: [] });
      const events = listRecentCommunication(options ?? {});
      return ok({ events });
    } catch (err) {
      console.error('[dorothy:agentCommunication:listRecent] failed', err);
      return fail(err instanceof Error ? err.message : 'list failed');
    }
  });

  /* ---------------------------------------------------------- phase 6-G */

  // Manual agent-definition registration. These touch agents.json (a file),
  // not dorothy.db, so they intentionally do NOT hard-fail when the DB is
  // absent — only the timeline HookEvent on register is best-effort.
  ipcMain.handle('dorothy:agentRegistration:listCandidates', async () => {
    try {
      const candidates = listRegistrationCandidates();
      return ok({ candidates });
    } catch (err) {
      console.error('[dorothy:agentRegistration:listCandidates] failed', err);
      return fail(err instanceof Error ? err.message : 'listCandidates failed');
    }
  });

  ipcMain.handle('dorothy:agentRegistration:preview', async (_event, params: {
    agentDefinitionId: string;
    options?: RegisterAgentDefinitionOptions;
  }) => {
    try {
      if (!params?.agentDefinitionId) return fail('agentDefinitionId is required');
      const preview = previewAgentRegistration(params.agentDefinitionId, params.options ?? {});
      if (!preview) return fail('Agent definition not found');
      return ok({ preview });
    } catch (err) {
      console.error('[dorothy:agentRegistration:preview] failed', err);
      return fail(err instanceof Error ? err.message : 'preview failed');
    }
  });

  ipcMain.handle('dorothy:agentRegistration:register', async (_event, params: {
    agentDefinitionId: string;
    options?: RegisterAgentDefinitionOptions & { reloadAfterRegister?: boolean };
    confirm?: boolean;
  }) => {
    try {
      if (!params?.agentDefinitionId) return fail('agentDefinitionId is required');
      // Server-side confirm gate: a non-dryRun register MUST carry confirm=true.
      const dryRun = params.options?.dryRun === true;
      if (!dryRun && params.confirm !== true) {
        return fail('Registration requires explicit confirm=true.');
      }
      const { reloadAfterRegister, ...regOptions } = params.options ?? {};
      const result = registerAgentDefinition(params.agentDefinitionId, regOptions);
      if (!result.ok) return fail(result.reason ?? 'register failed');

      // Phase 6-H — reload the live agent manager so the new record is usable
      // immediately and the next saveAgents() preserves it. Default on; never
      // for a dry run. Reload failure does NOT fail the registration.
      const warnings: string[] = [];
      let reloadResult: ReloadAgentsResult | undefined;
      if (!dryRun && reloadAfterRegister !== false) {
        reloadResult = await doReloadLiveAgents(`register:${params.agentDefinitionId}`);
        if (reloadResult && !reloadResult.ok) {
          warnings.push(`Registered to agents.json, but live reload failed: ${reloadResult.error ?? 'unknown'}.`);
        } else if (!reloadResult) {
          warnings.push('Registered to agents.json, but live reload is unavailable (restart to apply).');
        }
      }

      // Phase 6-I — re-fetch the definition so the caller sees the post-reload
      // isRegistered / isLiveLoaded / isSpawnable state. Skipped for dryRun.
      let postRegistrationDefinition: ReturnType<typeof getAgentDefinition> | undefined;
      if (!dryRun) {
        postRegistrationDefinition =
          getAgentDefinition(params.agentDefinitionId, { liveLoadedAgentIds: liveIds() }) ?? undefined;
        if (postRegistrationDefinition && !postRegistrationDefinition.isSpawnable) {
          warnings.push(`Registered, but not yet spawnable (${postRegistrationDefinition.spawnBlockReason ?? 'unknown'}).`);
        }
      }

      return ok({
        ...result,
        agentId: params.agentDefinitionId,
        reloadResult,
        postRegistrationDefinition,
        warnings: warnings.length ? warnings : undefined,
      });
    } catch (err) {
      console.error('[dorothy:agentRegistration:register] failed', err);
      return fail(err instanceof Error ? err.message : 'register failed');
    }
  });

  // Phase 6-H — standalone "Reload Live Agents" (no agents.json mutation).
  ipcMain.handle('dorothy:agentDefinitions:reloadLiveAgents', async (_event, params?: { reason?: string }) => {
    try {
      if (!reloadLiveAgents) {
        return ok({ result: { ok: false, beforeCount: 0, afterCount: 0, addedAgentIds: [], removedAgentIds: [], error: 'reloadLiveAgents not available' } });
      }
      const result = await doReloadLiveAgents(params?.reason ?? 'manual');
      return ok({ result });
    } catch (err) {
      console.error('[dorothy:agentDefinitions:reloadLiveAgents] failed', err);
      return fail(err instanceof Error ? err.message : 'reload failed');
    }
  });

  /* ---------------------------------------------------------- phase 6-J */

  // Dispatch readiness — DRY-RUN ONLY. Never spawns an agent / PTY / token.
  ipcMain.handle('dorothy:agentDispatch:listReadiness', async (_event, options?: { agentIds?: string[] }) => {
    try {
      if (!dbAvailable()) return ok({ readiness: [], counts: { ready: 0, blocked: 0, total: 0, byReason: {} } });
      // Phase 6-K — fold the claude binary check into dispatch readiness so a
      // missing binary surfaces as a blocker instead of an empty terminal.
      const bin = resolveClaudeBinaryPath({ configuredPath: readConfiguredClaudePath() });
      const readiness = computeDispatchReadiness({
        agentIds: options?.agentIds,
        liveLoadedAgentIds: liveIds(),
        claudeBinaryMissing: !bin.ok,
      });
      return ok({ readiness, counts: countDispatchReadiness(readiness) });
    } catch (err) {
      console.error('[dorothy:agentDispatch:listReadiness] failed', err);
      return fail(err instanceof Error ? err.message : 'listReadiness failed');
    }
  });

  /* ---------------------------------------------------------- phase 6-K */

  // Claude launch readiness — binary resolution + per-agent path validation.
  // Pure read-only; never spawns. agents.json/.md/skills are never modified.
  ipcMain.handle('dorothy:claude:launchReadiness', async () => {
    try {
      const configuredClaudePath = readConfiguredClaudePath();
      const bin = resolveClaudeBinaryPath({ configuredPath: configuredClaudePath });
      const homeDir = require('os').homedir() as string;
      const mcpConfigPath = pathK.join(homeDir, '.claude', 'mcp.json');
      const agents = readConfiguredAgentsForLaunch();
      const perAgent = agents
        .filter(a => (a.provider ?? 'claude') === 'claude')
        .map(a => checkClaudeLaunchReadiness({
          agentId: a.id,
          projectPath: a.projectPath,
          mcpConfigPath,
          mcpRequired: false,
          configuredClaudePath,
        }));
      // Mask: only expose the resolved binary path + source (not env/secrets).
      return ok({
        binary: { found: bin.ok, path: bin.path ?? null, source: bin.source ?? null, checkedCount: bin.checkedPaths.length },
        pathIncludesClaude: bin.ok && bin.source === 'path',
        mcpConfigPath: fsK.existsSync(mcpConfigPath) ? mcpConfigPath : null,
        addDir: pathK.join(homeDir, '.dorothy'),
        agents: perAgent,
      });
    } catch (err) {
      console.error('[dorothy:claude:launchReadiness] failed', err);
      return fail(err instanceof Error ? err.message : 'launchReadiness failed');
    }
  });

  /* ---------------------------------------------------------- phase 6-M */

  // Codex runtime readiness — binary + persistent config + per-agent model.
  ipcMain.handle('dorothy:codex:runtimeReadiness', async () => {
    try {
      const { configuredCodexPath, defaultCodexModel } = readCodexSettings();
      const readiness = getCodexRuntimeReadiness({
        configuredAgents: readConfiguredAgentsForLaunch(),
        configuredCodexPath,
        defaultCodexModel,
      });
      return ok({ readiness });
    } catch (err) {
      console.error('[dorothy:codex:runtimeReadiness] failed', err);
      return fail(err instanceof Error ? err.message : 'codex runtime readiness failed');
    }
  });

  // Phase 6-Q — batch warm-up: list eligible targets (dry-run, read-only).
  ipcMain.handle('dorothy:agents:warmupTargets', async (_event, options?: { agentIds?: string[] }) => {
    try {
      const targets = listWarmupTargets({
        agentIds: options?.agentIds,
        liveLoadedAgentIds: liveIds(),
        liveAgents: getLiveAgentStatuses?.() ?? [],
      });
      return ok({ targets });
    } catch (err) {
      console.error('[dorothy:agents:warmupTargets] failed', err);
      return fail(err instanceof Error ? err.message : 'warmupTargets failed');
    }
  });

  // Phase 6-Q — start safe warm-up sessions for eligible agents. Requires
  // confirm. Uses the internal start adapter (no shell curl). Never creates a
  // RunStep / Kanban task; file-modification-free prompt.
  ipcMain.handle('dorothy:agents:warmupAll', async (_event, params?: { agentIds?: string[]; confirm?: boolean }) => {
    try {
      if (params?.confirm !== true) return fail('Warm-up requires explicit confirm=true.');
      if (!startAgentByApi) {
        return ok({ result: { ok: false, requestedAgentIds: [], startedAgentIds: [], skipped: [], failed: [{ agentId: '*', error: 'startAgentByApi adapter not available' }] } });
      }
      const targets = listWarmupTargets({
        agentIds: params?.agentIds,
        liveLoadedAgentIds: liveIds(),
        liveAgents: getLiveAgentStatuses?.() ?? [],
      });
      const result: AgentWarmupResult = {
        ok: true,
        requestedAgentIds: targets.map(t => t.agentId),
        startedAgentIds: [],
        skipped: [],
        failed: [],
      };
      for (const t of targets) {
        if (!t.canWarmup) {
          result.skipped.push({ agentId: t.agentId, reason: t.reason ?? 'not eligible' });
          continue;
        }
        try {
          // Prefix a marker so the renderer can classify the session as warm-up.
          const prompt = `${WARMUP_MARKER}\n${buildWarmupPrompt(t.agentId)}`;
          await startAgentByApi({ agentId: t.agentId, prompt });
          result.startedAgentIds.push(t.agentId);
          safeCreateHookEvent({
            type: 'system_note', severity: 'info', source: 'system', agentId: t.agentId,
            title: `Warm-up started — ${t.agentId}`,
            summary: 'Safe warm-up session (no file edits).',
            metadata: { kind: 'agent_warmup_started', agentId: t.agentId },
          });
        } catch (e) {
          result.failed.push({ agentId: t.agentId, error: e instanceof Error ? e.message : 'start failed' });
        }
      }
      result.ok = result.failed.length === 0;
      return ok({ result });
    } catch (err) {
      console.error('[dorothy:agents:warmupAll] failed', err);
      return fail(err instanceof Error ? err.message : 'warmupAll failed');
    }
  });

  // Phase 6-Q — Codex model normalization (drop model='opus' on codex agents).
  ipcMain.handle('dorothy:agents:normalizeCodexModelsPreview', async () => {
    try {
      const preview = previewCodexModelNormalization();
      return ok({ preview });
    } catch (err) {
      console.error('[dorothy:agents:normalizeCodexModelsPreview] failed', err);
      return fail(err instanceof Error ? err.message : 'preview failed');
    }
  });

  ipcMain.handle('dorothy:agents:normalizeCodexModels', async (_event, params?: { confirm?: boolean }) => {
    try {
      if (params?.confirm !== true) return fail('Codex model normalization requires explicit confirm=true.');
      const result = normalizeCodexModels();
      if (!result.ok) return fail(result.reason ?? 'normalize failed');
      // Reload the live map so the change reflects without a full restart.
      let reloadResult: ReloadAgentsResult | undefined;
      if (reloadLiveAgents) reloadResult = await doReloadLiveAgents('normalizeCodexModels');
      return ok({ result, reloadResult });
    } catch (err) {
      console.error('[dorothy:agents:normalizeCodexModels] failed', err);
      return fail(err instanceof Error ? err.message : 'normalize failed');
    }
  });

  // Stale provider/model session detection (codex + Claude-family model).
  ipcMain.handle('dorothy:sessions:staleModelMismatch', async () => {
    try {
      if (!dbAvailable()) return ok({ flags: [] });
      const sessions = listAgentSessionsForCodex({ active: true, limit: 200 });
      const flags = detectStaleProviderModelSessions({
        sessions,
        configuredAgents: readConfiguredAgentsForLaunch(),
      });
      return ok({ flags });
    } catch (err) {
      console.error('[dorothy:sessions:staleModelMismatch] failed', err);
      return fail(err instanceof Error ? err.message : 'stale session detect failed');
    }
  });

  ipcMain.handle('dorothy:agentDispatch:listReadinessByRun', async (_event, runId: string) => {
    try {
      if (!runId) return fail('runId is required');
      if (!dbAvailable()) return ok({ readiness: [], counts: { ready: 0, blocked: 0, total: 0, byReason: {} } });
      const all = computeDispatchReadiness({ liveLoadedAgentIds: liveIds() });
      const readiness = all.filter(r => r.runId === runId);
      return ok({ readiness, counts: countDispatchReadiness(readiness) });
    } catch (err) {
      console.error('[dorothy:agentDispatch:listReadinessByRun] failed', err);
      return fail(err instanceof Error ? err.message : 'listReadinessByRun failed');
    }
  });
}

// Silence unused import warning if needed.
void normalizeAutoResumeMode;

// Helper for tests / future code paths that want to address the same routing
// without going through ipcMain.
export type { HandlerResult };
// Unused-imports silencer for Priority/RunStepState — these are part of the
// public type surface that handlers expose to the renderer.
void ([] as Priority[]);
