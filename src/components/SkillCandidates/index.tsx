'use client';

/**
 * Skill Candidates Dashboard (/skill-candidates) — Phase 6-D.
 *
 * Read + light-write surface for candidate skills derived from
 * ImprovementSignal / Diagnostic. Strict no-file-generation policy — even
 * accepted / ready_for_registry status only flags readiness; actual skill
 * registry registration is deferred (Phase 6-E).
 *
 * No auto-conversion from this UI. All conversions are operator-initiated
 * via confirm dialogs.
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
  FileWarning,
  Inbox,
  Layers,
  Lightbulb,
  RefreshCw,
  Search,
  Send,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useDorothySkillCandidates } from '@/hooks/useDorothyRuns';
import { dorothyRunsClient } from '@/lib/dorothyRunsClient';
import type {
  SkillCandidate,
  SkillCandidateCategory,
  SkillCandidateSeverity,
  SkillCandidateSource,
  SkillCandidateStatus,
} from '@/types/dorothy';
import {
  SKILL_CANDIDATE_STATUS_BADGE,
  SKILL_CANDIDATE_SEVERITY_BADGE,
  SKILL_CANDIDATE_CATEGORY_BADGE,
} from '@/types/dorothy';
import {
  formatAbsolute,
  formatRelative,
  maskSensitivePreview,
} from '@/components/RunCommon/badges';

const PREVIEW_MAX = 600;

const STATUS_OPTIONS: { id: 'all' | SkillCandidateStatus; label: string }[] = [
  { id: 'all',                  label: '전체' },
  { id: 'open',                 label: '열림' },
  { id: 'triaged',              label: '분류됨' },
  { id: 'accepted',             label: '승인됨' },
  { id: 'ready_for_registry',   label: '등록 준비됨' },
  { id: 'dismissed',            label: '기각됨' },
  { id: 'converted_to_task',    label: '변환됨' },
];

const SOURCE_OPTIONS: { id: 'all' | SkillCandidateSource; label: string }[] = [
  { id: 'all',                label: '전체 출처' },
  { id: 'improvement_signal', label: 'ImprovementSignal' },
  { id: 'diagnostic',         label: 'Diagnostic' },
  { id: 'workflow_progress',  label: 'WorkflowProgress' },
  { id: 'contract_drift',     label: '계약 드리프트' },
  { id: 'db_risk',            label: 'DB 위험' },
  { id: 'qa_failure',         label: 'QA 실패' },
  { id: 'ci_failure',         label: 'CI 실패' },
  { id: 'manual',             label: '수동' },
];

const CATEGORY_OPTIONS: { id: 'all' | SkillCandidateCategory; label: string }[] = [
  { id: 'all',           label: '전체 분류' },
  { id: 'frontend',      label: '프론트엔드' },
  { id: 'backend',       label: '백엔드' },
  { id: 'contract',      label: '계약' },
  { id: 'database',      label: '데이터베이스' },
  { id: 'qa',            label: 'QA' },
  { id: 'devops',        label: 'DevOps' },
  { id: 'orchestration', label: '오케스트레이션' },
  { id: 'security',      label: '보안' },
  { id: 'performance',   label: 'Performance' },
  { id: 'documentation', label: '문서화' },
  { id: 'general',       label: '일반' },
];

const SEVERITY_OPTIONS: { id: 'all' | SkillCandidateSeverity; label: string }[] = [
  { id: 'all',    label: '전체 심각도' },
  { id: 'high',   label: '높음' },
  { id: 'medium', label: '보통' },
  { id: 'low',    label: 'Low' },
];

export default function SkillCandidatesDashboard() {
  const [statusFilter, setStatusFilter] = useState<'all' | SkillCandidateStatus>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | SkillCandidateSource>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | SkillCandidateCategory>('all');
  const [severityFilter, setSeverityFilter] = useState<'all' | SkillCandidateSeverity>('all');
  const [agentFilter, setAgentFilter] = useState('');
  const [runIdFilter, setRunIdFilter] = useState('');
  const [query, setQuery] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const [recurringOnly, setRecurringOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: 'info' | 'error'; msg: string } | null>(null);

  const {
    candidates,
    isLoading,
    error,
    dbUnavailable,
    refresh,
  } = useDorothySkillCandidates({
    status: statusFilter === 'all' ? undefined : statusFilter,
    source: sourceFilter === 'all' ? undefined : sourceFilter,
    category: categoryFilter === 'all' ? undefined : categoryFilter,
    severity: severityFilter === 'all' ? undefined : severityFilter,
    runId: runIdFilter.trim() || undefined,
    agentId: agentFilter.trim() || undefined,
    onlyOpen: openOnly && statusFilter === 'all' ? true : undefined,
    minOccurrences: recurringOnly ? 2 : undefined,
    limit: 200,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(c => {
      const hay = [
        c.title,
        c.summary,
        c.proposedSkillName ?? '',
        c.proposedSkillDescription ?? '',
        c.proposedTrigger ?? '',
        c.runId ?? '',
        c.relatedAgentId ?? '',
        c.category,
        c.source,
        c.severity,
        c.status,
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [candidates, query]);

  const counts = useMemo(() => {
    let open = 0, triaged = 0, accepted = 0, ready = 0, dismissed = 0, converted = 0;
    for (const c of candidates) {
      if (c.status === 'open') open++;
      else if (c.status === 'triaged') triaged++;
      else if (c.status === 'accepted') accepted++;
      else if (c.status === 'ready_for_registry') ready++;
      else if (c.status === 'dismissed') dismissed++;
      else if (c.status === 'converted_to_task') converted++;
    }
    return { open, triaged, accepted, ready, dismissed, converted, total: candidates.length };
  }, [candidates]);

  const onUpdateStatus = async (id: string, status: SkillCandidateStatus) => {
    setBusyId(id);
    try {
      const res = await dorothyRunsClient.skillCandidates.updateStatus({ id, status });
      if (!res.ok) {
        setBanner({ kind: 'error', msg: res.error ?? 'updateStatus failed' });
      } else {
        setBanner({ kind: 'info', msg: `SkillCandidate marked ${status.replace(/_/g, ' ')}.` });
        await refresh();
      }
    } finally {
      setBusyId(null);
    }
  };

  const onConvert = async (c: SkillCandidate) => {
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        `Convert this SkillCandidate to a KanbanTask?\n\n${c.title}\n\n` +
        `${(c.summary ?? '').slice(0, 240)}\n\n` +
        'This creates a backlog task; no skill file is generated.',
      );
      if (!ok) return;
    }
    setBusyId(c.id);
    try {
      const res = await dorothyRunsClient.skillCandidates.convertToTask({ id: c.id });
      if (!res.ok) {
        setBanner({ kind: 'error', msg: res.error ?? 'convertToTask failed' });
      } else {
        setBanner({ kind: 'info', msg: 'KanbanTask로 변환되었습니다. /kanban에서 확인하세요.' });
        await refresh();
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
          Dorothy run database is not available — start the Electron app to populate this view.
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-foreground" />
          <h1 className="text-lg font-semibold text-foreground">스킬 후보</h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-amber-500" />
            Accept &amp; Ready for registry do <strong>not</strong> create skill files in this Phase.
          </span>
          <button
            onClick={() => { void refresh(); }}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} /> 새로고침
          </button>
        </div>
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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2 mb-4">
        <Kpi label="Open"          value={counts.open}      color="text-blue-500" />
        <Kpi label="Triaged"       value={counts.triaged}   color="text-amber-500" />
        <Kpi label="Accepted"      value={counts.accepted}  color="text-purple-500" />
        <Kpi label="Ready"         value={counts.ready}     color="text-emerald-500" highlight={counts.ready > 0} />
        <Kpi label="Converted"     value={counts.converted} color="text-cyan-500" />
        <Kpi label="Dismissed"     value={counts.dismissed} color="text-muted-foreground" />
        <Kpi label="Total"         value={counts.total}     color="text-foreground" />
      </div>

      {/* Filter bar */}
      <div className="bg-card border border-border p-3 mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground uppercase tracking-wider">필터:</span>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as 'all' | SkillCandidateStatus)}
          className="px-2 py-1 bg-card border border-border text-foreground"
        >
          {STATUS_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value as 'all' | SkillCandidateCategory)}
          className="px-2 py-1 bg-card border border-border text-foreground"
        >
          {CATEGORY_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <select
          value={sourceFilter}
          onChange={e => setSourceFilter(e.target.value as 'all' | SkillCandidateSource)}
          className="px-2 py-1 bg-card border border-border text-foreground"
        >
          {SOURCE_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <select
          value={severityFilter}
          onChange={e => setSeverityFilter(e.target.value as 'all' | SkillCandidateSeverity)}
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
          <input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} /> only open
        </label>
        <label className="inline-flex items-center gap-1 text-muted-foreground">
          <input type="checkbox" checked={recurringOnly} onChange={e => setRecurringOnly(e.target.checked)} /> recurring (≥2)
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

      {error && (
        <div className="p-3 border border-rose-500/30 bg-rose-500/5 text-rose-500 text-sm mb-3">{error}</div>
      )}
      {filtered.length === 0 ? (
        <div className="border border-dashed border-border py-12 px-6 text-center text-muted-foreground">
          <Inbox className="w-8 h-8 inline-block opacity-50 mb-3" />
          <p className="text-sm">
            {isLoading ? 'Loading…' : 'No skill candidates match the current filters.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map(c => (
            <SkillCandidateCard
              key={c.id}
              candidate={c}
              expanded={expandedId === c.id}
              busy={busyId === c.id}
              onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
              onUpdateStatus={onUpdateStatus}
              onConvert={onConvert}
            />
          ))}
        </ul>
      )}
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
    <div className={`bg-card border p-3 ${highlight ? 'border-emerald-500/40' : 'border-border'}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

export interface SkillCandidateCardProps {
  candidate: SkillCandidate;
  expanded: boolean;
  busy?: boolean;
  onToggle?: () => void;
  onUpdateStatus?: (id: string, status: SkillCandidateStatus) => void | Promise<void>;
  onConvert?: (c: SkillCandidate) => void | Promise<void>;
}

export function SkillCandidateCard({
  candidate,
  expanded,
  busy = false,
  onToggle,
  onUpdateStatus,
  onConvert,
}: SkillCandidateCardProps) {
  const c = candidate;
  const terminal = c.status === 'dismissed' || c.status === 'converted_to_task' || c.status === 'ready_for_registry';

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
            <span className={`inline-flex items-center px-2 py-0.5 font-medium border ${SKILL_CANDIDATE_SEVERITY_BADGE[c.severity]}`}>
              {c.severity}
            </span>
            <span className={`inline-flex items-center px-2 py-0.5 font-medium border ${SKILL_CANDIDATE_CATEGORY_BADGE[c.category]}`}>
              {c.category}
            </span>
            <span className={`inline-flex items-center px-2 py-0.5 font-medium border ${SKILL_CANDIDATE_STATUS_BADGE[c.status]}`}>
              {c.status.replace(/_/g, ' ')}
            </span>
            <code className="font-mono text-[10px] text-muted-foreground">{c.source}</code>
            {(c.occurrenceCount ?? 1) > 1 && (
              <span className="inline-flex items-center px-2 py-0.5 bg-amber-500/10 text-amber-500 border border-amber-500/30">
                ×{c.occurrenceCount}
              </span>
            )}
            <span className="ml-auto text-muted-foreground" title={formatAbsolute(c.updatedAt)}>
              {formatRelative(c.updatedAt)}
            </span>
          </div>
          <div className="mt-1 text-sm text-foreground break-words">{c.title}</div>
          <div className="mt-1 text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
            {c.proposedSkillName && <>name: <code className="font-mono">{c.proposedSkillName}</code></>}
            {c.runId && (
              <>
                <span>·</span>
                run <code className="font-mono">{c.runId.slice(0, 8)}</code>
              </>
            )}
            {c.relatedAgentId && (
              <>
                <span>·</span>
                <code className="font-mono">{c.relatedAgentId}</code>
              </>
            )}
          </div>
        </div>
      </button>
      {expanded && (
        <SkillCandidateDetailPanel
          candidate={c}
          busy={busy}
          terminal={terminal}
          onUpdateStatus={onUpdateStatus}
          onConvert={onConvert}
        />
      )}
    </li>
  );
}

function SkillCandidateDetailPanel({
  candidate: c,
  busy,
  terminal,
  onUpdateStatus,
  onConvert,
}: {
  candidate: SkillCandidate;
  busy: boolean;
  terminal: boolean;
  onUpdateStatus?: (id: string, status: SkillCandidateStatus) => void | Promise<void>;
  onConvert?: (c: SkillCandidate) => void | Promise<void>;
}) {
  return (
    <div className="border-t border-border p-4 space-y-3">
      {c.summary && (
        <Field label="Summary">
          <p className="text-sm text-foreground whitespace-pre-wrap">
            {maskSensitivePreview((c.summary ?? '').slice(0, PREVIEW_MAX))}
          </p>
        </Field>
      )}
      {c.proposedSkillDescription && (
        <Field label="Proposed skill description">
          <p className="text-sm text-foreground whitespace-pre-wrap">
            {maskSensitivePreview((c.proposedSkillDescription ?? '').slice(0, PREVIEW_MAX))}
          </p>
        </Field>
      )}
      {c.proposedTrigger && (
        <Field label="Proposed trigger">
          <p className="text-sm text-foreground whitespace-pre-wrap">
            {maskSensitivePreview((c.proposedTrigger ?? '').slice(0, PREVIEW_MAX))}
          </p>
        </Field>
      )}

      <ProposedList label="Proposed inputs" items={c.proposedInputs} />
      <ProposedList label="Proposed outputs" items={c.proposedOutputs} />
      <ProposedList label="Proposed guardrails" items={c.proposedGuardrails} icon={<AlertTriangle className="w-3 h-3 text-amber-500" />} />
      <ProposedList label="Proposed validation" items={c.proposedValidation} icon={<Lightbulb className="w-3 h-3 text-amber-500" />} />

      <EvidenceSection candidate={c} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted-foreground">
        <Meta label="Candidate id" value={<code className="font-mono">{c.id}</code>} />
        {c.fingerprint && (
          <Meta label="Fingerprint" value={<code className="font-mono">{c.fingerprint.slice(0, 80)}</code>} />
        )}
        <Meta label="Created" value={formatAbsolute(c.createdAt)} />
        <Meta label="Updated" value={formatAbsolute(c.updatedAt)} />
        {c.improvementSignalId && (
          <Meta
            label="Improvement"
            value={
              <Link href="/improvements" className="inline-flex items-center gap-1 text-foreground hover:underline">
                <ExternalLink className="w-3 h-3" /> {c.improvementSignalId.slice(0, 8)}
              </Link>
            }
          />
        )}
        {c.diagnosticId && (
          <Meta
            label="Diagnostic"
            value={
              <Link href="/diagnostics" className="inline-flex items-center gap-1 text-foreground hover:underline">
                <ExternalLink className="w-3 h-3" /> {c.diagnosticId.slice(0, 8)}
              </Link>
            }
          />
        )}
        {c.convertedTaskId && (
          <Meta
            label="KanbanTask"
            value={
              <Link href="/kanban" className="inline-flex items-center gap-1 text-foreground hover:underline">
                <ExternalLink className="w-3 h-3" /> {c.convertedTaskId.slice(0, 8)}
              </Link>
            }
          />
        )}
      </div>

      {c.runId && (
        <Link
          href={`/runs/${c.runId}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Open Run timeline <ArrowRight className="w-3 h-3" />
        </Link>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
        <ActionButton
          icon={<FileWarning className="w-3 h-3" />}
          label="Triage"
          tone="amber"
          disabled={busy || c.status === 'triaged' || terminal}
          onClick={() => onUpdateStatus?.(c.id, 'triaged')}
        />
        <ActionButton
          icon={<CheckCircle2 className="w-3 h-3" />}
          label="Accept"
          tone="purple"
          disabled={busy || c.status === 'accepted' || terminal}
          onClick={() => onUpdateStatus?.(c.id, 'accepted')}
        />
        <ActionButton
          icon={<Send className="w-3 h-3" />}
          label="Ready for registry"
          tone="emerald"
          title="Marks the candidate ready for human registration. Does NOT create skill files."
          disabled={busy || c.status === 'ready_for_registry' || terminal}
          onClick={() => onUpdateStatus?.(c.id, 'ready_for_registry')}
        />
        <ActionButton
          icon={<AlertTriangle className="w-3 h-3" />}
          label="Dismiss"
          tone="muted"
          disabled={busy || c.status === 'dismissed' || terminal}
          onClick={() => onUpdateStatus?.(c.id, 'dismissed')}
        />
        <ActionButton
          icon={<Wrench className="w-3 h-3" />}
          label="Convert to task"
          tone="cyan"
          disabled={busy || c.status === 'converted_to_task' || !!c.convertedTaskId}
          title={c.convertedTaskId ? 'Already converted to a KanbanTask' : undefined}
          onClick={() => onConvert?.(c)}
        />
      </div>
    </div>
  );
}

