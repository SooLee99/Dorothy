/**
 * Dorothy MVP Phase 5F — HookEvent service.
 *
 * Single source of truth for the unified runtime timeline. Every notable
 * runtime occurrence (Run / RunStep / AgentSession / Artifact / Handoff /
 * Approval / RateLimit / Resume / GitHub webhook / ImprovementSignal /
 * KanbanTask) creates one row here so the Run Detail Timeline can render a
 * single coherent feed.
 *
 * Storage rules:
 *   - `title` is short (≤140 chars).
 *   - `summary` is bounded (≤500 chars) — *never* a full agent output / GitHub
 *     body / signature.
 *   - `metadata` is JSON-encoded after the sensitive-value scrubber walks it.
 *   - Failure to write a row MUST NOT bubble — `safeCreateHookEvent` swallows
 *     + warns. The hook event bus is observability, not correctness.
 *
 * The service is DB-absent-tolerant (returns null when `getDorothyDb()` is
 * null) so the rest of Dorothy keeps running even if `~/.dorothy/dorothy.db`
 * is broken.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import type {
  HookEvent,
  HookEventType,
  HookEventSeverity,
  HookEventSource,
  CreateHookEventInput,
} from '../../types/dorothy';

/* ============================================================================
 * Sensitive-value masking
 *
 * Run on every value before it lands in `metadata_json` so a careless caller
 * can't smuggle a token / secret into the timeline.
 *
 * We mask:
 *   - the value of any key whose lowercased name *contains* one of the
 *     SENSITIVE_KEY_NAMES below
 *   - any substring that looks like a `key=...`, `key: ...`, or quoted JSON
 *     `"key": "..."` pair where key matches the same list
 *
 * Replacement is `'***'` so the redaction is visible in the UI.
 * ========================================================================== */

const SENSITIVE_KEY_NAMES = [
  'secret',
  'token',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'private_key',
  'privatekey',
  'bearer',
  'client_secret',
  'access_token',
  'refresh_token',
  'auth',
  'signature',
];

const MAX_TITLE_LEN = 140;
const MAX_SUMMARY_LEN = 500;
const MAX_METADATA_STRING_LEN = 1_000;
const MAX_METADATA_DEPTH = 6;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

function looksSensitive(keyName: string): boolean {
  const lc = keyName.toLowerCase();
  return SENSITIVE_KEY_NAMES.some(s => lc.includes(s));
}

/** Replace `key=value`, `key: value`, and `"key":"value"` matches in arbitrary
 *  strings. Conservative — we keep the key visible so the reader knows what
 *  was redacted; only the value is replaced. */
function maskInlineSensitives(input: string): string {
  if (!input) return input;
  let out = input;
  for (const key of SENSITIVE_KEY_NAMES) {
    // "key": "value"  or  'key': 'value'  (JSON-ish)
    const re1 = new RegExp(`(["']${key}["']\\s*:\\s*)(["'])([^"']*)(\\2)`, 'gi');
    out = out.replace(re1, (_m, prefix: string, quote: string) => `${prefix}${quote}***${quote}`);
    // key=value
    const re2 = new RegExp(`\\b(${key})\\s*=\\s*([^\\s,;)\\]}]+)`, 'gi');
    out = out.replace(re2, (_m, k: string) => `${k}=***`);
    // key: value (yaml-style, but no nested handling)
    const re3 = new RegExp(`\\b(${key})\\s*:\\s*([^\\s,;)\\]}]+)`, 'gi');
    out = out.replace(re3, (_m, k: string) => `${k}: ***`);
  }
  // Sometimes callers pass raw `Bearer <hex>` headers. Catch that too.
  out = out.replace(/(bearer\s+)[A-Za-z0-9._\-]{16,}/gi, '$1***');
  out = out.replace(/(sha256=)[a-f0-9]{16,}/gi, '$1***');
  return out;
}

/** Recursive scrub. Object values whose *key* is sensitive get '***';
 *  everything else gets the inline scrubber. Caps depth + per-string length
 *  so an absurd payload cannot blow up the row.
 *  Exported for tests. */
export function maskSensitive(value: unknown, depth = 0, keyName = ''): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_METADATA_DEPTH) return '[depth-clipped]';

  if (typeof value === 'string') {
    if (keyName && looksSensitive(keyName)) return '***';
    const inline = maskInlineSensitives(value);
    return inline.length > MAX_METADATA_STRING_LEN
      ? `${inline.slice(0, MAX_METADATA_STRING_LEN)}…[clipped]`
      : inline;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(v => maskSensitive(v, depth + 1, keyName));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const k of Object.keys(obj)) {
      if (i++ >= 50) { out['…'] = '[keys-clipped]'; break; }
      const childKey = looksSensitive(k) ? k : '';
      out[k] = looksSensitive(k) ? '***' : maskSensitive(obj[k], depth + 1, childKey);
    }
    return out;
  }
  // bigint / function / symbol — drop. Should never occur in our metadata.
  return undefined;
}

/* ============================================================================
 * Row mapping
 * ========================================================================== */

