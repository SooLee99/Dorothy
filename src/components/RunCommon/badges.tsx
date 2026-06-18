'use client';

/**
 * Small visual primitives shared between Run Board, Run Detail, Sessions, and
 * the Active Run Summary widget. Kept tiny on purpose — every screen uses the
 * same tailwind utility classes from the project, no new UI library.
 */

import type {
  RunState,
  Priority,
  RunStepState,
  AgentSessionEndStatus,
  PullRequestState,
  CIRunState,
  ArtifactType,
} from '@/types/dorothy';
import {
  RUN_STATE_BADGE,
  PRIORITY_BADGE,
  PR_STATE_BADGE,
  CI_STATE_BADGE,
} from '@/types/dorothy';

const STEP_STATE_BADGE: Record<RunStepState, string> = {
  pending:   'bg-muted text-muted-foreground border-border',
  running:   'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  completed: 'bg-emerald-700/15 text-emerald-700 border-emerald-700/30',
  failed:    'bg-rose-500/10 text-rose-500 border-rose-500/30',
  skipped:   'bg-muted text-muted-foreground border-border',
  cancelled: 'bg-muted text-muted-foreground border-border',
};

const SESSION_END_BADGE: Record<AgentSessionEndStatus, string> = {
  completed: 'bg-emerald-700/15 text-emerald-700 border-emerald-700/30',
  failed:    'bg-rose-500/10 text-rose-500 border-rose-500/30',
  cancelled: 'bg-muted text-muted-foreground border-border',
  timeout:   'bg-amber-500/10 text-amber-500 border-amber-500/30',
};

export function StateBadge({ state }: { state: RunState }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border ${RUN_STATE_BADGE[state]}`}>
      {state}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium ${PRIORITY_BADGE[priority]}`}>
      {priority}
    </span>
  );
}

export function StepStateBadge({ state }: { state: RunStepState }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border ${STEP_STATE_BADGE[state]}`}>
      {state}
    </span>
  );
}

export function PullRequestStateBadge({ state }: { state: PullRequestState }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border ${PR_STATE_BADGE[state]}`}>
      {state.replace(/_/g, ' ')}
    </span>
  );
}

export function CIRunStateBadge({ state }: { state: CIRunState }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border ${CI_STATE_BADGE[state]}`}>
      {state}
    </span>
  );
}

const ARTIFACT_TYPE_BADGE: Record<ArtifactType, string> = {
  report: 'bg-purple-500/10 text-purple-500 border-purple-500/30',
  doc:    'bg-blue-500/10 text-blue-500 border-blue-500/30',
  review: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  test:   'bg-amber-500/10 text-amber-500 border-amber-500/30',
  patch:  'bg-cyan-500/10 text-cyan-500 border-cyan-500/30',
  other:  'bg-muted text-muted-foreground border-border',
};

export function ArtifactTypeBadge({ type }: { type: ArtifactType }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border ${ARTIFACT_TYPE_BADGE[type]}`}>
      {type}
    </span>
  );
}

export function SessionStatusBadge({
  endStatus,
  active,
}: {
  endStatus?: AgentSessionEndStatus | null;
  active: boolean;
}) {
  if (active) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium border bg-emerald-500/10 text-emerald-500 border-emerald-500/30">
        running
      </span>
    );
  }
  if (!endStatus) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium border bg-muted text-muted-foreground border-border">
        unknown
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border ${SESSION_END_BADGE[endStatus]}`}>
      {endStatus}
    </span>
  );
}

/* ============================================================================
 * Time helpers — no external library to stay consistent with the rest of the
 * codebase (other dashboards just hand-format Date strings).
 * ========================================================================== */

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 5) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/**
 * Phase 5C-C — extended sensitive-pattern masker. Covers the keywords the
 * spec calls out plus the common `Authorization: Bearer <token>` shape that
 * sneaks into webhook payloads. The keyword itself is preserved so the
 * reader knows *what* was masked.
 */
export function maskSensitivePreview(text: string): string {
  if (!text) return '';
  return text
    // key: value / key=value style
    .replace(
      /\b(secret|token|password|api[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token)\b\s*[:=]\s*[^\s"',]+/gi,
      (_full, kw: string) => `${kw}: ***`,
    )
    // Authorization: Bearer xxxxxx
    .replace(
      /\b(authorization|auth)\s*[:=]\s*bearer\s+\S+/gi,
      (_full, kw: string) => `${kw}: Bearer ***`,
    );
}

export function durationBetween(
  start: string | null | undefined,
  end: string | null | undefined
): string {
  if (!start) return '—';
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(s) || Number.isNaN(e)) return '—';
  const ms = Math.max(0, e - s);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}
