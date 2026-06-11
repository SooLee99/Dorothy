/**
 * Dorothy MVP Phase 2 — read-only React hooks over the Run/Session/Artifact IPC.
 *
 * Hooks fetch on mount and re-fetch on a fixed 15 s interval (no live event
 * stream is wired in Phase 2; that's the `dorothy:runs:stream` follow-up). Each
 * hook exposes `{ data, isLoading, error, dbUnavailable, refresh }` so empty
 * states are uniform across the new screens.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dorothyRunsClient } from '@/lib/dorothyRunsClient';
import type { AgentTerminalSnapshot } from '@/lib/agentTerminalSnapshot';
import type {
  Run,
  RunStep,
  RunState,
  RunSource,
  AgentSession,
  Artifact,
  Handoff,
  RunGroup,
  PullRequest,
  PullRequestState,
  CIRun,
  CIRunState,
  RateLimitEvent,
  ImprovementSignal,
  ImprovementSignalStatus,
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
  AppFactoryPlan,
  AppFactoryPlanStatus,
  AgentDefinition,
  AgentRegistrySnapshot,
  AgentRegistryMismatch,
  AgentIdleStatus,
  AgentCommunicationEvent,
  AgentDispatchReadiness,
  DispatchReadinessCounts,
  ClaudeRuntimeReadiness,
  CodexRuntimeReadiness,
  StaleSessionFlag,
  AgentWarmupTarget,
} from '@/types/dorothy';
import { runGroupOf } from '@/types/dorothy';

const REFRESH_MS = 15_000;

interface HookState<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  dbUnavailable: boolean;
}

function emptyState<T>(initial: T): HookState<T> {
  return { data: initial, isLoading: true, error: null, dbUnavailable: false };
}

/**
 * Shared polling driver. Calls `fetcher` immediately, then every REFRESH_MS,
 * and provides a manual `refresh()` returning a promise so callers can await
 * a refresh after mutating state.
 *
 * The `enabled` flag lets callers (e.g. Run Detail when `id` is undefined)
 * skip the network entirely.
 */
function usePolledFetch<T>(
  fetcher: () => Promise<{ ok: boolean; data?: T; error?: string; dbUnavailable?: boolean }>,
  initial: T,
  enabled = true,
  intervalMs = REFRESH_MS
) {
  const [state, setState] = useState<HookState<T>>(emptyState(initial));
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    const res = await fetcherRef.current();
    setState({
      data: res.ok && res.data ? res.data : initial,
      isLoading: false,
      error: res.ok ? null : (res.error ?? 'unknown error'),
      dbUnavailable: !!res.dbUnavailable,
    });
  // `initial` is captured by reference; callers should pass a stable value.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState(s => ({ ...s, isLoading: false }));
      return;
    }
    void run();
    const id = setInterval(() => { void run(); }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, run, intervalMs]);

  return { ...state, refresh: run };
}

/* ============================================================================
 * Runs
 * ========================================================================== */

export interface UseDorothyRunsOptions {
  state?: RunState | RunState[];
  source?: RunSource;
  kanbanTaskId?: string;
  limit?: number;
}

