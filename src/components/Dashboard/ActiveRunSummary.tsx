'use client';

/**
 * Active Run Summary — Command Center widget surfacing live counters from
 * the new Dorothy MVP Run model. Mounted *alongside* the existing Dashboard
 * (we do not replace anything).
 *
 * Empty / dbUnavailable states render the widget with zeros so a fresh
 * install never blows up; a small banner explains why everything is zero.
 */

import Link from 'next/link';
import {
  Activity,
  AlertOctagon,
  ShieldAlert,
  Cpu,
  Hourglass,
  AlertCircle,
  GitPullRequest,
  XCircle,
  Stethoscope,
  Workflow,
} from 'lucide-react';
import {
  useActiveRunSummary,
  useDorothyPullRequestSummary,
  useDorothyCIRunSummary,
  useDorothyScheduledRateLimits,
  useDorothyRuns,
  useDorothyRecentHookEvents,
  useDorothyDiagnosticCounts,
  useDorothyWorkflowProgressCounts,
  useDorothyAgentIdleStatuses,
} from '@/hooks/useDorothyRuns';
import {
  RUN_MODE_BADGE,
  HOOK_EVENT_SEVERITY_BADGE,
  type RunMode,
  type HookEvent,
} from '@/types/dorothy';
import { useMemo } from 'react';

interface MetricProps {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  href?: string;
  hint?: string;
}

