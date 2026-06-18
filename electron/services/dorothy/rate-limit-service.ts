/**
 * Dorothy MVP — RateLimitEvent service.
 *
 * Phase 1 — only persists events.
 * Phase 5C-B — extends each event with resume scheduling fields
 * (`provider`, `resumeAt`, `resumeStatus`, `retryCount`, `lastResumeError`,
 * `affectedSessionIds`, `affectedRunStepIds`, `messageExcerpt`,
 * `parseConfidence`). Schema migration lives in db.ts; this service handles
 * the read/write surface.
 *
 * Auto-resume itself lives in `auto-resume-scheduler.ts` — this file stays
 * pure data + null-safe.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import { safeCreateHookEvent, makeExcerpt } from './hook-event-service';
import { safeDetectDiagnosticFromHookEvent } from './diagnostic-detector';
import { safeUpdateWorkflowProgressFromHookEvent } from './agent-workflow-progress-service';
import type {
  RateLimitEvent,
  RateLimitEngine,
  RateLimitSourceExtended,
  RateLimitProvider,
  RateLimitResumeStatus,
  CreateRateLimitEventInput,
} from '../../types/dorothy';

interface Row {
  id: string;
  engine: string;
  detected_at: string;
  reset_at: string | null;
  resumed_at: string | null;
  resolved_at: string | null;
  source: string;
  message: string | null;
  raw_ref: string | null;
  affected_run_ids_json: string | null;
  // Phase 5C-B columns (nullable; present after ALTER TABLE in db.ts).
  provider: string | null;
  resume_at: string | null;
  resume_status: string | null;
  affected_session_ids_json: string | null;
  affected_run_step_ids_json: string | null;
  retry_count: number | null;
  last_resume_error: string | null;
  message_excerpt: string | null;
  parse_confidence: string | null;
}

function parseList(s: string | null): string[] | undefined {
  if (!s) return undefined;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as string[]) : undefined;
  } catch { return undefined; }
}

function rowToEvent(r: Row): RateLimitEvent {
  return {
    id: r.id,
    engine: r.engine as RateLimitEngine,
    detectedAt: r.detected_at,
    resetAt: r.reset_at,
    resumedAt: r.resumed_at,
    resolvedAt: r.resolved_at,
    source: r.source as RateLimitSourceExtended,
    message: r.message,
    rawRef: r.raw_ref,
    affectedRunIds: parseList(r.affected_run_ids_json),
    provider: (r.provider ?? null) as RateLimitProvider | null,
    resumeAt: r.resume_at,
    resumeStatus: (r.resume_status ?? null) as RateLimitResumeStatus | null,
    affectedSessionIds: parseList(r.affected_session_ids_json),
    affectedRunStepIds: parseList(r.affected_run_step_ids_json),
    retryCount: r.retry_count ?? 0,
    lastResumeError: r.last_resume_error,
    messageExcerpt: r.message_excerpt,
    parseConfidence: (r.parse_confidence ?? null) as 'high' | 'medium' | 'low' | null,
  };
}

/* ============================================================================
 * Inputs
 * ========================================================================== */

export interface CreateRateLimitEventInputExtended extends CreateRateLimitEventInput {
  provider?: RateLimitProvider | null;
  resumeAt?: string | null;
  resumeStatus?: RateLimitResumeStatus | null;
  affectedSessionIds?: string[];
  affectedRunStepIds?: string[];
  messageExcerpt?: string | null;
  parseConfidence?: 'high' | 'medium' | 'low' | null;
}

