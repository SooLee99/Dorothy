/**
 * Dorothy MVP — Run/Session/Artifact/Handoff/Plan client.
 *
 * Talks to the Phase-1 IPC handlers (`electron/handlers/dorothy-runs-handler.ts`)
 * via `window.electronAPI.dorothy.*`. When the bridge is missing (web/dev
 * SSR), every method resolves to a `{ ok:false, dbUnavailable:true }` envelope
 * so screens can render their empty state without throwing.
 *
 * This file is intentionally small and read-mostly — Phase 2 is screens only,
 * so we expose the same surface the handler exposes and let components do
 * their own filtering/sorting.
 */

import type {
  Run,
  RunState,
  RunSource,
  RunStep,
  AgentSession,
  Artifact,
  Handoff,
  Plan,
  PullRequest,
  CIRun,
  RateLimitEvent,
  ImprovementSignal,
  ImprovementSignalStatus,
  DorothyIpcResult,
  HookEvent,
  HookEventType,
  HookEventSeverity,
  HookEventSource,
  Diagnostic,
  DiagnosticSource,
  DiagnosticSeverity,
  DiagnosticStatus,
  AgentWorkflowProgress,
  AgentWorkflowKind,
  AgentWorkflowProgressStatus,
  SkillCandidate,
  SkillCandidateCategory,
  SkillCandidateSource,
  SkillCandidateSeverity,
  SkillCandidateStatus,
  AppCandidate,
  AppCandidateStatus,
  AppImplementationDifficulty,
  CreateAppCandidateInput,
  AppFactoryPlan,
  AppFactoryPlanStatus,
  AgentDefinition,
  AgentRegistrySnapshot,
  AgentIdleStatus,
  AgentCommunicationEvent,
  AgentRegistrationPreview,
  RegisterAgentDefinitionOptions,
  RegisterAgentDefinitionResult,
  ReloadLiveAgentsResult,
  AgentDispatchReadiness,
  DispatchReadinessCounts,
  ClaudeRuntimeReadiness,
  CodexRuntimeReadiness,
  StaleSessionFlag,
  AgentWarmupTarget,
  AgentWarmupResult,
  CodexNormalizationPreview,
  CodexNormalizationResult,
} from '@/types/dorothy';
import type { AgentTerminalSnapshot } from '@/lib/agentTerminalSnapshot';

export interface SkillCandidateListOptions {
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
}

export interface SkillCandidateCountsSnapshot {
  open: number;
  triaged: number;
  accepted: number;
  dismissed: number;
  convertedToTask: number;
  readyForRegistry: number;
  total: number;
}

export interface WorkflowProgressListOptions {
  runId?: string;
  runStepId?: string;
  agentSessionId?: string;
  agentId?: string;
  workflowKind?: AgentWorkflowKind | AgentWorkflowKind[];
  status?: AgentWorkflowProgressStatus | AgentWorkflowProgressStatus[];
  limit?: number;
  offset?: number;
}

export interface WorkflowProgressCountsSnapshot {
  not_started: number;
  in_progress: number;
  blocked: number;
  failed: number;
  completed: number;
  stalled: number;
  total: number;
}

export interface DiagnosticListOptions {
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
}

export interface DiagnosticCountsSnapshot {
  open: number;
  investigating: number;
  fixed: number;
  ignored: number;
  convertedToTask: number;
  convertedToImprovement: number;
  highOrCritical: number;
  total: number;
}

export interface HookEventListOptions {
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
}

/* ============================================================================
 * Bridge
 * ========================================================================== */

