'use client';

/**
 * Improvement Signals (/improvements) — Phase 5C-C.
 *
 * Read + light-write surface for the self-improvement loop. Behaviour vs.
 * Phase 5C-B:
 *   - Cards expand inline to show the detail panel (metadata + evidence).
 *   - Evidence artifacts are looked up via `dorothy:artifacts:listByIds`.
 *   - Filters add `occurrenceCount >= 2` and `only open`.
 *   - convert_to_task button still disabled, but the tooltip is explicit
 *     about Phase 5D ownership.
 *
 * Spec contract: this UI never edits agent files or skills. Only status
 * mutations (open / triaged / accepted / dismissed) are exposed.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Inbox,
  Info,
  Lightbulb,
  ListChecks,
  RefreshCw,
  Search,
  Trash2,
  Wrench,
} from 'lucide-react';
import {
  useDorothyImprovementSignals,
  useDorothyArtifactsByIds,
} from '@/hooks/useDorothyRuns';
import { dorothyRunsClient } from '@/lib/dorothyRunsClient';
import type {
  Artifact,
  ImprovementSignal,
  ImprovementSignalStatus,
  ImprovementSignalSource,
  ImprovementSignalSeverity,
} from '@/types/dorothy';
import {
  IMPROVEMENT_SOURCE_BADGE,
  IMPROVEMENT_STATUS_BADGE,
} from '@/types/dorothy';
import {
  ArtifactTypeBadge,
  formatAbsolute,
  formatRelative,
  maskSensitivePreview,
} from '@/components/RunCommon/badges';

const PREVIEW_MAX = 600;
// Phase 5E — convert-to-task is enabled with an explicit user click + confirm.
// We keep the constant around so legacy strings still resolve.
const CONVERT_DISABLED_TOOLTIP =
  '이미 KanbanTask로 변환된 ImprovementSignal은 다시 변환할 수 없습니다.';

const STATUS_FILTERS: { id: 'all' | ImprovementSignalStatus; label: string }[] = [
  { id: 'all',                label: '전체' },
  { id: 'open',               label: '열림' },
  { id: 'triaged',            label: '분류됨' },
  { id: 'accepted',           label: '승인됨' },
  { id: 'dismissed',          label: '기각됨' },
  { id: 'converted_to_task',  label: '변환됨' },
];

const SOURCE_OPTIONS: { id: 'all' | ImprovementSignalSource; label: string }[] = [
  { id: 'all',                       label: '전체 출처' },
  { id: 'qa_failure',                label: 'QA 실패' },
  { id: 'ci_failure',                label: 'CI 실패' },
  { id: 'rate_limit',                label: '사용량 제한' },
  { id: 'approval_required',         label: '승인 게이트' },
  { id: 'review_changes_requested',  label: '변경 요청' },
  { id: 'retry_exceeded',            label: '재시도 초과' },
  { id: 'manual_note',               label: '수동 노트' },
];

const SEVERITY_OPTIONS: { id: 'all' | ImprovementSignalSeverity; label: string }[] = [
  { id: 'all',     label: '전체 심각도' },
  { id: 'high',    label: '높음' },
  { id: 'medium',  label: '보통' },
  { id: 'low',     label: '낮음' },
];

export default function ImprovementSignalsBoard() {
  const [statusFilter, setStatusFilter] = useState<'all' | ImprovementSignalStatus>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | ImprovementSignalSource>('all');
  const [severityFilter, setSeverityFilter] = useState<'all' | ImprovementSignalSeverity>('all');
  const [runIdFilter, setRunIdFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [query, setQuery] = useState('');
  const [recurringOnly, setRecurringOnly] = useState(false);
  const [openOnly, setOpenOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const { signals, isLoading, error, dbUnavailable, refresh } = useDorothyImprovementSignals({
    status: statusFilter === 'all' ? undefined : statusFilter,
    source: sourceFilter === 'all' ? undefined : sourceFilter,
    severity: severityFilter === 'all' ? undefined : severityFilter,
    runId: runIdFilter.trim() || undefined,
    limit: 500,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const ag = agentFilter.trim().toLowerCase();
    return signals.filter(s => {
      if (openOnly && s.status !== 'open' && s.status !== 'triaged') return false;
      if (recurringOnly && (s.occurrenceCount ?? 1) < 2) return false;
      if (ag && !(s.relatedAgentId ?? '').toLowerCase().includes(ag)) return false;
      if (!q) return true;
      const hay = `${s.title} ${s.summary} ${s.runId ?? ''} ${s.relatedAgentId ?? ''} ${s.relatedSkillId ?? ''} ${s.fingerprint ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [signals, query, agentFilter, openOnly, recurringOnly]);

  const updateStatus = async (id: string, status: ImprovementSignalStatus) => {
    setPending(id);
    setLastError(null);
    try {
      const res = await dorothyRunsClient.improvements.updateStatus({ id, status });
      if (!res.ok) {
        setLastError(res.error ?? 'updateStatus failed');
      }
      await refresh();
    } catch (err) {
      setLastError(err instanceof Error ? err.message : 'updateStatus threw');
    } finally {
      setPending(null);
    }
  };

  // Phase 5E — operator-driven Convert-to-Task. Confirms once, defaults the
  // new KanbanTask to the safer `backlog` column so it never auto-starts an
  // agent, and refuses to re-convert anything already converted.
  const convertToTask = async (signal: ImprovementSignal) => {
    if (signal.status === 'converted_to_task' || signal.convertedTaskId) {
      setLastError('Already converted to a KanbanTask.');
      return;
    }
    const msg = `Convert this improvement signal to a Kanban task?

Title: [Improvement] ${signal.title}
Default column: backlog (you can promote to planned manually)

Summary (truncated):
${signal.summary.slice(0, 400)}`;
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;
    setPending(signal.id);
    setLastError(null);
    try {
      const res = await dorothyRunsClient.improvements.convertToTask({ id: signal.id, column: 'backlog' });
      if (!res.ok) {
        setLastError(res.error ?? 'convertToTask failed');
      }
      await refresh();
    } catch (err) {
      setLastError(err instanceof Error ? err.message : 'convertToTask threw');
    } finally {
      setPending(null);
    }
  };

  // Phase 6-D — Convert to SkillCandidate. Distinct from task: the result is
  // a /skill-candidates row for review, not a Kanban entry.
  const [skillBannerInfo, setSkillBannerInfo] = useState<string | null>(null);
  const convertToSkillCandidate = async (signal: ImprovementSignal) => {
    const msg = `이 개선 신호를 스킬 후보로 변환할까요?

제목: [Skill] ${signal.title}

/skill-candidates에 검토용 후보가 생성됩니다.
스킬 파일은 생성되지 않습니다.`;
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;
    setPending(signal.id);
    setLastError(null);
    setSkillBannerInfo(null);
    try {
      const res = await dorothyRunsClient.skillCandidates.fromImprovementSignal({ id: signal.id });
      if (!res.ok) {
        setLastError(res.error ?? 'fromImprovementSignal failed');
      } else {
        setSkillBannerInfo('Skill Candidate created. See /skill-candidates.');
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : 'fromImprovementSignal threw');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between gap-4 mb-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
              <Lightbulb className="w-5 h-5" /> 개선 신호
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Dorothy가 실행 중 감지한 패턴 — QA 실패·CI 실패·사용량 제한·변경 요청·승인 게이트.
              후속 조치를 위해 분류하세요. 에이전트 파일이나 스킬은 자동으로 수정되지 않습니다.
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
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
          <div className="md:col-span-2 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="제목·요약·runId·에이전트·fingerprint로 검색…"
              className="w-full pl-9 pr-3 py-2 text-sm bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/30"
            />
          </div>
          <input
            value={runIdFilter}
            onChange={e => setRunIdFilter(e.target.value)}
            placeholder="runId"
            className="px-3 py-2 text-sm bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/30"
          />
          <input
            value={agentFilter}
            onChange={e => setAgentFilter(e.target.value)}
            placeholder="relatedAgentId"
            className="px-3 py-2 text-sm bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/30"
          />
          <select
            value={severityFilter}
            onChange={e => setSeverityFilter(e.target.value as 'all' | ImprovementSignalSeverity)}
            className="px-3 py-2 text-sm bg-card border border-border text-foreground focus:outline-none focus:border-foreground/30"
          >
            {SEVERITY_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
          <select
            value={sourceFilter}
            onChange={e => setSourceFilter(e.target.value as 'all' | ImprovementSignalSource)}
            className="px-3 py-2 text-sm bg-card border border-border text-foreground focus:outline-none focus:border-foreground/30"
          >
            {SOURCE_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as 'all' | ImprovementSignalStatus)}
            className="px-3 py-2 text-sm bg-card border border-border text-foreground focus:outline-none focus:border-foreground/30"
          >
            {STATUS_FILTERS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-3 mt-2 text-xs flex-wrap">
          <label className="inline-flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} />
            <span className="text-muted-foreground">열림 / 분류됨만</span>
          </label>
          <label className="inline-flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={recurringOnly} onChange={e => setRecurringOnly(e.target.checked)} />
            <span className="text-muted-foreground">Recurring (occurrence ≥ 2)</span>
          </label>
        </div>
      </div>

      {/* Banners */}
      {dbUnavailable && (
        <div className="mb-4 p-3 border border-amber-500/30 bg-amber-500/5 text-amber-500 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          Dorothy run database is not available — open the Electron app.
        </div>
      )}
      {(error || lastError) && !dbUnavailable && (
        <div className="mb-4 p-3 border border-rose-500/30 bg-rose-500/5 text-rose-500 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /><span>{lastError ?? error}</span>
        </div>
      )}
      {skillBannerInfo && !dbUnavailable && (
        <div className="mb-4 p-3 border border-emerald-500/30 bg-emerald-500/5 text-emerald-600 text-sm flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" />
          <span>{skillBannerInfo}</span>
          <Link href="/skill-candidates" className="ml-auto underline hover:text-emerald-700">
            Open Skill Candidates →
          </Link>
        </div>
      )}

      {/* List */}
      {filtered.length === 0 ? (
        <div className="border border-dashed border-border py-16 px-6 flex flex-col items-center text-center text-muted-foreground">
          <Inbox className="w-10 h-10 mb-3 opacity-50" />
          <p className="text-sm">
            {signals.length === 0 ? '아직 개선 신호가 없습니다.' : '현재 필터에 맞는 신호가 없습니다.'}
          </p>
          {signals.length === 0 && (
            <p className="text-xs mt-1">
              신호는 QA 실패·CI 실패·리뷰 피드백·사용량 제한에서 자동으로 생성됩니다.
              스스로 코드를 수정하지 않습니다.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(sig => (
            <SignalCard
              key={sig.id}
              signal={sig}
              expanded={expanded === sig.id}
              onToggle={() => setExpanded(prev => prev === sig.id ? null : sig.id)}
              onUpdate={updateStatus}
              onConvert={convertToTask}
              onConvertToSkillCandidate={convertToSkillCandidate}
              busy={pending === sig.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * Card
 * ========================================================================== */

function SignalCard({
  signal,
  expanded,
  onToggle,
  onUpdate,
  onConvert,
  onConvertToSkillCandidate,
  busy,
}: {
  signal: ImprovementSignal;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (id: string, status: ImprovementSignalStatus) => Promise<void>;
  onConvert: (signal: ImprovementSignal) => Promise<void>;
  onConvertToSkillCandidate: (signal: ImprovementSignal) => Promise<void>;
  busy: boolean;
}) {
  const alreadyConverted = signal.status === 'converted_to_task' || !!signal.convertedTaskId;
  const sourceCls = IMPROVEMENT_SOURCE_BADGE[signal.source];
  const statusCls = IMPROVEMENT_STATUS_BADGE[signal.status];
  return (
    <div className="bg-card border border-border">
      {/* Clickable summary row */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full text-left p-4 hover:bg-secondary/50 transition-colors"
      >
        <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
              <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border ${sourceCls}`}>
                {signal.source.replace(/_/g, ' ')}
              </span>
              <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border ${statusCls}`}>
                {signal.status.replace(/_/g, ' ')}
              </span>
              <SeverityChip severity={signal.severity} />
              {(signal.occurrenceCount ?? 1) > 1 && (
                <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium border bg-muted text-muted-foreground border-border">
                  ×{signal.occurrenceCount}
                </span>
              )}
              <h3 className="text-sm font-medium text-foreground leading-tight">{signal.title}</h3>
            </div>
            <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
              {signal.runId && (
                <span>
                  run <code className="font-mono">{signal.runId.slice(0, 8)}</code>
                </span>
              )}
              {signal.relatedAgentId && (
                <>
                  <span>·</span>
                  <span>agent <code className="font-mono">{signal.relatedAgentId}</code></span>
                </>
              )}
              {signal.evidenceArtifactIds && signal.evidenceArtifactIds.length > 0 && (
                <>
                  <span>·</span>
                  <span>{signal.evidenceArtifactIds.length} artifact{signal.evidenceArtifactIds.length === 1 ? '' : 's'}</span>
                </>
              )}
              <span>·</span>
              <span title={formatAbsolute(signal.updatedAt)}>updated {formatRelative(signal.updatedAt)}</span>
            </div>
          </div>
        </div>
        <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words mt-2 line-clamp-3">
          {signal.summary}
        </p>
      </button>

      {/* Expanded detail panel */}
      {expanded && <DetailPanel signal={signal} />}

      {/* Action bar — kept outside the expand toggle so a click on a button
          doesn't also collapse the card. */}
      <div className="border-t border-border p-3 flex items-center gap-2 flex-wrap">
        <button
          onClick={() => onUpdate(signal.id, 'triaged')}
          disabled={busy || signal.status === 'triaged'}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-emerald-500/40 bg-emerald-500/5 text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-50"
        >
          <CheckCircle2 className="w-3 h-3" /> Mark triaged
        </button>
        <button
          onClick={() => onUpdate(signal.id, 'accepted')}
          disabled={busy || signal.status === 'accepted'}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-purple-500/40 bg-purple-500/5 text-purple-500 hover:bg-purple-500/10 disabled:opacity-50"
        >
          <Wrench className="w-3 h-3" /> Accept
        </button>
        <button
          onClick={() => onUpdate(signal.id, 'dismissed')}
          disabled={busy || signal.status === 'dismissed'}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50"
        >
          <Trash2 className="w-3 h-3" /> Dismiss
        </button>
        {/* Phase 5E — operator-driven convert-to-task. Disabled once converted. */}
        <button
          onClick={() => { void onConvert(signal); }}
          disabled={busy || alreadyConverted}
          title={alreadyConverted ? CONVERT_DISABLED_TOOLTIP : 'Create a KanbanTask in backlog from this signal'}
          aria-label="Convert to KanbanTask"
          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-cyan-500/40 bg-cyan-500/5 text-cyan-500 hover:bg-cyan-500/10 disabled:opacity-50"
        >
          <ListChecks className="w-3 h-3" /> Convert to task
        </button>
        {/* Phase 6-D — Convert to SkillCandidate (review queue, no file generation). */}
        <button
          onClick={() => { void onConvertToSkillCandidate(signal); }}
          disabled={busy}
          title="Create a Skill Candidate for /skill-candidates review. No skill file is generated."
          aria-label="Convert to Skill Candidate"
          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-purple-500/40 bg-purple-500/5 text-purple-500 hover:bg-purple-500/10 disabled:opacity-50"
        >
          <Wrench className="w-3 h-3" /> Convert to Skill Candidate
        </button>
        {alreadyConverted && signal.convertedTaskId && (
          <Link
            href="/kanban"
            className="inline-flex items-center gap-1 text-[11px] text-cyan-500 hover:underline ml-1"
            title={`KanbanTask ${signal.convertedTaskId}`}
          >
            <Info className="w-3 h-3" /> See on Kanban
          </Link>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
 * Expanded detail panel + evidence preview
 * ========================================================================== */

function DetailPanel({ signal }: { signal: ImprovementSignal }) {
  const { artifacts, isLoading: artLoading } = useDorothyArtifactsByIds(signal.evidenceArtifactIds);

  return (
    <div className="border-t border-border bg-background/50 p-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        <Field label="Source"           value={signal.source.replace(/_/g, ' ')} />
        <Field label="Status"           value={signal.status.replace(/_/g, ' ')} />
        <Field label="Severity"         value={signal.severity} />
        <Field label="Occurrence count" value={`${signal.occurrenceCount ?? 1}`} />
        <Field label="Related agent"    value={signal.relatedAgentId ?? '—'} />
        <Field label="Related skill"    value={signal.relatedSkillId ?? '—'} />
        <Field label="Run"
          value={signal.runId ? (
            <Link href={`/runs/${signal.runId}`} className="hover:underline">
              <code className="font-mono">{signal.runId.slice(0, 8)}</code>
            </Link>
          ) : '—'}
        />
        <Field label="Fingerprint"      value={<code className="font-mono break-all">{signal.fingerprint ?? '—'}</code>} />
        <Field label="Created"          value={formatAbsolute(signal.createdAt)} sub={formatRelative(signal.createdAt)} />
        <Field label="Updated"          value={formatAbsolute(signal.updatedAt)} sub={formatRelative(signal.updatedAt)} />
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">요약</div>
        <p className="text-sm text-foreground whitespace-pre-wrap break-words">
          {maskSensitivePreview(signal.summary)}
        </p>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
          증거 ({signal.evidenceArtifactIds?.length ?? 0})
        </div>
        {(!signal.evidenceArtifactIds || signal.evidenceArtifactIds.length === 0) ? (
          <p className="text-xs text-muted-foreground italic">연결된 산출물이 없습니다.</p>
        ) : artLoading && artifacts.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">증거 불러오는 중…</p>
        ) : artifacts.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            Linked ids did not resolve — the artifact rows may have been deleted.
          </p>
        ) : (
          <ul className="space-y-2">
            {artifacts.map(a => <EvidenceItem key={a.id} artifact={a} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

function EvidenceItem({ artifact }: { artifact: Artifact }) {
  const isExternal = artifact.path?.startsWith('http://') || artifact.path?.startsWith('https://');
  const preview = useMemo(() => extractEvidencePreview(artifact), [artifact]);
  return (
    <li className="p-2 bg-card border border-border">
      <div className="flex items-start justify-between gap-2 flex-wrap mb-1">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <ArtifactTypeBadge type={artifact.type} />
          <span className="text-xs text-muted-foreground break-all">
            <code className="font-mono">{artifact.path ?? artifact.contentRef ?? '(no ref)'}</code>
          </span>
          <span className="text-[10px] text-muted-foreground">by <code className="font-mono">{artifact.producedByAgentId}</code></span>
          <span className="text-[10px] text-muted-foreground" title={formatAbsolute(artifact.createdAt)}>
            {formatRelative(artifact.createdAt)}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isExternal && artifact.path && (
            <a
              href={artifact.path}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] border border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
            >
              <ExternalLink className="w-3 h-3" /> Open
            </a>
          )}
          {!isExternal && artifact.path && (
            <Link
              href="/vault"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] border border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
              title={artifact.path}
            >
              <Archive className="w-3 h-3" /> Vault
            </Link>
          )}
          <Link
            href="/reports"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] border border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            Reports
          </Link>
        </div>
      </div>
      {preview && (
        <pre className="mt-1 p-2 bg-background border border-border text-[11px] text-muted-foreground whitespace-pre-wrap break-words line-clamp-6 max-h-32 overflow-hidden font-mono">
          {preview}
        </pre>
      )}
    </li>
  );
}

/**
 * Phase 5C-C — build a short evidence preview from `meta.summary`,
 * `meta.pr_body`, `meta.excerpt`, `meta.decision_note`, or the meta keys
 * themselves. Always masked. Capped to PREVIEW_MAX chars.
 */
function extractEvidencePreview(artifact: Artifact): string | null {
  const meta = (artifact.meta ?? {}) as Record<string, unknown>;
  const candidates = ['summary', 'pr_body', 'excerpt', 'decision_note', 'workflow'];
  for (const key of candidates) {
    const v = meta[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      return maskSensitivePreview(v.slice(0, PREVIEW_MAX));
    }
  }
  if (artifact.contentRef && artifact.contentRef.startsWith('inline:')) {
    return artifact.contentRef.slice(0, PREVIEW_MAX);
  }
  const keys = Object.keys(meta);
  if (!keys.length) return null;
  const compact = keys.map(k => `${k}: ${JSON.stringify(meta[k]).slice(0, 80)}`).join('\n');
  return maskSensitivePreview(compact.slice(0, PREVIEW_MAX));
}

/* ============================================================================
 * Tiny presentational helpers
 * ========================================================================== */

function Field({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground mt-0.5 break-words">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function SeverityChip({ severity }: { severity: ImprovementSignalSeverity }) {
  const cls = severity === 'high'   ? 'bg-rose-500/10 text-rose-500 border-rose-500/30'
            : severity === 'medium' ? 'bg-amber-500/10 text-amber-500 border-amber-500/30'
            : 'bg-muted text-muted-foreground border-border';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium border ${cls}`}>
      {severity}
    </span>
  );
}
