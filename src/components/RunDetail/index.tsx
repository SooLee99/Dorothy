'use client';

/**
 * Run Detail (/runs/[id]) — every facet of a single Dorothy Run.
 *
 * Layout: header + tab bar + tab body. Phase 2 keeps writes minimal:
 * we expose a "Cancel" button only when the Run is still active.
 *
 * Tabs render lazily-ish — every tab reads from already-fetched data, so we
 * don't pay extra IPC round trips when the user clicks between them.
 *
 * TODO (Phase 3+): wire AgentWorkflowProgress here. The Run Steps tab is
 * where the per-agent progress bar should land — see
 * docs/rebuild-target-mvp/mvp-agent-workflow-diagrams.md.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  AlertCircle,
  RefreshCw,
  Ban,
  FileText,
  ListChecks,
  TerminalSquare,
  Package,
  ArrowRightLeft,
  History as HistoryIcon,
  ShieldCheck,
  GitPullRequest,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Stethoscope,
  Workflow,
  CircleDot,
  Layers,
  MessagesSquare,
} from 'lucide-react';

import {
  useDorothyRun,
  useDorothySessions,
  useDorothyArtifacts,
  useDorothyHandoffs,
  useDorothyPullRequestsByRun,
  useDorothyCIRunsByRun,
  useDorothyImprovementSignalsByRun,
  useDorothyScheduledRateLimits,
  useDorothyHookEventsByRun,
  useDorothyDiagnosticsByRun,
  useDorothyWorkflowProgressByRun,
  useDorothySkillCandidatesByRun,
  useDorothyAgentCommunicationByRun,
  useDorothyDispatchReadinessByRun,
} from '@/hooks/useDorothyRuns';
import { DiagnosticCard } from '@/components/DiagnosticsDashboard';
import { SkillCandidateCard } from '@/components/SkillCandidates';
import { dorothyRunsClient } from '@/lib/dorothyRunsClient';
import { processDisplayName } from '@/lib/agentProcessDisplay';
import { DISPATCH_BLOCKER_KO } from '@/lib/koreanLabels';
import type {
  Artifact,
  AgentSession,
  Handoff,
  Run,
  RunStep,
  PullRequest,
  CIRun,
  HookEvent,
  HookEventSeverity,
  HookEventSource,
  Diagnostic,
  DiagnosticStatus,
  AgentWorkflowProgress,
  AgentWorkflowStepProgress,
  SkillCandidate,
  AgentCommunicationEvent,
} from '@/types/dorothy';
import {
  StateBadge,
  PriorityBadge,
  StepStateBadge,
  SessionStatusBadge,
  PullRequestStateBadge,
  CIRunStateBadge,
  formatAbsolute,
  formatRelative,
  durationBetween,
} from '@/components/RunCommon/badges';
import {
  RUN_MODE_BADGE,
  RUN_MODE_DESCRIPTION,
  HOOK_EVENT_SEVERITY_BADGE,
  WORKFLOW_STATUS_BADGE,
  WORKFLOW_STEP_STATUS_BADGE,
  WORKFLOW_KIND_LABEL,
  COMMUNICATION_TYPE_BADGE,
  COMMUNICATION_TYPE_LABEL,
} from '@/types/dorothy';

type Tab = 'overview' | 'steps' | 'sessions' | 'artifacts' | 'handoffs' | 'workflow' | 'communication' | 'diagnostics' | 'skill-candidates' | 'timeline' | 'pr-ci';

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'overview',         label: 'Overview',         icon: FileText },
  { id: 'steps',            label: 'Run Steps',        icon: ListChecks },
  { id: 'sessions',         label: 'Sessions',         icon: TerminalSquare },
  { id: 'workflow',         label: 'Agent Workflow',   icon: Workflow },
  { id: 'artifacts',        label: 'Artifacts',        icon: Package },
  { id: 'handoffs',         label: 'Handoffs',         icon: ArrowRightLeft },
  { id: 'communication',    label: 'Communication',    icon: MessagesSquare },
  { id: 'pr-ci',            label: 'PR / CI',          icon: GitPullRequest },
  { id: 'diagnostics',      label: 'Diagnostics',      icon: Stethoscope },
  { id: 'skill-candidates', label: 'Skill Candidates', icon: Layers },
  { id: 'timeline',         label: 'Timeline',         icon: HistoryIcon },
];

const ACTIVE_RUN_STATES = new Set([
  'created', 'planned', 'approval_required', 'approved',
  'running', 'verifying', 'needs_fix', 'reporting', 'blocked',
]);

export default function RunDetail({ runId }: { runId: string }) {
  const { run, steps, isLoading, error, dbUnavailable, refresh } = useDorothyRun(runId);
  const { sessions } = useDorothySessions({ runId, limit: 200 });
  const { artifacts } = useDorothyArtifacts(runId);
  const { handoffs } = useDorothyHandoffs(runId);
  const { pullRequests } = useDorothyPullRequestsByRun(runId);
  const { ciRuns } = useDorothyCIRunsByRun(runId);
  const { signals: improvementSignals } = useDorothyImprovementSignalsByRun(runId);
  // Phase 5C-C — Rate Limit / Resume context for the Run.
  const { events: scheduledEvents } = useDorothyScheduledRateLimits();
  const runRateLimitEvents = useMemo(
    () => scheduledEvents.filter(e => (e.affectedRunIds ?? []).includes(runId)),
    [scheduledEvents, runId],
  );
  // Phase 5F — HookEvent feed for the unified timeline. We over-fetch a
  // little (limit 500) so the Timeline tab can show severity / type filters
  // without an extra round trip. Failures fall back to the synthesized
  // timeline below — they never break Run Detail.
  const { events: hookEvents, dbUnavailable: hookEventsUnavailable } =
    useDorothyHookEventsByRun(runId, { limit: 500 });
  // Phase 6-A — Diagnostics tab data.
  const { diagnostics: runDiagnostics, refresh: refreshDiagnostics } =
    useDorothyDiagnosticsByRun(runId, { limit: 100 });
  // Phase 6-B — Agent Workflow tab data.
  const { rows: runWorkflows, refresh: refreshWorkflows } =
    useDorothyWorkflowProgressByRun(runId, { limit: 50 });
  // Phase 6-D — Skill Candidates tab data.
  const { candidates: runSkillCandidates } =
    useDorothySkillCandidatesByRun(runId, { limit: 100 });
  // Phase 6-E — Agent Communication tab data.
  const { events: communicationEvents } =
    useDorothyAgentCommunicationByRun(runId, { limit: 500 });

  const [tab, setTab] = useState<Tab>('overview');
  const [cancelling, setCancelling] = useState(false);
  // Phase 5E — operator-driven mode change. Disabled for terminal Runs.
  const [updatingMode, setUpdatingMode] = useState(false);

  const onCancel = async () => {
    if (!run) return;
    if (typeof window !== 'undefined' && !window.confirm(`Cancel run "${run.title}"?`)) return;
    setCancelling(true);
    try {
      await dorothyRunsClient.runs.updateState({ id: run.id, state: 'cancelled' });
      await refresh();
    } finally {
      setCancelling(false);
    }
  };

  const onChangeMode = async (next: 'manual' | 'team' | 'persistent' | 'ultraqa' | 'pipeline') => {
    if (!run || next === run.mode) return;
    // Warn on the riskier transitions explicitly enumerated in the spec.
    const riskyTransitions: Array<[string | null, string]> = [
      ['manual', 'persistent'],
      ['manual', 'team'],
      ['pipeline', 'team'],
    ];
    const fromAnyToPersistent = next === 'persistent';
    const isRisky = riskyTransitions.some(([f, t]) => (run.mode ?? null) === f && next === t) || fromAnyToPersistent;
    const baseMsg = `Change RunMode from ${run.mode ?? '(unset)'} → ${next}?\n\nMode changes do not auto-start agents.`;
    const msg = isRisky
      ? `${baseMsg}\n\n⚠ This is a risky transition — the orchestrator's retry budget and parallelism rules will change immediately for any future RunStep on this Run. Risk-keyword Runs still require ApprovalRequest.`
      : baseMsg;
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;
    setUpdatingMode(true);
    try {
      const reason = `mode changed to ${next} by user from Run Detail`;
      await dorothyRunsClient.runs.updateMode({ id: run.id, mode: next, reason, source: 'manual' });
      await refresh();
    } finally {
      setUpdatingMode(false);
    }
  };

  const modeChangeDisabled =
    !run ||
    run.state === 'completed' ||
    run.state === 'failed' ||
    run.state === 'cancelled' ||
    updatingMode;

  // -------- error / loading shells ----------
  if (dbUnavailable) {
    return (
      <DetailShell>
        <div className="p-4 border border-amber-500/30 bg-amber-500/5 text-amber-500 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          Dorothy run database is not available — start the Electron app to populate this view.
        </div>
      </DetailShell>
    );
  }
  if (isLoading && !run) {
    return (
      <DetailShell>
        <div className="p-8 text-center text-sm text-muted-foreground">Loading run…</div>
      </DetailShell>
    );
  }
  if (!run) {
    return (
      <DetailShell>
        <div className="p-8 border border-dashed border-border text-center">
          <p className="text-sm text-muted-foreground">Run not found.</p>
          {error && <p className="text-xs text-rose-500 mt-2">{error}</p>}
          <Link href="/runs" className="inline-flex items-center gap-2 text-sm mt-4 text-foreground hover:underline">
            <ArrowLeft className="w-4 h-4" /> Back to Run Board
          </Link>
        </div>
      </DetailShell>
    );
  }

  const canCancel = ACTIVE_RUN_STATES.has(run.state);

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="mb-4">
        <Link href="/runs" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-3">
          <ArrowLeft className="w-4 h-4" /> Back to Run Board
        </Link>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-foreground leading-tight">{run.title}</h1>
            <div className="text-xs text-muted-foreground mt-1 font-mono">{run.id}</div>
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <StateBadge state={run.state} />
              <PriorityBadge priority={run.priority} />
              <span className="inline-flex items-center px-2 py-0.5 text-xs bg-muted text-muted-foreground">
                {run.source}
              </span>
              {run.kanbanTaskId && (
                <span className="inline-flex items-center px-2 py-0.5 text-xs bg-muted text-muted-foreground">
                  kanban {run.kanbanTaskId.slice(0, 8)}
                </span>
              )}
              {/* Phase 5D — RunMode badge in the Run Detail header. */}
              {run.mode && (
                <span
                  className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border ${RUN_MODE_BADGE[run.mode]}`}
                  title={`${RUN_MODE_DESCRIPTION[run.mode]}${run.modeSource ? ` — source: ${run.modeSource}` : ''}`}
                >
                  mode: {run.mode}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Phase 5E — Run mode editor. Disabled on terminal Runs;
                otherwise a small select dispatches updateMode + refresh. */}
            <label className="text-xs text-muted-foreground flex items-center gap-1" title="Change RunMode. Does not auto-start agents.">
              mode:
              <select
                value={run.mode ?? ''}
                disabled={modeChangeDisabled}
                onChange={e => { void onChangeMode(e.target.value as 'manual' | 'team' | 'persistent' | 'ultraqa' | 'pipeline'); }}
                className="px-2 py-1 text-xs bg-card border border-border text-foreground disabled:opacity-50"
              >
                <option value="" disabled>(unset)</option>
                <option value="team">team</option>
                <option value="manual">manual</option>
                <option value="persistent">persistent</option>
                <option value="ultraqa">ultraqa</option>
                <option value="pipeline">pipeline</option>
              </select>
            </label>
            <button
              onClick={() => { void refresh(); }}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} /> Refresh
            </button>
            {canCancel && (
              <button
                onClick={onCancel}
                disabled={cancelling}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-rose-500/40 bg-rose-500/5 text-rose-500 hover:bg-rose-500/10 disabled:opacity-50"
              >
                <Ban className="w-4 h-4" /> {cancelling ? 'Cancelling…' : 'Cancel run'}
              </button>
            )}
          </div>
        </div>
        <Timestamps run={run} />
        {run.blockedReason && run.state === 'blocked' && (() => {
          const br = run.blockedReason ?? '';
          const isRate = br.startsWith('rate_limit:');
          const prov = br.split(':')[1] || '';
          const provKo = prov === 'claude' ? 'Claude' : prov === 'codex' ? 'Codex' : prov;
          return (
            <div className="mt-3 p-3 border border-yellow-500/30 bg-yellow-500/5 text-yellow-600 text-sm">
              <strong>일시중지</strong> — {isRate ? `${provKo} 사용 한도로 잠시 멈춤 (실패 아님)` : br}
              {isRate && (
                <div className="mt-2 text-xs text-yellow-600/80">
                  한도가 회복되면 최신 Handoff를 읽고 <b>자동으로 재개</b>됩니다. 자동 재개가 dry-run이면(<code className="font-mono mx-1">dorothyAutoResumeRateLimitedSessions</code>) 후보만 <Link href="/sessions" className="underline">/sessions</Link>에 표시되고 워커는 자동 시작되지 않습니다.
                </div>
              )}
              <div className="mt-2 text-xs text-foreground/70">⬇ 일시중지 중에도 진행 내역·단계·핸드오프·상태는 아래에서 계속 확인할 수 있습니다.</div>
            </div>
          );
        })()}
        {improvementSignals.length > 0 && (
          <div className="mt-3 p-3 border border-purple-500/30 bg-purple-500/5 text-purple-500 text-sm">
            <strong>{improvementSignals.length} improvement signal{improvementSignals.length === 1 ? '' : 's'}</strong> linked to this Run.{' '}
            <Link href="/improvements" className="underline hover:text-purple-400">Open Improvements</Link>
          </div>
        )}
        {runRateLimitEvents.length > 0 && (
          <RateLimitResumeSection events={runRateLimitEvents} />
        )}
        {run.errorReason && (
          <div className="mt-3 p-3 border border-rose-500/30 bg-rose-500/5 text-rose-500 text-sm">
            <strong>Error:</strong> {run.errorReason}
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="border-b border-border mb-4 flex gap-1 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-2 px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${
              tab === t.id
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
            {t.id === 'steps' && <Count value={steps.length} />}
            {t.id === 'sessions' && <Count value={sessions.length} />}
            {t.id === 'artifacts' && <Count value={artifacts.length} />}
            {t.id === 'handoffs' && <Count value={handoffs.length} />}
            {t.id === 'pr-ci' && <Count value={pullRequests.length + ciRuns.length} />}
            {t.id === 'diagnostics' && <Count value={runDiagnostics.length} />}
            {t.id === 'workflow' && <Count value={runWorkflows.length} />}
            {t.id === 'skill-candidates' && <Count value={runSkillCandidates.length} />}
          </button>
        ))}
      </div>

      {/* Tab body */}
      {tab === 'overview'  && <OverviewTab run={run} steps={steps} sessions={sessions} artifacts={artifacts} handoffs={handoffs} />}
      {tab === 'steps'     && <StepsTab steps={steps} />}
      {tab === 'sessions'  && <SessionsTab sessions={sessions} />}
      {tab === 'artifacts' && <ArtifactsTab artifacts={artifacts} />}
      {tab === 'handoffs'  && <HandoffsTab handoffs={handoffs} steps={steps} />}
      {tab === 'communication' && <CommunicationTab events={communicationEvents} />}
      {tab === 'pr-ci'     && <PrCiTab pullRequests={pullRequests} ciRuns={ciRuns} />}
      {tab === 'diagnostics' && <DiagnosticsTab diagnostics={runDiagnostics} onRefresh={refreshDiagnostics} />}
      {tab === 'workflow' && (
        <div className="space-y-3">
          <DispatchReadinessPanel runId={runId} />
          <AgentWorkflowTab
            runId={runId}
            rows={runWorkflows}
            onRefresh={refreshWorkflows}
          />
        </div>
      )}
      {tab === 'skill-candidates' && (
        <SkillCandidatesTab candidates={runSkillCandidates} />
      )}
      {tab === 'timeline'  && (
        <TimelineTab
          run={run}
          steps={steps}
          sessions={sessions}
          handoffs={handoffs}
          artifacts={artifacts}
          hookEvents={hookEvents}
          hookEventsUnavailable={hookEventsUnavailable}
        />
      )}
    </div>
  );
}

/* ============================================================================
 * Sub-components
 * ========================================================================== */

/**
 * Phase 5D — RunMode summary inset shown inside the Overview "At a glance"
 * card. We re-derive the policy bullets client-side from a tiny lookup so we
 * don't need a per-Run IPC fetch.
 *
 * The footer line carries Dorothy's "OMC-inspired concept, Dorothy-native
 * runtime" disclaimer so the operator knows we did not import OMC.
 */
function RunModeSummary({ run }: { run: Run }) {
  const mode = run.mode!;
  const bullets = MODE_BULLETS[mode] ?? [];
  return (
    <div className="mt-4 p-3 border border-border bg-background">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border ${RUN_MODE_BADGE[mode]}`}>
          mode: {mode}
        </span>
        {run.modeSource && (
          <span className="text-[10px] text-muted-foreground">
            source: <code className="font-mono">{run.modeSource}</code>
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{RUN_MODE_DESCRIPTION[mode]}</p>
      {bullets.length > 0 && (
        <ul className="mt-2 list-disc pl-4 text-[11px] text-muted-foreground space-y-0.5">
          {bullets.map(b => <li key={b}>{b}</li>)}
        </ul>
      )}
      {run.modeReason && (
        <div className="mt-2 text-[11px] text-muted-foreground italic">
          {run.modeReason}
        </div>
      )}
      <div className="mt-2 text-[10px] text-muted-foreground italic">
        OMC-inspired concept, Dorothy-native runtime.
      </div>
    </div>
  );
}

/**
 * Static mode → policy-bullet table. Mirrors `electron/services/dorothy/
 * run-mode-policy.ts`; keeping it in sync is enforced by the next build via
 * the shared `RunMode` enum.
 */
const MODE_BULLETS: Record<NonNullable<Run['mode']>, string[]> = {
  manual: [
    'No automatic retry on step failure',
    'No live auto-resume after rate limits',
    'Approval gate stays strong',
  ],
  team: [
    'FE and BE may run in parallel when worktrees differ',
    'Limited QA retry on flaky failures',
    'Handoff required between roles',
  ],
  persistent: [
    'maxFixAttempts default 3',
    'CI / QA failed → needs_fix → orchestrator re-dispatch',
    'Repeated failures spawn ImprovementSignal',
  ],
  ultraqa: [
    'Plan must include validation commands',
    'QA + Reviewer prioritized over implementation parallelism',
    'CI failures emit higher-severity ImprovementSignals',
  ],
  pipeline: [
    'No FE/BE parallel dispatch',
    'Each Handoff must complete before the next step',
    'maxFixAttempts capped at 1',
  ],
};

/**
 * Phase 5C-C — Rate Limit / Resume context section.
 * Shown only when at least one RateLimitEvent claims this Run via
 * `affectedRunIds`. Read-only; the actual Resume Now action lives on
 * /sessions where the AgentSession id provides the necessary scoping.
 */
function RateLimitResumeSection({ events }: { events: import('@/types/dorothy').RateLimitEvent[] }) {
  // Sort: failed first, then scheduled/pending earliest-due first.
  const sorted = [...events].sort((a, b) => {
    const score = (e: typeof a) => e.resumeStatus === 'failed' ? 0
      : e.resumeStatus === 'resuming' ? 1
      : e.resumeStatus === 'scheduled' ? 2
      : e.resumeStatus === 'pending' ? 3
      : 4;
    const sc = score(a) - score(b);
    if (sc !== 0) return sc;
    return (a.resumeAt ?? '').localeCompare(b.resumeAt ?? '');
  });
  return (
    <div className="mt-3 p-3 border border-yellow-500/30 bg-yellow-500/5 text-yellow-500 text-sm">
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <strong className="text-yellow-500">
          {events.length} rate-limit event{events.length === 1 ? '' : 's'} linked to this Run
        </strong>
        <Link href="/sessions" className="underline hover:text-yellow-400 text-xs">
          Resume on /sessions →
        </Link>
      </div>
      <p className="text-xs text-yellow-500/80 mb-3">
        Auto Resume reads the latest Handoff and continues only pending or blocked steps —
        completed RunSteps are never re-run. Manual <em>Resume Now</em> on /sessions works even
        when <code className="font-mono">dorothyAutoResumeRateLimitedSessions</code> is dry-run.
      </p>
      <ul className="space-y-2">
        {sorted.map(e => (
          <li key={e.id} className="bg-background border border-border p-2 text-foreground">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <code className="font-mono text-muted-foreground">{e.id.slice(0, 8)}</code>
              <span className="text-muted-foreground">·</span>
              <span>provider <code className="font-mono">{e.provider ?? e.engine}</code></span>
              <span className="text-muted-foreground">·</span>
              <span>status <code className="font-mono">{e.resumeStatus ?? 'pending'}</code></span>
              {e.parseConfidence && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span>confidence <code className="font-mono">{e.parseConfidence}</code></span>
                </>
              )}
              {(e.retryCount ?? 0) > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span>retry <code className="font-mono">{e.retryCount}</code></span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground mt-1">
              {e.resumeAt && (
                <span title={formatAbsolute(e.resumeAt)}>resumeAt: {formatRelative(e.resumeAt)}</span>
              )}
              {(e.affectedSessionIds && e.affectedSessionIds.length > 0) && (
                <span>sessions: {e.affectedSessionIds.map(s => s.slice(0, 8)).join(', ')}</span>
              )}
              {(e.affectedRunStepIds && e.affectedRunStepIds.length > 0) && (
                <span>steps: {e.affectedRunStepIds.map(s => s.slice(0, 8)).join(', ')}</span>
              )}
            </div>
            {e.lastResumeError && (
              <div className="mt-1 text-[11px] text-rose-500 line-clamp-2" title={e.lastResumeError}>
                last error: {e.lastResumeError.slice(0, 200)}
              </div>
            )}
            {e.messageExcerpt && (
              <div className="mt-1 text-[11px] text-muted-foreground italic line-clamp-2">
                excerpt: {e.messageExcerpt}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DetailShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <Link href="/runs" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to Run Board
      </Link>
      {children}
    </div>
  );
}

function Count({ value }: { value: number }) {
  return (
    <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] text-[10px] bg-muted text-muted-foreground px-1">
      {value}
    </span>
  );
}

function Timestamps({ run }: { run: Run }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4 text-xs">
      <Field label="Created"  value={formatAbsolute(run.createdAt)} sub={formatRelative(run.createdAt)} />
      <Field label="Started"  value={formatAbsolute(run.startedAt)} sub={formatRelative(run.startedAt)} />
      <Field label="Closed"   value={formatAbsolute(run.closedAt)}  sub={formatRelative(run.closedAt)} />
    </div>
  );
}

function Field({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="p-3 bg-card border border-border">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground mt-1 break-all">{value}</div>
      {sub && sub !== '—' && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function OverviewTab({
  run, steps, sessions, artifacts, handoffs,
}: {
  run: Run; steps: RunStep[]; sessions: AgentSession[]; artifacts: Artifact[]; handoffs: Handoff[];
}) {
  // TODO (Phase 3+): wire AgentWorkflowProgress here for a graphical view of
  // which agent is currently running and the dependency tree of remaining
  // RunSteps. For Phase 2 we just show a numeric strip.
  const stats = useMemo(() => ({
    steps: steps.length,
    completedSteps: steps.filter(s => s.state === 'completed').length,
    failedSteps: steps.filter(s => s.state === 'failed').length,
    sessions: sessions.length,
    activeSessions: sessions.filter(s => !s.exitedAt).length,
    artifacts: artifacts.length,
    handoffs: handoffs.length,
  }), [steps, sessions, artifacts, handoffs]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 p-4 bg-card border border-border">
        <h2 className="text-sm font-semibold text-foreground mb-3">Summary</h2>
        <dl className="space-y-2 text-sm">
          <Row label="ID"            value={<code className="font-mono text-xs">{run.id}</code>} />
          <Row label="Title"         value={run.title} />
          <Row label="State"         value={<StateBadge state={run.state} />} />
          <Row label="Priority"      value={<PriorityBadge priority={run.priority} />} />
          <Row label="Source"        value={run.source} />
          <Row label="Source ref"    value={run.sourceRefId ?? '—'} />
          <Row label="Kanban task"   value={run.kanbanTaskId ?? '—'} />
          <Row label="Plan"          value={run.planId ?? '—'} />
          <Row label="Comment"       value={run.comment ?? '—'} />
          <Row label="Created"       value={formatAbsolute(run.createdAt)} />
          <Row label="Started"       value={formatAbsolute(run.startedAt)} />
          <Row label="Closed"        value={formatAbsolute(run.closedAt)} />
          {run.startedAt && (
            <Row label="Duration"    value={durationBetween(run.startedAt, run.closedAt)} />
          )}
        </dl>
      </div>
      <div className="p-4 bg-card border border-border">
        <h2 className="text-sm font-semibold text-foreground mb-3">At a glance</h2>
        <ul className="space-y-2 text-sm">
          <KV label="Run steps"     value={`${stats.completedSteps} / ${stats.steps} completed${stats.failedSteps ? ` (${stats.failedSteps} failed)` : ''}`} />
          <KV label="Sessions"      value={`${stats.activeSessions} active / ${stats.sessions} total`} />
          <KV label="Artifacts"     value={`${stats.artifacts}`} />
          <KV label="Handoffs"      value={`${stats.handoffs}`} />
          <KV
            label="Current phase"
            value={derivedWorkflowPhase({ run, steps })}
          />
        </ul>
        <div className="mt-4 text-[11px] text-muted-foreground italic">
          {/* TODO Phase 5/6 — replace this widget with AgentWorkflowProgress.
              The model is intentionally not added yet; the label above derives
              the phase from Run.state + the most recent RunStep.agentId so the
              UI has a slot ready when the real model lands. */}
          Workflow tracking provisional — phase derived from Run.state + last step.
        </div>
        {run.mode && <RunModeSummary run={run} />}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground w-28 shrink-0 pt-0.5">{label}</dt>
      <dd className="text-sm text-foreground flex-1 break-words">{value}</dd>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground tabular-nums">{value}</span>
    </li>
  );
}

function StepsTab({ steps }: { steps: RunStep[] }) {
  if (steps.length === 0) {
    return <EmptyBox icon={<ListChecks className="w-8 h-8" />} text="No run steps yet." />;
  }
  return (
    <div className="bg-card border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <Th className="w-12 text-right pr-3">#</Th>
            <Th>Agent</Th>
            <Th>State</Th>
            <Th className="w-20 text-center">Retries</Th>
            <Th>Started</Th>
            <Th>Ended</Th>
            <Th>Duration</Th>
            <Th>Error</Th>
          </tr>
        </thead>
        <tbody>
          {steps.map(step => (
            <tr key={step.id} className="border-t border-border align-top">
              <Td className="text-right pr-3 tabular-nums text-muted-foreground">{step.order}</Td>
              <Td className="text-foreground">{step.agentId}</Td>
              <Td><StepStateBadge state={step.state} /></Td>
              <Td className="text-center tabular-nums">{step.retryCount}</Td>
              <Td><Time iso={step.startedAt} /></Td>
              <Td><Time iso={step.endedAt} /></Td>
              <Td className="tabular-nums">{durationBetween(step.startedAt, step.endedAt)}</Td>
              <Td className="text-rose-500 text-xs">{step.errorReason ?? ''}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionsTab({ sessions }: { sessions: AgentSession[] }) {
  if (sessions.length === 0) {
    return <EmptyBox icon={<TerminalSquare className="w-8 h-8" />} text="No agent sessions yet." />;
  }
  return (
    <div className="bg-card border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <Th>Agent</Th>
            <Th>Provider</Th>
            <Th>Status</Th>
            <Th>Started</Th>
            <Th>Exited</Th>
            <Th>Worktree</Th>
            <Th>Log</Th>
          </tr>
        </thead>
        <tbody>
          {sessions.map(s => (
            <tr key={s.id} className="border-t border-border">
              <Td className="text-foreground">{s.agentId}</Td>
              <Td className="text-muted-foreground">{s.provider}</Td>
              <Td>
                <SessionStatusBadge endStatus={s.endStatus ?? null} active={!s.exitedAt} />
                {s.waitingForUserInput && (
                  <span className="ml-2 inline-flex items-center px-1.5 py-0 text-[10px] bg-amber-500/10 text-amber-500 border border-amber-500/30">
                    waiting
                  </span>
                )}
              </Td>
              <Td><Time iso={s.startedAt} /></Td>
              <Td><Time iso={s.exitedAt} /></Td>
              <Td className="text-xs font-mono text-muted-foreground truncate max-w-[280px]" title={s.worktreePath ?? ''}>
                {s.worktreePath ?? '—'}
              </Td>
              <Td className="text-xs font-mono text-muted-foreground truncate max-w-[180px]" title={s.rawLogRef ?? ''}>
                {s.rawLogRef ?? '—'}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArtifactsTab({ artifacts }: { artifacts: Artifact[] }) {
  if (artifacts.length === 0) {
    return <EmptyBox icon={<Package className="w-8 h-8" />} text="No artifacts yet." />;
  }
  return (
    <div className="bg-card border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <Th>Type</Th>
            <Th>Path / Ref</Th>
            <Th>Produced by</Th>
            <Th>Step</Th>
            <Th>Created</Th>
          </tr>
        </thead>
        <tbody>
          {artifacts.map(a => (
            <tr key={a.id} className="border-t border-border">
              <Td>
                <span className="inline-flex items-center px-2 py-0.5 text-xs bg-muted text-muted-foreground">
                  {a.type}
                </span>
              </Td>
              <Td className="font-mono text-xs text-foreground break-all">
                {a.path ?? a.contentRef ?? '—'}
              </Td>
              <Td className="text-muted-foreground">{a.producedByAgentId}</Td>
              <Td className="text-xs font-mono text-muted-foreground">
                {a.runStepId ? a.runStepId.slice(0, 8) : '—'}
              </Td>
              <Td><Time iso={a.createdAt} /></Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HandoffsTab({ handoffs, steps }: { handoffs: Handoff[]; steps: RunStep[] }) {
  if (handoffs.length === 0) {
    return <EmptyBox icon={<ArrowRightLeft className="w-8 h-8" />} text="No handoffs yet." />;
  }
  const stepLabel = (id: string) => {
    const s = steps.find(x => x.id === id);
    return s ? `#${s.order} ${s.agentId}` : id.slice(0, 8);
  };
  return (
    <ol className="space-y-3">
      {handoffs.map(h => (
        <li key={h.id} className="p-3 bg-card border border-border">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
            <span className="font-mono">{stepLabel(h.fromRunStepId)}</span>
            <ArrowRightLeft className="w-3 h-3" />
            <span className="font-mono">{stepLabel(h.toRunStepId)}</span>
            <span className="ml-auto">{formatRelative(h.createdAt)}</span>
          </div>
          <div className="text-sm text-foreground whitespace-pre-wrap">{h.summary}</div>
          {h.attachedArtifactIds.length > 0 && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              attached: {h.attachedArtifactIds.map(id => id.slice(0, 8)).join(', ')}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function CommunicationTab({ events }: { events: AgentCommunicationEvent[] }) {
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [search, setSearch] = useState('');

  const agentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) {
      if (e.fromAgentId) set.add(e.fromAgentId);
      if (e.toAgentId) set.add(e.toAgentId);
    }
    return Array.from(set).sort();
  }, [events]);

  const typeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) set.add(e.type);
    return Array.from(set).sort();
  }, [events]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter(e => {
      if (agentFilter && e.fromAgentId !== agentFilter && e.toAgentId !== agentFilter) return false;
      if (typeFilter && e.type !== typeFilter) return false;
      if (q && !(`${e.title} ${e.summary ?? ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [events, agentFilter, typeFilter, search]);

  if (events.length === 0) {
    return <EmptyBox icon={<MessagesSquare className="w-8 h-8" />} text="No agent communication recorded yet." />;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select
          value={agentFilter}
          onChange={e => setAgentFilter(e.target.value)}
          className="px-2 py-1 text-xs border border-border bg-card rounded"
        >
          <option value="">All agents</option>
          {agentOptions.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          className="px-2 py-1 text-xs border border-border bg-card rounded"
        >
          <option value="">All types</option>
          {typeOptions.map(t => (
            <option key={t} value={t}>
              {COMMUNICATION_TYPE_LABEL[t as AgentCommunicationEvent['type']] ?? t}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-2 py-1 text-xs border border-border bg-card rounded flex-1 min-w-[140px]"
        />
        <span className="text-[11px] text-muted-foreground ml-auto">{filtered.length} / {events.length}</span>
      </div>
      <ol className="space-y-2">
        {filtered.map(e => (
          <li key={e.id} className="p-2.5 bg-card border border-border rounded">
            <div className="flex items-center gap-2 text-xs mb-1">
              <span className={`px-1.5 py-px text-[10px] border rounded shrink-0 ${COMMUNICATION_TYPE_BADGE[e.type]}`}>
                {COMMUNICATION_TYPE_LABEL[e.type]}
              </span>
              {e.fromAgentId && <span className="font-mono text-muted-foreground">{e.fromAgentId}</span>}
              {e.toAgentId && <span className="font-mono text-muted-foreground">→ {e.toAgentId}</span>}
              <span className="ml-auto text-muted-foreground">{formatRelative(e.createdAt)}</span>
            </div>
            <div className="text-sm text-foreground">{e.title}</div>
            {e.summary && <div className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{e.summary}</div>}
            {(e.handoffId || e.artifactId || e.hookEventId || e.diagnosticId || e.approvalRequestId) && (
              <div className="mt-1 text-[10px] text-muted-foreground/70 font-mono">
                {e.handoffId && `handoff:${e.handoffId.slice(0, 8)} `}
                {e.artifactId && `artifact:${e.artifactId.slice(0, 8)} `}
                {e.hookEventId && `hook:${e.hookEventId.slice(0, 8)} `}
                {e.diagnosticId && `diag:${e.diagnosticId.slice(0, 8)} `}
                {e.approvalRequestId && `approval:${e.approvalRequestId.slice(0, 8)}`}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function PrCiTab({
  pullRequests,
  ciRuns,
}: {
  pullRequests: PullRequest[];
  ciRuns: CIRun[];
}) {
  const failedCi = useMemo(() => ciRuns.filter(c => c.state === 'failed'), [ciRuns]);
  const mergedPrs = useMemo(() => pullRequests.filter(p => p.state === 'merged'), [pullRequests]);

  if (pullRequests.length === 0 && ciRuns.length === 0) {
    return (
      <EmptyBox
        icon={<GitPullRequest className="w-8 h-8" />}
        text="No PRs or CI runs linked to this Run yet."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Status banners — read-only signals; we never mutate Run.state from here. */}
      {failedCi.length > 0 && (
        <div className="p-3 border border-rose-500/30 bg-rose-500/5 text-rose-500 text-sm flex items-start gap-2">
          <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <strong>{failedCi.length} CI run{failedCi.length === 1 ? '' : 's'} failed.</strong>
            {' '}
            Run state is unchanged by the dashboard;
            {' '}
            <code className="font-mono">dorothyPrCiAutoTransition</code>{' '}
            in Settings governs any automatic transition.
          </div>
        </div>
      )}
      {mergedPrs.length > 0 && (
        <div className="p-3 border border-emerald-500/30 bg-emerald-500/5 text-emerald-600 text-sm flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <strong>{mergedPrs.length} PR{mergedPrs.length === 1 ? '' : 's'} merged.</strong>{' '}
            Review the Reports tab on /reports for the final result-report.
          </div>
        </div>
      )}

      {/* Pull Requests */}
      <section>
        <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider mb-2">
          Pull Requests ({pullRequests.length})
        </h2>
        {pullRequests.length === 0 ? (
          <div className="text-xs text-muted-foreground italic px-1 py-2">No PR linked.</div>
        ) : (
          <div className="space-y-2">
            {pullRequests.map(pr => <PrLine key={pr.id} pr={pr} />)}
          </div>
        )}
      </section>

      {/* CI Runs */}
      <section>
        <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider mb-2">
          CI Runs ({ciRuns.length})
        </h2>
        {ciRuns.length === 0 ? (
          <div className="text-xs text-muted-foreground italic px-1 py-2">No CI run yet.</div>
        ) : (
          <div className="bg-card border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <Th>Workflow</Th>
                  <Th>State</Th>
                  <Th>Conclusion</Th>
                  <Th>Started</Th>
                  <Th>Completed</Th>
                  <Th>Logs</Th>
                </tr>
              </thead>
              <tbody>
                {ciRuns.map(c => (
                  <tr key={c.id} className="border-t border-border">
                    <Td className="text-foreground">{c.workflow}</Td>
                    <Td><CIRunStateBadge state={c.state} /></Td>
                    <Td className="text-xs text-muted-foreground">{c.conclusion ?? '—'}</Td>
                    <Td><Time iso={c.startedAt} /></Td>
                    <Td><Time iso={c.completedAt} /></Td>
                    <Td>
                      {c.logsUrl ? (
                        <a
                          href={c.logsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="w-3 h-3" /> logs
                        </a>
                      ) : c.url ? (
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="w-3 h-3" /> open
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function PrLine({ pr }: { pr: PullRequest }) {
  return (
    <div className="p-3 bg-card border border-border">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <PullRequestStateBadge state={pr.state} />
            <span className="text-sm text-foreground break-words">{pr.title}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            <code className="font-mono">{pr.externalRef}</code>
            {' · '}
            <code className="font-mono">{pr.branch}</code> → <code className="font-mono">{pr.baseBranch}</code>
            {pr.mergedAt && <> · merged {formatRelative(pr.mergedAt)}</>}
          </div>
        </div>
        {pr.url && (
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <ExternalLink className="w-3 h-3" /> GitHub
          </a>
        )}
      </div>
    </div>
  );
}

interface TimelineEntry {
  id: string;
  at: string;
  kind: 'run' | 'step' | 'session' | 'artifact' | 'handoff';
  label: string;
  sub?: string;
}

type SeverityFilter = 'all' | HookEventSeverity;

const SEVERITY_FILTERS: ReadonlyArray<{ id: SeverityFilter; label: string }> = [
  { id: 'all',     label: 'All' },
  { id: 'error',   label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
  { id: 'info',    label: 'Info' },
  { id: 'debug',   label: 'Debug' },
];

function TimelineTab({
  run, steps, sessions, handoffs, artifacts, hookEvents, hookEventsUnavailable,
}: {
  run: Run; steps: RunStep[]; sessions: AgentSession[]; handoffs: Handoff[]; artifacts: Artifact[];
  hookEvents: HookEvent[];
  hookEventsUnavailable: boolean;
}) {
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');

  // Phase 5F — derive available type / source values from the loaded
  // HookEvents so the dropdown only shows things that actually occurred.
  const availableTypes = useMemo(() => {
    const s = new Set<string>(); for (const e of hookEvents) s.add(e.type);
    return Array.from(s).sort();
  }, [hookEvents]);
  const availableSources = useMemo(() => {
    const s = new Set<string>(); for (const e of hookEvents) s.add(e.source);
    return Array.from(s).sort();
  }, [hookEvents]);

  const filteredHookEvents = useMemo(() => {
    return hookEvents.filter(e => {
      if (severityFilter !== 'all' && e.severity !== severityFilter) return false;
      if (typeFilter !== 'all' && e.type !== typeFilter) return false;
      if (sourceFilter !== 'all' && e.source !== sourceFilter) return false;
      return true;
    });
  }, [hookEvents, severityFilter, typeFilter, sourceFilter]);

  // Fallback timeline (Phase 4) — used when HookEvents are empty or the IPC
  // bridge is unavailable. Same shape as before so the UI stays familiar.
  const fallback = useMemo<TimelineEntry[]>(() => {
    const out: TimelineEntry[] = [];
    out.push({ id: `run-created-${run.id}`, at: run.createdAt, kind: 'run', label: 'Run created' });
    if (run.startedAt) out.push({ id: `run-started-${run.id}`, at: run.startedAt, kind: 'run', label: 'Run started' });
    if (run.closedAt)  out.push({ id: `run-closed-${run.id}`, at: run.closedAt, kind: 'run', label: `Run closed (${run.state})` });
    for (const s of steps) {
      if (s.startedAt) out.push({ id: `step-start-${s.id}`, at: s.startedAt, kind: 'step', label: `Step #${s.order} ${s.agentId} started` });
      if (s.endedAt)   out.push({ id: `step-end-${s.id}`,   at: s.endedAt,   kind: 'step', label: `Step #${s.order} ${s.agentId} ${s.state}`, sub: s.errorReason ?? undefined });
    }
    for (const sn of sessions) {
      out.push({ id: `sess-start-${sn.id}`, at: sn.startedAt, kind: 'session', label: `Session start (${sn.agentId} / ${sn.provider})` });
      if (sn.exitedAt) out.push({ id: `sess-end-${sn.id}`, at: sn.exitedAt, kind: 'session', label: `Session exit (${sn.agentId} / ${sn.endStatus ?? 'unknown'})` });
    }
    for (const h of handoffs) out.push({ id: `ho-${h.id}`, at: h.createdAt, kind: 'handoff', label: `Handoff`, sub: h.summary });
    for (const a of artifacts) out.push({ id: `ar-${a.id}`, at: a.createdAt, kind: 'artifact', label: `Artifact: ${a.type}`, sub: a.path ?? a.contentRef ?? undefined });
    return out.sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
  }, [run, steps, sessions, handoffs, artifacts]);

  // Prefer HookEvents whenever the IPC succeeded. Fall back when:
  //   - the bridge is unavailable (running outside Electron)
  //   - the events list is empty (older Runs predate Phase 5F)
  const useFallback = hookEventsUnavailable || hookEvents.length === 0;

  if (useFallback && fallback.length === 0) {
    return <EmptyBox icon={<HistoryIcon className="w-8 h-8" />} text="Timeline empty." />;
  }

  return (
    <div className="space-y-3">
      {!useFallback && (
        <div className="bg-card border border-border p-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground uppercase tracking-wider">Filter:</span>
          <div className="flex gap-1 flex-wrap">
            {SEVERITY_FILTERS.map(f => (
              <button
                key={f.id}
                onClick={() => setSeverityFilter(f.id)}
                className={`px-2 py-1 border ${
                  severityFilter === f.id
                    ? 'bg-foreground/10 text-foreground border-foreground/30'
                    : 'bg-card text-muted-foreground border-border hover:text-foreground'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {availableTypes.length > 1 && (
            <label className="text-muted-foreground flex items-center gap-1 ml-2">
              type:
              <select
                value={typeFilter}
                onChange={e => setTypeFilter(e.target.value)}
                className="px-2 py-1 bg-card border border-border text-foreground"
              >
                <option value="all">all</option>
                {availableTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          )}
          {availableSources.length > 1 && (
            <label className="text-muted-foreground flex items-center gap-1">
              source:
              <select
                value={sourceFilter}
                onChange={e => setSourceFilter(e.target.value)}
                className="px-2 py-1 bg-card border border-border text-foreground"
              >
                <option value="all">all</option>
                {availableSources.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground">
            {filteredHookEvents.length} / {hookEvents.length} events
          </span>
        </div>
      )}
      {useFallback ? (
        <ol className="relative border-l border-border ml-3 space-y-3">
          {fallback.map(e => (
            <li key={e.id} className="pl-4 relative">
              <span className="absolute -left-[5px] top-1.5 w-2 h-2 bg-foreground/60" />
              <div className="text-xs text-muted-foreground">{formatAbsolute(e.at)}</div>
              <div className="text-sm text-foreground">{e.label}</div>
              {e.sub && <div className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap line-clamp-3">{e.sub}</div>}
            </li>
          ))}
        </ol>
      ) : filteredHookEvents.length === 0 ? (
        <EmptyBox icon={<HistoryIcon className="w-8 h-8" />} text="No events match the active filters." />
      ) : (
        <ol className="relative border-l border-border ml-3 space-y-3">
          {filteredHookEvents.map(ev => <HookEventRow key={ev.id} event={ev} />)}
        </ol>
      )}
    </div>
  );
}

/** A single HookEvent line on the unified timeline. */
function HookEventRow({ event }: { event: HookEvent }) {
  // Different families get a different left-rail tint so the operator can
  // visually skim: rate-limit/resume are yellow, github is blue, approval is
  // amber, improvement is purple. The severity badge is rendered separately.
  const familyColor =
    event.type.startsWith('rate_limit') || event.type.startsWith('resume_') ? 'bg-yellow-500'
    : event.type.startsWith('github_')                                       ? 'bg-blue-500'
    : event.type.startsWith('approval_')                                     ? 'bg-amber-500'
    : event.type.startsWith('improvement_') || event.type === 'kanban_task_created' ? 'bg-purple-500'
    : event.type.startsWith('ci_')                                            ? 'bg-rose-500'
    : event.type.startsWith('agent_session_')                                 ? 'bg-cyan-500'
    : event.severity === 'error'                                              ? 'bg-rose-500'
    : event.severity === 'warning'                                            ? 'bg-amber-500'
    : 'bg-foreground/60';

  return (
    <li className="pl-4 relative">
      <span className={`absolute -left-[5px] top-1.5 w-2 h-2 ${familyColor}`} />
      <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
        <span>{formatAbsolute(event.createdAt)}</span>
        <span
          className={`inline-flex items-center px-1.5 py-0 text-[10px] border ${HOOK_EVENT_SEVERITY_BADGE[event.severity]}`}
          title={`severity: ${event.severity}`}
        >
          {event.severity}
        </span>
        <code className="font-mono text-[10px] text-muted-foreground/80">{event.type}</code>
        <span className="text-muted-foreground/60">·</span>
        <code className="font-mono text-[10px] text-muted-foreground/80">{event.source}</code>
        {event.agentId && (
          <>
            <span className="text-muted-foreground/60">·</span>
            <code className="font-mono text-[10px]">{event.agentId}</code>
          </>
        )}
        {event.runStepId && (
          <>
            <span className="text-muted-foreground/60">·</span>
            <span title={event.runStepId}>step {event.runStepId.slice(0, 8)}</span>
          </>
        )}
        {event.agentSessionId && (
          <>
            <span className="text-muted-foreground/60">·</span>
            <span title={event.agentSessionId}>session {event.agentSessionId.slice(0, 8)}</span>
          </>
        )}
      </div>
      <div className="text-sm text-foreground break-words">{event.title}</div>
      {event.summary && (
        <div className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap line-clamp-3">
          {event.summary}
        </div>
      )}
    </li>
  );
}

/* ============================================================================
 * Phase 6-A — Diagnostics tab
 *
 * Lightweight wrapper around DiagnosticCard. Shows open / high counts at the
 * top, then the same expandable card UI used on /diagnostics so the operator
 * has a single mental model. Empty state surfaces a helpful pointer to
 * /diagnostics for cross-Run triage.
 * ========================================================================== */

function DiagnosticsTab({
  diagnostics,
  onRefresh,
}: {
  diagnostics: Diagnostic[];
  onRefresh: () => Promise<void>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const counts = useMemo(() => {
    let open = 0, highOrCritical = 0;
    for (const d of diagnostics) {
      if (d.status === 'open') open++;
      if (d.severity === 'high' || d.severity === 'critical') highOrCritical++;
    }
    return { open, highOrCritical };
  }, [diagnostics]);

  if (diagnostics.length === 0) {
    return (
      <EmptyBox
        icon={<Stethoscope className="w-8 h-8" />}
        text="No diagnostics for this Run yet."
      />
    );
  }

  const onUpdateStatus = async (id: string, status: DiagnosticStatus) => {
    setBusyId(id);
    try {
      await dorothyRunsClient.diagnostics.updateStatus({ id, status });
      await onRefresh();
    } finally {
      setBusyId(null);
    }
  };

  const onConvert = async (d: Diagnostic) => {
    if (typeof window !== 'undefined' && !window.confirm(`Convert "${d.title}" to an ImprovementSignal?`)) return;
    setBusyId(d.id);
    try {
      await dorothyRunsClient.diagnostics.convertToImprovement({ id: d.id });
      await onRefresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="inline-flex items-center px-2 py-0.5 bg-blue-500/10 text-blue-500 border border-blue-500/30">
          {counts.open} open
        </span>
        {counts.highOrCritical > 0 && (
          <span className="inline-flex items-center px-2 py-0.5 bg-orange-500/10 text-orange-500 border border-orange-500/30">
            {counts.highOrCritical} high/critical
          </span>
        )}
        <Link
          href="/diagnostics"
          className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          Open /diagnostics →
        </Link>
      </div>
      <ul className="space-y-2">
        {diagnostics.map(d => (
          <DiagnosticCard
            key={d.id}
            diagnostic={d}
            expanded={expandedId === d.id}
            busy={busyId === d.id}
            onToggle={() => setExpandedId(expandedId === d.id ? null : d.id)}
            onUpdateStatus={onUpdateStatus}
            onConvert={onConvert}
          />
        ))}
      </ul>
    </div>
  );
}

/* ============================================================================
 * Phase 6-B — Agent Workflow tab
 *
 * One card per (RunStep × Agent) workflow row. The progress bar + checklist
 * are derived from the template-materialised `steps` array on each row.
 * "Recompute" rebuilds the per-Run rows from HookEvents (idempotent).
 * ========================================================================== */

function DispatchReadinessPanel({ runId }: { runId: string }) {
  const { readiness, counts } = useDorothyDispatchReadinessByRun(runId);
  const nextRunnable = readiness.find(r => r.ready);
  const blocked = readiness.filter(r => !r.ready && r.reason);
  return (
    <div className="p-3 bg-card border border-border rounded">
      <div className="flex items-center gap-2 mb-2 text-xs">
        <CircleDot className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="font-semibold text-foreground">자동 실행 준비</span>
        <span className="text-emerald-500">{counts.ready} 실행 가능</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-orange-500">{counts.blocked} 차단</span>
        <span className="text-[10px] text-muted-foreground ml-auto">dry-run — 이 화면은 에이전트를 실행하지 않습니다</span>
      </div>
      {nextRunnable && (
        <p className="text-[11px] text-emerald-500 mb-1">
          다음 실행 가능 에이전트: <span className="font-mono">{processDisplayName(nextRunnable.agentId, nextRunnable.agentId)}</span>
        </p>
      )}
      {readiness.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">이 Run에 대기 중인 에이전트가 없습니다.</p>
      ) : (
        <ul className="space-y-1">
          {readiness.map(r => (
            <li key={`${r.agentId}-${r.runStepId ?? 'none'}`} className="flex items-start gap-2 text-[11px]">
              <span className={`px-1.5 py-px border rounded shrink-0 ${r.ready ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' : 'bg-orange-500/10 text-orange-500 border-orange-500/30'}`}>
                {r.ready ? '실행 가능' : (r.reason ? DISPATCH_BLOCKER_KO[r.reason] : '차단')}
              </span>
              <span className="font-mono text-foreground shrink-0">{processDisplayName(r.agentId, r.agentId)}</span>
              <span className="text-muted-foreground">{r.summary}</span>
            </li>
          ))}
        </ul>
      )}
      {blocked.some(b => b.reason === 'handoff_missing') && (
        <p className="text-[10px] text-muted-foreground mt-1">인계 문서 없음 — Communication 탭에서 마지막 인계를 확인하세요.</p>
      )}
      {blocked.some(b => b.reason === 'approval_required') && (
        <p className="text-[10px] text-muted-foreground mt-1">승인 필요 — <a href="/approvals" className="text-primary hover:underline">/approvals</a>.</p>
      )}
      {blocked.some(b => b.reason === 'rate_limited') && (
        <p className="text-[10px] text-muted-foreground mt-1">사용량 제한 — <a href="/usage" className="text-primary hover:underline">/usage</a>.</p>
      )}
    </div>
  );
}

function AgentWorkflowTab({
  runId,
  rows,
  onRefresh,
}: {
  runId: string;
  rows: AgentWorkflowProgress[];
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const onRecompute = async () => {
    if (typeof window !== 'undefined' && !window.confirm(
      'Recompute Agent Workflow progress from HookEvents?\n\n' +
      'This rebuilds every workflow row on this Run from scratch and overwrites their step states.',
    )) return;
    setBusy(true);
    try {
      await dorothyRunsClient.workflowProgress.recomputeByRun(runId);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Agent Workflow</h2>
          <button
            disabled={busy}
            onClick={onRecompute}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} /> Recompute
          </button>
        </div>
        <EmptyBox icon={<Workflow className="w-8 h-8" />} text="No workflow progress recorded yet." />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Workflow className="w-3 h-3" />
          <span>{rows.length} agent workflow{rows.length === 1 ? '' : 's'} tracked</span>
        </div>
        <button
          disabled={busy}
          onClick={onRecompute}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50"
          title="Rebuild every workflow row on this Run from HookEvents"
        >
          <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} /> Recompute
        </button>
      </div>
      <ul className="space-y-3">
        {rows.map(row => <AgentWorkflowCard key={row.id} row={row} />)}
      </ul>
    </div>
  );
}

function AgentWorkflowCard({ row }: { row: AgentWorkflowProgress }) {
  return (
    <li className="bg-card border border-border">
      <div className="p-3 flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className={`inline-flex items-center px-2 py-0.5 font-medium border ${WORKFLOW_STATUS_BADGE[row.status]}`}>
              {row.status.replace(/_/g, ' ')}
            </span>
            <span className="inline-flex items-center px-2 py-0.5 bg-muted text-muted-foreground border border-border">
              {WORKFLOW_KIND_LABEL[row.workflowKind]}
            </span>
            <span className="text-muted-foreground">·</span>
            <code className="font-mono text-[11px] text-muted-foreground">{row.agentId}</code>
            {row.agentSessionId && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-[11px] text-muted-foreground">session {row.agentSessionId.slice(0, 8)}</span>
              </>
            )}
            {row.runStepId && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-[11px] text-muted-foreground">step {row.runStepId.slice(0, 8)}</span>
              </>
            )}
            <span className="ml-auto text-muted-foreground" title={formatAbsolute(row.updatedAt)}>
              {formatRelative(row.updatedAt)}
            </span>
          </div>
          <div className="mt-1 text-sm text-foreground">
            <span className="font-medium">{row.currentStepLabel ?? 'Idle'}</span>
            <span className="text-muted-foreground ml-2">— {row.progressPercent}%</span>
          </div>
          {(row.blockedReason || row.failedReason || row.stalledReason) && (
            <div className="mt-1 text-[11px] text-amber-500">
              {row.failedReason && <span>failed: {row.failedReason}</span>}
              {row.blockedReason && <span>{row.failedReason ? ' · ' : ''}blocked: {row.blockedReason}</span>}
              {row.stalledReason && <span>{(row.failedReason || row.blockedReason) ? ' · ' : ''}stalled: {row.stalledReason}</span>}
            </div>
          )}
        </div>
      </div>
      {/* Progress bar */}
      <div className="px-3">
        <div className="h-1.5 w-full bg-muted relative overflow-hidden">
          <div
            className={`absolute inset-y-0 left-0 ${
              row.status === 'failed' ? 'bg-rose-500'
              : row.status === 'blocked' ? 'bg-yellow-500'
              : row.status === 'stalled' ? 'bg-amber-500'
              : row.status === 'completed' ? 'bg-emerald-700'
              : 'bg-emerald-500'
            }`}
            style={{ width: `${Math.min(100, Math.max(0, row.progressPercent))}%` }}
          />
        </div>
      </div>
      {/* Step checklist */}
      <ul className="px-3 pb-3 mt-3 space-y-1.5">
        {row.steps.map(step => <WorkflowStepRow key={step.stepId} step={step} />)}
      </ul>
    </li>
  );
}

function WorkflowStepRow({ step }: { step: AgentWorkflowStepProgress }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <span className="mt-0.5 shrink-0">
        {step.status === 'completed' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
         : step.status === 'failed'  ? <XCircle className="w-3.5 h-3.5 text-rose-500" />
         : step.status === 'in_progress' ? <CircleDot className="w-3.5 h-3.5 text-emerald-500 animate-pulse" />
         : <CircleDot className="w-3.5 h-3.5 text-muted-foreground/40" />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center px-1.5 py-0 text-[10px] border ${WORKFLOW_STEP_STATUS_BADGE[step.status]}`}>
            {step.status.replace(/_/g, ' ')}
          </span>
          <span className="text-foreground">{step.label}</span>
          <code className="font-mono text-[10px] text-muted-foreground">{step.stepId}</code>
        </div>
        {step.note && (
          <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{step.note}</div>
        )}
        {((step.evidenceHookEventIds?.length ?? 0) + (step.evidenceArtifactIds?.length ?? 0) + (step.evidenceHandoffIds?.length ?? 0)) > 0 && (
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {step.evidenceHookEventIds && step.evidenceHookEventIds.length > 0 && (
              <span>hooks: {step.evidenceHookEventIds.slice(0, 3).map(id => id.slice(0, 8)).join(', ')}{step.evidenceHookEventIds.length > 3 ? ` +${step.evidenceHookEventIds.length - 3}` : ''}</span>
            )}
            {step.evidenceArtifactIds && step.evidenceArtifactIds.length > 0 && (
              <span> · artifacts: {step.evidenceArtifactIds.slice(0, 3).map(id => id.slice(0, 8)).join(', ')}{step.evidenceArtifactIds.length > 3 ? ` +${step.evidenceArtifactIds.length - 3}` : ''}</span>
            )}
            {step.evidenceHandoffIds && step.evidenceHandoffIds.length > 0 && (
              <span> · handoffs: {step.evidenceHandoffIds.slice(0, 3).map(id => id.slice(0, 8)).join(', ')}{step.evidenceHandoffIds.length > 3 ? ` +${step.evidenceHandoffIds.length - 3}` : ''}</span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/* ============================================================================
 * Phase 6-D — Skill Candidates tab
 *
 * Read-only Run-scoped view of SkillCandidate rows. The full triage surface
 * lives at /skill-candidates; this tab is a "what's queued for review on
 * this Run" lens.
 * ========================================================================== */

function SkillCandidatesTab({ candidates }: { candidates: SkillCandidate[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const counts = useMemo(() => {
    let open = 0, ready = 0;
    for (const c of candidates) {
      if (c.status === 'open') open++;
      if (c.status === 'ready_for_registry') ready++;
    }
    return { open, ready };
  }, [candidates]);

  if (candidates.length === 0) {
    return (
      <EmptyBox icon={<Layers className="w-8 h-8" />} text="No skill candidates for this Run yet." />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="inline-flex items-center px-2 py-0.5 bg-blue-500/10 text-blue-500 border border-blue-500/30">
          {counts.open} open
        </span>
        {counts.ready > 0 && (
          <span className="inline-flex items-center px-2 py-0.5 bg-emerald-500/10 text-emerald-500 border border-emerald-500/30">
            {counts.ready} ready
          </span>
        )}
        <Link
          href="/skill-candidates"
          className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          Open /skill-candidates →
        </Link>
      </div>
      <ul className="space-y-2">
        {candidates.map(c => (
          <SkillCandidateCard
            key={c.id}
            candidate={c}
            expanded={expandedId === c.id}
            onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
          />
        ))}
      </ul>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={`text-left font-medium px-3 py-2 ${className ?? ''}`}>{children}</th>;
}
function Td({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <td className={`px-3 py-2 ${className ?? ''}`} title={title}>{children}</td>;
}
function Time({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="text-xs text-muted-foreground" title={formatAbsolute(iso)}>
      {formatRelative(iso)}
    </span>
  );
}
function EmptyBox({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="border border-dashed border-border py-12 px-6 flex flex-col items-center text-center text-muted-foreground">
      <div className="opacity-50 mb-3">{icon}</div>
      <p className="text-sm">{text}</p>
    </div>
  );
}

// Re-import ShieldCheck so it doesn't get tree-shaken — reserved for the
// upcoming Approval History tab in Phase 4.
void ShieldCheck;

/**
 * MVP Phase 4.5 — until a dedicated AgentWorkflowProgress model exists, we
 * synthesize a coarse "current workflow phase" string from Run.state + the
 * agentId of the most recently active RunStep. When neither is known, we
 * show "Not tracked yet" so the slot is visibly populated.
 *
 * TODO Phase 5/6 — replace with a real per-agent progress feed.
 */
function derivedWorkflowPhase({
  run,
  steps,
}: {
  run: Run;
  steps: RunStep[];
}): string {
  if (!steps.length) {
    return run.state === 'created' || run.state === 'planned'
      ? `${run.state} (no steps yet)`
      : 'Not tracked yet';
  }
  const inFlight = steps.find(s => s.state === 'running' || s.state === 'pending');
  const latest = inFlight ?? steps[steps.length - 1];
  const verb = latest.state === 'running' ? 'running'
             : latest.state === 'pending' ? 'queued'
             : latest.state === 'failed'  ? 'failed'
             : 'last';
  return `${verb}: ${latest.agentId} (run.state=${run.state})`;
}
