'use client';

/**
 * Agent Sessions (/sessions) — phase-2 read-only table of AgentSession rows.
 *
 * Filters: status (active / completed / failed / cancelled / timeout / all),
 * agentId, provider, runId. Clicking a row navigates to /runs/[runId] when
 * the session has one, otherwise it's a no-op (we still show the session
 * because PM-tick / external CLI launches can have no Run yet).
 *
 * Note: this does NOT replace /agents — that page still shows live
 * AgentStatus from agents.json. /sessions is the historical view backed by
 * dorothy.db, surfaced for Phase 2 visibility.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ExternalLink, Inbox, PlayCircle, RefreshCw, Search, Hourglass, Eye } from 'lucide-react';
import AgentTerminalPanel from '@/components/AgentTerminalPanel';
import {
  useDorothySessions,
  useDorothyScheduledRateLimits,
  useDorothyWorkflowProgress,
  useDorothyAgentIdleStatuses,
  useDorothyDispatchReadiness,
  useDorothyStaleSessionFlags,
  useDorothyAgentTerminalSnapshots,
  useDorothyPmTickStatus,
} from '@/hooks/useDorothyRuns';
import { dorothyRunsClient } from '@/lib/dorothyRunsClient';
import { processDisplayName } from '@/lib/agentProcessDisplay';
import { IDLE_REASON_KO, DISPATCH_BLOCKER_KO, UI_KO, AGENT_STATUS_KO } from '@/lib/koreanLabels';
import type {
  AgentSession,
  AgentSessionEndStatus,
  RateLimitEvent,
  AgentWorkflowProgress,
  AgentIdleStatus,
  AgentDispatchReadiness,
  StaleSessionFlag,
} from '@/types/dorothy';
import {
  WORKFLOW_STATUS_BADGE,
  IDLE_REASON_BADGE,
} from '@/types/dorothy';
import {
  SessionStatusBadge,
  formatRelative,
  formatAbsolute,
  durationBetween,
} from '@/components/RunCommon/badges';

type StatusFilter = 'all' | 'active' | AgentSessionEndStatus;

const PAGE_LIMIT = 200;

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all',       label: '전체' },
  { id: 'active',    label: '활성' },
  { id: 'completed', label: '완료' },
  { id: 'failed',    label: '실패' },
  { id: 'cancelled', label: '취소됨' },
  { id: 'timeout',   label: '타임아웃' },
];

export default function SessionList() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [agentFilter, setAgentFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [runIdFilter, setRunIdFilter] = useState('');
  const [query, setQuery] = useState('');
  // Phase 6-AE — read-only terminal attach for a selected session's agent.
  const [viewAgentId, setViewAgentId] = useState<string | null>(null);

  // Phase 6-AE — live PTY agent snapshots (read-only, masked, ~3s) + PM-tick
  // status. These reflect the REAL execution layer (PM-tick → orchestrator →
  // electron PTY) which dorothy.db's agent_sessions does not currently mirror.
  const { snapshots: liveSnapshots } = useDorothyAgentTerminalSnapshots({ lines: 40 });
  const { latest: pmTickLatest, available: pmTickAvailable } = useDorothyPmTickStatus();
  const liveCount = liveSnapshots.filter(s => s.streamAvailable).length;

  // The IPC `active` flag short-circuits a WHERE; everything else is filtered
  // client-side. With PAGE_LIMIT this is fast and avoids cycling more IPC.
  const { sessions, isLoading, error, dbUnavailable, refresh } = useDorothySessions({
    active: statusFilter === 'active' ? true : undefined,
    runId: runIdFilter.trim() || undefined,
    agentId: agentFilter.trim() || undefined,
    limit: PAGE_LIMIT,
  });

  // Phase 5C-B — overlay scheduler info onto each AgentSession row.
  const { events: scheduledEvents, counts: resumeCounts } = useDorothyScheduledRateLimits();
  const resumeBySession = useMemo(() => {
    const map = new Map<string, RateLimitEvent>();
    for (const e of scheduledEvents) {
      for (const sid of e.affectedSessionIds ?? []) {
        // Prefer scheduled / resuming over already-resumed entries for the
        // overlay — the user usually wants to see the *next* scheduled one.
        const prev = map.get(sid);
        if (!prev || prev.resumeStatus === 'resumed') map.set(sid, e);
      }
    }
    return map;
  }, [scheduledEvents]);

  // Phase 6-B — overlay workflow progress onto each session row. We pull a
  // capped slice and index by agentSessionId for O(1) lookup.
  const { rows: workflowRows } = useDorothyWorkflowProgress({ limit: 500 });
  const workflowBySession = useMemo(() => {
    const map = new Map<string, AgentWorkflowProgress>();
    for (const w of workflowRows) {
      if (!w.agentSessionId) continue;
      // Keep the most-recently-updated row when we see duplicates.
      const prev = map.get(w.agentSessionId);
      if (!prev || prev.updatedAt < w.updatedAt) map.set(w.agentSessionId, w);
    }
    return map;
  }, [workflowRows]);

  // Phase 6-E — overlay idle/waiting/rate-limit/auto-resume reason per agent.
  const { statuses: idleStatuses } = useDorothyAgentIdleStatuses();
  const idleByAgentKey = useMemo(() => {
    const norm = (id: string) => id.toLowerCase().replace(/[\s\-./]+/g, '_').replace(/^_+|_+$/g, '');
    const map = new Map<string, AgentIdleStatus>();
    for (const st of idleStatuses) map.set(norm(st.agentId), st);
    return map;
  }, [idleStatuses]);
  const idleFor = (agentId: string): AgentIdleStatus | undefined =>
    idleByAgentKey.get(agentId.toLowerCase().replace(/[\s\-./]+/g, '_').replace(/^_+|_+$/g, ''));

  // Phase 6-M — stale provider/model session flags (codex + opus).
  const { bySession: staleBySession } = useDorothyStaleSessionFlags();

  // Phase 6-J — dispatch readiness overlay per agent.
  const { byAgent: readinessByAgent } = useDorothyDispatchReadiness();
  const readinessFor = (agentId: string) => {
    const norm = (id: string) => id.toLowerCase().replace(/[\s\-./]+/g, '_').replace(/^_+|_+$/g, '');
    for (const [aid, r] of readinessByAgent) if (norm(aid) === norm(agentId)) return r;
    return undefined;
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter(s => {
      if (statusFilter !== 'all' && statusFilter !== 'active') {
        if (s.endStatus !== statusFilter) return false;
      }
      if (providerFilter && s.provider !== providerFilter) return false;
      if (q) {
        const hay =
          `${s.id} ${s.agentId} ${s.provider} ${s.runId ?? ''} ${s.runStepId ?? ''} ${s.worktreePath ?? ''}`
            .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [sessions, statusFilter, providerFilter, query]);

  const providerOptions = useMemo(() => {
    const set = new Set<string>();
    sessions.forEach(s => set.add(s.provider));
    return Array.from(set).sort();
  }, [sessions]);

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between gap-4 mb-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">에이전트 세션</h1>
            <p className="text-sm text-muted-foreground mt-1">
              <code className="font-mono">dorothy.db</code>에 저장된 PTY/CLI 세션.
              에이전트의 실시간 상태는 <Link href="/agents" className="underline">/agents</Link>에서 확인하세요.
            </p>
          </div>
          <button
            onClick={() => { void refresh(); }}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} /> 새로고침
          </button>
        </div>
        {/* Phase 5C-B — surface scheduler counters next to the filters so the
            operator can spot overdue / failed resumes immediately. */}
        {(resumeCounts.scheduled || resumeCounts.overdue || resumeCounts.failed) > 0 && (
          <div className="mb-2 text-xs text-muted-foreground">
            <Hourglass className="w-3 h-3 inline mr-1" />
            Auto Resume: {resumeCounts.scheduled} scheduled · {resumeCounts.overdue} overdue · {resumeCounts.failed} failed
            <span className="ml-2 italic">(see Settings → GitHub Webhook for mode)</span>
          </div>
        )}

        {/* Phase 6-AE — execution-layer note: the real fleet runs on PTY, not
            the dorothy.db Run/AgentSession model (which is not mirrored yet). */}
        <div className="mb-3 rounded-md border border-cyan-500/30 bg-cyan-500/5 px-3 py-2 text-xs text-muted-foreground">
          <p className="text-cyan-300 font-medium">실행 레이어 안내</p>
          <p className="mt-0.5">
            현재 자동개발은 <span className="font-mono">PM-tick → orchestrator → electron PTY</span> 경로로 실행됩니다.
            아래 <span className="text-foreground">라이브 에이전트 터미널 세션</span>은 실제 PTY 기반 라이브 상태(읽기 전용·마스킹)이며,
            <span className="font-mono"> dorothy.db</span>의 Run / AgentSession 미러는 아직 연결되지 않았습니다.
          </p>
          {pmTickAvailable && pmTickLatest && (
            <p className="mt-1">
              최근 PM-tick:{' '}
              <span className={`font-mono ${pmTickLatest.kind === 'ERROR' ? 'text-red-400' : pmTickLatest.kind === 'STARTED' ? 'text-green-400' : 'text-foreground'}`}>
                {pmTickLatest.kind}
              </span>{' '}
              <span className="text-muted-foreground/80">— {pmTickLatest.line}</span>
            </p>
          )}
        </div>

        {/* Phase 6-AE — Live Agent Terminal Sessions (PTY-based, always shown
            even when dorothy.db agent_sessions is empty). */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <PlayCircle className="w-4 h-4 text-green-400" />
            <h2 className="text-sm font-semibold text-foreground">{UI_KO.liveAgentTerminalSessions}</h2>
            <span className="text-[11px] text-muted-foreground">{UI_KO.ptyBased} · {liveSnapshots.length} {UI_KO.baseline} · {liveCount} {UI_KO.liveTerminal} · {UI_KO.readOnly}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {liveSnapshots.map(s => {
              const isLive = s.streamAvailable;
              const hasOut = s.outputLines.length > 0;
              return (
                <div key={s.agentId} className="rounded-md border border-border bg-card px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-green-400' : hasOut ? 'bg-cyan-400' : 'bg-muted-foreground/40'}`} />
                    <span className="text-xs font-medium text-foreground truncate">{s.processName ?? s.agentId}</span>
                    <span className="text-[10px] text-muted-foreground font-mono ml-auto">{AGENT_STATUS_KO[s.status] ?? s.status}</span>
                  </div>
                  {s.role && <p className="text-[10px] text-muted-foreground mt-0.5">{s.role}</p>}
                  {s.currentTask && <p className="text-[10px] text-muted-foreground/90 mt-0.5 truncate" title={s.currentTask}>작업: {s.currentTask}</p>}
                  {s.outputPreview && <p className="text-[10px] text-foreground/70 mt-1 font-mono truncate" title={s.outputPreview}>{s.outputPreview}</p>}
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => setViewAgentId(prev => prev === s.agentId ? null : s.agentId)}
                      disabled={!isLive && !hasOut}
                      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      <Eye className="w-2.5 h-2.5" /> {UI_KO.viewOutput}
                    </button>
                    {!isLive && !hasOut && <span className="text-[9px] text-muted-foreground/70">{UI_KO.noTerminal} (대기)</span>}
                  </div>
                </div>
              );
            })}
          </div>
          {liveCount === 0 && (
            <p className="text-[11px] text-muted-foreground mt-2">
              현재 연결된 터미널은 없습니다. 기본 프로세스 8개와 개발·검증 보조 3개는 자동 실행 준비 상태입니다. PM-tick 또는 작업 할당 시 터미널이 생성됩니다.
            </p>
          )}
          {viewAgentId && (
            <div className="mt-3">
              <AgentTerminalPanel agentId={viewAgentId} onClose={() => setViewAgentId(null)} />
            </div>
          )}
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
          <div className="md:col-span-2 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="id·에이전트·프로바이더·run id·워크트리로 검색…"
              className="w-full pl-9 pr-3 py-2 text-sm bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/30"
            />
          </div>
          <input
            value={agentFilter}
            onChange={e => setAgentFilter(e.target.value)}
            placeholder="agentId"
            className="px-3 py-2 text-sm bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/30"
          />
          <select
            value={providerFilter}
            onChange={e => setProviderFilter(e.target.value)}
            className="px-3 py-2 text-sm bg-card border border-border text-foreground focus:outline-none focus:border-foreground/30"
          >
            <option value="">전체 프로바이더</option>
            {providerOptions.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <input
            value={runIdFilter}
            onChange={e => setRunIdFilter(e.target.value)}
            placeholder="runId"
            className="px-3 py-2 text-sm bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/30"
          />
        </div>

        {/* Status pills */}
        <div className="flex gap-1 mt-2 flex-wrap">
          {STATUS_FILTERS.map(s => (
            <button
              key={s.id}
              onClick={() => setStatusFilter(s.id)}
              className={`px-3 py-1 text-xs border ${
                statusFilter === s.id
                  ? 'border-foreground/40 bg-secondary text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Banners */}
      {dbUnavailable && (
        <div className="mb-4 p-3 border border-amber-500/30 bg-amber-500/5 text-amber-500 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          Dorothy run database is not available — start the Electron app to populate this view.
        </div>
      )}
      {error && !dbUnavailable && (
        <div className="mb-4 p-3 border border-rose-500/30 bg-rose-500/5 text-rose-500 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="border border-dashed border-border py-16 px-6 flex flex-col items-center text-center text-muted-foreground">
          <Inbox className="w-10 h-10 mb-3 opacity-50" />
          <p className="text-sm">
            {sessions.length === 0 ? '아직 세션이 없습니다.' : '필터에 맞는 세션이 없습니다.'}
          </p>
          {sessions.length === 0 && (
            <>
              <p className="text-xs mt-1">
                실행 중인 터미널 세션이 없습니다 — 기본 프로세스 8개 + 개발·검증 보조 3개(backend/frontend/security-reviewer)는 준비되어 있습니다.
              </p>
              <p className="text-xs mt-1">
                자동 실행은 PM-tick → orchestrator → RunStep → Dispatch Readiness 흐름에 따라 시작됩니다.
              </p>
              <p className="text-xs mt-1">
                확인: <Link href="/agents" className="text-primary hover:underline">/agents</Link>(실행 가능 에이전트) ·{' '}
                <Link href="/runs" className="text-primary hover:underline">/runs</Link>(대기 중 작업) · 대시보드 <Link href="/" className="text-primary hover:underline">에이전트 터미널 개요</Link>.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {/* Phase 6-AE — the read-only terminal panel renders in the Live Agent
              Terminal Sessions section above (single instance). */}
          <div className="bg-card border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <Th>세션</Th>
                <Th>Run</Th>
                <Th>에이전트</Th>
                <Th>프로바이더</Th>
                {/* Phase 4.5 — slot for AgentWorkflowProgress (Phase 5/6). */}
                <Th>단계</Th>
                <Th>시작</Th>
                <Th>종료</Th>
                <Th>종료 상태</Th>
                <Th>대기</Th>
                <Th>워크트리</Th>
                <Th>소요</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => (
                <SessionRow
                  key={s.id}
                  s={s}
                  resume={resumeBySession.get(s.id)}
                  workflow={workflowBySession.get(s.id)}
                  idle={idleFor(s.agentId)}
                  readiness={readinessFor(s.agentId)}
                  stale={staleBySession.get(s.id)}
                  onViewTerminal={(id) => setViewAgentId(prev => (prev === id ? null : id))}
                  active={viewAgentId === s.agentId}
                />
              ))}
            </tbody>
          </table>
          <div className="px-3 py-2 text-[11px] text-muted-foreground border-t border-border">
            전체 {sessions.length}건 중 {filtered.length}건 표시 (최대 {PAGE_LIMIT}).
          </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionRow({
  s, resume, workflow, idle, readiness, stale, onViewTerminal, active,
}: {
  s: AgentSession;
  resume?: RateLimitEvent;
  workflow?: AgentWorkflowProgress;
  idle?: AgentIdleStatus;
  readiness?: AgentDispatchReadiness;
  stale?: StaleSessionFlag;
  onViewTerminal?: (agentId: string) => void;
  active?: boolean;
}) {
  const runHref = s.runId ? `/runs/${s.runId}` : null;
  return (
    <tr className="border-t border-border align-top">
      <Td>
        <code className="font-mono text-xs text-muted-foreground" title={s.id}>
          {s.id.slice(0, 8)}
        </code>
        {onViewTerminal && (
          <button
            onClick={() => onViewTerminal(s.agentId)}
            className={`mt-1 inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 border rounded cursor-pointer ${active ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'}`}
            title="이 세션 에이전트의 PTY 출력을 읽기 전용으로 봅니다(강제 실행 아님)"
          >
            <Eye className="w-2.5 h-2.5" /> 터미널 출력
          </button>
        )}
      </Td>
      <Td>
        {runHref ? (
          <Link href={runHref} className="inline-flex items-center gap-1 text-foreground hover:underline">
            <code className="font-mono text-xs">{s.runId!.slice(0, 8)}</code>
            <ExternalLink className="w-3 h-3" />
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </Td>
      <Td className="text-foreground">
        <div className="flex flex-col gap-0.5">
          <span title={s.agentId}>{processDisplayName(s.agentId, s.agentId)}</span>
          {idle && (
            <span
              className={`inline-flex w-fit items-center px-1.5 py-0 text-[10px] border rounded ${IDLE_REASON_BADGE[idle.reason]}`}
              title={idle.summary}
            >
              {IDLE_REASON_KO[idle.reason]}
            </span>
          )}
          {readiness && (
            readiness.ready ? (
              <span className="inline-flex w-fit items-center px-1.5 py-0 text-[10px] border rounded bg-emerald-500/10 text-emerald-500 border-emerald-500/30" title={readiness.summary}>
                실행 준비됨
              </span>
            ) : readiness.reason ? (
              <span className="inline-flex w-fit items-center px-1.5 py-0 text-[10px] border rounded bg-orange-500/10 text-orange-500 border-orange-500/30" title={readiness.summary}>
                {DISPATCH_BLOCKER_KO[readiness.reason]}
              </span>
            ) : null
          )}
          {stale && (
            <span className="inline-flex w-fit items-center px-1.5 py-0 text-[10px] border rounded bg-rose-500/10 text-rose-500 border-rose-500/30" title={stale.summary}>
              오래된 세션 모델 불일치
            </span>
          )}
        </div>
      </Td>
      <Td className="text-muted-foreground">{s.provider}</Td>
      {/* Phase 6-B — render the actual AgentWorkflowProgress phase. When no
          workflow row is bound yet, fall back to the legacy "Not tracked"
          marker so the dashboard remains useful for PM-tick / Stop-hook
          spawned sessions without a Run. */}
      <Td>
        {workflow ? (
          <Link
            href={s.runId ? `/runs/${s.runId}` : '#'}
            title={`${workflow.workflowKind} · ${workflow.status}`}
            className="inline-flex items-center gap-1 text-foreground hover:underline"
          >
            <span className={`inline-flex items-center px-1.5 py-0 text-[10px] border ${WORKFLOW_STATUS_BADGE[workflow.status]}`}>
              {workflow.progressPercent}%
            </span>
            <span className="text-[11px] text-foreground truncate max-w-[160px]">
              {workflow.currentStepLabel ?? workflow.workflowKind}
            </span>
          </Link>
        ) : s.runStepId ? (
          <code className="font-mono text-[11px] text-muted-foreground" title={s.runStepId}>
            step {s.runStepId.slice(0, 8)}
          </code>
        ) : (
          <span className="text-[11px] text-muted-foreground italic">미추적</span>
        )}
      </Td>
      <Td><Time iso={s.startedAt} /></Td>
      <Td><Time iso={s.exitedAt} /></Td>
      <Td>
        <SessionStatusBadge endStatus={s.endStatus ?? null} active={!s.exitedAt} />
        {/* Phase 5C-B — rate-limit overlay. */}
        {resume && <ResumeChip event={resume} sessionId={s.id} />}
      </Td>
      <Td>{s.waitingForUserInput ? <span className="text-amber-500 text-xs">yes</span> : <span className="text-muted-foreground">—</span>}</Td>
      <Td className="text-xs font-mono text-muted-foreground truncate max-w-[260px]" title={s.worktreePath ?? ''}>
        {s.worktreePath ?? '—'}
      </Td>
      <Td className="text-xs tabular-nums">{durationBetween(s.startedAt, s.exitedAt)}</Td>
    </tr>
  );
}

function ResumeChip({ event, sessionId }: { event: RateLimitEvent; sessionId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const lowConfidence = event.parseConfidence === 'low';
  const isOverdueDryRun =
    (event.resumeStatus === 'scheduled' || event.resumeStatus === 'pending') &&
    !!event.resumeAt &&
    new Date(event.resumeAt).getTime() <= Date.now();

  const onResume = async () => {
    let msg = `Manually resume session ${sessionId.slice(0, 8)} now?\n\nEvent: ${event.id.slice(0, 8)} (${event.provider ?? event.engine})`;
    if (event.resumeAt) msg += `\nresumeAt: ${event.resumeAt}`;
    msg += `\nretryCount: ${event.retryCount ?? 0}`;
    if (lowConfidence) {
      msg += `\n\n⚠ parseConfidence is "low" — Dorothy could not reliably parse the reset time. Continue only if you are sure cooldown has ended.`;
    }
    if (event.lastResumeError) {
      msg += `\n\nLast error: ${event.lastResumeError.slice(0, 240)}`;
    }
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;
    setBusy(true); setErr(null);
    try {
      const res = await dorothyRunsClient.rateLimit.resumeNow(event.id);
      if (!res.ok) setErr(res.error ?? 'resumeNow failed');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'resumeNow threw');
    } finally {
      setBusy(false);
    }
  };

  const tone =
    event.resumeStatus === 'failed'    ? 'border-rose-500/40 text-rose-500'
  : event.resumeStatus === 'resuming'  ? 'border-emerald-500/40 text-emerald-600'
  : event.resumeStatus === 'resumed'   ? 'border-emerald-700/40 text-emerald-700'
  : event.resumeStatus === 'cancelled' ? 'border-border text-muted-foreground'
  : lowConfidence                       ? 'border-amber-500/40 text-amber-500'
  : isOverdueDryRun                     ? 'border-orange-500/40 text-orange-500'
                                        : 'border-amber-500/40 text-amber-500';

  // Multi-state label with explicit dry-run-overdue + manual-review-required variants.
  const label =
    event.resumeStatus === 'failed'    ? 'resume failed'
  : event.resumeStatus === 'resuming'  ? 'resuming…'
  : event.resumeStatus === 'resumed'   ? 'resumed'
  : event.resumeStatus === 'cancelled' ? 'cancelled'
  : lowConfidence                       ? 'manual review required'
  : isOverdueDryRun                     ? `dry-run overdue (${formatRelative(event.resumeAt!)})`
  : event.resumeAt                      ? `resume at ${formatRelative(event.resumeAt)}`
                                        : 'rate-limited';

  const tooltipLines = [
    `event=${event.id.slice(0, 8)}`,
    event.resumeAt ? `resumeAt=${formatAbsolute(event.resumeAt)}` : null,
    `confidence=${event.parseConfidence ?? '—'}`,
    `retryCount=${event.retryCount ?? 0}`,
    event.lastResumeError ? `lastError=${event.lastResumeError.slice(0, 160)}` : null,
  ].filter(Boolean).join('\n');

  return (
    <div className="mt-1 flex items-center gap-1 flex-wrap">
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0 text-[10px] border ${tone}`}
        title={tooltipLines}
      >
        <Hourglass className="w-3 h-3" /> {label}
        {(event.retryCount ?? 0) > 0 && <span className="opacity-80">·r{event.retryCount}</span>}
      </span>
      <button
        onClick={onResume}
        disabled={busy || event.resumeStatus === 'resuming' || event.resumeStatus === 'resumed'}
        title={lowConfidence
          ? '⚠ Low-confidence reset time — confirm before resuming'
          : 'Resume Now — runs even when auto-resume is dry-run'}
        className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] border border-border text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50"
      >
        <PlayCircle className="w-3 h-3" /> {busy ? '재개 중…' : '지금 재개'}
      </button>
      {err && (
        <span className="text-[10px] text-rose-500" title={err}>error</span>
      )}
      {event.lastResumeError && !err && event.resumeStatus === 'failed' && (
        <span
          className="text-[10px] text-rose-500 truncate max-w-[180px]"
          title={event.lastResumeError}
        >
          {event.lastResumeError.slice(0, 60)}
        </span>
      )}
      <span className="sr-only">session {sessionId}</span>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left font-medium px-3 py-2">{children}</th>;
}
function Td({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <td className={`px-3 py-2 ${className ?? ''}`} title={title}>{children}</td>;
}
function Time({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="text-muted-foreground">—</span>;
  return <span className="text-xs text-muted-foreground" title={formatAbsolute(iso)}>{formatRelative(iso)}</span>;
}
