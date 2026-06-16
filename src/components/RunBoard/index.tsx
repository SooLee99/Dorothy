'use client';

/**
 * Run Board (/runs) — phase-2 read-only view of all Dorothy MVP Runs grouped
 * by lifecycle bucket (Pending / Active / Blocked / Done / Stopped).
 *
 * Refreshes every 15 s; clicking a card navigates to /runs/[id]. There is
 * no in-place mutation in phase 2 — the only write is the "cancel" affordance
 * which lives on the Run Detail page.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Inbox, RefreshCw, Search } from 'lucide-react';
import { useDorothyRuns, useDorothyDispatchReadiness } from '@/hooks/useDorothyRuns';
import {
  RUN_GROUP_LABEL,
  RUN_GROUP_ORDER,
  RUN_MODE_BADGE,
  RUN_MODE_DESCRIPTION,
  type Run,
  type RunGroup,
  type RunMode,
} from '@/types/dorothy';
import {
  StateBadge,
  PriorityBadge,
  formatRelative,
} from '@/components/RunCommon/badges';

const PAGE_LIMIT = 200;

type ModeFilter = 'all' | RunMode | 'unset';
type ViewMode = 'state' | 'mode';
const MODE_FILTERS: { id: ModeFilter; label: string }[] = [
  { id: 'all',         label: '전체 모드' },
  { id: 'team',        label: 'team' },
  { id: 'persistent',  label: 'persistent' },
  { id: 'ultraqa',     label: 'ultraqa' },
  { id: 'pipeline',    label: 'pipeline' },
  { id: 'manual',      label: 'manual' },
  { id: 'unset',       label: 'unset (legacy)' },
];
const MODE_BUCKETS: Array<RunMode | 'unset'> = ['team', 'persistent', 'ultraqa', 'pipeline', 'manual', 'unset'];

export default function RunBoard() {
  const { runs, groups, isLoading, error, dbUnavailable, refresh } = useDorothyRuns({ limit: PAGE_LIMIT });
  // Phase 6-J — per-run dispatch counts (dry-run; never spawns).
  const { readiness } = useDorothyDispatchReadiness();
  const dispatchByRun = useMemo(() => {
    const m = new Map<string, { pending: number; ready: number; blocked: number }>();
    for (const r of readiness) {
      if (!r.runId) continue;
      const e = m.get(r.runId) ?? { pending: 0, ready: 0, blocked: 0 };
      e.pending++;
      if (r.ready) e.ready++; else if (r.reason) e.blocked++;
      m.set(r.runId, e);
    }
    return m;
  }, [readiness]);
  const [query, setQuery] = useState('');
  // Phase 5E — mode filter + view toggle. Default is the existing state
  // grouping so legacy users see no change.
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('state');

  // Predicate shared between state-view + mode-view; honours search + mode filter.
  const passesFilters = (r: Run, q: string): boolean => {
    if (q && !(
      r.title.toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q) ||
      (r.kanbanTaskId ?? '').toLowerCase().includes(q) ||
      r.source.toLowerCase().includes(q) ||
      (r.mode ?? '').toLowerCase().includes(q)
    )) return false;
    if (modeFilter === 'all') return true;
    if (modeFilter === 'unset') return !r.mode;
    return r.mode === modeFilter;
  };

  // Filter happens client-side: list is bounded by PAGE_LIMIT so it's cheap.
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Record<RunGroup, Run[]> = {
      pending: [], active: [], blocked: [], done: [], stopped: [],
    };
    for (const g of RUN_GROUP_ORDER) {
      out[g] = groups[g].filter(r => passesFilters(r, q));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, query, modeFilter]);

  // Phase 5E — when view='mode', re-bucket the same filtered list by Run.mode.
  const filteredModeGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Record<RunMode | 'unset', Run[]> = {
      team: [], persistent: [], ultraqa: [], pipeline: [], manual: [], unset: [],
    };
    for (const r of runs) {
      if (!passesFilters(r, q)) continue;
      const key: RunMode | 'unset' = (r.mode ?? 'unset') as RunMode | 'unset';
      out[key].push(r);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, query, modeFilter]);

  const total = runs.length;
  const totalFiltered = RUN_GROUP_ORDER.reduce((s, g) => s + filteredGroups[g].length, 0);

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between gap-4 mb-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-foreground">자동개발 실행 기록</h1>
              {/* Dead-screen 처리 (#죽은화면) — Run 미러 미연결이라 화면이 비어 보일 수
                  있음을 명확히 알리는 "준비 중" 배지. 실연결(PTY↔DB 미러)은 심장수술
                  영역으로 별도. 아래 안내 배너와 한 쌍으로 동작. */}
              <span
                title="Run 미러(PTY↔DB) 연결 전이라 비어 보일 수 있습니다. 실제 실행은 /sessions에서 확인하세요."
                className="px-2 py-0.5 text-[11px] font-medium border border-amber-500/40 bg-amber-500/10 text-amber-500 rounded"
              >
                준비 중
              </span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              현재 실제 실행 상태는 <Link href="/sessions" className="text-primary underline">에이전트 터미널</Link>에서 확인하세요.
              이 화면은 실행 기록(Run mirror)이 연결되면 자동으로 채워집니다.
              {' '}
              {query.trim()
                ? <span>{total}건 중 {totalFiltered}건 일치</span>
                : <span>{total}건</span>}
            </p>
          </div>
          <button
            onClick={() => { void refresh(); }}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary"
            aria-label="새로고침"
            title="새로고침"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            새로고침
          </button>
        </div>
        <div className="relative max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="제목·id·칸반 작업·소스·모드로 필터…"
            className="w-full pl-9 pr-3 py-2 text-sm bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/30"
          />
        </div>
        {/* Phase 5E — mode filter pills + group-by toggle. Defaults to
            "all" + "state" so the original Run Board layout is unchanged. */}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground uppercase tracking-wider">모드:</span>
          {MODE_FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setModeFilter(f.id)}
              className={`px-2 py-0.5 text-[11px] border ${
                modeFilter === f.id
                  ? 'border-foreground/40 bg-secondary text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              {f.label}
            </button>
          ))}
          <span className="text-[11px] text-muted-foreground uppercase tracking-wider ml-3">그룹화:</span>
          {(['state', 'mode'] as ViewMode[]).map(v => (
            <button
              key={v}
              onClick={() => setViewMode(v)}
              className={`px-2 py-0.5 text-[11px] border ${
                viewMode === v
                  ? 'border-foreground/40 bg-secondary text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Banner states */}
      {dbUnavailable && (
        <div className="mb-4 p-3 border border-amber-500/30 bg-amber-500/5 text-amber-500 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          <span>
            Dorothy 실행 데이터베이스를 사용할 수 없습니다 — Phase 1 미초기화이거나
            Electron 외부에서 실행 중일 수 있습니다. 빈 상태를 표시합니다.
          </span>
        </div>
      )}
      {error && !dbUnavailable && (
        <div className="mb-4 p-3 border border-rose-500/30 bg-rose-500/5 text-rose-500 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}

      {/* Phase 6-AE — Run-mirror-not-connected guidance. The real fleet runs on
          the PTY layer; the Run model is not mirrored from it yet, so this board
          can look empty even while agents are actively working. */}
      <div className="mb-4 rounded-md border border-cyan-500/30 bg-cyan-500/5 px-3 py-2 text-xs text-muted-foreground">
        <p className="text-cyan-300 font-medium">실행 레이어 안내 — Run 미러 미연결</p>
        <p className="mt-0.5">
          현재 자동개발은 <span className="font-mono">PM-tick → orchestrator → electron PTY</span> 경로로 실행되며,
          Run 모델 미러는 아직 활성화되지 않았습니다. 이 보드가 비어 있어도 에이전트는 실제로 동작 중일 수 있습니다.
        </p>
        <p className="mt-1">
          실제 실행 상태:{' '}
          <Link href="/sessions" className="text-primary hover:underline">/sessions</Link>의 Live Agent Terminal Sessions 또는{' '}
          <Link href="/" className="text-primary hover:underline">대시보드 터미널 보드</Link>를 확인하세요.
        </p>
      </div>

      {/* Columns — Phase 5E: switch buckets when group-by=mode. */}
      {viewMode === 'state' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {RUN_GROUP_ORDER.map(group => (
            <Column key={group} group={group} runs={filteredGroups[group]} dispatchByRun={dispatchByRun} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
          {MODE_BUCKETS.map(m => (
            <ModeColumn key={m} mode={m} runs={filteredModeGroups[m]} dispatchByRun={dispatchByRun} />
          ))}
        </div>
      )}

      {/* Initial empty state when DB is fine but no runs yet */}
      {!isLoading && !dbUnavailable && total === 0 && (
        <div className="mt-12 flex flex-col items-center text-center text-muted-foreground py-12 border border-dashed border-border">
          <Inbox className="w-10 h-10 mb-3 opacity-50" />
          <p className="text-sm">아직 실행 Run이 없습니다.</p>
          <p className="text-xs mt-1">
            Run은 Kanban 작업과 PM-tick 사이클에서 자동으로 생성됩니다.
          </p>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * Column + Card
 * ========================================================================== */

type DispatchByRun = Map<string, { pending: number; ready: number; blocked: number }>;

function ModeColumn({ mode, runs, dispatchByRun }: { mode: RunMode | 'unset'; runs: Run[]; dispatchByRun: DispatchByRun }) {
  const cls = mode === 'unset'
    ? 'bg-muted text-muted-foreground border-border'
    : RUN_MODE_BADGE[mode];
  return (
    <div className="bg-card border border-border flex flex-col min-h-[200px]">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium border ${cls}`}>
          {mode}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{runs.length}</span>
      </div>
      <div className="flex-1 p-2 space-y-2 overflow-y-auto max-h-[calc(100vh-260px)]">
        {runs.length === 0 ? (
          <div className="text-xs text-muted-foreground/60 italic px-2 py-3">empty</div>
        ) : (
          runs.map(run => <RunCard key={run.id} run={run} dispatch={dispatchByRun.get(run.id)} />)
        )}
      </div>
    </div>
  );
}

function Column({ group, runs, dispatchByRun }: { group: RunGroup; runs: Run[]; dispatchByRun: DispatchByRun }) {
  return (
    <div className="bg-card border border-border flex flex-col min-h-[200px]">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {RUN_GROUP_LABEL[group]}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{runs.length}</span>
      </div>
      <div className="flex-1 p-2 space-y-2 overflow-y-auto max-h-[calc(100vh-220px)]">
        {runs.length === 0 ? (
          <div className="text-xs text-muted-foreground/60 italic px-2 py-3">empty</div>
        ) : (
          runs.map(run => <RunCard key={run.id} run={run} dispatch={dispatchByRun.get(run.id)} />)
        )}
      </div>
    </div>
  );
}

function RunCard({ run, dispatch }: { run: Run; dispatch?: { pending: number; ready: number; blocked: number } }) {
  const hasBlock = run.state === 'blocked' && run.blockedReason;
  const hasError = (run.state === 'failed' || run.state === 'needs_fix') && run.errorReason;

  return (
    <Link
      href={`/runs/${run.id}`}
      className="block p-3 bg-background border border-border hover:border-foreground/30 hover:bg-secondary/50 transition-colors group"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="text-sm text-foreground font-medium leading-tight line-clamp-2 group-hover:text-foreground">
          {run.title}
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap mb-2">
        <StateBadge state={run.state} />
        <PriorityBadge priority={run.priority} />
        <span className="inline-flex items-center px-2 py-0.5 text-xs bg-muted text-muted-foreground">
          {run.source}
        </span>
        {/* Phase 5D — RunMode badge. Tooltip carries source + reason so the
            operator knows why this Run is in (e.g.) persistent vs team. */}
        {run.mode && (
          <span
            className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border ${RUN_MODE_BADGE[run.mode]}`}
            title={`${RUN_MODE_DESCRIPTION[run.mode]}${run.modeSource ? `\n— source: ${run.modeSource}` : ''}${run.modeReason ? `\n— ${run.modeReason}` : ''}`}
          >
            {run.mode}
          </span>
        )}
      </div>
      {run.kanbanTaskId && (
        <div className="text-[11px] text-muted-foreground mb-1 truncate">
          kanban: <code className="font-mono">{run.kanbanTaskId.slice(0, 8)}</code>
        </div>
      )}
      {hasBlock && (
        <div className="text-[11px] text-yellow-500 mb-1 line-clamp-2" title={run.blockedReason ?? ''}>
          blocked: {run.blockedReason}
        </div>
      )}
      {hasError && (
        <div className="text-[11px] text-rose-500 mb-1 line-clamp-2" title={run.errorReason ?? ''}>
          error: {run.errorReason}
        </div>
      )}
      {dispatch && dispatch.pending > 0 && (
        <div className="flex items-center gap-1.5 mb-1 text-[10px]">
          <span className="px-1.5 py-px border border-border rounded text-muted-foreground">자동실행 {dispatch.pending}</span>
          {dispatch.ready > 0 && (
            <span className="px-1.5 py-px border border-emerald-500/30 text-emerald-500 rounded">{dispatch.ready} 실행가능</span>
          )}
          {dispatch.blocked > 0 && (
            <span className="px-1.5 py-px border border-orange-500/30 text-orange-500 rounded">{dispatch.blocked} 차단</span>
          )}
        </div>
      )}
      <div className="text-[11px] text-muted-foreground tabular-nums">
        {formatRelative(run.createdAt)}
      </div>
    </Link>
  );
}