export function createRateLimitEvent(input: CreateRateLimitEventInputExtended): RateLimitEvent | null {
  const db = getDorothyDb();
  if (!db) return null;
  const id = uuidv4();
  const detectedAt = input.detectedAt ?? new Date().toISOString();
  // Decide an initial resume status: confidence high/medium + resumeAt → scheduled;
  // resumeAt without confidence or low confidence → pending (manual review).
  let resumeStatus: RateLimitResumeStatus = input.resumeStatus ?? 'pending';
  if (!input.resumeStatus) {
    if (input.resumeAt && input.parseConfidence !== 'low') {
      resumeStatus = 'scheduled';
    }
  }
  db.prepare(`
    INSERT INTO rate_limit_events (
      id, engine, detected_at, reset_at, resumed_at, resolved_at,
      source, message, raw_ref, affected_run_ids_json,
      provider, resume_at, resume_status,
      affected_session_ids_json, affected_run_step_ids_json,
      retry_count, last_resume_error, message_excerpt, parse_confidence
    ) VALUES (
      @id, @engine, @detected_at, @reset_at, NULL, NULL,
      @source, @message, @raw_ref, @affected_json,
      @provider, @resume_at, @resume_status,
      @affected_sessions_json, @affected_steps_json,
      0, NULL, @message_excerpt, @parse_confidence
    )
  `).run({
    id,
    engine: input.engine,
    detected_at: detectedAt,
    reset_at: input.resetAt ?? null,
    source: input.source,
    message: input.message ?? null,
    raw_ref: input.rawRef ?? null,
    affected_json: input.affectedRunIds && input.affectedRunIds.length ? JSON.stringify(input.affectedRunIds) : null,
    provider: input.provider ?? null,
    resume_at: input.resumeAt ?? null,
    resume_status: resumeStatus,
    affected_sessions_json: input.affectedSessionIds && input.affectedSessionIds.length ? JSON.stringify(input.affectedSessionIds) : null,
    affected_steps_json: input.affectedRunStepIds && input.affectedRunStepIds.length ? JSON.stringify(input.affectedRunStepIds) : null,
    message_excerpt: input.messageExcerpt ?? null,
    parse_confidence: input.parseConfidence ?? null,
  });
  // Phase 5F — emit both rate_limit_detected and the resume schedule event
  // (when a resumeAt is known). The detected row carries provider/engine, the
  // schedule row carries the resumeAt + parseConfidence so the timeline can
  // surface the cooldown explicitly.
  const firstAffectedRun = (input.affectedRunIds ?? [])[0] ?? null;
  const detectedEv = safeCreateHookEvent({
    type: 'rate_limit_detected',
    severity: 'warning',
    source: 'rate_limit',
    runId: firstAffectedRun,
    rateLimitEventId: id,
    title: `Rate limit detected (${input.provider ?? input.engine})`,
    summary: makeExcerpt(input.messageExcerpt ?? input.message ?? null, 240),
    metadata: {
      engine: input.engine,
      provider: input.provider ?? null,
      source: input.source,
      resetAt: input.resetAt ?? null,
      parseConfidence: input.parseConfidence ?? null,
      excerpt: input.messageExcerpt ?? null,
      affectedRunIds: input.affectedRunIds ?? [],
      affectedSessionIds: input.affectedSessionIds ?? [],
      affectedRunStepIds: input.affectedRunStepIds ?? [],
    },
  });
  // Phase 6-A — track repeating rate limits via Diagnostic (low severity).
  safeDetectDiagnosticFromHookEvent(detectedEv);
  // Phase 6-B — block active workflows on the Run.
  safeUpdateWorkflowProgressFromHookEvent(detectedEv);
  if (input.resumeAt && resumeStatus === 'scheduled') {
    safeCreateHookEvent({
      type: 'rate_limit_scheduled',
      severity: 'info',
      source: 'rate_limit',
      runId: firstAffectedRun,
      rateLimitEventId: id,
      title: `Rate limit resume scheduled — ${input.resumeAt}`,
      summary: input.messageExcerpt ?? null,
      metadata: {
        engine: input.engine,
        provider: input.provider ?? null,
        resumeAt: input.resumeAt,
        parseConfidence: input.parseConfidence ?? null,
      },
    });
  }
  return getRateLimitEvent(id);
}

export function getRateLimitEvent(id: string): RateLimitEvent | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM rate_limit_events WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToEvent(row) : null;
}

