/**
 * Dorothy MVP Phase 6-E — Agent Communication Timeline.
 *
 * Synthesizes a single "who told whom what" timeline from existing records —
 * Handoff, Artifact, HookEvent, Diagnostic, ApprovalRequest — without adding a
 * new DB table. The renderer uses this to show inter-agent communication on a
 * Run, on an agent, and in a recent global feed.
 *
 * Safety:
 *   - No raw output / file bodies are returned. Every `summary` is excerpted
 *     and sensitive substrings masked via `makeExcerpt` (≤500 chars).
 *   - Best-effort: every source read is wrapped; a failure contributes nothing.
 */

import { listHandoffsByRun, listArtifactsByRun } from './artifact-service';
import { listRunStepsByRun, listRuns } from './run-service';
import { listHookEventsByRun, listRecentHookEvents, makeExcerpt } from './hook-event-service';
import { listDiagnosticsByRun, listDiagnostics } from './diagnostic-service';
import { listApprovalRequests } from './approval-request-service';
import type {
  Artifact,
  Diagnostic,
  Handoff,
  HookEvent,
  ApprovalRequest,
  RunStep,
} from '../../types/dorothy';

/* ============================================================================
 * Types
 * ========================================================================== */

export type AgentCommunicationType =
  | 'handoff'
  | 'artifact'
  | 'hook_event'
  | 'diagnostic'
  | 'approval'
  | 'workflow_update'
  | 'rate_limit'
  | 'resume'
  | 'comment';

export interface AgentCommunicationEvent {
  id: string;
  type: AgentCommunicationType;
  runId?: string;
  runStepId?: string;
  fromAgentId?: string;
  toAgentId?: string;
  agentSessionId?: string;
  title: string;
  summary?: string;
  artifactId?: string;
  handoffId?: string;
  hookEventId?: string;
  diagnosticId?: string;
  approvalRequestId?: string;
  createdAt: string;
}

/* ============================================================================
 * Helpers
 * ========================================================================== */

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Map a HookEvent type to a communication type bucket. */
function hookTypeToCommType(t: HookEvent['type']): AgentCommunicationType {
  if (t === 'handoff_created') return 'handoff';
  if (t === 'artifact_created') return 'artifact';
  if (t === 'approval_required' || t === 'approval_resolved') return 'approval';
  if (t.startsWith('rate_limit')) return 'rate_limit';
  if (t.startsWith('resume')) return 'resume';
  return 'hook_event';
}

interface BuildSources {
  handoffs: Handoff[];
  artifacts: Artifact[];
  hookEvents: HookEvent[];
  diagnostics: Diagnostic[];
  approvals: ApprovalRequest[];
  /** runId -> (runStepId -> agentId) for resolving handoff from/to agents. */
  stepAgentByRun: Map<string, Map<string, string>>;
}

function buildEvents(src: BuildSources): AgentCommunicationEvent[] {
  const events: AgentCommunicationEvent[] = [];

  // Linking ids already represented by a primary record, so we can skip the
  // mirrored HookEvent and avoid duplicate timeline rows.
  const coveredHandoffIds = new Set(src.handoffs.map(h => h.id));
  const coveredArtifactIds = new Set(src.artifacts.map(a => a.id));
  const coveredApprovalIds = new Set(src.approvals.map(a => a.id));

  // 1) Handoffs
  for (const h of src.handoffs) {
    const stepMap = src.stepAgentByRun.get(h.runId);
    events.push({
      id: `handoff:${h.id}`,
      type: 'handoff',
      runId: h.runId,
      runStepId: h.toRunStepId,
      fromAgentId: stepMap?.get(h.fromRunStepId),
      toAgentId: stepMap?.get(h.toRunStepId),
      title: 'Handoff',
      summary: makeExcerpt(h.summary, 500) ?? undefined,
      handoffId: h.id,
      createdAt: h.createdAt,
    });
  }

  // 2) Artifacts
  for (const a of src.artifacts) {
    events.push({
      id: `artifact:${a.id}`,
      type: 'artifact',
      runId: a.runId,
      runStepId: a.runStepId ?? undefined,
      fromAgentId: a.producedByAgentId,
      title: `Artifact (${a.type})`,
      summary: makeExcerpt(a.path ?? a.contentRef ?? null, 500) ?? undefined,
      artifactId: a.id,
      createdAt: a.createdAt,
    });
  }

  // 3) Diagnostics
  for (const d of src.diagnostics) {
    events.push({
      id: `diagnostic:${d.id}`,
      type: 'diagnostic',
      runId: d.runId ?? undefined,
      runStepId: d.runStepId ?? undefined,
      fromAgentId: d.agentId ?? undefined,
      agentSessionId: d.agentSessionId ?? undefined,
      title: `Diagnostic (${d.severity}) — ${makeExcerpt(d.title, 120) ?? d.source}`,
      summary: makeExcerpt(d.summary, 500) ?? undefined,
      diagnosticId: d.id,
      createdAt: d.createdAt,
    });
  }

  // 4) Approval requests
  for (const ap of src.approvals) {
    events.push({
      id: `approval:${ap.id}`,
      type: 'approval',
      runId: ap.runId,
      title: `Approval ${ap.state} (${ap.riskLevel} risk)`,
      summary: makeExcerpt(ap.topic ?? ap.decisionNote ?? null, 500) ?? undefined,
      approvalRequestId: ap.id,
      createdAt: ap.createdAt,
    });
  }

  // 5) HookEvents — skip ones already represented by a primary record.
  for (const ev of src.hookEvents) {
    if (ev.handoffId && coveredHandoffIds.has(ev.handoffId)) continue;
    if (ev.artifactId && coveredArtifactIds.has(ev.artifactId)) continue;
    if (ev.approvalRequestId && coveredApprovalIds.has(ev.approvalRequestId)) continue;

    // Phase 6-G — a manual agent-definition registration note renders as a
    // System → <agent> communication so the operator sees who was registered.
    const meta = ev.metadata as Record<string, unknown> | null | undefined;
    const isRegistration = !!meta && meta.kind === 'agent_definition_registered';
    const fromAgentId = isRegistration ? 'system' : (ev.agentId ?? undefined);
    const toAgentId = isRegistration
      ? (typeof meta?.agentId === 'string' ? meta.agentId : ev.agentId ?? undefined)
      : undefined;

    events.push({
      id: `hook:${ev.id}`,
      type: isRegistration ? 'comment' : hookTypeToCommType(ev.type),
      runId: ev.runId ?? undefined,
      runStepId: ev.runStepId ?? undefined,
      fromAgentId,
      toAgentId,
      agentSessionId: ev.agentSessionId ?? undefined,
      title: makeExcerpt(ev.title, 140) ?? ev.type,
      summary: makeExcerpt(ev.summary ?? null, 500) ?? undefined,
      hookEventId: ev.id,
      artifactId: ev.artifactId ?? undefined,
      handoffId: ev.handoffId ?? undefined,
      approvalRequestId: ev.approvalRequestId ?? undefined,
      createdAt: ev.createdAt,
    });
  }

  // Newest first.
  events.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return events;
}