function EvidenceSection({ candidate: c }: { candidate: SkillCandidate }) {
  const hooks = c.evidenceHookEventIds ?? [];
  const arts = c.evidenceArtifactIds ?? [];
  const handoffs = c.evidenceHandoffIds ?? [];
  if (hooks.length === 0 && arts.length === 0 && handoffs.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        Evidence ids
      </div>
      <div className="text-[11px] text-muted-foreground space-y-0.5">
        {hooks.length > 0 && (
          <div>hooks: {hooks.slice(0, 5).map(id => id.slice(0, 8)).join(', ')}{hooks.length > 5 ? ` +${hooks.length - 5}` : ''}</div>
        )}
        {arts.length > 0 && (
          <div>artifacts: {arts.slice(0, 5).map(id => id.slice(0, 8)).join(', ')}{arts.length > 5 ? ` +${arts.length - 5}` : ''}</div>
        )}
        {handoffs.length > 0 && (
          <div>handoffs: {handoffs.slice(0, 5).map(id => id.slice(0, 8)).join(', ')}{handoffs.length > 5 ? ` +${handoffs.length - 5}` : ''}</div>
        )}
      </div>
    </div>
  );
}

function ProposedList({
  label, items, icon,
}: {
  label: string;
  items?: string[];
  icon?: React.ReactNode;
}) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <ul className="mt-1 space-y-0.5 text-[12px] text-foreground">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-1.5">
            {icon ?? <span className="mt-1.5 inline-block w-1 h-1 bg-muted-foreground/60 shrink-0" />}
            <span>{maskSensitivePreview(it.slice(0, 200))}</span>
          </li>
        ))}
      </ul>
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
