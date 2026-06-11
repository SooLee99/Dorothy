/**
 * Dorothy MVP Phase 6-A — Diagnostic service.
 *
 * A Diagnostic captures "Dorothy noticed this problem and is tracking how to
 * resolve it". Diagnostics are derived from HookEvents (see
 * `diagnostic-detector.ts`). They're separate from `ImprovementSignal`:
 *
 *   - Diagnostic        = current problem + status timeline
 *   - ImprovementSignal = recurring / structural pattern
 *
 * Storage rules (same family as HookEvent):
 *   - `summary` ≤ 500 chars, masked.
 *   - `rootCause` / `impact` / `suggestedFix` each ≤ 500 chars, masked.
 *   - `title` ≤ 140 chars, masked.
 *   - evidence id arrays are stored as JSON.
 *   - Diagnostic creation failures must not propagate; the wrapper
 *     `safeCreateDiagnostic` / `safeCreateOrUpdateDiagnostic` swallow + warn.
 *
 * Dedupe policy:
 *   - When a `fingerprint` is supplied, `createOrUpdateDiagnostic` looks up an
 *     existing row in the last 24h with the same fingerprint whose status is
 *     not in {`fixed`, `ignored`, `converted_to_task`, `converted_to_improvement`}
 *     and bumps `occurrence_count` + `updated_at` instead of inserting a new row.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import {
  createImprovementSignal,
  fingerprintFor,
} from './improvement-signal-service';
import { maskSensitive } from './hook-event-service';
import type {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticSource,
  DiagnosticStatus,
  CreateDiagnosticInput,
  UpdateDiagnosticStatusInput,
  ImprovementSignal,
} from '../../types/dorothy';

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_TITLE_LEN = 140;
const MAX_LONG_LEN = 500;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/* ============================================================================
 * Row mapping
 * ========================================================================== */

interface DiagnosticRow {
  id: string;
  run_id: string | null;
  run_step_id: string | null;
  agent_session_id: string | null;
  agent_id: string | null;
  source: string;
  severity: string;
  status: string;
  title: string;
  summary: string;
  root_cause: string | null;
  impact: string | null;
  suggested_fix: string | null;
  evidence_hook_event_ids_json: string | null;
  evidence_artifact_ids_json: string | null;
  related_improvement_signal_id: string | null;
  related_kanban_task_id: string | null;
  fingerprint: string | null;
  occurrence_count: number;
  created_at: string;
  updated_at: string;
}

function parseStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function rowToDiagnostic(r: DiagnosticRow): Diagnostic {
  return {
    id: r.id,
    runId: r.run_id,
    runStepId: r.run_step_id,
    agentSessionId: r.agent_session_id,
    agentId: r.agent_id,
    source: r.source as DiagnosticSource,
    severity: r.severity as DiagnosticSeverity,
    status: r.status as DiagnosticStatus,
    title: r.title,
    summary: r.summary,
    rootCause: r.root_cause,
    impact: r.impact,
    suggestedFix: r.suggested_fix,
    evidenceHookEventIds: parseStringList(r.evidence_hook_event_ids_json),
    evidenceArtifactIds: parseStringList(r.evidence_artifact_ids_json),
    relatedImprovementSignalId: r.related_improvement_signal_id,
    relatedKanbanTaskId: r.related_kanban_task_id,
    fingerprint: r.fingerprint,
    occurrenceCount: r.occurrence_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ============================================================================
 * Masking helpers — keep summary fields free of secrets.
 * ========================================================================== */

function clampString(value: string | null | undefined, max: number): string {
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function maskString(value: string | null | undefined): string | null {
  if (value == null) return null;
  // Round-trip through maskSensitive so the same inline regex rules used by
  // HookEvent apply here too. The util preserves strings end-to-end.
  const masked = maskSensitive(value);
  return typeof masked === 'string' ? masked : String(masked ?? '');
}

function normalizeStringField(value: string | null | undefined, max: number = MAX_LONG_LEN): string | null {
  if (value == null) return null;
  const masked = maskString(value);
  if (masked == null) return null;
  return clampString(masked, max);
}

function severityDefault(): DiagnosticSeverity {
  return 'medium';
}

/* ============================================================================
 * CRUD
 * ========================================================================== */

export function createDiagnostic(input: CreateDiagnosticInput): Diagnostic | null {
  const db = getDorothyDb();
  if (!db) return null;

  const id = uuidv4();
  const now = new Date().toISOString();
  const severity: DiagnosticSeverity = input.severity ?? severityDefault();
  const status: DiagnosticStatus = input.status ?? 'open';
  const title = clampString(maskString(input.title) ?? '', MAX_TITLE_LEN);
  const summary = normalizeStringField(input.summary, MAX_LONG_LEN) ?? '';
  const rootCause = normalizeStringField(input.rootCause, MAX_LONG_LEN);
  const impact = normalizeStringField(input.impact, MAX_LONG_LEN);
  const suggestedFix = normalizeStringField(input.suggestedFix, MAX_LONG_LEN);

  const hookIds = (input.evidenceHookEventIds ?? []).slice(0, 50);
  const artifactIds = (input.evidenceArtifactIds ?? []).slice(0, 50);

  db.prepare(`
    INSERT INTO diagnostics (
      id, run_id, run_step_id, agent_session_id, agent_id,
      source, severity, status,
      title, summary, root_cause, impact, suggested_fix,
      evidence_hook_event_ids_json, evidence_artifact_ids_json,
      related_improvement_signal_id, related_kanban_task_id,
      fingerprint, occurrence_count, created_at, updated_at
    ) VALUES (
      @id, @run_id, @run_step_id, @agent_session_id, @agent_id,
      @source, @severity, @status,
      @title, @summary, @root_cause, @impact, @suggested_fix,
      @hook_ids_json, @artifact_ids_json,
      NULL, NULL,
      @fingerprint, @occurrence_count, @now, @now
    )
  `).run({
    id,
    run_id: input.runId ?? null,
    run_step_id: input.runStepId ?? null,
    agent_session_id: input.agentSessionId ?? null,
    agent_id: input.agentId ?? null,
    source: input.source,
    severity,
    status,
    title,
    summary,
    root_cause: rootCause,
    impact,
    suggested_fix: suggestedFix,
    hook_ids_json: hookIds.length ? JSON.stringify(hookIds) : null,
    artifact_ids_json: artifactIds.length ? JSON.stringify(artifactIds) : null,
    fingerprint: input.fingerprint ?? null,
    occurrence_count: input.occurrenceCount ?? 1,
    now,
  });

  return getDiagnostic(id);
}

/**
 * Create-or-update with fingerprint-based dedupe. When a non-terminal
 * Diagnostic with the same fingerprint exists in the last 24h, bump
 * `occurrence_count` + `updated_at` + merge evidence ids (deduped).
 */
export function createOrUpdateDiagnostic(input: CreateDiagnosticInput): Diagnostic | null {
  const db = getDorothyDb();
  if (!db) return null;

  if (input.fingerprint) {
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    const existing = db.prepare(`
      SELECT * FROM diagnostics
      WHERE fingerprint = @fp
        AND updated_at >= @since
        AND status NOT IN ('fixed', 'ignored', 'converted_to_task', 'converted_to_improvement')
      ORDER BY updated_at DESC
      LIMIT 1
    `).get({ fp: input.fingerprint, since }) as DiagnosticRow | undefined;

    if (existing) {
      const nextCount = (existing.occurrence_count ?? 1) + 1;
      const now = new Date().toISOString();

      // Merge evidence id lists (deduped, capped at 100 each so we don't
      // explode on a chronically-failing flow).
      const existingHookIds = parseStringList(existing.evidence_hook_event_ids_json);
      const existingArtifactIds = parseStringList(existing.evidence_artifact_ids_json);
      const mergedHookIds = Array.from(new Set([
        ...existingHookIds,
        ...(input.evidenceHookEventIds ?? []),
      ])).slice(0, 100);
      const mergedArtifactIds = Array.from(new Set([
        ...existingArtifactIds,
        ...(input.evidenceArtifactIds ?? []),
      ])).slice(0, 100);

      db.prepare(`
        UPDATE diagnostics SET
          occurrence_count = @count,
          updated_at = @now,
          summary = @summary,
          evidence_hook_event_ids_json = @hook_ids_json,
          evidence_artifact_ids_json   = @artifact_ids_json
        WHERE id = @id
      `).run({
        id: existing.id,
        count: nextCount,
        now,
        summary: normalizeStringField(input.summary, MAX_LONG_LEN) ?? existing.summary,
        hook_ids_json: mergedHookIds.length ? JSON.stringify(mergedHookIds) : null,
        artifact_ids_json: mergedArtifactIds.length ? JSON.stringify(mergedArtifactIds) : null,
      });
      return getDiagnostic(existing.id);
    }
  }

  return createDiagnostic(input);
}

/** Same as createDiagnostic but never throws. Use in hot paths. */
export function safeCreateDiagnostic(input: CreateDiagnosticInput): Diagnostic | null {
  try {
    return createDiagnostic(input);
  } catch (err) {
    console.warn(
      '[diagnostic] safeCreateDiagnostic suppressed error:',
      err instanceof Error ? err.message : 'unknown',
    );
    return null;
  }
}

/** Same as createOrUpdateDiagnostic but never throws. */
export function safeCreateOrUpdateDiagnostic(input: CreateDiagnosticInput): Diagnostic | null {
  try {
    return createOrUpdateDiagnostic(input);
  } catch (err) {
    console.warn(
      '[diagnostic] safeCreateOrUpdateDiagnostic suppressed error:',
      err instanceof Error ? err.message : 'unknown',
    );
    return null;
  }
}

export function getDiagnostic(id: string): Diagnostic | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM diagnostics WHERE id = ?').get(id) as
    | DiagnosticRow
    | undefined;
  return row ? rowToDiagnostic(row) : null;
}

export interface ListDiagnosticsOptions {
  runId?: string;
  runStepId?: string;
  agentSessionId?: string;
  agentId?: string;
  source?: DiagnosticSource | DiagnosticSource[];
  severity?: DiagnosticSeverity | DiagnosticSeverity[];
  status?: DiagnosticStatus | DiagnosticStatus[];
  /** When true, restrict to status='open'. */
  onlyOpen?: boolean;
  /** When set, restrict to `occurrence_count >= n`. */
  minOccurrences?: number;
  /** Default 200, cap 500. */
  limit?: number;
  offset?: number;
}

function clampLimit(n: number | undefined): number {
  const v = n ?? DEFAULT_LIMIT;
  if (v <= 0) return DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

export function listDiagnostics(opts: ListDiagnosticsOptions = {}): Diagnostic[] {
  const db = getDorothyDb();
  if (!db) return [];

  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts.runId)            { where.push('run_id = @run_id');             params.run_id = opts.runId; }
  if (opts.runStepId)        { where.push('run_step_id = @run_step_id');   params.run_step_id = opts.runStepId; }
  if (opts.agentSessionId)   { where.push('agent_session_id = @session_id'); params.session_id = opts.agentSessionId; }
  if (opts.agentId)          { where.push('agent_id = @agent_id');         params.agent_id = opts.agentId; }
  if (opts.onlyOpen)         { where.push("status = 'open'"); }
  if (opts.minOccurrences && opts.minOccurrences > 0) {
    where.push('occurrence_count >= @min_occ');
    params.min_occ = opts.minOccurrences;
  }
  if (opts.source) {
    if (Array.isArray(opts.source)) {
      const placeholders = opts.source.map((_, i) => `@src${i}`);
      opts.source.forEach((s, i) => { params[`src${i}`] = s; });
      where.push(`source IN (${placeholders.join(',')})`);
    } else { where.push('source = @source'); params.source = opts.source; }
  }
  if (opts.severity) {
    if (Array.isArray(opts.severity)) {
      const placeholders = opts.severity.map((_, i) => `@sev${i}`);
      opts.severity.forEach((s, i) => { params[`sev${i}`] = s; });
      where.push(`severity IN (${placeholders.join(',')})`);
    } else { where.push('severity = @severity'); params.severity = opts.severity; }
  }
  if (opts.status) {
    if (Array.isArray(opts.status)) {
      const placeholders = opts.status.map((_, i) => `@st${i}`);
      opts.status.forEach((s, i) => { params[`st${i}`] = s; });
      where.push(`status IN (${placeholders.join(',')})`);
    } else { where.push('status = @status'); params.status = opts.status; }
  }

  const limit = clampLimit(opts.limit);
  const offset = opts.offset ?? 0;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT * FROM diagnostics
    ${whereSql}
    ORDER BY updated_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }) as DiagnosticRow[];
  return rows.map(rowToDiagnostic);
}