export function listRateLimitEvents(opts: {
  engine?: RateLimitEngine;
  active?: boolean;
  resumeStatus?: RateLimitResumeStatus | RateLimitResumeStatus[];
  limit?: number;
} = {}): RateLimitEvent[] {
  const db = getDorothyDb();
  if (!db) return [];
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.engine)            { where.push('engine = @engine'); params.engine = opts.engine; }
  if (opts.active === true)   where.push('resolved_at IS NULL');
  if (opts.active === false)  where.push('resolved_at IS NOT NULL');
  if (opts.resumeStatus) {
    if (Array.isArray(opts.resumeStatus)) {
      const placeholders = opts.resumeStatus.map((_, i) => `@rs${i}`);
      opts.resumeStatus.forEach((s, i) => { params[`rs${i}`] = s; });
      where.push(`resume_status IN (${placeholders.join(',')})`);
    } else {
      where.push('resume_status = @resume_status');
      params.resume_status = opts.resumeStatus;
    }
  }
  const sql = `
    SELECT * FROM rate_limit_events
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY detected_at DESC
    LIMIT @limit
  `;
  const rows = db.prepare(sql).all({ ...params, limit: opts.limit ?? 200 }) as Row[];
  return rows.map(rowToEvent);
}

/** List events ready (or overdue) for resume — i.e. scheduled and resumeAt <= now. */
export function listResumeReadyEvents(now: Date = new Date()): RateLimitEvent[] {
  const db = getDorothyDb();
  if (!db) return [];
  const iso = now.toISOString();
  const rows = db.prepare(`
    SELECT * FROM rate_limit_events
    WHERE resume_status IN ('scheduled', 'pending')
      AND resume_at IS NOT NULL
      AND resume_at <= @now
      AND resolved_at IS NULL
    ORDER BY resume_at ASC
    LIMIT 200
  `).all({ now: iso }) as Row[];
  return rows.map(rowToEvent);
}

