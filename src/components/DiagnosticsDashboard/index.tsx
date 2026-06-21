'use client';
import DetailModal from '@/components/DetailModal';

/**
 * Diagnostics Dashboard (/diagnostics) — Phase 6-A.
 *
 * Reads Diagnostics from the HookEvent-derived store and presents an
 * actionable triage surface. Strict read + light-write boundary:
 *   - Status updates (investigating / fixed / ignored) and Convert to
 *     ImprovementSignal are the only writes.
 *   - No raw HookEvent metadata is rendered without masking + clamping.
 *   - Evidence previews show ≤600 chars after masking.
 *
 * The Sidebar `/diagnostics` link lands here. Run Detail's Diagnostics tab
 * (Phase 6-A also) uses the same DiagnosticCard via shared props.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Inbox,
  Layers,
  Lightbulb,
  RefreshCw,
  Search,
  ShieldAlert,
  Stethoscope,
  Wrench,
  XCircle,
} from 'lucide-react';
import {
  useDorothyDiagnostics,
  useDorothyHookEvents,
} from '@/hooks/useDorothyRuns';
import { dorothyRunsClient } from '@/lib/dorothyRunsClient';
import type {
  Diagnostic,
  DiagnosticSource,
  DiagnosticSeverity,
  DiagnosticStatus,
  HookEvent,
} from '@/types/dorothy';
import {
  DIAGNOSTIC_SEVERITY_BADGE,
  DIAGNOSTIC_STATUS_BADGE,
  DIAGNOSTIC_SOURCE_BADGE,
  HOOK_EVENT_SEVERITY_BADGE,
} from '@/types/dorothy';
import {
  formatAbsolute,
  formatRelative,
  maskSensitivePreview,
} from '@/components/RunCommon/badges';

const PREVIEW_MAX = 600;

const STATUS_OPTIONS: { id: 'all' | DiagnosticStatus; label: string }[] = [
  { id: 'all',                       label: '전체' },
  { id: 'open',                      label: '열림' },
  { id: 'investigating',             label: '조사 중' },
  { id: 'fixed',                     label: '해결됨' },
  { id: 'ignored',                   label: '무시됨' },
  { id: 'converted_to_improvement',  label: '변환됨' },
];

const SOURCE_OPTIONS: { id: 'all' | DiagnosticSource; label: string }[] = [
  { id: 'all',             label: '전체 출처' },
  { id: 'ci_failure',      label: 'CI 실패' },
  { id: 'resume_failure',  label: '재개 실패' },
  { id: 'qa_failure',      label: 'QA 실패' },
  { id: 'orchestrator',    label: '오케스트레이터' },
  { id: 'agent_session',   label: '에이전트 세션' },
  { id: 'github_review',   label: 'GitHub 리뷰' },
  { id: 'approval_block',  label: '승인 차단' },
  { id: 'rate_limit',      label: '사용량 제한' },
  { id: 'hook_event',      label: '훅 이벤트' },
  { id: 'manual',          label: '수동' },
];

const SEVERITY_OPTIONS: { id: 'all' | DiagnosticSeverity; label: string }[] = [
  { id: 'all',      label: '전체 심각도' },
  { id: 'critical', label: '치명적' },
  { id: 'high',     label: '높음' },
  { id: 'medium',   label: '보통' },
  { id: 'low',      label: '낮음' },
];

// enum 값을 카드/배지에서 한글로 표시하기 위한 매핑(데이터는 그대로, 표시만 한글).
const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  critical: '치명적', high: '높음', medium: '보통', low: '낮음',
};
const SOURCE_LABEL: Record<DiagnosticSource, string> = {
  ci_failure: 'CI 실패', resume_failure: '재개 실패', qa_failure: 'QA 실패',
  orchestrator: '오케스트레이터', agent_session: '에이전트 세션', github_review: 'GitHub 리뷰',
  approval_block: '승인 차단', rate_limit: '사용량 제한', hook_event: '훅 이벤트', manual: '수동',
};
const STATUS_LABEL: Record<DiagnosticStatus, string> = {
  open: '열림', investigating: '조사 중', fixed: '해결됨', ignored: '무시됨',
  converted_to_improvement: '개선으로 변환됨', converted_to_task: '작업으로 변환됨',
};

export default function DiagnosticsDashboard() {
  const [statusFilter, setStatusFilter] = useState<'all' | DiagnosticStatus>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | DiagnosticSource>('all');
  const [severityFilter, setSeverityFilter] = useState<'all' | DiagnosticSeverity>('all');
  const [runIdFilter, setRunIdFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [query, setQuery] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const [recurringOnly, setRecurringOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: 'info' | 'error'; msg: string } | null>(null);

  const {
    diagnostics,
    isLoading,
    error,
    dbUnavailable,
    refresh,
  } = useDorothyDiagnostics({
    status: statusFilter === 'all' ? undefined : statusFilter,
    source: sourceFilter === 'all' ? undefined : sourceFilter,
    severity: severityFilter === 'all' ? undefined : severityFilter,
    runId: runIdFilter.trim() || undefined,
    agentId: agentFilter.trim() || undefined,
    onlyOpen: openOnly && statusFilter === 'all' ? true : undefined,
    minOccurrences: recurringOnly ? 2 : undefined,
    limit: 200,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return diagnostics;
    return diagnostics.filter(d => {
      const hay = [
        d.title,
        d.summary,
        d.rootCause ?? '',
        d.impact ?? '',
        d.suggestedFix ?? '',
        d.runId ?? '',
        d.agentId ?? '',
        d.source,
        d.status,
        d.severity,
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [diagnostics, query]);

  // Aggregate counts for the top KPI row.
  const counts = useMemo(() => {
    let open = 0, investigating = 0, fixed = 0, ignored = 0, critical = 0, highOrCritical = 0;
    for (const d of diagnostics) {
      if (d.status === 'open') open++;
      if (d.status === 'investigating') investigating++;
      if (d.status === 'fixed') fixed++;
      if (d.status === 'ignored') ignored++;
      if (d.severity === 'critical') critical++;
      if (d.severity === 'high' || d.severity === 'critical') highOrCritical++;
    }
    return { open, investigating, fixed, ignored, critical, highOrCritical, total: diagnostics.length };
  }, [diagnostics]);

  const onUpdateStatus = async (id: string, status: DiagnosticStatus) => {
    setBusyId(id);
    try {
      const res = await dorothyRunsClient.diagnostics.updateStatus({ id, status });
      if (!res.ok) {
        setBanner({ kind: 'error', msg: res.error ?? '상태 업데이트 실패' });
      } else {
        setBanner({ kind: 'info', msg: `진단을 "${STATUS_LABEL[status] ?? status}"(으)로 표시했습니다.` });
        await refresh();
      }
    } finally {
      setBusyId(null);
    }
  };

  const onConvert = async (d: Diagnostic) => {
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        `이 진단을 개선 신호(ImprovementSignal)로 변환할까요?\n\n${d.title}\n\n` +
        `${(d.summary ?? '').slice(0, 240)}\n\n` +
        '이 작업은 /improvements 에서 개선 신호를 편집해야만 되돌릴 수 있습니다.',
      );
      if (!ok) return;
    }
    setBusyId(d.id);
    try {
      const res = await dorothyRunsClient.diagnostics.convertToImprovement({ id: d.id });
      if (!res.ok) {
        setBanner({ kind: 'error', msg: res.error ?? '변환 실패' });
      } else {
        setBanner({ kind: 'info', msg: '개선 신호로 변환했습니다. /improvements 에서 확인하세요.' });
        await refresh();
      }
    } finally {
      setBusyId(null);
    }
  };

  // Phase 6-D — Convert to SkillCandidate. Distinct path; the Diagnostic
  // status is not flipped (a Diagnostic can remain in triage while a skill
  // candidate is being reviewed).
  const onConvertToSkillCandidate = async (d: Diagnostic) => {
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        `이 진단을 스킬 후보(Skill Candidate)로 변환할까요?\n\n${d.title}\n\n` +
        `${(d.summary ?? '').slice(0, 240)}\n\n` +
        '사람 검토용 후보를 /skill-candidates 에 생성합니다. 스킬 파일은 생성되지 않습니다.',
      );
      if (!ok) return;
    }
    setBusyId(d.id);
    try {
      const res = await dorothyRunsClient.skillCandidates.fromDiagnostic({ id: d.id });
      if (!res.ok) {
        setBanner({ kind: 'error', msg: res.error ?? '스킬 후보 변환 실패' });
      } else {
        setBanner({ kind: 'info', msg: '스킬 후보를 생성했습니다. /skill-candidates 에서 확인하세요.' });
      }
    } finally {
      setBusyId(null);
    }
  };

  if (dbUnavailable) {
    return (
      <Shell>
        <div className="p-4 border border-amber-500/30 bg-amber-500/5 text-amber-500 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          Dorothy 실행 데이터베이스를 사용할 수 없습니다 — 이 화면을 채우려면 Electron 앱을 실행하세요.
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Stethoscope className="w-5 h-5 text-foreground" />
          <h1 className="text-lg font-semibold text-foreground">진단</h1>
        </div>
        <button
          onClick={() => { void refresh(); }}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} /> 새로고침
        </button>
      </div>

      {banner && (
        <div
          className={`mb-3 p-3 border text-sm flex items-center gap-2 ${
            banner.kind === 'info'
              ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600'
              : 'border-rose-500/30 bg-rose-500/5 text-rose-500'
          }`}
        >
          {banner.kind === 'info' ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          <span>{banner.msg}</span>
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 mb-4">
        <Kpi label="열림"          value={counts.open}           color="text-blue-500" />
        <Kpi label="조사 중"        value={counts.investigating}  color="text-amber-500" />
        <Kpi label="높음/치명적"     value={counts.highOrCritical} color="text-orange-500" highlight={counts.highOrCritical > 0} />
        <Kpi label="치명적"         value={counts.critical}       color="text-rose-500" highlight={counts.critical > 0} />
        <Kpi label="해결됨"         value={counts.fixed}          color="text-emerald-500" />
        <Kpi label="전체"          value={counts.total}          color="text-foreground" />
      </div>

      {/* Filter bar */}
      <div className="bg-card border border-border p-3 mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground uppercase tracking-wider">필터:</span>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as 'all' | DiagnosticStatus)}
          className="px-2 py-1 bg-card border border-border text-foreground"
        >
          {STATUS_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <select
          value={sourceFilter}
          onChange={e => setSourceFilter(e.target.value as 'all' | DiagnosticSource)}
          className="px-2 py-1 bg-card border border-border text-foreground"
        >
          {SOURCE_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <select
          value={severityFilter}
          onChange={e => setSeverityFilter(e.target.value as 'all' | DiagnosticSeverity)}
          className="px-2 py-1 bg-card border border-border text-foreground"
        >
          {SEVERITY_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <input
          value={runIdFilter}
          onChange={e => setRunIdFilter(e.target.value)}
          placeholder="runId"
          className="px-2 py-1 bg-card border border-border text-foreground font-mono"
        />
        <input
          value={agentFilter}
          onChange={e => setAgentFilter(e.target.value)}
          placeholder="agentId"
          className="px-2 py-1 bg-card border border-border text-foreground font-mono"
        />
        <label className="inline-flex items-center gap-1 text-muted-foreground">
          <input
            type="checkbox"
            checked={openOnly}
            onChange={e => setOpenOnly(e.target.checked)}
          /> 열림만
        </label>
        <label className="inline-flex items-center gap-1 text-muted-foreground">
          <input
            type="checkbox"
            checked={recurringOnly}
            onChange={e => setRecurringOnly(e.target.checked)}
          /> 반복(≥2)
        </label>
        <div className="ml-auto flex items-center gap-1 px-2 py-1 bg-card border border-border">
          <Search className="w-3 h-3 text-muted-foreground" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="제목 / 요약 / runId 검색"
            className="bg-transparent outline-none w-72 text-foreground"
          />
        </div>
      </div>

      {/* List + detail */}
      {error && (
        <div className="p-3 border border-rose-500/30 bg-rose-500/5 text-rose-500 text-sm mb-3">
          {error}
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="border border-dashed border-border py-12 px-6 text-center text-muted-foreground">
          <Inbox className="w-8 h-8 inline-block opacity-50 mb-3" />
          <p className="text-sm">
            {isLoading ? '불러오는 중…' : '현재 필터에 맞는 진단이 없습니다.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {/* 팝업화 — 리스트는 항상 요약(collapsed). 클릭 시 상세는 DetailModal 로(메인 슬림). */}
          {filtered.map(d => (
            <DiagnosticCard
              key={d.id}
              diagnostic={d}
              expanded={false}
              busy={busyId === d.id}
              onToggle={() => setExpandedId(d.id)}
              onUpdateStatus={onUpdateStatus}
              onConvert={onConvert}
              onConvertToSkillCandidate={onConvertToSkillCandidate}
            />
          ))}
        </ul>
      )}

      {/* 팝업화 — 선택 진단 상세(요약은 리스트에·상세는 여기로 옮김·정보 손실 0·DiagnosticCard 재사용). */}
      {(() => {
        const detail = filtered.find(d => d.id === expandedId) ?? null;
        return (
          <DetailModal
            open={!!detail}
            onClose={() => setExpandedId(null)}
            title={detail?.title ?? '진단 상세'}
            subtitle={detail ? `${detail.source} · ${detail.severity}` : undefined}
            widthClass="max-w-2xl"
          >
            {detail && (
              <ul>
                <DiagnosticCard
                  diagnostic={detail}
                  expanded
                  busy={busyId === detail.id}
                  onToggle={() => setExpandedId(null)}
                  onUpdateStatus={onUpdateStatus}
                  onConvert={onConvert}
                  onConvertToSkillCandidate={onConvertToSkillCandidate}
                />
              </ul>
            )}
          </DetailModal>
        );
      })()}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="p-6 max-w-[1400px] mx-auto">{children}</div>;
}

function Kpi({
  label, value, color, highlight,
}: { label: string; value: number; color: string; highlight?: boolean }) {
  return (
    <div
      className={`bg-card border p-3 ${
        highlight ? 'border-orange-500/40' : 'border-border'
      }`}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

/* ============================================================================
 * DiagnosticCard
 *
 * Compact row in collapsed mode (severity / source / status / title / runId
 * link). Click expands to show summary / rootCause / impact / suggestedFix +
 * evidence HookEvent preview + the four operator actions.
 *
 * Exported so Run Detail's Diagnostics tab can reuse it.
 * ========================================================================== */

export interface DiagnosticCardProps {
  diagnostic: Diagnostic;
  expanded: boolean;
  busy?: boolean;
  onToggle?: () => void;
  onUpdateStatus?: (id: string, status: DiagnosticStatus) => void | Promise<void>;
  onConvert?: (d: Diagnostic) => void | Promise<void>;
  /** Phase 6-D — Convert to SkillCandidate. Optional so RunDetail can omit it. */
  onConvertToSkillCandidate?: (d: Diagnostic) => void | Promise<void>;
}

export function DiagnosticCard({
  diagnostic,
  expanded,
  busy = false,
  onToggle,
  onUpdateStatus,
  onConvert,
  onConvertToSkillCandidate,
}: DiagnosticCardProps) {
  const d = diagnostic;
  const alreadyConverted = d.status === 'converted_to_improvement' || d.status === 'converted_to_task';
  return (
    <li className="bg-card border border-border">
      <button
        type="button"
        onClick={onToggle}
        className="w-full p-3 flex items-start gap-3 text-left hover:bg-secondary/40"
      >
        {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground mt-1" /> : <ChevronRight className="w-4 h-4 text-muted-foreground mt-1" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className={`inline-flex items-center px-2 py-0.5 font-medium border ${DIAGNOSTIC_SEVERITY_BADGE[d.severity]}`}>
              {SEVERITY_LABEL[d.severity] ?? d.severity}
            </span>
            <span className={`inline-flex items-center px-2 py-0.5 font-medium border ${DIAGNOSTIC_SOURCE_BADGE[d.source]}`}>
              {SOURCE_LABEL[d.source] ?? d.source}
            </span>
            <span className={`inline-flex items-center px-2 py-0.5 font-medium border ${DIAGNOSTIC_STATUS_BADGE[d.status]}`}>
              {STATUS_LABEL[d.status] ?? d.status.replace(/_/g, ' ')}
            </span>
            {(d.occurrenceCount ?? 1) > 1 && (
              <span className="inline-flex items-center px-2 py-0.5 bg-amber-500/10 text-amber-500 border border-amber-500/30">
                ×{d.occurrenceCount}
              </span>
            )}
            <span className="text-muted-foreground" title={formatAbsolute(d.updatedAt)}>
              {formatRelative(d.updatedAt)}
            </span>
          </div>
          <div className="mt-1 text-sm text-foreground break-words">{d.title}</div>
          <div className="mt-1 text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
            {d.runId && <>run <code className="font-mono">{d.runId.slice(0, 8)}</code></>}
            {d.agentId && (
              <>
                <span>·</span>
                <code className="font-mono">{d.agentId}</code>
              </>
            )}
            {d.runStepId && (
              <>
                <span>·</span>
                <span>step {d.runStepId.slice(0, 8)}</span>
              </>
            )}
            {d.agentSessionId && (
              <>
                <span>·</span>
                <span>session {d.agentSessionId.slice(0, 8)}</span>
              </>
            )}
          </div>
        </div>
      </button>
      {expanded && (
        <DiagnosticDetailPanel
          diagnostic={d}
          busy={busy}
          onUpdateStatus={onUpdateStatus}
          onConvert={onConvert}
          onConvertToSkillCandidate={onConvertToSkillCandidate}
          alreadyConverted={alreadyConverted}
        />
      )}
    </li>
  );
}

function DiagnosticDetailPanel({
  diagnostic: d,
  busy,
  onUpdateStatus,
  onConvert,
  onConvertToSkillCandidate,
  alreadyConverted,
}: {
  diagnostic: Diagnostic;
  busy: boolean;
  onUpdateStatus?: (id: string, status: DiagnosticStatus) => void | Promise<void>;
  onConvert?: (d: Diagnostic) => void | Promise<void>;
  onConvertToSkillCandidate?: (d: Diagnostic) => void | Promise<void>;
  alreadyConverted: boolean;
}) {
  return (
    <div className="border-t border-border p-4 space-y-3">
      {d.summary && (
        <Field label="요약">
          <p className="text-sm text-foreground whitespace-pre-wrap">
            {maskSensitivePreview((d.summary ?? '').slice(0, PREVIEW_MAX))}
          </p>
        </Field>
      )}
      {d.rootCause && (
        <Field label="근본 원인">
          <p className="text-sm text-foreground whitespace-pre-wrap">
            {maskSensitivePreview((d.rootCause ?? '').slice(0, PREVIEW_MAX))}
          </p>
        </Field>
      )}
      {d.impact && (
        <Field label="영향">
          <p className="text-sm text-foreground whitespace-pre-wrap">
            {maskSensitivePreview((d.impact ?? '').slice(0, PREVIEW_MAX))}
          </p>
        </Field>
      )}
      {d.suggestedFix && (
        <Field label="제안된 해결책">
          <p className="text-sm text-foreground whitespace-pre-wrap flex items-start gap-2">
            <Lightbulb className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <span>{maskSensitivePreview((d.suggestedFix ?? '').slice(0, PREVIEW_MAX))}</span>
          </p>
        </Field>
      )}

      <EvidenceSection diagnostic={d} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted-foreground">
        <Meta label="진단 ID" value={<code className="font-mono">{d.id}</code>} />
        {d.fingerprint && (
          <Meta label="지문" value={<code className="font-mono">{d.fingerprint.slice(0, 80)}</code>} />
        )}
        <Meta label="생성" value={formatAbsolute(d.createdAt)} />
        <Meta label="업데이트" value={formatAbsolute(d.updatedAt)} />
        {d.relatedImprovementSignalId && (
          <Meta
            label="개선"
            value={
              <Link
                href="/improvements"
                className="inline-flex items-center gap-1 text-foreground hover:underline"
              >
                <ExternalLink className="w-3 h-3" /> {d.relatedImprovementSignalId.slice(0, 8)}
              </Link>
            }
          />
        )}
      </div>

      {d.runId && (
        <Link
          href={`/runs/${d.runId}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          실행 타임라인 열기 <ArrowRight className="w-3 h-3" />
        </Link>
      )}

      {/* Actions row */}
      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
        <ActionButton
          icon={<ShieldAlert className="w-3 h-3" />}
          label="조사 중"
          tone="amber"
          disabled={busy || d.status === 'investigating' || alreadyConverted}
          onClick={() => onUpdateStatus?.(d.id, 'investigating')}
        />
        <ActionButton
          icon={<CheckCircle2 className="w-3 h-3" />}
          label="해결됨으로 표시"
          tone="emerald"
          disabled={busy || d.status === 'fixed' || alreadyConverted}
          onClick={() => onUpdateStatus?.(d.id, 'fixed')}
        />
        <ActionButton
          icon={<AlertTriangle className="w-3 h-3" />}
          label="무시"
          tone="muted"
          disabled={busy || d.status === 'ignored' || alreadyConverted}
          onClick={() => onUpdateStatus?.(d.id, 'ignored')}
        />
        <ActionButton
          icon={<Wrench className="w-3 h-3" />}
          label="개선으로 변환"
          tone="purple"
          disabled={busy || alreadyConverted}
          title={alreadyConverted ? '이미 변환됨' : undefined}
          onClick={() => onConvert?.(d)}
        />
        {onConvertToSkillCandidate && (
          <ActionButton
            icon={<Layers className="w-3 h-3" />}
            label="스킬 후보로 변환"
            tone="cyan"
            disabled={busy}
            title="사람 검토용 후보를 /skill-candidates 에 생성합니다. 스킬 파일은 생성되지 않습니다."
            onClick={() => onConvertToSkillCandidate(d)}
          />
        )}
      </div>
    </div>
  );
}

function EvidenceSection({ diagnostic: d }: { diagnostic: Diagnostic }) {
  // Fetch the actual HookEvent rows for inline preview. We over-fetch a few
  // and filter client-side because the IPC handler currently accepts a single
  // filter, not a multi-id list. The cost is fine for the 0-10 ids per
  // Diagnostic that we typically see.
  const { events } = useDorothyHookEvents({
    runId: d.runId ?? undefined,
    limit: 200,
  });
  const matched = useMemo<HookEvent[]>(() => {
    const ids = new Set(d.evidenceHookEventIds ?? []);
    if (ids.size === 0) return [];
    return events.filter(e => ids.has(e.id)).slice(0, 5);
  }, [events, d.evidenceHookEventIds]);

  if (!d.evidenceHookEventIds?.length && !d.evidenceArtifactIds?.length) return null;

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        증거 (훅 이벤트 {d.evidenceHookEventIds.length}개
        {d.evidenceArtifactIds?.length ? ` · 산출물 ${d.evidenceArtifactIds.length}개` : ''})
      </div>
      {matched.length > 0 ? (
        <ul className="space-y-1.5 mt-1">
          {matched.map(ev => (
            <li
              key={ev.id}
              className="bg-background border border-border px-2 py-1 flex items-center gap-2 flex-wrap text-[11px]"
            >
              <span
                className={`inline-flex items-center px-1.5 py-0 text-[10px] border ${HOOK_EVENT_SEVERITY_BADGE[ev.severity]}`}
              >
                {ev.severity}
              </span>
              <code className="font-mono text-[10px] text-muted-foreground">{ev.type}</code>
              <span className="text-foreground break-words flex-1 min-w-0">{ev.title}</span>
              <span className="text-muted-foreground" title={formatAbsolute(ev.createdAt)}>
                {formatRelative(ev.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground italic">
          증거 행이 아직 로드되지 않았습니다 — 관련 실행을 열어 타임라인을 확인하세요.
        </p>
      )}
      {d.evidenceArtifactIds?.length ? (
        <div className="mt-1 text-[10px] text-muted-foreground">
          산출물 ID: {d.evidenceArtifactIds.slice(0, 5).map(a => a.slice(0, 8)).join(', ')}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="uppercase tracking-wider text-muted-foreground/80 text-[10px]">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function ActionButton({
  icon, label, tone, onClick, disabled, title,
}: {
  icon: React.ReactNode;
  label: string;
  tone: 'amber' | 'emerald' | 'muted' | 'purple' | 'cyan';
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const palette =
    tone === 'amber'   ? 'border-amber-500/30 bg-amber-500/5 text-amber-500 hover:bg-amber-500/10'
    : tone === 'emerald' ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-500 hover:bg-emerald-500/10'
    : tone === 'purple' ? 'border-purple-500/30 bg-purple-500/5 text-purple-500 hover:bg-purple-500/10'
    : tone === 'cyan'   ? 'border-cyan-500/30 bg-cyan-500/5 text-cyan-500 hover:bg-cyan-500/10'
    : 'border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary';
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2 py-1 text-xs border ${palette} disabled:opacity-40 disabled:hover:bg-transparent`}
    >
      {icon}
      {label}
    </button>
  );
}