interface DorothyRunsBridge {
  runs: {
    list: (options?: {
      state?: string | string[];
      source?: string;
      kanbanTaskId?: string;
      limit?: number;
      offset?: number;
    }) => Promise<DorothyIpcResult<{ runs: Run[] }>>;
    get: (id: string) => Promise<DorothyIpcResult<{ run: Run; steps: RunStep[] }>>;
    create: (input: {
      title: string;
      source: RunSource;
      sourceRefId?: string | null;
      priority?: string;
      state?: string;
      kanbanTaskId?: string | null;
      planId?: string | null;
      comment?: string | null;
    }) => Promise<DorothyIpcResult<{ run: Run }>>;
    updateState: (params: {
      id: string;
      state: string;
      blockedReason?: string;
      errorReason?: string;
      comment?: string;
    }) => Promise<DorothyIpcResult<{ run: Run }>>;
    updateMode: (params: {
      id: string;
      mode: 'manual' | 'team' | 'persistent' | 'ultraqa' | 'pipeline';
      reason?: string;
      source?: 'manual' | 'keyword' | 'policy' | 'default';
    }) => Promise<DorothyIpcResult<{ run: Run }>>;
  };
  sessions: {
    list: (options?: {
      agentId?: string;
      runId?: string;
      runStepId?: string;
      active?: boolean;
      limit?: number;
    }) => Promise<DorothyIpcResult<{ sessions: AgentSession[] }>>;
  };
  // Phase 6-AE — read-only, masked live agent terminal snapshots.
  agentTerminal?: {
    listSnapshots: (options?: { lines?: number }) =>
      Promise<DorothyIpcResult<{ snapshots: AgentTerminalSnapshot[]; updatedAt: string }>>;
    getSnapshot: (agentId: string, options?: { lines?: number }) =>
      Promise<DorothyIpcResult<{ snapshot: AgentTerminalSnapshot; updatedAt: string }>>;
  };
  artifacts: {
    list: (options?: {
      runId?: string;
      runStepId?: string;
      type?: string;
      producedByAgentId?: string;
      limit?: number;
    }) => Promise<DorothyIpcResult<{ artifacts: Artifact[] }>>;
    get: (id: string) => Promise<DorothyIpcResult<{ artifact: Artifact }>>;
    listByIds: (ids: string[]) => Promise<DorothyIpcResult<{ artifacts: Artifact[] }>>;
  };
  handoffs: {
    list: (params: { runId: string }) => Promise<DorothyIpcResult<{ handoffs: Handoff[] }>>;
  };
  plans: {
    list: (options?: {
      runId?: string;
      state?: string;
      limit?: number;
    }) => Promise<DorothyIpcResult<{ plans: Plan[] }>>;
    get: (id: string) => Promise<DorothyIpcResult<{ plan: Plan }>>;
  };
  // Phase 5A — PR / CI tracking. Read-only surface for the renderer.
  pr: {
    list: (options?: {
      state?: string | string[];
      runId?: string;
      owner?: string;
      repo?: string;
      limit?: number;
      offset?: number;
    }) => Promise<DorothyIpcResult<{ pullRequests: PullRequest[] }>>;
    get: (id: string) => Promise<DorothyIpcResult<{ pullRequest: PullRequest }>>;
    listByRun: (runId: string) => Promise<DorothyIpcResult<{ pullRequests: PullRequest[] }>>;
  };
  ci: {
    list: (options?: {
      state?: string | string[];
      runId?: string;
      pullRequestId?: string;
      workflow?: string;
      limit?: number;
      offset?: number;
    }) => Promise<DorothyIpcResult<{ ciRuns: CIRun[] }>>;
    get: (id: string) => Promise<DorothyIpcResult<{ ciRun: CIRun }>>;
    listByRun: (runId: string) => Promise<DorothyIpcResult<{ ciRuns: CIRun[] }>>;
    listByPullRequest: (pullRequestId: string) => Promise<DorothyIpcResult<{ ciRuns: CIRun[] }>>;
  };
  // Phase 5F — Hook Event Bus reads.
  hookEvents: {
    list: (options?: HookEventListOptions) =>
      Promise<DorothyIpcResult<{ events: HookEvent[] }>>;
    listByRun: (runId: string, options?: Omit<HookEventListOptions, 'runId'>) =>
      Promise<DorothyIpcResult<{ events: HookEvent[] }>>;
    listBySession: (agentSessionId: string, options?: Omit<HookEventListOptions, 'agentSessionId'>) =>
      Promise<DorothyIpcResult<{ events: HookEvent[] }>>;
    listRecent: (options?: Omit<HookEventListOptions, 'runId' | 'runStepId' | 'agentSessionId'>) =>
      Promise<DorothyIpcResult<{ events: HookEvent[] }>>;
  };
  // Phase 6-D — SkillCandidate reads + light writes.
  skillCandidates: {
    list: (options?: SkillCandidateListOptions) =>
      Promise<DorothyIpcResult<{ candidates: SkillCandidate[] }>>;
    listByRun: (runId: string, options?: Omit<SkillCandidateListOptions, 'runId'>) =>
      Promise<DorothyIpcResult<{ candidates: SkillCandidate[] }>>;
    get: (id: string) =>
      Promise<DorothyIpcResult<{ candidate: SkillCandidate }>>;
    updateStatus: (params: { id: string; status: SkillCandidateStatus; note?: string }) =>
      Promise<DorothyIpcResult<{ candidate: SkillCandidate }>>;
    fromImprovementSignal: (params: { id: string }) =>
      Promise<DorothyIpcResult<{ ok: boolean; signal: ImprovementSignal | null; candidate: SkillCandidate | null }>>;
    fromDiagnostic: (params: { id: string }) =>
      Promise<DorothyIpcResult<{ ok: boolean; diagnostic: Diagnostic | null; candidate: SkillCandidate | null }>>;
    convertToTask: (params: { id: string; column?: 'backlog' | 'planned' | 'ongoing' | 'done' }) =>
      Promise<DorothyIpcResult<{ ok: boolean; candidate: SkillCandidate | null; task: unknown }>>;
    counts: () =>
      Promise<DorothyIpcResult<{ counts: SkillCandidateCountsSnapshot }>>;
  };
  // Phase 6-W — App Factory (planning-only).
  appFactory: {
    listCandidates: (options?: {
      status?: AppCandidateStatus | AppCandidateStatus[];
      implementationDifficulty?: AppImplementationDifficulty | AppImplementationDifficulty[];
      limit?: number;
      offset?: number;
    }) => Promise<DorothyIpcResult<{ candidates: AppCandidate[] }>>;
    getCandidate: (id: string) => Promise<DorothyIpcResult<{ candidate: AppCandidate }>>;
    createCandidate: (input: CreateAppCandidateInput) => Promise<DorothyIpcResult<{ candidate: AppCandidate }>>;
    updateCandidateStatus: (params: { id: string; status: AppCandidateStatus }) =>
      Promise<DorothyIpcResult<{ candidate: AppCandidate }>>;
    generatePlanPreview: (params: { appCandidateId: string }) =>
      Promise<DorothyIpcResult<{ plan: AppFactoryPlan; persisted: boolean }>>;
    createPlan: (params: { appCandidateId: string; status?: AppFactoryPlanStatus }) =>
      Promise<DorothyIpcResult<{ plan: AppFactoryPlan; persisted: boolean }>>;
    listPlans: (options?: { appCandidateId?: string; status?: AppFactoryPlanStatus | AppFactoryPlanStatus[]; limit?: number }) =>
      Promise<DorothyIpcResult<{ plans: AppFactoryPlan[] }>>;
    getPlan: (id: string) => Promise<DorothyIpcResult<{ plan: AppFactoryPlan }>>;
    counts: () => Promise<DorothyIpcResult<{ counts: Record<string, number> }>>;
  };
  // Phase 6-B — AgentWorkflowProgress reads.
  workflowProgress: {
    list: (options?: WorkflowProgressListOptions) =>
      Promise<DorothyIpcResult<{ rows: AgentWorkflowProgress[] }>>;
    listByRun: (runId: string, options?: Omit<WorkflowProgressListOptions, 'runId'>) =>
      Promise<DorothyIpcResult<{ rows: AgentWorkflowProgress[] }>>;
    listBySession: (agentSessionId: string, options?: Omit<WorkflowProgressListOptions, 'agentSessionId'>) =>
      Promise<DorothyIpcResult<{ rows: AgentWorkflowProgress[] }>>;
    get: (id: string) =>
      Promise<DorothyIpcResult<{ row: AgentWorkflowProgress }>>;
    recomputeByRun: (runId: string) =>
      Promise<DorothyIpcResult<{ rows: AgentWorkflowProgress[] }>>;
    counts: () =>
      Promise<DorothyIpcResult<{ counts: WorkflowProgressCountsSnapshot }>>;
  };
  // Phase 6-A — Diagnostic reads + write surface.
  diagnostics: {
    list: (options?: DiagnosticListOptions) =>
      Promise<DorothyIpcResult<{ diagnostics: Diagnostic[] }>>;
    listByRun: (runId: string, options?: Omit<DiagnosticListOptions, 'runId'>) =>
      Promise<DorothyIpcResult<{ diagnostics: Diagnostic[] }>>;
    get: (id: string) =>
      Promise<DorothyIpcResult<{ diagnostic: Diagnostic }>>;
    updateStatus: (params: { id: string; status: DiagnosticStatus; note?: string }) =>
      Promise<DorothyIpcResult<{ diagnostic: Diagnostic }>>;
    convertToImprovement: (params: { id: string }) =>
      Promise<DorothyIpcResult<{ ok: boolean; diagnostic: Diagnostic | null; signal: ImprovementSignal | null }>>;
    counts: () =>
      Promise<DorothyIpcResult<{ counts: DiagnosticCountsSnapshot }>>;
  };
  // Phase 5C-B
  rateLimit: {
    listScheduled: (options?: { limit?: number }) => Promise<DorothyIpcResult<{ events: RateLimitEvent[] }>>;
    resumeNow: (eventId: string) => Promise<DorothyIpcResult<{ outcome: unknown }>>;
    schedulerStatus: () => Promise<DorothyIpcResult<{ tick: unknown }>>;
  };
  improvements: {
    list: (options?: {
      status?: ImprovementSignalStatus | ImprovementSignalStatus[];
      source?: string;
      runId?: string;
      severity?: string;
      limit?: number;
      offset?: number;
    }) => Promise<DorothyIpcResult<{ signals: ImprovementSignal[] }>>;
    listByRun: (runId: string) => Promise<DorothyIpcResult<{ signals: ImprovementSignal[] }>>;
    updateStatus: (params: { id: string; status: ImprovementSignalStatus; note?: string }) =>
      Promise<DorothyIpcResult<{ signal: ImprovementSignal }>>;
    convertToTask: (params: {
      id: string;
      column?: 'backlog' | 'planned' | 'ongoing' | 'done';
      projectId?: string;
      projectPath?: string;
    }) => Promise<DorothyIpcResult<{ ok: boolean; signal: ImprovementSignal | null; task: unknown }>>;
  };
  // Phase 6-E — Agent Definition Registry / Idle Reason / Communication.
  agentDefinitions: {
    list: (options?: { extraProjectPaths?: string[]; includeUserDir?: boolean }) =>
      Promise<DorothyIpcResult<{ snapshot: AgentRegistrySnapshot; dbUnavailable?: boolean }>>;
    get: (agentId: string) => Promise<DorothyIpcResult<{ definition: AgentDefinition }>>;
    rescan: (options?: { extraProjectPaths?: string[]; includeUserDir?: boolean }) =>
      Promise<DorothyIpcResult<{ snapshot: AgentRegistrySnapshot; dbUnavailable?: boolean }>>;
    reloadLiveAgents: (params?: { reason?: string }) =>
      Promise<DorothyIpcResult<{ result: ReloadLiveAgentsResult }>>;
  };
  agentIdle: {
    list: (options?: { agentIds?: string[] }) =>
      Promise<DorothyIpcResult<{ statuses: AgentIdleStatus[] }>>;
    get: (agentId: string) =>
      Promise<DorothyIpcResult<{ status: AgentIdleStatus | null }>>;
  };
  agentCommunication: {
    listByRun: (runId: string, options?: { limit?: number }) =>
      Promise<DorothyIpcResult<{ events: AgentCommunicationEvent[] }>>;
    listByAgent: (agentId: string, options?: { limit?: number; runIds?: string[] }) =>
      Promise<DorothyIpcResult<{ events: AgentCommunicationEvent[] }>>;
    listRecent: (options?: { limit?: number }) =>
      Promise<DorothyIpcResult<{ events: AgentCommunicationEvent[] }>>;
  };
  // Phase 6-G — manual agent-definition registration.
  agentRegistration: {
    listCandidates: () =>
      Promise<DorothyIpcResult<{ candidates: AgentDefinition[] }>>;
    preview: (params: { agentDefinitionId: string; options?: RegisterAgentDefinitionOptions }) =>
      Promise<DorothyIpcResult<{ preview: AgentRegistrationPreview }>>;
    register: (params: { agentDefinitionId: string; options?: RegisterAgentDefinitionOptions; confirm?: boolean }) =>
      Promise<DorothyIpcResult<RegisterAgentDefinitionResult>>;
  };
  // Phase 6-J — dispatch readiness (dry-run diagnosis).
  agentDispatch: {
    listReadiness: (options?: { agentIds?: string[] }) =>
      Promise<DorothyIpcResult<{ readiness: AgentDispatchReadiness[]; counts: DispatchReadinessCounts }>>;
    listReadinessByRun: (runId: string) =>
      Promise<DorothyIpcResult<{ readiness: AgentDispatchReadiness[]; counts: DispatchReadinessCounts }>>;
  };
  // Phase 6-K — Claude launch readiness.
  claude: {
    launchReadiness: () => Promise<DorothyIpcResult<ClaudeRuntimeReadiness>>;
  };
  // Phase 6-M — Codex runtime readiness + stale sessions.
  codex: {
    runtimeReadiness: () => Promise<DorothyIpcResult<{ readiness: CodexRuntimeReadiness }>>;
  };
  staleSessions: {
    list: () => Promise<DorothyIpcResult<{ flags: StaleSessionFlag[] }>>;
  };
  // Phase 6-Q — batch warm-up + Codex model normalization.
  warmup: {
    targets: (options?: { agentIds?: string[] }) =>
      Promise<DorothyIpcResult<{ targets: AgentWarmupTarget[] }>>;
    all: (params: { agentIds?: string[]; confirm?: boolean }) =>
      Promise<DorothyIpcResult<{ result: AgentWarmupResult }>>;
  };
  codexNormalize: {
    preview: () => Promise<DorothyIpcResult<{ preview: CodexNormalizationPreview }>>;
    apply: (params: { confirm?: boolean }) =>
      Promise<DorothyIpcResult<{ result: CodexNormalizationResult }>>;
  };
}

