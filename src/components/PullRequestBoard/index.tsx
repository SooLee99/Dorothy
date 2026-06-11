'use client';

/**
 * Pull Request Board (/pr) — phase-5B read-only view of every PR mirrored
 * from GitHub. Writes happen entirely through the webhook receiver; this UI
 * never sends data back to GitHub.
 *
 * Refresh: 15 s polling shared with the rest of the dashboard. CI rollup
 * comes from `useDorothyCIRuns({ limit:500 })` so we only pay one IPC hit
 * even when 50 PRs are visible.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Inbox,
  MessageSquare,
  RefreshCw,
  Search,
  ShieldAlert,
} from 'lucide-react';
import {
  useDorothyPullRequests,
  useDorothyCIRuns,
} from '@/hooks/useDorothyRuns';
import type { PullRequest, PullRequestState, CIRun } from '@/types/dorothy';
import {
  PullRequestStateBadge,
  CIRunStateBadge,
  formatRelative,
  formatAbsolute,
} from '@/components/RunCommon/badges';

const PAGE_LIMIT = 200;

type StateFilter = 'all' | PullRequestState;
const STATE_FILTERS: { id: StateFilter; label: string }[] = [
  { id: 'all',                label: 'All' },
  { id: 'draft',              label: 'Draft' },
  { id: 'open',               label: 'Open' },
  { id: 'review',             label: 'Review' },
  { id: 'changes_requested',  label: 'Changes' },
  { id: 'merged',             label: 'Merged' },
  { id: 'closed',             label: 'Closed' },
];

export default function PullRequestBoard() {
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [query, setQuery] = useState('');

  const { pullRequests, isLoading, error, dbUnavailable, refresh } = useDorothyPullRequests({
    state: stateFilter === 'all' ? undefined : stateFilter,
    limit: PAGE_LIMIT,
  });
  // One bulk CI fetch — we index by PR id and let RunCard look up its rollup.
  const { ciRuns } = useDorothyCIRuns({ limit: PAGE_LIMIT * 4 });

  const ciByPr = useMemo(() => {
    const map = new Map<string, CIRun[]>();
    for (const c of ciRuns) {
      if (!c.pullRequestId) continue;
      const list = map.get(c.pullRequestId) ?? [];
      list.push(c);
      map.set(c.pullRequestId, list);
    }
    return map;
  }, [ciRuns]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pullRequests;
    return pullRequests.filter(p =>
      p.title.toLowerCase().includes(q) ||
      p.externalRef.toLowerCase().includes(q) ||
      `${p.owner}/${p.repo}`.toLowerCase().includes(q) ||
      p.branch.toLowerCase().includes(q) ||
      (p.runId ?? '').toLowerCase().includes(q)
    );
  }, [pullRequests, query]);

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between gap-4 mb-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
              <GitPullRequest className="w-5 h-5" /> 풀 리퀘스트
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              GitHub webhook로 미러된 읽기 전용 보기. {query.trim()
                ? <span>{pullRequests.length}건 중 {filtered.length}건 일치</span>
                : <span>{pullRequests.length}건</span>}
            </p>
          </div>
          <button
            onClick={() => { void refresh(); }}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} /> 새로고침
          </button>
        </div>

        {/* Filters */}
        <div className="relative max-w-md mb-2">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="제목·owner/repo·브랜치·runId·externalRef로 검색…"
            className="w-full pl-9 pr-3 py-2 text-sm bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/30"
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          {STATE_FILTERS.map(s => (
            <button
              key={s.id}
              onClick={() => setStateFilter(s.id)}
              className={`px-3 py-1 text-xs border ${
                stateFilter === s.id
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
          Dorothy 실행 데이터베이스를 사용할 수 없습니다 — Electron 앱을 열면 이 화면이 채워집니다.
        </div>
      )}
      {error && !dbUnavailable && (
        <div className="mb-4 p-3 border border-rose-500/30 bg-rose-500/5 text-rose-500 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}

      {/* List */}
      {filtered.length === 0 ? (
        <div className="border border-dashed border-border py-16 px-6 flex flex-col items-center text-center text-muted-foreground">
          <Inbox className="w-10 h-10 mb-3 opacity-50" />
          <p className="text-sm">
            {pullRequests.length === 0
              ? '아직 PR이 없습니다.'
              : '현재 필터에 맞는 PR이 없습니다.'}
          </p>
          {pullRequests.length === 0 && (
            <p className="text-xs mt-1">
              PR은 GitHub가 <code className="font-mono">/api/github/webhook</code>로 전송할 때 표시됩니다.
              설정에서 <code className="font-mono">githubWebhookSecret</code>을 구성하면 활성화됩니다.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {filtered.map(pr => <PullRequestCard key={pr.id} pr={pr} ci={ciByPr.get(pr.id) ?? []} />)}
          </div>
          {pullRequests.length >= PAGE_LIMIT && (
            <p className="mt-3 text-[11px] text-muted-foreground italic">
              최신 {PAGE_LIMIT}개 PR을 표시합니다. 이전 PR은 <code className="font-mono">dorothy.db</code>에 보관되며
              Phase 5C-B에서 페이지네이션됩니다.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function PullRequestCard({ pr, ci }: { pr: PullRequest; ci: CIRun[] }) {
  const latestCi = ci[0];
  const failedCount = ci.filter(c => c.state === 'failed').length;
  const successCount = ci.filter(c => c.state === 'success').length;

  // Phase 5C-A — group reviewers by verdict so the card surfaces blocking
  // reviewers clearly. We bucket pending separately so they don't dilute the
  // approval/changes count.
  const reviewers = pr.reviewers ?? [];
  const approved = reviewers.filter(r => r.state === 'approved');
  const changesRequested = reviewers.filter(r => r.state === 'changes_requested');
  const commented = reviewers.filter(r => r.state === 'commented');
  const pending = reviewers.filter(r => r.state === 'pending');

  return (
    <div className="bg-card border border-border p-4 hover:border-foreground/30 transition-colors">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="text-base font-medium text-foreground leading-tight break-words">
              {pr.title}
            </h3>
            <PullRequestStateBadge state={pr.state} />
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
            <code className="font-mono">{pr.externalRef}</code>
            <span>·</span>
            <span><code className="font-mono">{pr.branch}</code> → <code className="font-mono">{pr.baseBranch}</code></span>
            {pr.authorAgentId && (
              <>
                <span>·</span>
                <span>by <code className="font-mono">{pr.authorAgentId}</code></span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {pr.runId && (
            <Link
              href={`/runs/${pr.runId}`}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-border text-foreground hover:bg-secondary"
              title={pr.runId}
            >
              run {pr.runId.slice(0, 8)}
            </Link>
          )}
          {pr.url && (
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
              title="Open on GitHub"
            >
              <ExternalLink className="w-3 h-3" />
              GitHub
            </a>
          )}
        </div>
      </div>

      {/* Changes-requested warning row (only when at least one blocking review). */}
      {changesRequested.length > 0 && (
        <div className="mt-3 p-2 border border-orange-500/30 bg-orange-500/5 text-orange-500 text-xs flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            <strong>{changesRequested.length} reviewer{changesRequested.length === 1 ? '' : 's'} requested changes:</strong>{' '}
            {changesRequested.map(r => <code key={r.name} className="font-mono">{r.name}</code>).reduce((acc, el, i) => (
              <>{acc}{i > 0 ? ', ' : ''}{el}</>
            ), <></> as React.ReactNode)}
          </span>
        </div>
      )}

      {/* Reviewer rollup chips */}
      {reviewers.length > 0 && (
        <div className="mt-3 flex items-center gap-2 flex-wrap text-xs">
          {approved.length > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-emerald-500/10 text-emerald-600 border border-emerald-500/30">
              <CheckCircle2 className="w-3 h-3" /> {approved.length} approved
            </span>
          )}
          {changesRequested.length > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-orange-500/10 text-orange-500 border border-orange-500/30">
              <AlertTriangle className="w-3 h-3" /> {changesRequested.length} changes
            </span>
          )}
          {commented.length > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-blue-500/10 text-blue-500 border border-blue-500/30">
              <MessageSquare className="w-3 h-3" /> {commented.length} commented
            </span>
          )}
          {pending.length > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-muted text-muted-foreground border border-border">
              {pending.length} pending
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">
            ({reviewers.map(r => `${r.name}: ${r.state}`).join(', ')})
          </span>
        </div>
      )}

      {/* CI rollup */}
      {ci.length > 0 && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">ci:</span>
          <CIRunStateBadge state={latestCi.state} />
          {failedCount > 0 && (
            <span className="text-rose-500 text-[11px]">{failedCount} failed</span>
          )}
          {successCount > 0 && (
            <span className="text-emerald-600 text-[11px]">{successCount} passed</span>
          )}
        </div>
      )}

      {/* Approval-required slot. We don't yet have a per-PR approval lookup;
          the slot lights up as soon as Phase 5C-B's
          `useDorothyApprovalsByPullRequest` hook lands. Until then, we show
          the affordance only when the PR is in `changes_requested`. */}
      {pr.state === 'changes_requested' && (
        <div className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-amber-500/10 text-amber-500 border border-amber-500/30">
          <ShieldAlert className="w-3 h-3" />
          Approval required
          <span className="text-muted-foreground">— see /approvals (gate hooks coming in 5C-B)</span>
        </div>
      )}

      {/* Timestamps */}
      <div className="mt-3 text-[11px] text-muted-foreground tabular-nums flex items-center gap-3 flex-wrap">
        <span title={formatAbsolute(pr.createdAt)}>created {formatRelative(pr.createdAt)}</span>
        <span title={formatAbsolute(pr.updatedAt)}>updated {formatRelative(pr.updatedAt)}</span>
        {pr.mergedAt && (
          <span className="text-purple-500" title={formatAbsolute(pr.mergedAt)}>
            merged {formatRelative(pr.mergedAt)}
          </span>
        )}
        {pr.closedAt && !pr.mergedAt && (
          <span title={formatAbsolute(pr.closedAt)}>closed {formatRelative(pr.closedAt)}</span>
        )}
      </div>
    </div>
  );
}