export function listDiagnosticsByRun(runId: string, opts: Omit<ListDiagnosticsOptions, 'runId'> = {}): Diagnostic[] {
  return listDiagnostics({ ...opts, runId });
}

export function updateDiagnosticStatus(input: UpdateDiagnosticStatusInput): Diagnostic | null {
  const db = getDorothyDb();
  if (!db) return null;
  const current = getDiagnostic(input.id);
  if (!current) return null;

  const now = new Date().toISOString();
  const nextSummary = input.note
    ? clampString(`${current.summary}\n\n— note: ${normalizeStringField(input.note, 200) ?? ''}`, MAX_LONG_LEN * 2)
    : current.summary;

  db.prepare(`
    UPDATE diagnostics SET
      status = @status,
      summary = @summary,
      updated_at = @now
    WHERE id = @id
  `).run({
    id: input.id,
    status: input.status,
    summary: nextSummary,
    now,
  });
  return getDiagnostic(input.id);
}

/* ============================================================================
 * Diagnostic ↔ ImprovementSignal
 * ========================================================================== */

export function linkDiagnosticToImprovementSignal(
  diagnosticId: string,
  improvementSignalId: string,
): Diagnostic | null {
  const db = getDorothyDb();
  if (!db) return null;
  const current = getDiagnostic(diagnosticId);
  if (!current) return null;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE diagnostics SET
      related_improvement_signal_id = @sid,
      updated_at = @now
    WHERE id = @id
  `).run({ id: diagnosticId, sid: improvementSignalId, now });
  return getDiagnostic(diagnosticId);
}

export interface ConvertDiagnosticResult {
  ok: boolean;
  diagnostic: Diagnostic | null;
  signal: ImprovementSignal | null;
  reason?: string;
}

const SOURCE_TO_IMPROVEMENT_SOURCE: Record<DiagnosticSource, 'qa_failure' | 'ci_failure' | 'rate_limit' | 'approval_required' | 'review_changes_requested' | 'retry_exceeded' | 'manual_note'> = {
  qa_failure: 'qa_failure',
  ci_failure: 'ci_failure',
  rate_limit: 'rate_limit',
  resume_failure: 'rate_limit',
  approval_block: 'approval_required',
  github_review: 'review_changes_requested',
  orchestrator: 'retry_exceeded',
  agent_session: 'retry_exceeded',
  hook_event: 'manual_note',
  manual: 'manual_note',
};

/**
 * Operator-initiated conversion. Refuses to re-convert and de-dupes via the
 * fingerprint already on the Diagnostic. The resulting ImprovementSignal
 * gets the standard `[Diagnostic] ${title}` prefix and a summary block
 * describing the originating diagnosis.
 */
export function convertDiagnosticToImprovementSignal(diagnosticId: string): ConvertDiagnosticResult {
  const db = getDorothyDb();
  if (!db) return { ok: false, diagnostic: null, signal: null, reason: 'dorothy.db not initialized' };

  const diag = getDiagnostic(diagnosticId);
  if (!diag) return { ok: false, diagnostic: null, signal: null, reason: 'diagnostic not found' };

  if (diag.status === 'converted_to_improvement' && diag.relatedImprovementSignalId) {
    // Already converted — return existing relationship.
    return {
      ok: true,
      diagnostic: diag,
      signal: null,
      reason: 'already-converted',
    };
  }
  if (diag.status === 'converted_to_task') {
    return { ok: false, diagnostic: diag, signal: null, reason: 'already-converted-to-task' };
  }

  const title = clampString(`[Diagnostic] ${diag.title}`, MAX_TITLE_LEN);

  const lines: string[] = [];
  lines.push(diag.summary);
  lines.push('');
  lines.push('---');
  if (diag.rootCause)    lines.push(`rootCause: ${diag.rootCause}`);
  if (diag.impact)       lines.push(`impact: ${diag.impact}`);
  if (diag.suggestedFix) lines.push(`suggestedFix: ${diag.suggestedFix}`);
  if (diag.evidenceHookEventIds.length) {
    lines.push(`evidenceHookEventIds: ${diag.evidenceHookEventIds.slice(0, 10).join(', ')}`);
  }
  if (diag.evidenceArtifactIds?.length) {
    lines.push(`evidenceArtifactIds: ${diag.evidenceArtifactIds.slice(0, 10).join(', ')}`);
  }
  lines.push(`diagnosticId: ${diag.id}`);

  // Reuse the existing ImprovementSignal fingerprint helper so back-to-back
  // converts of similar Diagnostics still roll up via dedupe.
  const sigSource = SOURCE_TO_IMPROVEMENT_SOURCE[diag.source] ?? 'manual_note';
  const fp = diag.fingerprint ?? fingerprintFor({
    source: sigSource,
    runId: diag.runId ?? null,
    relatedAgentId: diag.agentId ?? null,
    normalizedTitle: `diag:${diag.title}`,
  });

  const signal = createImprovementSignal({
    runId: diag.runId ?? null,
    source: sigSource,
    severity: diag.severity === 'critical' ? 'high'
            : diag.severity === 'high' ? 'high'
            : diag.severity === 'low' ? 'low'
            : 'medium',
    title,
    summary: clampString(lines.join('\n'), 4000),
    evidenceArtifactIds: diag.evidenceArtifactIds,
    relatedAgentId: diag.agentId ?? null,
    fingerprint: fp,
  });

  if (!signal) {
    return { ok: false, diagnostic: diag, signal: null, reason: 'createImprovementSignal returned null' };
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE diagnostics SET
      status = 'converted_to_improvement',
      related_improvement_signal_id = @sid,
      updated_at = @now
    WHERE id = @id
  `).run({ id: diag.id, sid: signal.id, now });

  return { ok: true, diagnostic: getDiagnostic(diag.id), signal };
}