function bridge(): DorothyRunsBridge | null {
  if (typeof window === 'undefined') return null;
  const api = (
    window as unknown as {
      electronAPI?: {
        dorothy?: Partial<DorothyRunsBridge>;
      };
    }
  ).electronAPI;
  const d = api?.dorothy;
  // Coarse runtime check: the bridge must have the runs namespace.
  if (!d || !d.runs) return null;
  return d as DorothyRunsBridge;
}

const UNAVAILABLE: DorothyIpcResult<never> = {
  ok: false,
  error: 'Dorothy IPC bridge unavailable (running outside Electron)',
  dbUnavailable: true,
};

function unavailable<T>(): DorothyIpcResult<T> {
  return UNAVAILABLE as DorothyIpcResult<T>;
}

/* ============================================================================
 * Public client
 * ========================================================================== */

export const dorothyRunsClient = {
  runs: {
    list: async (options?: Parameters<DorothyRunsBridge['runs']['list']>[0]) => {
      const b = bridge();
      if (!b) return unavailable<{ runs: Run[] }>();
      try {
        return await b.runs.list(options);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ runs: Run[] }>;
      }
    },
    get: async (id: string) => {
      const b = bridge();
      if (!b) return unavailable<{ run: Run; steps: RunStep[] }>();
      try {
        return await b.runs.get(id);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'get failed' } as DorothyIpcResult<{ run: Run; steps: RunStep[] }>;
      }
    },
    create: async (input: Parameters<DorothyRunsBridge['runs']['create']>[0]) => {
      const b = bridge();
      if (!b) return unavailable<{ run: Run }>();
      try { return await b.runs.create(input); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'create failed' } as DorothyIpcResult<{ run: Run }>;
      }
    },
    updateState: async (params: Parameters<DorothyRunsBridge['runs']['updateState']>[0]) => {
      const b = bridge();
      if (!b) return unavailable<{ run: Run }>();
      try { return await b.runs.updateState(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'updateState failed' } as DorothyIpcResult<{ run: Run }>;
      }
    },
    updateMode: async (params: Parameters<DorothyRunsBridge['runs']['updateMode']>[0]) => {
      const b = bridge();
      if (!b) return unavailable<{ run: Run }>();
      try { return await b.runs.updateMode(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'updateMode failed' } as DorothyIpcResult<{ run: Run }>;
      }
    },
  },
  sessions: {
    list: async (options?: Parameters<DorothyRunsBridge['sessions']['list']>[0]) => {
      const b = bridge();
      if (!b) return unavailable<{ sessions: AgentSession[] }>();
      try { return await b.sessions.list(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ sessions: AgentSession[] }>;
      }
    },
  },
  // Phase 6-AE — read-only, masked agent terminal snapshots. Works in BOTH
  // Electron (IPC bridge) and browser-dev (REST proxy to the electron API).
  agentTerminal: {
    listSnapshots: async (options?: { lines?: number }): Promise<DorothyIpcResult<{ snapshots: AgentTerminalSnapshot[]; updatedAt: string }>> => {
      const b = bridge();
      if (b?.agentTerminal) {
        try { return await b.agentTerminal.listSnapshots(options); }
        catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'list failed' }; }
      }
      // Browser-dev fallback → Next proxy → electron API.
      try {
        const q = options?.lines ? `?lines=${options.lines}` : '';
        const res = await fetch(`/api/dorothy/agent-terminal-snapshots${q}`, { cache: 'no-store' });
        const data = await res.json();
        return { ok: true, data: { snapshots: data.snapshots ?? [], updatedAt: data.updatedAt ?? '' }, dbUnavailable: !!data.unavailable };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' };
      }
    },
    getSnapshot: async (agentId: string, options?: { lines?: number }): Promise<DorothyIpcResult<{ snapshot: AgentTerminalSnapshot | null; updatedAt: string }>> => {
      const b = bridge();
      if (b?.agentTerminal) {
        try { return await b.agentTerminal.getSnapshot(agentId, options); }
        catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'get failed' }; }
      }
      try {
        const q = new URLSearchParams({ agentId, ...(options?.lines ? { lines: String(options.lines) } : {}) }).toString();
        const res = await fetch(`/api/dorothy/agent-terminal-snapshots?${q}`, { cache: 'no-store' });
        const data = await res.json();
        return { ok: true, data: { snapshot: data.snapshot ?? null, updatedAt: data.updatedAt ?? '' }, dbUnavailable: !!data.unavailable };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' };
      }
    },
  },
  artifacts: {
    list: async (options?: Parameters<DorothyRunsBridge['artifacts']['list']>[0]) => {
      const b = bridge();
      if (!b) return unavailable<{ artifacts: Artifact[] }>();
      try { return await b.artifacts.list(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ artifacts: Artifact[] }>;
      }
    },
    get: async (id: string) => {
      const b = bridge();
      if (!b) return unavailable<{ artifact: Artifact }>();
      try { return await b.artifacts.get(id); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'get failed' } as DorothyIpcResult<{ artifact: Artifact }>;
      }
    },
    listByIds: async (ids: string[]) => {
      const b = bridge();
      if (!b) return unavailable<{ artifacts: Artifact[] }>();
      try { return await b.artifacts.listByIds(ids); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listByIds failed' } as DorothyIpcResult<{ artifacts: Artifact[] }>;
      }
    },
  },
  handoffs: {
    list: async (params: { runId: string }) => {
      const b = bridge();
      if (!b) return unavailable<{ handoffs: Handoff[] }>();
      try { return await b.handoffs.list(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ handoffs: Handoff[] }>;
      }
    },
  },
  plans: {
    list: async (options?: Parameters<DorothyRunsBridge['plans']['list']>[0]) => {
      const b = bridge();
      if (!b) return unavailable<{ plans: Plan[] }>();
      try { return await b.plans.list(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ plans: Plan[] }>;
      }
    },
    get: async (id: string) => {
      const b = bridge();
      if (!b) return unavailable<{ plan: Plan }>();
      try { return await b.plans.get(id); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'get failed' } as DorothyIpcResult<{ plan: Plan }>;
      }
    },
  },
  pr: {
    list: async (options?: Parameters<DorothyRunsBridge['pr']['list']>[0]) => {
      const b = bridge();
      if (!b) return unavailable<{ pullRequests: PullRequest[] }>();
      try { return await b.pr.list(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ pullRequests: PullRequest[] }>;
      }
    },
    get: async (id: string) => {
      const b = bridge();
      if (!b) return unavailable<{ pullRequest: PullRequest }>();
      try { return await b.pr.get(id); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'get failed' } as DorothyIpcResult<{ pullRequest: PullRequest }>;
      }
    },
    listByRun: async (runId: string) => {
      const b = bridge();
      if (!b) return unavailable<{ pullRequests: PullRequest[] }>();
      try { return await b.pr.listByRun(runId); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listByRun failed' } as DorothyIpcResult<{ pullRequests: PullRequest[] }>;
      }
    },
  },
  rateLimit: {
    listScheduled: async (options?: Parameters<DorothyRunsBridge['rateLimit']['listScheduled']>[0]) => {
      const b = bridge();
      if (!b) return unavailable<{ events: RateLimitEvent[] }>();
      try { return await b.rateLimit.listScheduled(options); }
      catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ events: RateLimitEvent[] }>; }
    },
    resumeNow: async (eventId: string) => {
      const b = bridge();
      if (!b) return unavailable<{ outcome: unknown }>();
      try { return await b.rateLimit.resumeNow(eventId); }
      catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'resumeNow failed' } as DorothyIpcResult<{ outcome: unknown }>; }
    },
    schedulerStatus: async () => {
      const b = bridge();
      if (!b) return unavailable<{ tick: unknown }>();
      try { return await b.rateLimit.schedulerStatus(); }
      catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'status failed' } as DorothyIpcResult<{ tick: unknown }>; }
    },
  },
  improvements: {
    list: async (options?: Parameters<DorothyRunsBridge['improvements']['list']>[0]) => {
      const b = bridge();
      if (!b) return unavailable<{ signals: ImprovementSignal[] }>();
      try { return await b.improvements.list(options); }
      catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ signals: ImprovementSignal[] }>; }
    },
    listByRun: async (runId: string) => {
      const b = bridge();
      if (!b) return unavailable<{ signals: ImprovementSignal[] }>();
      try { return await b.improvements.listByRun(runId); }
      catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'listByRun failed' } as DorothyIpcResult<{ signals: ImprovementSignal[] }>; }
    },
    updateStatus: async (params: Parameters<DorothyRunsBridge['improvements']['updateStatus']>[0]) => {
      const b = bridge();
      if (!b) return unavailable<{ signal: ImprovementSignal }>();
      try { return await b.improvements.updateStatus(params); }
      catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'updateStatus failed' } as DorothyIpcResult<{ signal: ImprovementSignal }>; }
    },
    convertToTask: async (params: Parameters<DorothyRunsBridge['improvements']['convertToTask']>[0]) => {
      const b = bridge();
      type R = { ok: boolean; signal: ImprovementSignal | null; task: unknown };
      if (!b) return unavailable<R>();
      try { return await b.improvements.convertToTask(params); }
      catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'convertToTask failed' } as DorothyIpcResult<R>; }
    },
  },
  ci: {
    list: async (options?: Parameters<DorothyRunsBridge['ci']['list']>[0]) => {
      const b = bridge();
      if (!b) return unavailable<{ ciRuns: CIRun[] }>();
      try { return await b.ci.list(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ ciRuns: CIRun[] }>;
      }
    },
    get: async (id: string) => {
      const b = bridge();
      if (!b) return unavailable<{ ciRun: CIRun }>();
      try { return await b.ci.get(id); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'get failed' } as DorothyIpcResult<{ ciRun: CIRun }>;
      }
    },
    listByRun: async (runId: string) => {
      const b = bridge();
      if (!b) return unavailable<{ ciRuns: CIRun[] }>();
      try { return await b.ci.listByRun(runId); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listByRun failed' } as DorothyIpcResult<{ ciRuns: CIRun[] }>;
      }
    },
    listByPullRequest: async (pullRequestId: string) => {
      const b = bridge();
      if (!b) return unavailable<{ ciRuns: CIRun[] }>();
      try { return await b.ci.listByPullRequest(pullRequestId); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listByPullRequest failed' } as DorothyIpcResult<{ ciRuns: CIRun[] }>;
      }
    },
  },
  hookEvents: {
    list: async (options?: HookEventListOptions) => {
      const b = bridge();
      if (!b) return unavailable<{ events: HookEvent[] }>();
      try { return await b.hookEvents.list(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ events: HookEvent[] }>;
      }
    },
    listByRun: async (runId: string, options?: Omit<HookEventListOptions, 'runId'>) => {
      const b = bridge();
      if (!b) return unavailable<{ events: HookEvent[] }>();
      try { return await b.hookEvents.listByRun(runId, options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listByRun failed' } as DorothyIpcResult<{ events: HookEvent[] }>;
      }
    },
    listBySession: async (agentSessionId: string, options?: Omit<HookEventListOptions, 'agentSessionId'>) => {
      const b = bridge();
      if (!b) return unavailable<{ events: HookEvent[] }>();
      try { return await b.hookEvents.listBySession(agentSessionId, options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listBySession failed' } as DorothyIpcResult<{ events: HookEvent[] }>;
      }
    },
    listRecent: async (options?: Omit<HookEventListOptions, 'runId' | 'runStepId' | 'agentSessionId'>) => {
      const b = bridge();
      if (!b) return unavailable<{ events: HookEvent[] }>();
      try { return await b.hookEvents.listRecent(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listRecent failed' } as DorothyIpcResult<{ events: HookEvent[] }>;
      }
    },
  },
  diagnostics: {
    list: async (options?: DiagnosticListOptions) => {
      const b = bridge();
      if (!b) return unavailable<{ diagnostics: Diagnostic[] }>();
      try { return await b.diagnostics.list(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ diagnostics: Diagnostic[] }>;
      }
    },
    listByRun: async (runId: string, options?: Omit<DiagnosticListOptions, 'runId'>) => {
      const b = bridge();
      if (!b) return unavailable<{ diagnostics: Diagnostic[] }>();
      try { return await b.diagnostics.listByRun(runId, options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listByRun failed' } as DorothyIpcResult<{ diagnostics: Diagnostic[] }>;
      }
    },
    get: async (id: string) => {
      const b = bridge();
      if (!b) return unavailable<{ diagnostic: Diagnostic }>();
      try { return await b.diagnostics.get(id); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'get failed' } as DorothyIpcResult<{ diagnostic: Diagnostic }>;
      }
    },
    updateStatus: async (params: { id: string; status: DiagnosticStatus; note?: string }) => {
      const b = bridge();
      if (!b) return unavailable<{ diagnostic: Diagnostic }>();
      try { return await b.diagnostics.updateStatus(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'updateStatus failed' } as DorothyIpcResult<{ diagnostic: Diagnostic }>;
      }
    },
    convertToImprovement: async (params: { id: string }) => {
      const b = bridge();
      type R = { ok: boolean; diagnostic: Diagnostic | null; signal: ImprovementSignal | null };
      if (!b) return unavailable<R>();
      try { return await b.diagnostics.convertToImprovement(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'convertToImprovement failed' } as DorothyIpcResult<R>;
      }
    },
    counts: async () => {
      const b = bridge();
      if (!b) return unavailable<{ counts: DiagnosticCountsSnapshot }>();
      try { return await b.diagnostics.counts(); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'counts failed' } as DorothyIpcResult<{ counts: DiagnosticCountsSnapshot }>;
      }
    },
  },
  workflowProgress: {
    list: async (options?: WorkflowProgressListOptions) => {
      const b = bridge();
      if (!b) return unavailable<{ rows: AgentWorkflowProgress[] }>();
      try { return await b.workflowProgress.list(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ rows: AgentWorkflowProgress[] }>;
      }
    },
    listByRun: async (runId: string, options?: Omit<WorkflowProgressListOptions, 'runId'>) => {
      const b = bridge();
      if (!b) return unavailable<{ rows: AgentWorkflowProgress[] }>();
      try { return await b.workflowProgress.listByRun(runId, options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listByRun failed' } as DorothyIpcResult<{ rows: AgentWorkflowProgress[] }>;
      }
    },
    listBySession: async (agentSessionId: string, options?: Omit<WorkflowProgressListOptions, 'agentSessionId'>) => {
      const b = bridge();
      if (!b) return unavailable<{ rows: AgentWorkflowProgress[] }>();
      try { return await b.workflowProgress.listBySession(agentSessionId, options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listBySession failed' } as DorothyIpcResult<{ rows: AgentWorkflowProgress[] }>;
      }
    },
    get: async (id: string) => {
      const b = bridge();
      if (!b) return unavailable<{ row: AgentWorkflowProgress }>();
      try { return await b.workflowProgress.get(id); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'get failed' } as DorothyIpcResult<{ row: AgentWorkflowProgress }>;
      }
    },
    recomputeByRun: async (runId: string) => {
      const b = bridge();
      if (!b) return unavailable<{ rows: AgentWorkflowProgress[] }>();
      try { return await b.workflowProgress.recomputeByRun(runId); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'recomputeByRun failed' } as DorothyIpcResult<{ rows: AgentWorkflowProgress[] }>;
      }
    },
    counts: async () => {
      const b = bridge();
      if (!b) return unavailable<{ counts: WorkflowProgressCountsSnapshot }>();
      try { return await b.workflowProgress.counts(); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'counts failed' } as DorothyIpcResult<{ counts: WorkflowProgressCountsSnapshot }>;
      }
    },
  },
  skillCandidates: {
    list: async (options?: SkillCandidateListOptions) => {
      const b = bridge();
      if (!b) return unavailable<{ candidates: SkillCandidate[] }>();
      try { return await b.skillCandidates.list(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ candidates: SkillCandidate[] }>;
      }
    },
    listByRun: async (runId: string, options?: Omit<SkillCandidateListOptions, 'runId'>) => {
      const b = bridge();
      if (!b) return unavailable<{ candidates: SkillCandidate[] }>();
      try { return await b.skillCandidates.listByRun(runId, options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listByRun failed' } as DorothyIpcResult<{ candidates: SkillCandidate[] }>;
      }
    },
    get: async (id: string) => {
      const b = bridge();
      if (!b) return unavailable<{ candidate: SkillCandidate }>();
      try { return await b.skillCandidates.get(id); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'get failed' } as DorothyIpcResult<{ candidate: SkillCandidate }>;
      }
    },
    updateStatus: async (params: { id: string; status: SkillCandidateStatus; note?: string }) => {
      const b = bridge();
      if (!b) return unavailable<{ candidate: SkillCandidate }>();
      try { return await b.skillCandidates.updateStatus(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'updateStatus failed' } as DorothyIpcResult<{ candidate: SkillCandidate }>;
      }
    },
    fromImprovementSignal: async (params: { id: string }) => {
      const b = bridge();
      type R = { ok: boolean; signal: ImprovementSignal | null; candidate: SkillCandidate | null };
      if (!b) return unavailable<R>();
      try { return await b.skillCandidates.fromImprovementSignal(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'fromImprovementSignal failed' } as DorothyIpcResult<R>;
      }
    },
    fromDiagnostic: async (params: { id: string }) => {
      const b = bridge();
      type R = { ok: boolean; diagnostic: Diagnostic | null; candidate: SkillCandidate | null };
      if (!b) return unavailable<R>();
      try { return await b.skillCandidates.fromDiagnostic(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'fromDiagnostic failed' } as DorothyIpcResult<R>;
      }
    },
    convertToTask: async (params: { id: string; column?: 'backlog' | 'planned' | 'ongoing' | 'done' }) => {
      const b = bridge();
      type R = { ok: boolean; candidate: SkillCandidate | null; task: unknown };
      if (!b) return unavailable<R>();
      try { return await b.skillCandidates.convertToTask(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'convertToTask failed' } as DorothyIpcResult<R>;
      }
    },
    counts: async () => {
      const b = bridge();
      if (!b) return unavailable<{ counts: SkillCandidateCountsSnapshot }>();
      try { return await b.skillCandidates.counts(); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'counts failed' } as DorothyIpcResult<{ counts: SkillCandidateCountsSnapshot }>;
      }
    },
  },
  // Phase 6-W — App Factory (planning-only).
  appFactory: {
    listCandidates: async (options?: {
      status?: AppCandidateStatus | AppCandidateStatus[];
      implementationDifficulty?: AppImplementationDifficulty | AppImplementationDifficulty[];
      limit?: number;
      offset?: number;
    }) => {
      const b = bridge();
      if (!b) return unavailable<{ candidates: AppCandidate[] }>();
      try { return await b.appFactory.listCandidates(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ candidates: AppCandidate[] }>;
      }
    },
    getCandidate: async (id: string) => {
      const b = bridge();
      if (!b) return unavailable<{ candidate: AppCandidate }>();
      try { return await b.appFactory.getCandidate(id); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'get failed' } as DorothyIpcResult<{ candidate: AppCandidate }>;
      }
    },
    createCandidate: async (input: CreateAppCandidateInput) => {
      const b = bridge();
      if (!b) return unavailable<{ candidate: AppCandidate }>();
      try { return await b.appFactory.createCandidate(input); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'create failed' } as DorothyIpcResult<{ candidate: AppCandidate }>;
      }
    },
    updateCandidateStatus: async (params: { id: string; status: AppCandidateStatus }) => {
      const b = bridge();
      if (!b) return unavailable<{ candidate: AppCandidate }>();
      try { return await b.appFactory.updateCandidateStatus(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'update failed' } as DorothyIpcResult<{ candidate: AppCandidate }>;
      }
    },
    generatePlanPreview: async (params: { appCandidateId: string }) => {
      const b = bridge();
      if (!b) return unavailable<{ plan: AppFactoryPlan; persisted: boolean }>();
      try { return await b.appFactory.generatePlanPreview(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'preview failed' } as DorothyIpcResult<{ plan: AppFactoryPlan; persisted: boolean }>;
      }
    },
    createPlan: async (params: { appCandidateId: string; status?: AppFactoryPlanStatus }) => {
      const b = bridge();
      if (!b) return unavailable<{ plan: AppFactoryPlan; persisted: boolean }>();
      try { return await b.appFactory.createPlan(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'create plan failed' } as DorothyIpcResult<{ plan: AppFactoryPlan; persisted: boolean }>;
      }
    },
    listPlans: async (options?: { appCandidateId?: string; status?: AppFactoryPlanStatus | AppFactoryPlanStatus[]; limit?: number }) => {
      const b = bridge();
      if (!b) return unavailable<{ plans: AppFactoryPlan[] }>();
      try { return await b.appFactory.listPlans(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ plans: AppFactoryPlan[] }>;
      }
    },
    getPlan: async (id: string) => {
      const b = bridge();
      if (!b) return unavailable<{ plan: AppFactoryPlan }>();
      try { return await b.appFactory.getPlan(id); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'get failed' } as DorothyIpcResult<{ plan: AppFactoryPlan }>;
      }
    },
    counts: async () => {
      const b = bridge();
      if (!b) return unavailable<{ counts: Record<string, number> }>();
      try { return await b.appFactory.counts(); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'counts failed' } as DorothyIpcResult<{ counts: Record<string, number> }>;
      }
    },
  },
  // Phase 6-E — Agent Definition Registry / Idle Reason / Communication.
  agentDefinitions: {
    list: async (options?: { extraProjectPaths?: string[]; includeUserDir?: boolean }) => {
      const b = bridge();
      type R = { snapshot: AgentRegistrySnapshot; dbUnavailable?: boolean };
      if (!b) return unavailable<R>();
      try { return await b.agentDefinitions.list(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<R>;
      }
    },
    get: async (agentId: string) => {
      const b = bridge();
      if (!b) return unavailable<{ definition: AgentDefinition }>();
      try { return await b.agentDefinitions.get(agentId); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'get failed' } as DorothyIpcResult<{ definition: AgentDefinition }>;
      }
    },
    rescan: async (options?: { extraProjectPaths?: string[]; includeUserDir?: boolean }) => {
      const b = bridge();
      type R = { snapshot: AgentRegistrySnapshot; dbUnavailable?: boolean };
      if (!b) return unavailable<R>();
      try { return await b.agentDefinitions.rescan(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'rescan failed' } as DorothyIpcResult<R>;
      }
    },
    reloadLiveAgents: async (params?: { reason?: string }) => {
      const b = bridge();
      if (!b) return unavailable<{ result: ReloadLiveAgentsResult }>();
      try { return await b.agentDefinitions.reloadLiveAgents(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'reloadLiveAgents failed' } as DorothyIpcResult<{ result: ReloadLiveAgentsResult }>;
      }
    },
  },
  agentIdle: {
    list: async (options?: { agentIds?: string[] }) => {
      const b = bridge();
      if (!b) return unavailable<{ statuses: AgentIdleStatus[] }>();
      try { return await b.agentIdle.list(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'list failed' } as DorothyIpcResult<{ statuses: AgentIdleStatus[] }>;
      }
    },
    get: async (agentId: string) => {
      const b = bridge();
      if (!b) return unavailable<{ status: AgentIdleStatus | null }>();
      try { return await b.agentIdle.get(agentId); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'get failed' } as DorothyIpcResult<{ status: AgentIdleStatus | null }>;
      }
    },
  },
  agentCommunication: {
    listByRun: async (runId: string, options?: { limit?: number }) => {
      const b = bridge();
      if (!b) return unavailable<{ events: AgentCommunicationEvent[] }>();
      try { return await b.agentCommunication.listByRun(runId, options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listByRun failed' } as DorothyIpcResult<{ events: AgentCommunicationEvent[] }>;
      }
    },
    listByAgent: async (agentId: string, options?: { limit?: number; runIds?: string[] }) => {
      const b = bridge();
      if (!b) return unavailable<{ events: AgentCommunicationEvent[] }>();
      try { return await b.agentCommunication.listByAgent(agentId, options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listByAgent failed' } as DorothyIpcResult<{ events: AgentCommunicationEvent[] }>;
      }
    },
    listRecent: async (options?: { limit?: number }) => {
      const b = bridge();
      if (!b) return unavailable<{ events: AgentCommunicationEvent[] }>();
      try { return await b.agentCommunication.listRecent(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listRecent failed' } as DorothyIpcResult<{ events: AgentCommunicationEvent[] }>;
      }
    },
  },
  agentRegistration: {
    listCandidates: async () => {
      const b = bridge();
      if (!b) return unavailable<{ candidates: AgentDefinition[] }>();
      try { return await b.agentRegistration.listCandidates(); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listCandidates failed' } as DorothyIpcResult<{ candidates: AgentDefinition[] }>;
      }
    },
    preview: async (params: { agentDefinitionId: string; options?: RegisterAgentDefinitionOptions }) => {
      const b = bridge();
      if (!b) return unavailable<{ preview: AgentRegistrationPreview }>();
      try { return await b.agentRegistration.preview(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'preview failed' } as DorothyIpcResult<{ preview: AgentRegistrationPreview }>;
      }
    },
    register: async (params: { agentDefinitionId: string; options?: RegisterAgentDefinitionOptions; confirm?: boolean }) => {
      const b = bridge();
      if (!b) return unavailable<RegisterAgentDefinitionResult>();
      try { return await b.agentRegistration.register(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'register failed' } as DorothyIpcResult<RegisterAgentDefinitionResult>;
      }
    },
  },
  agentDispatch: {
    listReadiness: async (options?: { agentIds?: string[] }) => {
      const b = bridge();
      type R = { readiness: AgentDispatchReadiness[]; counts: DispatchReadinessCounts };
      if (!b) return unavailable<R>();
      try { return await b.agentDispatch.listReadiness(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listReadiness failed' } as DorothyIpcResult<R>;
      }
    },
    listReadinessByRun: async (runId: string) => {
      const b = bridge();
      type R = { readiness: AgentDispatchReadiness[]; counts: DispatchReadinessCounts };
      if (!b) return unavailable<R>();
      try { return await b.agentDispatch.listReadinessByRun(runId); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listReadinessByRun failed' } as DorothyIpcResult<R>;
      }
    },
  },
  claude: {
    launchReadiness: async () => {
      const b = bridge();
      if (!b) return unavailable<ClaudeRuntimeReadiness>();
      try { return await b.claude.launchReadiness(); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'launchReadiness failed' } as DorothyIpcResult<ClaudeRuntimeReadiness>;
      }
    },
  },
  codex: {
    runtimeReadiness: async () => {
      const b = bridge();
      if (!b) return unavailable<{ readiness: CodexRuntimeReadiness }>();
      try { return await b.codex.runtimeReadiness(); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'runtimeReadiness failed' } as DorothyIpcResult<{ readiness: CodexRuntimeReadiness }>;
      }
    },
  },
  staleSessions: {
    list: async () => {
      const b = bridge();
      if (!b) return unavailable<{ flags: StaleSessionFlag[] }>();
      try { return await b.staleSessions.list(); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'staleSessions failed' } as DorothyIpcResult<{ flags: StaleSessionFlag[] }>;
      }
    },
  },
  warmup: {
    targets: async (options?: { agentIds?: string[] }) => {
      const b = bridge();
      if (!b) return unavailable<{ targets: AgentWarmupTarget[] }>();
      try { return await b.warmup.targets(options); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'targets failed' } as DorothyIpcResult<{ targets: AgentWarmupTarget[] }>;
      }
    },
    all: async (params: { agentIds?: string[]; confirm?: boolean }) => {
      const b = bridge();
      if (!b) return unavailable<{ result: AgentWarmupResult }>();
      try { return await b.warmup.all(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'warmupAll failed' } as DorothyIpcResult<{ result: AgentWarmupResult }>;
      }
    },
  },
  codexNormalize: {
    preview: async () => {
      const b = bridge();
      if (!b) return unavailable<{ preview: CodexNormalizationPreview }>();
      try { return await b.codexNormalize.preview(); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'preview failed' } as DorothyIpcResult<{ preview: CodexNormalizationPreview }>;
      }
    },
    apply: async (params: { confirm?: boolean }) => {
      const b = bridge();
      if (!b) return unavailable<{ result: CodexNormalizationResult }>();
      try { return await b.codexNormalize.apply(params); }
      catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'apply failed' } as DorothyIpcResult<{ result: CodexNormalizationResult }>;
      }
    },
  },
};

// Convenience re-exports used by hooks.
export type { DorothyIpcResult, RunState, RunSource };