export function useDorothyRuns(options: UseDorothyRunsOptions = {}) {
  const { state, source, kanbanTaskId, limit } = options;
  // Stabilize the array reference for state filtering.
  const stateKey = Array.isArray(state) ? state.join(',') : state ?? '';

  const fetcher = useCallback(() => {
    return dorothyRunsClient.runs.list({ state, source, kanbanTaskId, limit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey, source, kanbanTaskId, limit]);

  const { data, isLoading, error, dbUnavailable, refresh } = usePolledFetch<{ runs: Run[] }>(
    fetcher,
    { runs: [] }
  );

  // Bucket the runs into the 5 UI groups so consumers (Run Board / Active
  // Summary) don't have to do it themselves.
  const groups = useMemo(() => {
    const out: Record<RunGroup, Run[]> = {
      pending: [],
      active: [],
      blocked: [],
      done: [],
      stopped: [],
    };
    for (const r of data?.runs ?? []) {
      out[runGroupOf(r.state)].push(r);
    }
    return out;
  }, [data?.runs]);

  return {
    runs: data?.runs ?? [],
    groups,
    isLoading,
    error,
    dbUnavailable,
    refresh,
  };
}

/* ============================================================================
 * Single Run + its bundle
 * ========================================================================== */

export function useDorothyRun(id: string | undefined) {
  const fetcher = useCallback(async () => {
    if (!id) return { ok: false, error: 'missing id' as const, data: undefined };
    return dorothyRunsClient.runs.get(id);
  }, [id]);

  const { data, isLoading, error, dbUnavailable, refresh } =
    usePolledFetch<{ run: Run | null; steps: RunStep[] }>(
      fetcher as () => Promise<{ ok: boolean; data?: { run: Run | null; steps: RunStep[] }; error?: string; dbUnavailable?: boolean }>,
      { run: null, steps: [] },
      Boolean(id)
    );

  return {
    run: data?.run ?? null,
    steps: data?.steps ?? [],
    isLoading,
    error,
    dbUnavailable,
    refresh,
  };
}

/* ============================================================================
 * Sessions
 * ========================================================================== */

export interface UseDorothySessionsOptions {
  agentId?: string;
  runId?: string;
  runStepId?: string;
  active?: boolean;
  limit?: number;
}

export function useDorothySessions(options: UseDorothySessionsOptions = {}) {
  const { agentId, runId, runStepId, active, limit } = options;
  const fetcher = useCallback(() => {
    return dorothyRunsClient.sessions.list({ agentId, runId, runStepId, active, limit });
  }, [agentId, runId, runStepId, active, limit]);
  const { data, ...rest } = usePolledFetch<{ sessions: AgentSession[] }>(fetcher, { sessions: [] });
  return { sessions: data?.sessions ?? [], ...rest };
}

/* ============================================================================
 * Phase 6-AE — live agent terminal snapshots (read-only, masked) + PM-tick
 * ========================================================================== */

const TERMINAL_REFRESH_MS = 3_000;
const EMPTY_SNAPSHOTS: { snapshots: AgentTerminalSnapshot[]; updatedAt: string } = { snapshots: [], updatedAt: '' };

/** Poll the 11 baseline agents' read-only, masked terminal snapshots (~3s). */
export function useDorothyAgentTerminalSnapshots(options: { lines?: number } = {}) {
  const { lines } = options;
  const fetcher = useCallback(() => dorothyRunsClient.agentTerminal.listSnapshots({ lines }), [lines]);
  const { data, ...rest } = usePolledFetch<{ snapshots: AgentTerminalSnapshot[]; updatedAt: string }>(
    fetcher, EMPTY_SNAPSHOTS, true, TERMINAL_REFRESH_MS,
  );
  return { snapshots: data?.snapshots ?? [], updatedAt: data?.updatedAt ?? '', ...rest };
}

/** Poll a single baseline agent's read-only, masked terminal snapshot (~3s). */
export function useDorothyAgentTerminalSnapshot(agentId: string | undefined, options: { lines?: number } = {}) {
  const { lines } = options;
  const fetcher = useCallback(async () => {
    if (!agentId) return { ok: false, error: 'missing agentId' as const };
    return dorothyRunsClient.agentTerminal.getSnapshot(agentId, { lines });
  }, [agentId, lines]);
  const { data, ...rest } = usePolledFetch<{ snapshot: AgentTerminalSnapshot | null; updatedAt: string }>(
    fetcher as () => Promise<{ ok: boolean; data?: { snapshot: AgentTerminalSnapshot | null; updatedAt: string }; error?: string; dbUnavailable?: boolean }>,
    { snapshot: null, updatedAt: '' }, Boolean(agentId), TERMINAL_REFRESH_MS,
  );
  return { snapshot: data?.snapshot ?? null, updatedAt: data?.updatedAt ?? '', ...rest };
}

export interface PmTickMark { kind: 'STARTED' | 'SKIP' | 'RESET' | 'ERROR' | 'unknown'; line: string }
const EMPTY_PMTICK: { available: boolean; recent: PmTickMark[]; latest: PmTickMark | null } = { available: false, recent: [], latest: null };

/** Read-only recent PM-tick / orchestrator status (log tail, masked). */
export function useDorothyPmTickStatus() {
  const fetcher = useCallback(async () => {
    try {
      const res = await fetch('/api/dorothy/pm-tick', { cache: 'no-store' });
      const data = await res.json();
      return { ok: true, data: { available: !!data.available, recent: data.recent ?? [], latest: data.latest ?? null } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' };
    }
  }, []);
  const { data, ...rest } = usePolledFetch<{ available: boolean; recent: PmTickMark[]; latest: PmTickMark | null }>(
    fetcher, EMPTY_PMTICK, true, 10_000,
  );
  return { available: !!data?.available, recent: data?.recent ?? [], latest: data?.latest ?? null, ...rest };
}

/* ============================================================================
 * Artifacts / Handoffs for a single Run
 * ========================================================================== */

export function useDorothyArtifacts(runId: string | undefined, limit = 500) {
  const fetcher = useCallback(async () => {
    if (!runId) return { ok: false, error: 'missing runId' as const };
    return dorothyRunsClient.artifacts.list({ runId, limit });
  }, [runId, limit]);
  const { data, ...rest } = usePolledFetch<{ artifacts: Artifact[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { artifacts: Artifact[] }; error?: string; dbUnavailable?: boolean }>,
    { artifacts: [] },
    Boolean(runId)
  );
  return { artifacts: data?.artifacts ?? [], ...rest };
}

/**
 * Phase 5C-C — bulk artifact lookup for the ImprovementSignal evidence
 * preview. Returns [] until both `ids` is non-empty AND the IPC settles.
 */
export function useDorothyArtifactsByIds(ids: string[] | undefined) {
  // Stabilize the array key so the polled fetch doesn't churn on identical
  // re-renders (caller may pass a fresh array each time).
  const idsKey = (ids ?? []).join(',');
  const enabled = !!ids && ids.length > 0;
  const fetcher = useCallback(async () => {
    if (!enabled) return { ok: false, error: 'no-ids' as const };
    return dorothyRunsClient.artifacts.listByIds(ids!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, enabled]);
  const { data, ...rest } = usePolledFetch<{ artifacts: Artifact[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { artifacts: Artifact[] }; error?: string; dbUnavailable?: boolean }>,
    { artifacts: [] },
    enabled,
  );
  return { artifacts: data?.artifacts ?? [], ...rest };
}

export function useDorothyHandoffs(runId: string | undefined) {
  const fetcher = useCallback(async () => {
    if (!runId) return { ok: false, error: 'missing runId' as const };
    return dorothyRunsClient.handoffs.list({ runId });
  }, [runId]);
  const { data, ...rest } = usePolledFetch<{ handoffs: Handoff[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { handoffs: Handoff[] }; error?: string; dbUnavailable?: boolean }>,
    { handoffs: [] },
    Boolean(runId)
  );
  return { handoffs: data?.handoffs ?? [], ...rest };
}

/* ============================================================================
 * Active Run summary (for Command Center)
 *
 * Composes a few of the above lists so the Dashboard widget can show counters
 * with a single hook. Re-fetches all parts on the same 15 s tick so the
 * displayed numbers are mutually consistent.
 * ========================================================================== */

export interface ActiveRunSummary {
  activeRuns: number;
  blockedRuns: number;
  approvalRequiredRuns: number;
  activeSessions: number;
  rateLimitedSessions: number;
  /** True when no part of the summary could be fetched (no IPC bridge etc). */
  dbUnavailable: boolean;
}

export function useActiveRunSummary(): {
  summary: ActiveRunSummary;
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const [summary, setSummary] = useState<ActiveRunSummary>({
    activeRuns: 0,
    blockedRuns: 0,
    approvalRequiredRuns: 0,
    activeSessions: 0,
    rateLimitedSessions: 0,
    dbUnavailable: false,
  });
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [runsRes, sessionsRes] = await Promise.all([
      dorothyRunsClient.runs.list({ limit: 500 }),
      dorothyRunsClient.sessions.list({ active: true, limit: 500 }),
    ]);

    const runs = runsRes.ok && runsRes.data ? runsRes.data.runs : [];
    const sessions = sessionsRes.ok && sessionsRes.data ? sessionsRes.data.sessions : [];

    const next: ActiveRunSummary = {
      activeRuns: runs.filter(r => runGroupOf(r.state) === 'active').length,
      blockedRuns: runs.filter(r => r.state === 'blocked').length,
      approvalRequiredRuns: runs.filter(r => r.state === 'approval_required').length,
      activeSessions: sessions.length,
      // Phase 1 reuses Run.blockedReason='rate_limit:*' as the cooldown
      // signal; a richer RateLimitEvent feed lands in Phase 4.
      rateLimitedSessions: runs.filter(r =>
        r.state === 'blocked' && (r.blockedReason || '').startsWith('rate_limit:')
      ).length,
      dbUnavailable: !!runsRes.dbUnavailable && !!sessionsRes.dbUnavailable,
    };

    setSummary(next);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { summary, isLoading, refresh };
}

/* ============================================================================
 * Phase 5A — PR / CI hooks
 *
 * Read-only; data is mirrored from GitHub by the webhook receiver. The
 * Run Detail / Run Board UI in Phase 5B will use these to render badges.
 * ========================================================================== */

export interface UseDorothyPullRequestsOptions {
  state?: PullRequestState | PullRequestState[];
  runId?: string;
  owner?: string;
  repo?: string;
  limit?: number;
}

export function useDorothyPullRequests(options: UseDorothyPullRequestsOptions = {}) {
  const { state, runId, owner, repo, limit } = options;
  const stateKey = Array.isArray(state) ? state.join(',') : state ?? '';
  const fetcher = useCallback(() => {
    return dorothyRunsClient.pr.list({ state, runId, owner, repo, limit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey, runId, owner, repo, limit]);
  const { data, ...rest } = usePolledFetch<{ pullRequests: PullRequest[] }>(fetcher, { pullRequests: [] });
  return { pullRequests: data?.pullRequests ?? [], ...rest };
}

export function useDorothyPullRequestsByRun(runId: string | undefined) {
  const fetcher = useCallback(async () => {
    if (!runId) return { ok: false, error: 'missing runId' as const };
    return dorothyRunsClient.pr.listByRun(runId);
  }, [runId]);
  const { data, ...rest } = usePolledFetch<{ pullRequests: PullRequest[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { pullRequests: PullRequest[] }; error?: string; dbUnavailable?: boolean }>,
    { pullRequests: [] },
    Boolean(runId)
  );
  return { pullRequests: data?.pullRequests ?? [], ...rest };
}

export interface UseDorothyCIRunsOptions {
  state?: CIRunState | CIRunState[];
  runId?: string;
  pullRequestId?: string;
  workflow?: string;
  limit?: number;
}

export function useDorothyCIRuns(options: UseDorothyCIRunsOptions = {}) {
  const { state, runId, pullRequestId, workflow, limit } = options;
  const stateKey = Array.isArray(state) ? state.join(',') : state ?? '';
  const fetcher = useCallback(() => {
    return dorothyRunsClient.ci.list({ state, runId, pullRequestId, workflow, limit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey, runId, pullRequestId, workflow, limit]);
  const { data, ...rest } = usePolledFetch<{ ciRuns: CIRun[] }>(fetcher, { ciRuns: [] });
  return { ciRuns: data?.ciRuns ?? [], ...rest };
}

export function useDorothyCIRunsByRun(runId: string | undefined) {
  const fetcher = useCallback(async () => {
    if (!runId) return { ok: false, error: 'missing runId' as const };
    return dorothyRunsClient.ci.listByRun(runId);
  }, [runId]);
  const { data, ...rest } = usePolledFetch<{ ciRuns: CIRun[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { ciRuns: CIRun[] }; error?: string; dbUnavailable?: boolean }>,
    { ciRuns: [] },
    Boolean(runId)
  );
  return { ciRuns: data?.ciRuns ?? [], ...rest };
}

/* ============================================================================
 * Phase 5B — Summary + Reports hooks
 *
 * `useDorothyPullRequestSummary` and `useDorothyCIRunSummary` are tiny
 * derivations over the existing list hooks, used by Command Center cards.
 * `useDorothyReports` pulls artifacts that count as "reports" (type=report /
 * type=doc by devops-reporter / review / test) into a single ordered list.
 * ========================================================================== */

export interface PullRequestSummary {
  total: number;
  open: number;
  draft: number;
  review: number;
  changesRequested: number;
  merged: number;
  closed: number;
}

export function useDorothyPullRequestSummary(): {
  summary: PullRequestSummary;
  isLoading: boolean;
  dbUnavailable: boolean;
} {
  const { pullRequests, isLoading, dbUnavailable } = useDorothyPullRequests({ limit: 500 });
  const summary = useMemo<PullRequestSummary>(() => ({
    total: pullRequests.length,
    open:               pullRequests.filter(p => p.state === 'open').length,
    draft:              pullRequests.filter(p => p.state === 'draft').length,
    review:             pullRequests.filter(p => p.state === 'review').length,
    changesRequested:   pullRequests.filter(p => p.state === 'changes_requested').length,
    merged:             pullRequests.filter(p => p.state === 'merged').length,
    closed:             pullRequests.filter(p => p.state === 'closed').length,
  }), [pullRequests]);
  return { summary, isLoading, dbUnavailable };
}

export interface CIRunSummary {
  total: number;
  queued: number;
  running: number;
  success: number;
  failed: number;
  cancelled: number;
  skipped: number;
}

export function useDorothyCIRunSummary(): {
  summary: CIRunSummary;
  isLoading: boolean;
  dbUnavailable: boolean;
} {
  const { ciRuns, isLoading, dbUnavailable } = useDorothyCIRuns({ limit: 500 });
  const summary = useMemo<CIRunSummary>(() => ({
    total:     ciRuns.length,
    queued:    ciRuns.filter(c => c.state === 'queued').length,
    running:   ciRuns.filter(c => c.state === 'running').length,
    success:   ciRuns.filter(c => c.state === 'success').length,
    failed:    ciRuns.filter(c => c.state === 'failed').length,
    cancelled: ciRuns.filter(c => c.state === 'cancelled').length,
    skipped:   ciRuns.filter(c => c.state === 'skipped').length,
  }), [ciRuns]);
  return { summary, isLoading, dbUnavailable };
}

/**
 * A "report" in the Phase 5B sense is one of:
 *   1. Artifact type='report'
 *   2. Artifact type='doc' produced by 'devops-reporter'
 *   3. Artifact type='review'
 *   4. Artifact type='test'
 *
 * The hook walks `dorothy:artifacts:list` (newest first) and applies the
 * filter client-side — the artifact API does not yet support OR-on-type, and
 * the per-call limit caps the cost.
 */
export interface UseDorothyReportsOptions {
  runId?: string;
  producedByAgentId?: string;
  limit?: number;
}

const REPORT_TYPES = new Set<Artifact['type']>(['report', 'doc', 'review', 'test']);

/* ============================================================================
 * Phase 5C-B — Scheduled rate-limit resumes + ImprovementSignal hooks
 * ========================================================================== */

export function useDorothyScheduledRateLimits(limit = 200) {
  const fetcher = useCallback(() => dorothyRunsClient.rateLimit.listScheduled({ limit }), [limit]);
  const { data, ...rest } = usePolledFetch<{ events: RateLimitEvent[] }>(fetcher, { events: [] });
  // Lightweight bucketing for the Command Center card.
  const counts = useMemo(() => {
    const events = data?.events ?? [];
    const now = Date.now();
    let scheduled = 0; let overdue = 0; let failed = 0;
    for (const e of events) {
      if (e.resumeStatus === 'failed') { failed++; continue; }
      if (e.resumeStatus === 'scheduled' || e.resumeStatus === 'pending') {
        if (e.resumeAt && new Date(e.resumeAt).getTime() <= now) overdue++;
        else scheduled++;
      }
    }
    return { scheduled, overdue, failed };
  }, [data?.events]);
  return { events: data?.events ?? [], counts, ...rest };
}

export interface UseDorothyImprovementSignalsOptions {
  status?: ImprovementSignalStatus | ImprovementSignalStatus[];
  source?: string;
  runId?: string;
  severity?: string;
  limit?: number;
}

export function useDorothyImprovementSignals(options: UseDorothyImprovementSignalsOptions = {}) {
  const { status, source, runId, severity, limit } = options;
  const statusKey = Array.isArray(status) ? status.join(',') : status ?? '';
  const fetcher = useCallback(() => {
    return dorothyRunsClient.improvements.list({ status, source, runId, severity, limit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusKey, source, runId, severity, limit]);
  const { data, ...rest } = usePolledFetch<{ signals: ImprovementSignal[] }>(fetcher, { signals: [] });
  return { signals: data?.signals ?? [], ...rest };
}

export function useDorothyImprovementSignalsByRun(runId: string | undefined) {
  const fetcher = useCallback(async () => {
    if (!runId) return { ok: false, error: 'missing runId' as const };
    return dorothyRunsClient.improvements.listByRun(runId);
  }, [runId]);
  const { data, ...rest } = usePolledFetch<{ signals: ImprovementSignal[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { signals: ImprovementSignal[] }; error?: string; dbUnavailable?: boolean }>,
    { signals: [] },
    Boolean(runId)
  );
  return { signals: data?.signals ?? [], ...rest };
}

/* ============================================================================
 * Phase 5F — HookEvent hooks
 *
 * Read-only React hooks over `dorothy:hookEvents:*` IPC. They follow the same
 * 15s polling pattern as the rest of `useDorothyRuns`. Each hook returns
 * `{ events, isLoading, error, dbUnavailable, refresh }` and short-circuits
 * when the bridge is unavailable.
 *
 * Filters intentionally mirror `ListHookEventsOptions` so callers can pass the
 * same payload shape end-to-end.
 * ========================================================================== */

export interface UseDorothyHookEventsOptions {
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

function hookEventKey(opts: UseDorothyHookEventsOptions): string {
  // Serialize options to a stable key so the polled fetch doesn't churn on
  // identical re-renders.
  const arr = (v: unknown) => (Array.isArray(v) ? v.join(',') : v ?? '');
  return [
    opts.runId, opts.runStepId, opts.agentSessionId, opts.agentId,
    arr(opts.type), arr(opts.severity), arr(opts.source),
    opts.since, opts.limit, opts.offset,
  ].map(String).join('|');
}

export function useDorothyHookEvents(options: UseDorothyHookEventsOptions = {}) {
  const key = hookEventKey(options);
  const fetcher = useCallback(() => {
    return dorothyRunsClient.hookEvents.list(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const { data, ...rest } = usePolledFetch<{ events: HookEvent[] }>(fetcher, { events: [] });
  return { events: data?.events ?? [], ...rest };
}

export function useDorothyHookEventsByRun(
  runId: string | undefined,
  options: Omit<UseDorothyHookEventsOptions, 'runId'> = {},
) {
  const key = hookEventKey({ ...options, runId: runId ?? '' });
  const fetcher = useCallback(async () => {
    if (!runId) return { ok: false, error: 'missing runId' as const };
    return dorothyRunsClient.hookEvents.listByRun(runId, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, runId]);
  const { data, ...rest } = usePolledFetch<{ events: HookEvent[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { events: HookEvent[] }; error?: string; dbUnavailable?: boolean }>,
    { events: [] },
    Boolean(runId),
  );
  return { events: data?.events ?? [], ...rest };
}

export function useDorothyHookEventsBySession(
  agentSessionId: string | undefined,
  options: Omit<UseDorothyHookEventsOptions, 'agentSessionId'> = {},
) {
  const key = hookEventKey({ ...options, agentSessionId: agentSessionId ?? '' });
  const fetcher = useCallback(async () => {
    if (!agentSessionId) return { ok: false, error: 'missing sessionId' as const };
    return dorothyRunsClient.hookEvents.listBySession(agentSessionId, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, agentSessionId]);
  const { data, ...rest } = usePolledFetch<{ events: HookEvent[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { events: HookEvent[] }; error?: string; dbUnavailable?: boolean }>,
    { events: [] },
    Boolean(agentSessionId),
  );
  return { events: data?.events ?? [], ...rest };
}

export function useDorothyRecentHookEvents(
  options: Omit<UseDorothyHookEventsOptions, 'runId' | 'runStepId' | 'agentSessionId'> = {},
) {
  const key = hookEventKey(options);
  const fetcher = useCallback(() => {
    return dorothyRunsClient.hookEvents.listRecent(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const { data, ...rest } = usePolledFetch<{ events: HookEvent[] }>(fetcher, { events: [] });
  return { events: data?.events ?? [], ...rest };
}

/* ============================================================================
 * Phase 6-A — Diagnostic hooks
 *
 * Read surface for `/diagnostics` + Run Detail Diagnostics tab + Command
 * Center counts. Same polling + stable-key pattern as the HookEvent hooks.
 * ========================================================================== */

export interface UseDorothyDiagnosticsOptions {
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
}

function diagnosticKey(opts: UseDorothyDiagnosticsOptions): string {
  const arr = (v: unknown) => (Array.isArray(v) ? v.join(',') : v ?? '');
  return [
    opts.runId, opts.runStepId, opts.agentSessionId, opts.agentId,
    arr(opts.source), arr(opts.severity), arr(opts.status),
    String(!!opts.onlyOpen), opts.minOccurrences ?? '', opts.limit,
  ].map(String).join('|');
}

export function useDorothyDiagnostics(options: UseDorothyDiagnosticsOptions = {}) {
  const key = diagnosticKey(options);
  const fetcher = useCallback(() => {
    return dorothyRunsClient.diagnostics.list(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const { data, ...rest } = usePolledFetch<{ diagnostics: Diagnostic[] }>(fetcher, { diagnostics: [] });
  return { diagnostics: data?.diagnostics ?? [], ...rest };
}

export function useDorothyDiagnosticsByRun(
  runId: string | undefined,
  options: Omit<UseDorothyDiagnosticsOptions, 'runId'> = {},
) {
  const key = diagnosticKey({ ...options, runId: runId ?? '' });
  const fetcher = useCallback(async () => {
    if (!runId) return { ok: false, error: 'missing runId' as const };
    return dorothyRunsClient.diagnostics.listByRun(runId, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, runId]);
  const { data, ...rest } = usePolledFetch<{ diagnostics: Diagnostic[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { diagnostics: Diagnostic[] }; error?: string; dbUnavailable?: boolean }>,
    { diagnostics: [] },
    Boolean(runId),
  );
  return { diagnostics: data?.diagnostics ?? [], ...rest };
}

export function useDorothyDiagnostic(id: string | undefined) {
  const fetcher = useCallback(async () => {
    if (!id) return { ok: false, error: 'missing id' as const };
    return dorothyRunsClient.diagnostics.get(id);
  }, [id]);
  const { data, ...rest } = usePolledFetch<{ diagnostic: Diagnostic | null }>(
    fetcher as () => Promise<{ ok: boolean; data?: { diagnostic: Diagnostic | null }; error?: string; dbUnavailable?: boolean }>,
    { diagnostic: null },
    Boolean(id),
  );
  return { diagnostic: data?.diagnostic ?? null, ...rest };
}

/** Diagnostic counts for the Command Center compact row. */
export interface DiagnosticCountsRollup {
  open: number;
  critical: number;
  highOrCritical: number;
  total: number;
}

export function useDorothyDiagnosticCounts(): {
  counts: DiagnosticCountsRollup;
  isLoading: boolean;
  dbUnavailable: boolean;
} {
  const { diagnostics, isLoading, dbUnavailable } = useDorothyDiagnostics({ limit: 500 });
  const counts = useMemo<DiagnosticCountsRollup>(() => {
    let open = 0, critical = 0, highOrCritical = 0;
    for (const d of diagnostics) {
      if (d.status === 'open') open++;
      if (d.severity === 'critical') critical++;
      if (d.severity === 'high' || d.severity === 'critical') highOrCritical++;
    }
    return { open, critical, highOrCritical, total: diagnostics.length };
  }, [diagnostics]);
  return { counts, isLoading, dbUnavailable };
}

/* ============================================================================
 * Phase 6-B — AgentWorkflowProgress hooks
 * ========================================================================== */

export interface UseDorothyWorkflowProgressOptions {
  runId?: string;
  runStepId?: string;
  agentSessionId?: string;
  agentId?: string;
  workflowKind?: AgentWorkflowKind | AgentWorkflowKind[];
  status?: AgentWorkflowProgressStatus | AgentWorkflowProgressStatus[];
  limit?: number;
}

function workflowKey(opts: UseDorothyWorkflowProgressOptions): string {
  const arr = (v: unknown) => (Array.isArray(v) ? v.join(',') : v ?? '');
  return [
    opts.runId, opts.runStepId, opts.agentSessionId, opts.agentId,
    arr(opts.workflowKind), arr(opts.status), opts.limit,
  ].map(String).join('|');
}

export function useDorothyWorkflowProgress(options: UseDorothyWorkflowProgressOptions = {}) {
  const key = workflowKey(options);
  const fetcher = useCallback(() => {
    return dorothyRunsClient.workflowProgress.list(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const { data, ...rest } = usePolledFetch<{ rows: AgentWorkflowProgress[] }>(fetcher, { rows: [] });
  return { rows: data?.rows ?? [], ...rest };
}

export function useDorothyWorkflowProgressByRun(
  runId: string | undefined,
  options: Omit<UseDorothyWorkflowProgressOptions, 'runId'> = {},
) {
  const key = workflowKey({ ...options, runId: runId ?? '' });
  const fetcher = useCallback(async () => {
    if (!runId) return { ok: false, error: 'missing runId' as const };
    return dorothyRunsClient.workflowProgress.listByRun(runId, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, runId]);
  const { data, ...rest } = usePolledFetch<{ rows: AgentWorkflowProgress[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { rows: AgentWorkflowProgress[] }; error?: string; dbUnavailable?: boolean }>,
    { rows: [] },
    Boolean(runId),
  );
  return { rows: data?.rows ?? [], ...rest };
}

export function useDorothyWorkflowProgressBySession(
  agentSessionId: string | undefined,
  options: Omit<UseDorothyWorkflowProgressOptions, 'agentSessionId'> = {},
) {
  const key = workflowKey({ ...options, agentSessionId: agentSessionId ?? '' });
  const fetcher = useCallback(async () => {
    if (!agentSessionId) return { ok: false, error: 'missing sessionId' as const };
    return dorothyRunsClient.workflowProgress.listBySession(agentSessionId, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, agentSessionId]);
  const { data, ...rest } = usePolledFetch<{ rows: AgentWorkflowProgress[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { rows: AgentWorkflowProgress[] }; error?: string; dbUnavailable?: boolean }>,
    { rows: [] },
    Boolean(agentSessionId),
  );
  return { rows: data?.rows ?? [], ...rest };
}

/** Aggregate counters for the Command Center compact row. */
export interface WorkflowProgressCountsRollup {
  active: number;
  blocked: number;
  failed: number;
  stalled: number;
  completed: number;
  total: number;
}

export function useDorothyWorkflowProgressCounts(): {
  counts: WorkflowProgressCountsRollup;
  isLoading: boolean;
  dbUnavailable: boolean;
} {
  const { rows, isLoading, dbUnavailable } = useDorothyWorkflowProgress({ limit: 500 });
  const counts = useMemo<WorkflowProgressCountsRollup>(() => {
    let active = 0, blocked = 0, failed = 0, stalled = 0, completed = 0;
    for (const r of rows) {
      if (r.status === 'in_progress' || r.status === 'not_started') active++;
      else if (r.status === 'blocked') blocked++;
      else if (r.status === 'failed') failed++;
      else if (r.status === 'stalled') stalled++;
      else if (r.status === 'completed') completed++;
    }
    return { active, blocked, failed, stalled, completed, total: rows.length };
  }, [rows]);
  return { counts, isLoading, dbUnavailable };
}

/* ============================================================================
 * Phase 6-D — SkillCandidate hooks
 * ========================================================================== */

export interface UseDorothySkillCandidatesOptions {
  runId?: string;
  agentId?: string;
  category?: SkillCandidateCategory | SkillCandidateCategory[];
  source?: SkillCandidateSource | SkillCandidateSource[];
  severity?: SkillCandidateSeverity | SkillCandidateSeverity[];
  status?: SkillCandidateStatus | SkillCandidateStatus[];
  onlyOpen?: boolean;
  minOccurrences?: number;
  limit?: number;
}

function skillCandidateKey(opts: UseDorothySkillCandidatesOptions): string {
  const arr = (v: unknown) => (Array.isArray(v) ? v.join(',') : v ?? '');
  return [
    opts.runId, opts.agentId,
    arr(opts.category), arr(opts.source), arr(opts.severity), arr(opts.status),
    String(!!opts.onlyOpen), opts.minOccurrences ?? '', opts.limit,
  ].map(String).join('|');
}

export function useDorothySkillCandidates(options: UseDorothySkillCandidatesOptions = {}) {
  const key = skillCandidateKey(options);
  const fetcher = useCallback(() => {
    return dorothyRunsClient.skillCandidates.list(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const { data, ...rest } = usePolledFetch<{ candidates: SkillCandidate[] }>(fetcher, { candidates: [] });
  return { candidates: data?.candidates ?? [], ...rest };
}

export function useDorothySkillCandidatesByRun(
  runId: string | undefined,
  options: Omit<UseDorothySkillCandidatesOptions, 'runId'> = {},
) {
  const key = skillCandidateKey({ ...options, runId: runId ?? '' });
  const fetcher = useCallback(async () => {
    if (!runId) return { ok: false, error: 'missing runId' as const };
    return dorothyRunsClient.skillCandidates.listByRun(runId, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, runId]);
  const { data, ...rest } = usePolledFetch<{ candidates: SkillCandidate[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { candidates: SkillCandidate[] }; error?: string; dbUnavailable?: boolean }>,
    { candidates: [] },
    Boolean(runId),
  );
  return { candidates: data?.candidates ?? [], ...rest };
}

export function useDorothySkillCandidate(id: string | undefined) {
  const fetcher = useCallback(async () => {
    if (!id) return { ok: false, error: 'missing id' as const };
    return dorothyRunsClient.skillCandidates.get(id);
  }, [id]);
  const { data, ...rest } = usePolledFetch<{ candidate: SkillCandidate | null }>(
    fetcher as () => Promise<{ ok: boolean; data?: { candidate: SkillCandidate | null }; error?: string; dbUnavailable?: boolean }>,
    { candidate: null },
    Boolean(id),
  );
  return { candidate: data?.candidate ?? null, ...rest };
}

/* ============================================================================
 * Phase 6-W — App Factory hooks
 * ========================================================================== */

export interface UseDorothyAppCandidatesOptions {
  status?: AppCandidateStatus | AppCandidateStatus[];
  implementationDifficulty?: AppImplementationDifficulty | AppImplementationDifficulty[];
  limit?: number;
}

export function useDorothyAppCandidates(options: UseDorothyAppCandidatesOptions = {}) {
  const arr = (v: unknown) => (Array.isArray(v) ? v.join(',') : v ?? '');
  const key = [arr(options.status), arr(options.implementationDifficulty), options.limit ?? ''].map(String).join('|');
  const fetcher = useCallback(() => {
    return dorothyRunsClient.appFactory.listCandidates(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const { data, ...rest } = usePolledFetch<{ candidates: AppCandidate[] }>(fetcher, { candidates: [] });
  return { candidates: data?.candidates ?? [], ...rest };
}

export function useDorothyAppFactoryPlans(
  appCandidateId?: string,
  options: { status?: AppFactoryPlanStatus | AppFactoryPlanStatus[]; limit?: number } = {},
) {
  const arr = (v: unknown) => (Array.isArray(v) ? v.join(',') : v ?? '');
  const key = [appCandidateId ?? '', arr(options.status), options.limit ?? ''].map(String).join('|');
  const fetcher = useCallback(() => {
    return dorothyRunsClient.appFactory.listPlans({ appCandidateId, ...options });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const { data, ...rest } = usePolledFetch<{ plans: AppFactoryPlan[] }>(fetcher, { plans: [] });
  return { plans: data?.plans ?? [], ...rest };
}

export function useDorothyAppFactoryPlan(id: string | undefined) {
  const fetcher = useCallback(async () => {
    if (!id) return { ok: false, error: 'missing id' as const };
    return dorothyRunsClient.appFactory.getPlan(id);
  }, [id]);
  const { data, ...rest } = usePolledFetch<{ plan: AppFactoryPlan | null }>(
    fetcher as () => Promise<{ ok: boolean; data?: { plan: AppFactoryPlan | null }; error?: string; dbUnavailable?: boolean }>,
    { plan: null },
    Boolean(id),
  );
  return { plan: data?.plan ?? null, ...rest };
}

export function useDorothyReports(options: UseDorothyReportsOptions = {}) {
  const { runId, producedByAgentId, limit } = options;
  const fetcher = useCallback(() => {
    return dorothyRunsClient.artifacts.list({ runId, producedByAgentId, limit: limit ?? 500 });
  }, [runId, producedByAgentId, limit]);
  const { data, ...rest } = usePolledFetch<{ artifacts: Artifact[] }>(fetcher, { artifacts: [] });
  const reports = useMemo<Artifact[]>(() => {
    return (data?.artifacts ?? [])
      .filter(a => {
        if (!REPORT_TYPES.has(a.type)) return false;
        // `doc` is only counted as a report when devops-reporter wrote it;
        // architectural ADRs etc. live on the Vault/Artifacts screen.
        if (a.type === 'doc' && a.producedByAgentId !== 'devops-reporter') return false;
        return true;
      })
      // newest first (artifact-service already returns by createdAt DESC for
      // listArtifacts; listArtifactsByRun is ASC — re-sort defensively).
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  }, [data?.artifacts]);
  return { reports, ...rest };
}

/* ============================================================================
 * Phase 6-E — Agent Definition Registry / Idle Reason / Communication
 * ========================================================================== */

const EMPTY_REGISTRY: AgentRegistrySnapshot = {
  definitions: [],
  warnings: [],
  scanRoots: [],
  configuredCount: 0,
  fileCount: 0,
  liveSessionAgentCount: 0,
};

export function useDorothyAgentDefinitions(
  options: { extraProjectPaths?: string[]; includeUserDir?: boolean } = {},
) {
  const key = JSON.stringify(options);
  const fetcher = useCallback(() => {
    return dorothyRunsClient.agentDefinitions.list(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const { data, ...rest } = usePolledFetch<{ snapshot: AgentRegistrySnapshot; dbUnavailable?: boolean }>(
    fetcher,
    { snapshot: EMPTY_REGISTRY },
  );
  const snapshot = data?.snapshot ?? EMPTY_REGISTRY;
  return {
    snapshot,
    definitions: snapshot.definitions as AgentDefinition[],
    warnings: snapshot.warnings as AgentRegistryMismatch[],
    ...rest,
  };
}

export function useDorothyAgentDefinition(agentId: string | undefined) {
  const fetcher = useCallback(async () => {
    if (!agentId) return { ok: false, error: 'missing agentId' as const };
    return dorothyRunsClient.agentDefinitions.get(agentId);
  }, [agentId]);
  const { data, ...rest } = usePolledFetch<{ definition: AgentDefinition | null }>(
    fetcher as () => Promise<{ ok: boolean; data?: { definition: AgentDefinition | null }; error?: string; dbUnavailable?: boolean }>,
    { definition: null },
    Boolean(agentId),
  );
  return { definition: data?.definition ?? null, ...rest };
}

export function useDorothyAgentIdleStatuses(options: { agentIds?: string[] } = {}) {
  const key = JSON.stringify(options.agentIds ?? []);
  const fetcher = useCallback(() => {
    return dorothyRunsClient.agentIdle.list(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const { data, ...rest } = usePolledFetch<{ statuses: AgentIdleStatus[] }>(fetcher, { statuses: [] });
  const statuses = data?.statuses ?? [];
  const byAgent = useMemo(() => {
    const m = new Map<string, AgentIdleStatus>();
    for (const s of statuses) m.set(s.agentId, s);
    return m;
  }, [statuses]);
  return { statuses, byAgent, ...rest };
}

export function useDorothyAgentCommunicationByRun(
  runId: string | undefined,
  options: { limit?: number } = {},
) {
  const fetcher = useCallback(async () => {
    if (!runId) return { ok: false, error: 'missing runId' as const };
    return dorothyRunsClient.agentCommunication.listByRun(runId, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, options.limit]);
  const { data, ...rest } = usePolledFetch<{ events: AgentCommunicationEvent[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { events: AgentCommunicationEvent[] }; error?: string; dbUnavailable?: boolean }>,
    { events: [] },
    Boolean(runId),
  );
  return { events: data?.events ?? [], ...rest };
}

export function useDorothyAgentCommunicationByAgent(
  agentId: string | undefined,
  options: { limit?: number; runIds?: string[] } = {},
) {
  const key = JSON.stringify({ limit: options.limit, runIds: options.runIds });
  const fetcher = useCallback(async () => {
    if (!agentId) return { ok: false, error: 'missing agentId' as const };
    return dorothyRunsClient.agentCommunication.listByAgent(agentId, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, key]);
  const { data, ...rest } = usePolledFetch<{ events: AgentCommunicationEvent[] }>(
    fetcher as () => Promise<{ ok: boolean; data?: { events: AgentCommunicationEvent[] }; error?: string; dbUnavailable?: boolean }>,
    { events: [] },
    Boolean(agentId),
  );
  return { events: data?.events ?? [], ...rest };
}

export function useDorothyRecentAgentCommunication(options: { limit?: number } = {}) {
  const fetcher = useCallback(() => {
    return dorothyRunsClient.agentCommunication.listRecent(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.limit]);
  const { data, ...rest } = usePolledFetch<{ events: AgentCommunicationEvent[] }>(fetcher, { events: [] });
  return { events: data?.events ?? [], ...rest };
}

export function useDorothyAgentRegistrationCandidates() {
  const fetcher = useCallback(() => {
    return dorothyRunsClient.agentRegistration.listCandidates();
  }, []);
  const { data, ...rest } = usePolledFetch<{ candidates: AgentDefinition[] }>(fetcher, { candidates: [] });
  return { candidates: data?.candidates ?? [], ...rest };
}

const EMPTY_READINESS_COUNTS: DispatchReadinessCounts = { ready: 0, blocked: 0, total: 0, byReason: {} };

export function useDorothyDispatchReadiness(options: { agentIds?: string[] } = {}) {
  const key = JSON.stringify(options.agentIds ?? []);
  const fetcher = useCallback(() => {
    return dorothyRunsClient.agentDispatch.listReadiness(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const { data, ...rest } = usePolledFetch<{ readiness: AgentDispatchReadiness[]; counts: DispatchReadinessCounts }>(
    fetcher,
    { readiness: [], counts: EMPTY_READINESS_COUNTS },
  );
  const readiness = data?.readiness ?? [];
  const byAgent = useMemo(() => {
    const m = new Map<string, AgentDispatchReadiness>();
    for (const r of readiness) m.set(r.agentId, r);
    return m;
  }, [readiness]);
  return { readiness, counts: data?.counts ?? EMPTY_READINESS_COUNTS, byAgent, ...rest };
}

const EMPTY_RUNTIME: ClaudeRuntimeReadiness = {
  binary: { found: false, checkedCount: 0 },
  pathIncludesClaude: false,
  addDir: '',
  agents: [],
};

export function useDorothyClaudeLaunchReadiness() {
  const fetcher = useCallback(() => {
    return dorothyRunsClient.claude.launchReadiness();
  }, []);
  const { data, ...rest } = usePolledFetch<ClaudeRuntimeReadiness>(fetcher, EMPTY_RUNTIME);
  return { runtime: data ?? EMPTY_RUNTIME, ...rest };
}

const EMPTY_CODEX_RUNTIME: CodexRuntimeReadiness = {
  binaryFound: false,
  persistentModelOpus: false,
  incompatibleConfiguredAgents: [],
  opusBlocked: true,
  autoRewrite: false,
};

export function useDorothyCodexRuntimeReadiness() {
  const fetcher = useCallback(() => {
    return dorothyRunsClient.codex.runtimeReadiness();
  }, []);
  const { data, ...rest } = usePolledFetch<{ readiness: CodexRuntimeReadiness }>(
    fetcher,
    { readiness: EMPTY_CODEX_RUNTIME },
  );
  return { runtime: data?.readiness ?? EMPTY_CODEX_RUNTIME, ...rest };
}

export function useDorothyWarmupTargets() {
  const fetcher = useCallback(() => {
    return dorothyRunsClient.warmup.targets();
  }, []);
  const { data, ...rest } = usePolledFetch<{ targets: AgentWarmupTarget[] }>(fetcher, { targets: [] });
  return { targets: data?.targets ?? [], ...rest };
}

export function useDorothyStaleSessionFlags() {
  const fetcher = useCallback(() => {
    return dorothyRunsClient.staleSessions.list();
  }, []);
  const { data, ...rest } = usePolledFetch<{ flags: StaleSessionFlag[] }>(fetcher, { flags: [] });
  const flags = data?.flags ?? [];
  const bySession = useMemo(() => {
    const m = new Map<string, StaleSessionFlag>();
    for (const f of flags) m.set(f.sessionId, f);
    return m;
  }, [flags]);
  return { flags, bySession, ...rest };
}

export function useDorothyDispatchReadinessByRun(runId: string | undefined) {
  const fetcher = useCallback(async () => {
    if (!runId) return { ok: false, error: 'missing runId' as const };
    return dorothyRunsClient.agentDispatch.listReadinessByRun(runId);
  }, [runId]);
  const { data, ...rest } = usePolledFetch<{ readiness: AgentDispatchReadiness[]; counts: DispatchReadinessCounts }>(
    fetcher as () => Promise<{ ok: boolean; data?: { readiness: AgentDispatchReadiness[]; counts: DispatchReadinessCounts }; error?: string; dbUnavailable?: boolean }>,
    { readiness: [], counts: EMPTY_READINESS_COUNTS },
    Boolean(runId),
  );
  return { readiness: data?.readiness ?? [], counts: data?.counts ?? EMPTY_READINESS_COUNTS, ...rest };
}