function Metric({ label, value, icon: Icon, color, href, hint }: MetricProps) {
  const card = (
    <div className="bg-card border border-border p-4 hover:border-foreground/30 transition-colors h-full">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <div className="text-2xl font-semibold text-foreground tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
  return href ? <Link href={href}>{card}</Link> : card;
}

export default function ActiveRunSummary() {
  const { summary, isLoading } = useActiveRunSummary();
  // Phase 5B — pull PR + CI rollups in here. Each hook polls on its own
  // 15s cadence; the cost is one extra IPC pair per Dashboard mount.
  const { summary: prSummary } = useDorothyPullRequestSummary();
  const { summary: ciSummary } = useDorothyCIRunSummary();
  // Phase 5C-B — scheduled / overdue / failed resume counts shown inside the
  // existing Rate-limited card.
  const { counts: resumeCounts } = useDorothyScheduledRateLimits();
  // Phase 5D — RunMode rollup as a footer row (no extra card so the grid
  // stays at 7 columns wide).
  const { runs: allRuns } = useDorothyRuns({ limit: 500 });
  const modeCounts = useMemo(() => {
    const counts: Record<RunMode | 'unset', number> = {
      team: 0, persistent: 0, ultraqa: 0, pipeline: 0, manual: 0, unset: 0,
    };
    for (const r of allRuns) {
      const m = (r.mode ?? null) as RunMode | null;
      if (m && m in counts) counts[m]++;
      else counts.unset++;
    }
    return counts;
  }, [allRuns]);
  const modeOrder: Array<RunMode | 'unset'> = ['team', 'persistent', 'ultraqa', 'pipeline', 'manual', 'unset'];

  return (
    <section aria-label="Active Run Summary" className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
          Active Runs
        </h2>
        <Link href="/runs" className="text-xs text-muted-foreground hover:text-foreground">
          Open Run Board →
        </Link>
      </div>

      {summary.dbUnavailable && (
        <div className="mb-3 p-3 border border-amber-500/30 bg-amber-500/5 text-amber-500 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          Dorothy run database is not available yet — counters will populate once Runs are recorded.
        </div>
      )}

      {/* 5 existing cards + 2 Phase 5B additions = 7. We bump the breakpoint
          so the row stays readable on wide screens; narrow viewports wrap to
          2-per-row as before. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <Metric
          label="Active"
          value={summary.activeRuns}
          icon={Activity}
          color="text-emerald-500"
          href="/runs"
          hint="running / verifying / reporting"
        />
        <Metric
          label="Blocked"
          value={summary.blockedRuns}
          icon={AlertOctagon}
          color="text-yellow-500"
          href="/runs"
          hint="awaiting external input"
        />
        <Metric
          label="Approval"
          value={summary.approvalRequiredRuns}
          icon={ShieldAlert}
          color="text-amber-500"
          href="/approvals"
          hint="user decision needed"
        />
        <Metric
          label="Sessions"
          value={summary.activeSessions}
          icon={Cpu}
          color="text-emerald-500"
          href="/sessions"
          hint="live agent PTYs"
        />
        <Metric
          label="Rate-limited"
          value={summary.rateLimitedSessions}
          icon={Hourglass}
          color="text-orange-500"
          href="/usage"
          hint={
            // Phase 5C-B — surface scheduler health inline so the operator
            // sees "X scheduled / Y overdue / Z failed" without leaving the
            // Command Center.
            (resumeCounts.scheduled || resumeCounts.overdue || resumeCounts.failed)
              ? `${resumeCounts.scheduled} scheduled · ${resumeCounts.overdue} overdue · ${resumeCounts.failed} failed`
              : 'cooldown in progress'
          }
        />
        <Metric
          label="Open PRs"
          value={prSummary.open + prSummary.draft + prSummary.review + prSummary.changesRequested}
          icon={GitPullRequest}
          color="text-blue-500"
          href="/pr"
          hint="draft / open / review / changes"
        />
        <Metric
          label="Failed CI"
          value={ciSummary.failed}
          icon={XCircle}
          color="text-rose-500"
          href="/pr"
          hint="failures from github_actions"
        />
      </div>

      {/* Phase 5D — Run mode rollup row. Compact chips so the existing 7-card
          grid above stays the primary view. */}
      <div className="mt-3 flex items-center gap-2 flex-wrap text-[11px]">
        <span className="uppercase tracking-wider text-muted-foreground">Run modes:</span>
        {modeOrder.map(m => {
          const count = modeCounts[m] ?? 0;
          if (count === 0 && m !== 'team') return null;
          const cls = m === 'unset'
            ? 'bg-muted text-muted-foreground border-border'
            : RUN_MODE_BADGE[m];
          return (
            <Link
              key={m}
              href="/runs"
              className={`inline-flex items-center gap-1 px-2 py-0.5 border ${cls} hover:opacity-90`}
              title={m === 'unset' ? 'Runs predating the RunMode field — display only.' : `${m} mode`}
            >
              {m}: <span className="tabular-nums">{count}</span>
            </Link>
          );
        })}
      </div>

      {isLoading && (
        <div className="text-[11px] text-muted-foreground mt-2">refreshing…</div>
      )}

      {/* Phase 6-A — Diagnostics compact row. */}
      <DiagnosticsCompactRow />

      {/* Phase 6-B — Agent Workflow compact row. */}
      <WorkflowCompactRow />

      {/* Phase 6-E — Agent idle reason compact row. */}
      <AgentIdleCompactRow />

      {/* Phase 5F — Recent HookEvent strip. Read-only signal of the latest
          interesting runtime occurrences (error / warning / rate limit /
          approval / ci_failed / improvement). */}
      <RecentHookEvents />
    </section>
  );
}

/* ============================================================================
 * Phase 6-A — Diagnostics compact row
 *
 * Tiny strip just below the mode chips and just above RecentHookEvents.
 * Surfaces open / critical Diagnostic counts so the operator can spot active
 * problems without leaving the Command Center.
 * ========================================================================== */

/* ============================================================================
 * Phase 6-E — Agent idle reason compact row
 *
 * Surfaces why agents aren't working right now: active / idle / blocked /
 * rate-limited / waiting-approval / waiting-dependency. Built from the
 * dorothy:agentIdle:list feed.
 * ========================================================================== */

function AgentIdleCompactRow() {
  const { statuses, dbUnavailable } = useDorothyAgentIdleStatuses();
  const counts = useMemo(() => {
    const c = {
      active: 0,
      idle: 0,
      blocked: 0,
      rateLimited: 0,
      waitingApproval: 0,
      waitingDependency: 0,
    };
    for (const s of statuses) {
      switch (s.reason) {
        case 'active': c.active++; break;
        case 'no_assigned_runstep': case 'completed': case 'unknown': c.idle++; break;
        case 'blocked_by_runmode_policy': case 'orchestrator_autospawn_disabled': c.blocked++; break;
        case 'blocked_by_rate_limit': case 'auto_resume_dry_run': c.rateLimited++; break;
        case 'waiting_for_approval': c.waitingApproval++; break;
        case 'waiting_for_dependency': case 'waiting_for_handoff': case 'waiting_for_validation': c.waitingDependency++; break;
        default: break;
      }
    }
    return c;
  }, [statuses]);

  if (dbUnavailable || statuses.length === 0) return null;

  const chips: Array<{ label: string; value: number; cls: string }> = [
    { label: 'active',        value: counts.active,            cls: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' },
    { label: 'idle',          value: counts.idle,              cls: 'bg-muted text-muted-foreground border-border' },
    { label: 'blocked',       value: counts.blocked,           cls: 'bg-orange-500/10 text-orange-500 border-orange-500/30' },
    { label: 'rate-limited',  value: counts.rateLimited,       cls: 'bg-rose-500/10 text-rose-500 border-rose-500/30' },
    { label: 'wait approval', value: counts.waitingApproval,   cls: 'bg-amber-500/10 text-amber-500 border-amber-500/30' },
    { label: 'wait dep',      value: counts.waitingDependency, cls: 'bg-blue-500/10 text-blue-500 border-blue-500/30' },
  ];

  return (
    <div className="mt-3 flex items-center gap-2 flex-wrap text-[11px]">
      <span className="uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1">
        <Cpu className="w-3 h-3" /> Agents:
      </span>
      {chips.map(chip => (
        <Link
          key={chip.label}
          href="/agents"
          className={`inline-flex items-center gap-1 px-2 py-0.5 border hover:opacity-90 ${chip.cls}`}
        >
          {chip.label}: <span className="tabular-nums">{chip.value}</span>
        </Link>
      ))}
    </div>
  );
}

function DiagnosticsCompactRow() {
  const { counts, dbUnavailable } = useDorothyDiagnosticCounts();
  if (dbUnavailable) return null;
  if (counts.total === 0) {
    return (
      <div className="mt-3 text-[11px] text-muted-foreground flex items-center gap-2">
        <Stethoscope className="w-3 h-3" />
        <span>No active diagnostics.</span>
        <Link href="/diagnostics" className="ml-auto hover:text-foreground">Open /diagnostics →</Link>
      </div>
    );
  }
  return (
    <div className="mt-3 flex items-center gap-2 flex-wrap text-[11px]">
      <span className="uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1">
        <Stethoscope className="w-3 h-3" /> Diagnostics:
      </span>
      <Link
        href="/diagnostics"
        className="inline-flex items-center gap-1 px-2 py-0.5 border bg-blue-500/10 text-blue-500 border-blue-500/30 hover:opacity-90"
      >
        open: <span className="tabular-nums">{counts.open}</span>
      </Link>
      <Link
        href="/diagnostics"
        className={`inline-flex items-center gap-1 px-2 py-0.5 border hover:opacity-90 ${
          counts.highOrCritical > 0
            ? 'bg-orange-500/10 text-orange-500 border-orange-500/30'
            : 'bg-muted text-muted-foreground border-border'
        }`}
      >
        high/critical: <span className="tabular-nums">{counts.highOrCritical}</span>
      </Link>
      {counts.critical > 0 && (
        <Link
          href="/diagnostics"
          className="inline-flex items-center gap-1 px-2 py-0.5 border bg-rose-500/10 text-rose-500 border-rose-500/30 hover:opacity-90"
        >
          critical: <span className="tabular-nums">{counts.critical}</span>
        </Link>
      )}
      <Link href="/diagnostics" className="ml-auto text-muted-foreground hover:text-foreground">
        Open /diagnostics →
      </Link>
    </div>
  );
}

/* ============================================================================
 * Phase 5F — Recent HookEvents strip
 *
 * Filters the hook event bus down to the noise-worthy types so the Command
 * Center surfaces what an operator actually needs to see at a glance.
 * Failures (dbUnavailable / empty / IPC errors) render an empty state.
 * ========================================================================== */

const RECENT_EVENT_TYPES = [
  'rate_limit_detected',
  'approval_required',
  'ci_failed',
  'improvement_signal_created',
  'run_step_failed',
  'agent_session_failed',
  'resume_failed',
  'github_comment_gate',
  'github_review_event',
] as const;

/* ============================================================================
 * Phase 6-B — Agent Workflow compact row
 *
 * Mirrors the Diagnostics row: a tiny strip with chip-level counts so the
 * operator can spot active/blocked/failed/stalled workflows without leaving
 * the Command Center.
 * ========================================================================== */

function WorkflowCompactRow() {
  const { counts, dbUnavailable } = useDorothyWorkflowProgressCounts();
  if (dbUnavailable) return null;
  if (counts.total === 0) {
    return (
      <div className="mt-3 text-[11px] text-muted-foreground flex items-center gap-2">
        <Workflow className="w-3 h-3" />
        <span>No agent workflows tracked yet.</span>
        <Link href="/runs" className="ml-auto hover:text-foreground">Open Run Board →</Link>
      </div>
    );
  }
  return (
    <div className="mt-3 flex items-center gap-2 flex-wrap text-[11px]">
      <span className="uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1">
        <Workflow className="w-3 h-3" /> Agent workflows:
      </span>
      <span className="inline-flex items-center gap-1 px-2 py-0.5 border bg-emerald-500/10 text-emerald-500 border-emerald-500/30">
        active: <span className="tabular-nums">{counts.active}</span>
      </span>
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 border ${
          counts.blocked > 0
            ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
            : 'bg-muted text-muted-foreground border-border'
        }`}
      >
        blocked: <span className="tabular-nums">{counts.blocked}</span>
      </span>
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 border ${
          counts.failed > 0
            ? 'bg-rose-500/10 text-rose-500 border-rose-500/30'
            : 'bg-muted text-muted-foreground border-border'
        }`}
      >
        failed: <span className="tabular-nums">{counts.failed}</span>
      </span>
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 border ${
          counts.stalled > 0
            ? 'bg-amber-500/10 text-amber-500 border-amber-500/30'
            : 'bg-muted text-muted-foreground border-border'
        }`}
      >
        stalled: <span className="tabular-nums">{counts.stalled}</span>
      </span>
      <span className="inline-flex items-center gap-1 px-2 py-0.5 border bg-emerald-700/15 text-emerald-700 border-emerald-700/30">
        completed: <span className="tabular-nums">{counts.completed}</span>
      </span>
      <Link href="/runs" className="ml-auto text-muted-foreground hover:text-foreground">
        Open Run Board →
      </Link>
    </div>
  );
}

function RecentHookEvents() {
  const { events, isLoading, dbUnavailable } = useDorothyRecentHookEvents({
    severity: ['warning', 'error'],
    limit: 50,
  });

  // Further narrow to the type whitelist so a noisy `agent_session_output`
  // warning doesn't crowd out the headline signals.
  const filtered = useMemo<HookEvent[]>(() => {
    const wl = new Set<string>(RECENT_EVENT_TYPES);
    return events.filter(e => wl.has(e.type)).slice(0, 8);
  }, [events]);

  if (dbUnavailable) {
    // The IPC bridge couldn't fetch — silently hide to avoid double-banner
    // noise (the wider dbUnavailable banner above already covered this).
    return null;
  }

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wider text-muted-foreground">
          Recent runtime events
        </h3>
        <Link href="/improvements" className="text-[11px] text-muted-foreground hover:text-foreground">
          Open Improvements →
        </Link>
      </div>
      {filtered.length === 0 ? (
        <div className="border border-dashed border-border p-3 text-[11px] text-muted-foreground text-center">
          {isLoading ? 'Loading recent events…' : 'No notable events in the last refresh.'}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {filtered.map(ev => (
            <li
              key={ev.id}
              className="bg-card border border-border px-3 py-2 flex items-center gap-2 flex-wrap text-xs"
            >
              <span
                className={`inline-flex items-center px-1.5 py-0 text-[10px] border ${HOOK_EVENT_SEVERITY_BADGE[ev.severity]}`}
              >
                {ev.severity}
              </span>
              <code className="font-mono text-[10px] text-muted-foreground">{ev.type}</code>
              <span className="text-foreground break-words flex-1 min-w-0">{ev.title}</span>
              {ev.runId && (
                <Link
                  href={`/runs/${ev.runId}`}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  run {ev.runId.slice(0, 8)}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
