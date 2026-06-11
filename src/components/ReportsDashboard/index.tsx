'use client';

/**
 * Reports Dashboard (/reports) — read-only feed of every "report-shaped"
 * artifact written through Dorothy's lifecycle:
 *
 *   1. Artifact{ type:'report' }                — devops-reporter result reports
 *   2. Artifact{ type:'doc', producedByAgentId:'devops-reporter' }
 *                                                — changelog / PR body texts
 *   3. Artifact{ type:'review' }                — QA review verdicts + CI summaries
 *   4. Artifact{ type:'test' }                   — CI failures / unit test rollups
 *
 * Phase 5B scope keeps this read-only. Inline previews are shown for short
 * `meta` text; file paths are surfaced with a "view in Vault" hint but we
 * don't preempt the existing Vault viewer.
 *
 * TODO Phase 5C+: when the Vault viewer learns to render a path-based
 * artifact, render an embedded preview right here. For now we link out.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  Inbox,
  RefreshCw,
  Search,
  ExternalLink,
  FileText,
  XCircle,
  Archive,
} from 'lucide-react';
import { useDorothyReports } from '@/hooks/useDorothyRuns';
import type { Artifact, ArtifactType } from '@/types/dorothy';
import { ArtifactTypeBadge, formatRelative, formatAbsolute } from '@/components/RunCommon/badges';

type TypeFilter = 'all' | ArtifactType;
const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
  { id: 'all',    label: 'All' },
  { id: 'report', label: 'Reports' },
  { id: 'doc',    label: 'Docs' },
  { id: 'review', label: 'Reviews' },
  { id: 'test',   label: 'Tests' },
];

export default function ReportsDashboard() {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [runIdFilter, setRunIdFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [query, setQuery] = useState('');
  const [dateFilter, setDateFilter] = useState(''); // YYYY-MM-DD

  const { reports, isLoading, error, dbUnavailable, refresh } = useDorothyReports({
    runId: runIdFilter.trim() || undefined,
    producedByAgentId: agentFilter.trim() || undefined,
    limit: 500,
  });

  const agentOptions = useMemo(() => {
    const set = new Set<string>();
    reports.forEach(r => set.add(r.producedByAgentId));
    return Array.from(set).sort();
  }, [reports]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return reports.filter(r => {
      if (typeFilter !== 'all' && r.type !== typeFilter) return false;
      if (dateFilter && !r.createdAt.startsWith(dateFilter)) return false;
      if (!q) return true;
      const hay = `${r.type} ${r.path ?? ''} ${r.contentRef ?? ''} ${r.producedByAgentId} ${r.runId ?? ''} ${r.id}`.toLowerCase();
      return hay.includes(q);
    });
  }, [reports, typeFilter, dateFilter, query]);

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between gap-4 mb-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
              <FileText className="w-5 h-5" /> 보고서
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              결과 보고서·체인지로그·QA 리뷰·CI 테스트 요약 — 최신순 정렬.
              {' '}
              {query.trim() || dateFilter || typeFilter !== 'all' || runIdFilter || agentFilter
                ? <span>{reports.length}건 중 {filtered.length}건 일치</span>
                : <span>{reports.length}건</span>}
            </p>
          </div>
          <button
            onClick={() => { void refresh(); }}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} /> 새로고침
          </button>
        </div>

        {/* Filter row */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <div className="md:col-span-2 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="id·경로·contentRef·에이전트·runId로 검색…"
              className="w-full pl-9 pr-3 py-2 text-sm bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/30"
            />
          </div>
          <input
            value={runIdFilter}
            onChange={e => setRunIdFilter(e.target.value)}
            placeholder="runId"
            className="px-3 py-2 text-sm bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/30"
          />
          <select
            value={agentFilter}
            onChange={e => setAgentFilter(e.target.value)}
            className="px-3 py-2 text-sm bg-card border border-border text-foreground focus:outline-none focus:border-foreground/30"
          >
            <option value="">전체 생성자</option>
            {agentOptions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        <div className="flex gap-1 mt-2 flex-wrap items-center">
          {TYPE_FILTERS.map(t => (
            <button
              key={t.id}
              onClick={() => setTypeFilter(t.id)}
              className={`px-3 py-1 text-xs border ${
                typeFilter === t.id
                  ? 'border-foreground/40 bg-secondary text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              {t.label}
            </button>
          ))}
          <input
            type="date"
            value={dateFilter}
            onChange={e => setDateFilter(e.target.value)}
            className="ml-2 px-2 py-1 text-xs bg-card border border-border text-foreground focus:outline-none focus:border-foreground/30"
            aria-label="날짜로 필터"
          />
          {dateFilter && (
            <button
              onClick={() => setDateFilter('')}
              className="px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              날짜 지우기
            </button>
          )}
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
            {reports.length === 0
              ? '아직 보고서가 없습니다.'
              : '현재 필터에 맞는 보고서가 없습니다.'}
          </p>
          {reports.length === 0 && (
            <p className="text-xs mt-1">
              보고서는 devops-reporter·qa-reviewer 또는 GitHub Actions가 산출물을 작성할 때 표시됩니다.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(r => <ReportCard key={r.id} artifact={r} />)}
        </div>
      )}
    </div>
  );
}

function ReportCard({ artifact }: { artifact: Artifact }) {
  const isExternal = artifact.path?.startsWith('http://') || artifact.path?.startsWith('https://');
  const title = artifact.path ?? artifact.contentRef ?? `(${artifact.type})`;

  // Inline preview when meta contains short strings (summary / pr_body), else
  // we just surface the meta keys. We deliberately *do not* render full pr_body
  // text — it could contain large diffs.
  const preview = useMemo(() => extractPreview(artifact), [artifact]);

  // Phase 5C-A — surface common meta sub-fields as their own UI rows when
  // present. The pr_body preview always goes through `maskSensitive` so a
  // leaked `secret: foo` line is rendered as `secret: ***`.
  const meta = (artifact.meta ?? {}) as Record<string, unknown>;
  const summaryStr = typeof meta.summary === 'string' && meta.summary.trim() ? meta.summary : null;
  const workflowStr = typeof meta.workflow === 'string' && meta.workflow.trim() ? meta.workflow : null;
  const prBodyStr = typeof meta.pr_body === 'string' && meta.pr_body.trim() ? meta.pr_body : null;
  const ciState = typeof meta.ci_state === 'string' ? meta.ci_state : null;
  const isFailedCi = artifact.type === 'test' && ciState === 'failed';
  const sourceTag = classifySource(artifact.contentRef ?? null);

  return (
    <div className="bg-card border border-border p-4">
      {isFailedCi && (
        <div className="mb-3 p-2 border border-rose-500/30 bg-rose-500/5 text-rose-500 text-xs flex items-start gap-2">
          <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            <strong>CI failed</strong>
            {workflowStr ? <> on <code className="font-mono">{workflowStr}</code></> : null}
            {' '}— inspect linked logs / Run Detail for the failure trace.
          </span>
        </div>
      )}

      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <ArtifactTypeBadge type={artifact.type} />
            {sourceTag && (
              <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium border bg-muted text-muted-foreground border-border">
                {sourceTag}
              </span>
            )}
            <span className="text-sm text-foreground font-medium break-words">{title}</span>
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
            <span>by <code className="font-mono">{artifact.producedByAgentId}</code></span>
            {artifact.runId && (
              <>
                <span>·</span>
                <Link href={`/runs/${artifact.runId}`} className="hover:underline">
                  run <code className="font-mono">{artifact.runId.slice(0, 8)}</code>
                </Link>
              </>
            )}
            {artifact.runStepId && (
              <>
                <span>·</span>
                <span>step <code className="font-mono">{artifact.runStepId.slice(0, 8)}</code></span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isExternal && artifact.path && (
            <a
              href={artifact.path}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
            >
              <ExternalLink className="w-3 h-3" /> Open
            </a>
          )}
          {!isExternal && artifact.path && (
            <Link
              href="/vault"
              className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-border text-foreground hover:bg-secondary"
              title={artifact.path}
            >
              <Archive className="w-3 h-3" /> Open in Vault
            </Link>
          )}
        </div>
      </div>

      {/* Summary row — surfaced separately so it's visually distinct from
          the raw meta preview. */}
      {(summaryStr || workflowStr) && (
        <div className="mt-2 mb-1 text-xs">
          {workflowStr && (
            <div className="text-muted-foreground">
              workflow: <code className="font-mono text-foreground">{workflowStr}</code>
            </div>
          )}
          {summaryStr && (
            <div className="mt-1 text-foreground whitespace-pre-wrap break-words">
              {summaryStr}
            </div>
          )}
        </div>
      )}

      {/* PR body preview — masked. */}
      {prBodyStr && (
        <pre className="mt-2 p-2 bg-background border border-border text-[11px] text-muted-foreground whitespace-pre-wrap break-words line-clamp-6 max-h-32 overflow-hidden font-mono">
          {maskSensitive(prBodyStr.slice(0, 600))}
        </pre>
      )}

      {/* Generic preview fallback when no pr_body / summary specialization
          fired. */}
      {!prBodyStr && !summaryStr && preview && (
        <pre className="mt-2 p-2 bg-background border border-border text-[11px] text-muted-foreground whitespace-pre-wrap break-words line-clamp-6 max-h-32 overflow-hidden font-mono">
          {maskSensitive(preview)}
        </pre>
      )}

      <div className="mt-2 text-[11px] text-muted-foreground tabular-nums" title={formatAbsolute(artifact.createdAt)}>
        {formatRelative(artifact.createdAt)} · <code className="font-mono">{artifact.contentRef ?? '—'}</code>
      </div>
    </div>
  );
}

/**
 * Phase 5C-A — derive a short "source" label from contentRef so a reader can
 * tell at a glance whether an artifact came from a PR body, a CI run, a
 * git commit, or somewhere else.
 */
function classifySource(contentRef: string | null): string | null {
  if (!contentRef) return null;
  if (contentRef === 'inline:pr-body') return 'PR body';
  if (contentRef.startsWith('ci:')) return 'CI';
  if (contentRef.startsWith('review:')) return 'review';
  if (contentRef.startsWith('comment:')) return 'comment';
  if (contentRef.startsWith('git:')) return 'git';
  if (contentRef.startsWith('vault:')) return 'vault';
  if (contentRef.startsWith('inline:')) return 'inline';
  return null;
}

/**
 * Phase 5C-A — mask common secret patterns in arbitrary text. We replace the
 * value after `secret`, `token`, or `password` (case-insensitive, separated
 * by `:` or `=`) with `***`. Lines lacking that pattern pass through.
 */
export function maskSensitive(text: string): string {
  // Pattern: keyword, optional whitespace, `:` or `=`, optional whitespace,
  // then the value up to the next whitespace / line break / quote.
  // We keep the keyword itself intact so the reader knows *what* was masked.
  return text.replace(
    /\b(secret|token|password)\b\s*[:=]\s*[^\s"',]+/gi,
    (_full, kw: string) => `${kw}: ***`,
  );
}

/**
 * Pull a small preview string from artifact.meta when it's a short text-like
 * value. Keeps the card readable even when the artifact was written from a
 * webhook (no full Vault doc behind it).
 */
function extractPreview(artifact: Artifact): string | null {
  const meta = artifact.meta ?? {};
  // Ordered probes — the first match wins.
  const candidates = ['summary', 'pr_body', 'ci_state', 'workflow'];
  for (const key of candidates) {
    const v = (meta as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      return v.slice(0, 600);
    }
  }
  // No string fields — render a tiny meta key list.
  const keys = Object.keys(meta);
  if (!keys.length) return null;
  return keys.map(k => `${k}: ${JSON.stringify((meta as Record<string, unknown>)[k]).slice(0, 80)}`).join('\n');
}