interface HookEventRow {
  id: string;
  type: string;
  severity: string;
  run_id: string | null;
  run_step_id: string | null;
  agent_session_id: string | null;
  agent_id: string | null;
  artifact_id: string | null;
  handoff_id: string | null;
  approval_request_id: string | null;
  rate_limit_event_id: string | null;
  pull_request_id: string | null;
  ci_run_id: string | null;
  improvement_signal_id: string | null;
  kanban_task_id: string | null;
  source: string;
  title: string;
  summary: string | null;
  metadata_json: string | null;
  created_at: string;
}

function rowToEvent(r: HookEventRow): HookEvent {
  let metadata: Record<string, unknown> | undefined;
  if (r.metadata_json) {
    try {
      const parsed = JSON.parse(r.metadata_json);
      if (parsed && typeof parsed === 'object') {
        metadata = parsed as Record<string, unknown>;
      }
    } catch { /* ignore — corrupt metadata is non-fatal */ }
  }
  return {
    id: r.id,
    type: r.type as HookEventType,
    severity: r.severity as HookEventSeverity,
    runId: r.run_id,
    runStepId: r.run_step_id,
    agentSessionId: r.agent_session_id,
    agentId: r.agent_id,
    artifactId: r.artifact_id,
    handoffId: r.handoff_id,
    approvalRequestId: r.approval_request_id,
    rateLimitEventId: r.rate_limit_event_id,
    pullRequestId: r.pull_request_id,
    ciRunId: r.ci_run_id,
    improvementSignalId: r.improvement_signal_id,
    kanbanTaskId: r.kanban_task_id,
    source: r.source as HookEventSource,
    title: r.title,
    summary: r.summary,
    metadata: metadata ?? null,
    createdAt: r.created_at,
  };
}

function clamp(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function defaultSeverityFor(type: HookEventType): HookEventSeverity {
  switch (type) {
    case 'run_step_failed':
    case 'agent_session_failed':
    case 'resume_failed':
    case 'ci_failed':
    case 'qa_failed':
      return 'error';
    case 'rate_limit_detected':
    case 'rate_limit_scheduled':
    case 'approval_required':
    case 'agent_session_waiting':
    case 'github_comment_gate':
    case 'improvement_signal_created':
      return 'warning';
    default:
      return 'info';
  }
}

/* ============================================================================
 * Create
 * ========================================================================== */

export function createHookEvent(input: CreateHookEventInput): HookEvent | null {
  const db = getDorothyDb();
  if (!db) return null;

  const id = uuidv4();
  const now = input.createdAt ?? new Date().toISOString();
  const severity = input.severity ?? defaultSeverityFor(input.type);

  const title = clamp(maskInlineSensitives(input.title ?? ''), MAX_TITLE_LEN) ?? '';
  const summary = clamp(
    input.summary == null ? null : maskInlineSensitives(input.summary),
    MAX_SUMMARY_LEN,
  );

  let metadataJson: string | null = null;
  if (input.metadata && typeof input.metadata === 'object') {
    try {
      const scrubbed = maskSensitive(input.metadata);
      const json = JSON.stringify(scrubbed);
      // SQLite text columns have no hard cap; we clamp here so an absurd
      // payload can't blow up the renderer.
      metadataJson = json.length > 10_000 ? `${json.slice(0, 9_999)}…` : json;
    } catch (err) {
      console.warn('[hook-event] metadata stringify failed (ignored):', err instanceof Error ? err.message : 'unknown');
      metadataJson = null;
    }
  }

  db.prepare(`
    INSERT INTO hook_events (
      id, type, severity,
      run_id, run_step_id, agent_session_id, agent_id,
      artifact_id, handoff_id, approval_request_id,
      rate_limit_event_id, pull_request_id, ci_run_id,
      improvement_signal_id, kanban_task_id,
      source, title, summary, metadata_json, created_at
    ) VALUES (
      @id, @type, @severity,
      @run_id, @run_step_id, @agent_session_id, @agent_id,
      @artifact_id, @handoff_id, @approval_request_id,
      @rate_limit_event_id, @pull_request_id, @ci_run_id,
      @improvement_signal_id, @kanban_task_id,
      @source, @title, @summary, @metadata_json, @created_at
    )
  `).run({
    id,
    type: input.type,
    severity,
    run_id: input.runId ?? null,
    run_step_id: input.runStepId ?? null,
    agent_session_id: input.agentSessionId ?? null,
    agent_id: input.agentId ?? null,
    artifact_id: input.artifactId ?? null,
    handoff_id: input.handoffId ?? null,
    approval_request_id: input.approvalRequestId ?? null,
    rate_limit_event_id: input.rateLimitEventId ?? null,
    pull_request_id: input.pullRequestId ?? null,
    ci_run_id: input.ciRunId ?? null,
    improvement_signal_id: input.improvementSignalId ?? null,
    kanban_task_id: input.kanbanTaskId ?? null,
    source: input.source,
    title,
    summary,
    metadata_json: metadataJson,
    created_at: now,
  });
  return getHookEvent(id);
}

/**
 * Same as `createHookEvent`, but swallows every error. Use this in the hot
 * paths (hooks-routes, orchestrator, webhook) where a hook-event write must
 * never break the originating flow.
 */
export function safeCreateHookEvent(input: CreateHookEventInput): HookEvent | null {
  try {
    return createHookEvent(input);
  } catch (err) {
    console.warn(
      '[hook-event] safeCreateHookEvent suppressed error:',
      err instanceof Error ? err.message : 'unknown',
    );
    return null;
  }
}

/* ============================================================================
 * Read
 * ========================================================================== */

export function getHookEvent(id: string): HookEvent | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM hook_events WHERE id = ?').get(id) as
    | HookEventRow
    | undefined;
  return row ? rowToEvent(row) : null;
}