/* ============================================================================
 * Counts (used by Settings + Command Center)
 * ========================================================================== */

export interface DiagnosticCounts {
  open: number;
  investigating: number;
  fixed: number;
  ignored: number;
  convertedToTask: number;
  convertedToImprovement: number;
  highOrCritical: number;
  total: number;
}

export function countDiagnostics(): DiagnosticCounts {
  const db = getDorothyDb();
  if (!db) {
    return { open: 0, investigating: 0, fixed: 0, ignored: 0, convertedToTask: 0, convertedToImprovement: 0, highOrCritical: 0, total: 0 };
  }
  type StatusRow = { status: string; n: number };
  type SeverityRow = { severity: string; n: number };
  const byStatus = db.prepare(`SELECT status, COUNT(*) AS n FROM diagnostics GROUP BY status`).all() as StatusRow[];
  const bySeverity = db.prepare(`SELECT severity, COUNT(*) AS n FROM diagnostics GROUP BY severity`).all() as SeverityRow[];
  let total = 0;
  const c: DiagnosticCounts = {
    open: 0, investigating: 0, fixed: 0, ignored: 0,
    convertedToTask: 0, convertedToImprovement: 0,
    highOrCritical: 0, total: 0,
  };
  for (const row of byStatus) {
    total += row.n;
    switch (row.status) {
      case 'open':                     c.open = row.n; break;
      case 'investigating':            c.investigating = row.n; break;
      case 'fixed':                    c.fixed = row.n; break;
      case 'ignored':                  c.ignored = row.n; break;
      case 'converted_to_task':        c.convertedToTask = row.n; break;
      case 'converted_to_improvement': c.convertedToImprovement = row.n; break;
    }
  }
  for (const row of bySeverity) {
    if (row.severity === 'high' || row.severity === 'critical') c.highOrCritical += row.n;
  }
  c.total = total;
  return c;
}