function stepAgentMap(runId: string, steps?: RunStep[]): Map<string, string> {
  const s = steps ?? safe(() => listRunStepsByRun(runId), []);
  const m = new Map<string, string>();
  for (const st of s) m.set(st.id, st.agentId);
  return m;
}

/* ============================================================================
 * Public surface
 * ========================================================================== */

export interface CommunicationByRunOptions {
  limit?: number;
  /** Injected sources for tests — when provided, no DB reads happen. */
  handoffs?: Handoff[];
  artifacts?: Artifact[];
  hookEvents?: HookEvent[];
  diagnostics?: Diagnostic[];
  approvals?: ApprovalRequest[];
  steps?: RunStep[];
}

export function listCommunicationByRun(
  runId: string,
  opts: CommunicationByRunOptions = {},
): AgentCommunicationEvent[] {
  const stepAgentByRun = new Map<string, Map<string, string>>();
  stepAgentByRun.set(runId, stepAgentMap(runId, opts.steps));

  const src: BuildSources = {
    handoffs: opts.handoffs ?? safe(() => listHandoffsByRun(runId), []),
    artifacts: opts.artifacts ?? safe(() => listArtifactsByRun(runId), []),
    hookEvents: opts.hookEvents ?? safe(() => listHookEventsByRun(runId, { limit: opts.limit ?? 500 }), []),
    diagnostics: opts.diagnostics ?? safe(() => listDiagnosticsByRun(runId, { limit: opts.limit ?? 200 }), []),
    approvals: opts.approvals ?? safe(() => listApprovalRequests({ runId, limit: 200 }), []),
    stepAgentByRun,
  };
  const events = buildEvents(src);
  return opts.limit ? events.slice(0, opts.limit) : events;
}

export interface CommunicationByAgentOptions extends CommunicationByRunOptions {
  /** When true, only events whose from/to agent matches are returned. */
  runIds?: string[];
}

export function listCommunicationByAgent(
  agentId: string,
  opts: CommunicationByAgentOptions = {},
): AgentCommunicationEvent[] {
  const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[\s\-./]+/g, '_');
  const target = norm(agentId);

  // Determine which runs to scan: explicit runIds, else recent active runs.
  const runIds =
    opts.runIds ??
    safe(() => listRuns({ limit: 100 }).map(r => r.id), []);

  const all: AgentCommunicationEvent[] = [];
  for (const runId of runIds) {
    all.push(...listCommunicationByRun(runId, { limit: opts.limit ?? 500 }));
  }
  const filtered = all.filter(
    e => norm(e.fromAgentId) === target || norm(e.toAgentId) === target,
  );
  filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

export interface RecentCommunicationOptions {
  limit?: number;
  hookEvents?: HookEvent[];
  diagnostics?: Diagnostic[];
}

/**
 * Lightweight global feed for the /agents "Recent Communications" panel and the
 * Command Center. Built from the recent HookEvent + Diagnostic streams only
 * (handoffs/artifacts already surface via their `*_created` hook events), so it
 * stays a single bounded read instead of fanning out across every run.
 */
export function listRecentCommunication(
  opts: RecentCommunicationOptions = {},
): AgentCommunicationEvent[] {
  const limit = opts.limit ?? 100;
  const hookEvents = opts.hookEvents ?? safe(() => listRecentHookEvents({ limit }), []);
  const diagnostics = opts.diagnostics ?? safe(() => listDiagnostics({ limit }), []);

  const src: BuildSources = {
    handoffs: [],
    artifacts: [],
    hookEvents,
    diagnostics,
    approvals: [],
    stepAgentByRun: new Map(),
  };
  return buildEvents(src).slice(0, limit);
}