export interface ListHookEventsOptions {
  runId?: string;
  agentSessionId?: string;
  runStepId?: string;
  agentId?: string;
  type?: HookEventType | HookEventType[];
  severity?: HookEventSeverity | HookEventSeverity[];
  source?: HookEventSource | HookEventSource[];
  /** ISO timestamp lower bound; rows with `created_at >= since` returned. */
  since?: string;
  /** Default 200, capped at MAX_LIMIT (500). */
  limit?: number;
  offset?: number;
}

function clampLimit(n: number | undefined): number {
  const v = n ?? DEFAULT_LIMIT;
  if (v <= 0) return DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

export function listHookEvents(opts: ListHookEventsOptions = {}): HookEvent[] {
  const db = getDorothyDb();
  if (!db) return [];

  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts.runId)            { where.push('run_id = @run_id');                   params.run_id = opts.runId; }
  if (opts.agentSessionId)   { where.push('agent_session_id = @session_id');     params.session_id = opts.agentSessionId; }
  if (opts.runStepId)        { where.push('run_step_id = @step_id');             params.step_id = opts.runStepId; }
  if (opts.agentId)          { where.push('agent_id = @agent_id');               params.agent_id = opts.agentId; }
  if (opts.since)            { where.push('created_at >= @since');               params.since = opts.since; }
  if (opts.type) {
    if (Array.isArray(opts.type)) {
      const placeholders = opts.type.map((_, i) => `@type${i}`);
      opts.type.forEach((t, i) => { params[`type${i}`] = t; });
      where.push(`type IN (${placeholders.join(',')})`);
    } else { where.push('type = @type'); params.type = opts.type; }
  }
  if (opts.severity) {
    if (Array.isArray(opts.severity)) {
      const placeholders = opts.severity.map((_, i) => `@sev${i}`);
      opts.severity.forEach((s, i) => { params[`sev${i}`] = s; });
      where.push(`severity IN (${placeholders.join(',')})`);
    } else { where.push('severity = @severity'); params.severity = opts.severity; }
  }
  if (opts.source) {
    if (Array.isArray(opts.source)) {
      const placeholders = opts.source.map((_, i) => `@src${i}`);
      opts.source.forEach((s, i) => { params[`src${i}`] = s; });
      where.push(`source IN (${placeholders.join(',')})`);
    } else { where.push('source = @source'); params.source = opts.source; }
  }

  const limit = clampLimit(opts.limit);
  const offset = opts.offset ?? 0;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT * FROM hook_events
    ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }) as HookEventRow[];
  return rows.map(rowToEvent);
}

export function listHookEventsByRun(runId: string, opts: Omit<ListHookEventsOptions, 'runId'> = {}): HookEvent[] {
  return listHookEvents({ ...opts, runId });
}

export function listHookEventsBySession(
  agentSessionId: string,
  opts: Omit<ListHookEventsOptions, 'agentSessionId'> = {},
): HookEvent[] {
  return listHookEvents({ ...opts, agentSessionId });
}

export function listHookEventsByRunStep(
  runStepId: string,
  opts: Omit<ListHookEventsOptions, 'runStepId'> = {},
): HookEvent[] {
  return listHookEvents({ ...opts, runStepId });
}

export function listRecentHookEvents(opts: ListHookEventsOptions = {}): HookEvent[] {
  return listHookEvents({ ...opts, limit: opts.limit ?? 100 });
}

/* ============================================================================
 * Output excerpt helper
 *
 * Stop hook output → HookEvent uses this to ensure no full transcript /
 * sensitive value leaks into the timeline. Exported so other callers
 * (orchestrator, plan validator) get the same scrubbing.
 * ========================================================================== */

export function makeExcerpt(raw: string | null | undefined, maxLen = MAX_SUMMARY_LEN): string | null {
  if (!raw) return null;
  const masked = maskInlineSensitives(raw);
  // Collapse whitespace so an excerpt is one tidy line.
  const tidy = masked.replace(/\s+/g, ' ').trim();
  return tidy.length > maxLen ? `${tidy.slice(0, maxLen - 1)}…` : tidy;
}

/* ============================================================================
 * Test helpers
 * ========================================================================== */

/** Direct row count for the Settings panel + tests. */
export function countHookEvents(): number {
  const db = getDorothyDb();
  if (!db) return 0;
  const row = db.prepare('SELECT COUNT(*) AS n FROM hook_events').get() as { n: number } | undefined;
  return row?.n ?? 0;
}