export function resolveRateLimitEvent(id: string): RateLimitEvent | null {
  const db = getDorothyDb();
  if (!db) return null;
  const current = getRateLimitEvent(id);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE rate_limit_events SET
      resumed_at = COALESCE(resumed_at, @now),
      resolved_at = COALESCE(resolved_at, @now),
      resume_status = CASE WHEN resume_status IN ('resumed','cancelled') THEN resume_status ELSE 'resumed' END
    WHERE id = @id
  `).run({ id, now });
  // Phase 5F — emit resume_completed when the event transitions to a final
  // resumed state (idempotent — only fires the first time).
  if (current && current.resumeStatus !== 'resumed' && current.resumeStatus !== 'cancelled') {
    const ev = safeCreateHookEvent({
      type: 'resume_completed',
      severity: 'info',
      source: 'rate_limit',
      runId: (current.affectedRunIds ?? [])[0] ?? null,
      rateLimitEventId: id,
      title: `Rate limit resolved (${current.provider ?? current.engine})`,
      metadata: {
        engine: current.engine,
        provider: current.provider ?? null,
        resumedAt: now,
        retryCount: current.retryCount ?? 0,
      },
    });
    // Phase 6-B — unblock workflows on the Run.
    safeUpdateWorkflowProgressFromHookEvent(ev);
  }
  return getRateLimitEvent(id);
}

export interface UpdateRateLimitResumeInput {
  id: string;
  resumeStatus?: RateLimitResumeStatus;
  resumeAt?: string | null;
  resumedAt?: string | null;
  lastResumeError?: string | null;
  incrementRetry?: boolean;
  affectedRunIds?: string[];
  affectedSessionIds?: string[];
  affectedRunStepIds?: string[];
}

export function updateRateLimitResume(input: UpdateRateLimitResumeInput): RateLimitEvent | null {
  const db = getDorothyDb();
  if (!db) return null;
  const current = getRateLimitEvent(input.id);
  if (!current) return null;
  db.prepare(`
    UPDATE rate_limit_events SET
      resume_status              = COALESCE(@resume_status, resume_status),
      resume_at                  = COALESCE(@resume_at, resume_at),
      resumed_at                 = COALESCE(@resumed_at, resumed_at),
      last_resume_error          = COALESCE(@last_resume_error, last_resume_error),
      retry_count                = retry_count + @inc,
      affected_run_ids_json      = COALESCE(@affected_runs_json, affected_run_ids_json),
      affected_session_ids_json  = COALESCE(@affected_sessions_json, affected_session_ids_json),
      affected_run_step_ids_json = COALESCE(@affected_steps_json, affected_run_step_ids_json)
    WHERE id = @id
  `).run({
    id: input.id,
    resume_status: input.resumeStatus ?? null,
    resume_at: input.resumeAt ?? null,
    resumed_at: input.resumedAt ?? null,
    last_resume_error: input.lastResumeError ?? null,
    inc: input.incrementRetry ? 1 : 0,
    affected_runs_json: input.affectedRunIds ? JSON.stringify(input.affectedRunIds) : null,
    affected_sessions_json: input.affectedSessionIds ? JSON.stringify(input.affectedSessionIds) : null,
    affected_steps_json: input.affectedRunStepIds ? JSON.stringify(input.affectedRunStepIds) : null,
  });
  // Phase 5F — surface lifecycle changes on the unified timeline. Same-status
  // updates (e.g. scheduled→scheduled when only `resumeAt` shifts) are not
  // emitted to keep the timeline readable.
  if (input.resumeStatus && input.resumeStatus !== current.resumeStatus) {
    const runHint = (current.affectedRunIds ?? [])[0] ?? null;
    if (input.resumeStatus === 'scheduled' || input.resumeStatus === 'pending') {
      safeCreateHookEvent({
        type: 'resume_scheduled',
        severity: 'info',
        source: 'auto_resume',
        runId: runHint,
        rateLimitEventId: input.id,
        title: `Resume ${input.resumeStatus} (${current.provider ?? current.engine})`,
        metadata: {
          resumeAt: input.resumeAt ?? current.resumeAt ?? null,
          retryCount: (current.retryCount ?? 0) + (input.incrementRetry ? 1 : 0),
        },
      });
    } else if (input.resumeStatus === 'resuming') {
      safeCreateHookEvent({
        type: 'resume_started',
        severity: 'info',
        source: 'auto_resume',
        runId: runHint,
        rateLimitEventId: input.id,
        title: `Resume started (${current.provider ?? current.engine})`,
        metadata: { retryCount: current.retryCount ?? 0 },
      });
    } else if (input.resumeStatus === 'resumed') {
      const ev = safeCreateHookEvent({
        type: 'resume_completed',
        severity: 'info',
        source: 'auto_resume',
        runId: runHint,
        rateLimitEventId: input.id,
        title: `Resume completed (${current.provider ?? current.engine})`,
        metadata: { retryCount: current.retryCount ?? 0 },
      });
      // Phase 6-B — unblock workflows on the Run.
      safeUpdateWorkflowProgressFromHookEvent(ev);
    } else if (input.resumeStatus === 'failed') {
      const ev = safeCreateHookEvent({
        type: 'resume_failed',
        severity: 'error',
        source: 'auto_resume',
        runId: runHint,
        rateLimitEventId: input.id,
        title: `Resume failed (${current.provider ?? current.engine})`,
        summary: makeExcerpt(input.lastResumeError ?? null, 240),
        metadata: {
          provider: current.provider ?? current.engine ?? null,
          engine: current.engine,
          retryCount: (current.retryCount ?? 0) + (input.incrementRetry ? 1 : 0),
          lastResumeError: makeExcerpt(input.lastResumeError ?? null, 240),
        },
      });
      // Phase 6-A — repeated resume failures should surface on /diagnostics.
      safeDetectDiagnosticFromHookEvent(ev);
    } else if (input.resumeStatus === 'cancelled') {
      safeCreateHookEvent({
        type: 'system_note',
        severity: 'info',
        source: 'auto_resume',
        runId: runHint,
        rateLimitEventId: input.id,
        title: `Resume cancelled (${current.provider ?? current.engine})`,
      });
    }
  }
  return getRateLimitEvent(input.id);
}
