/**
 * Dorothy MVP — Artifact + Handoff service.
 *
 * Artifacts are the unit of "thing produced by a Run step" — code patches,
 * test results, reports, ADRs, reviews. Handoffs are the typed edges between
 * steps; their `summary` is what mirrors into triplan/.claude/memories/handoff.md.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import { safeCreateHookEvent, makeExcerpt } from './hook-event-service';
import { safeUpdateWorkflowProgressFromHookEvent } from './agent-workflow-progress-service';
import type {
  Artifact,
  ArtifactType,
  Handoff,
  CreateArtifactInput,
  CreateHandoffInput,
} from '../../types/dorothy';

/* ============================================================================
 * Artifact
 * ========================================================================== */

interface ArtifactRow {
  id: string;
  run_id: string;
  run_step_id: string | null;
  type: string;
  path: string | null;
  content_ref: string | null;
  produced_by_agent_id: string;
  meta_json: string | null;
  created_at: string;
}

function rowToArtifact(r: ArtifactRow): Artifact {
  let meta: Record<string, unknown> | undefined;
  if (r.meta_json) {
    try { meta = JSON.parse(r.meta_json) as Record<string, unknown>; } catch { /* ignore */ }
  }
  return {
    id: r.id,
    runId: r.run_id,
    runStepId: r.run_step_id,
    type: r.type as ArtifactType,
    path: r.path,
    contentRef: r.content_ref,
    producedByAgentId: r.produced_by_agent_id,
    meta,
    createdAt: r.created_at,
  };
}

export function createArtifact(input: CreateArtifactInput): Artifact | null {
  const db = getDorothyDb();
  if (!db) return null;

  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO artifacts (
      id, run_id, run_step_id, type, path, content_ref,
      produced_by_agent_id, meta_json, created_at
    ) VALUES (
      @id, @run_id, @run_step_id, @type, @path, @content_ref,
      @produced_by_agent_id, @meta_json, @now
    )
  `).run({
    id,
    run_id: input.runId,
    run_step_id: input.runStepId ?? null,
    type: input.type,
    path: input.path ?? null,
    content_ref: input.contentRef ?? null,
    produced_by_agent_id: input.producedByAgentId,
    meta_json: input.meta ? JSON.stringify(input.meta) : null,
    now,
  });

  // Phase 5F — Hook Event timeline. We only carry the spec-allowed metadata
  // (type, path, contentRef excerpt, producedByAgentId) — never the full
  // meta payload (it may include comment bodies / pr bodies).
  const ev = safeCreateHookEvent({
    type: 'artifact_created',
    severity: 'info',
    source: 'orchestrator',
    runId: input.runId,
    runStepId: input.runStepId ?? null,
    artifactId: id,
    agentId: input.producedByAgentId,
    title: `Artifact ${input.type} by ${input.producedByAgentId}`,
    summary: makeExcerpt(input.path ?? input.contentRef ?? null),
    metadata: {
      type: input.type,
      path: input.path ?? null,
      contentRef: makeExcerpt(input.contentRef ?? null, 120),
      producedByAgentId: input.producedByAgentId,
    },
  });
  // Phase 6-B — attach the artifact id to the matching workflow step as
  // validation / implementation evidence.
  safeUpdateWorkflowProgressFromHookEvent(ev);

  return getArtifact(id);
}

export function getArtifact(id: string): Artifact | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
    | ArtifactRow
    | undefined;
  return row ? rowToArtifact(row) : null;
}

/**
 * Phase 5C-C — bulk lookup for the ImprovementSignal evidence preview.
 * Empty / unknown ids are silently skipped; order matches the input.
 */
export function listArtifactsByIds(ids: string[]): Artifact[] {
  const db = getDorothyDb();
  if (!db || !ids || ids.length === 0) return [];
  // Cap to avoid an absurd IN list — the UI only ever asks for a handful.
  const capped = ids.slice(0, 50);
  const placeholders = capped.map((_, i) => `@id${i}`).join(',');
  const params: Record<string, unknown> = {};
  capped.forEach((id, i) => { params[`id${i}`] = id; });
  const rows = db.prepare(`SELECT * FROM artifacts WHERE id IN (${placeholders})`).all(params) as ArtifactRow[];
  // Re-order to match caller's ids order.
  const byId = new Map(rows.map(r => [r.id, rowToArtifact(r)]));
  return capped.map(id => byId.get(id)).filter((a): a is Artifact => !!a);
}

export function listArtifactsByRun(runId: string): Artifact[] {
  const db = getDorothyDb();
  if (!db) return [];
  const rows = db.prepare(
    'SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC'
  ).all(runId) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

export interface ListArtifactsOptions {
  runId?: string;
  runStepId?: string;
  type?: ArtifactType;
  producedByAgentId?: string;
  limit?: number;
}

export function listArtifacts(opts: ListArtifactsOptions = {}): Artifact[] {
  const db = getDorothyDb();
  if (!db) return [];
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.runId) { where.push('run_id = @run_id'); params.run_id = opts.runId; }
  if (opts.runStepId) { where.push('run_step_id = @run_step_id'); params.run_step_id = opts.runStepId; }
  if (opts.type) { where.push('type = @type'); params.type = opts.type; }
  if (opts.producedByAgentId) { where.push('produced_by_agent_id = @aid'); params.aid = opts.producedByAgentId; }

  const sql = `
    SELECT * FROM artifacts
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC
    LIMIT @limit
  `;
  const rows = db.prepare(sql).all({ ...params, limit: opts.limit ?? 200 }) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

/* ============================================================================
 * Handoff
 * ========================================================================== */

interface HandoffRow {
  id: string;
  run_id: string;
  from_run_step_id: string;
  to_run_step_id: string;
  summary: string;
  attached_artifact_ids_json: string | null;
  created_at: string;
}

function rowToHandoff(r: HandoffRow): Handoff {
  let ids: string[] = [];
  if (r.attached_artifact_ids_json) {
    try { ids = JSON.parse(r.attached_artifact_ids_json) as string[]; } catch { /* ignore */ }
  }
  return {
    id: r.id,
    runId: r.run_id,
    fromRunStepId: r.from_run_step_id,
    toRunStepId: r.to_run_step_id,
    summary: r.summary,
    attachedArtifactIds: ids,
    createdAt: r.created_at,
  };
}

export function createHandoff(input: CreateHandoffInput): Handoff | null {
  const db = getDorothyDb();
  if (!db) return null;

  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO handoffs (
      id, run_id, from_run_step_id, to_run_step_id, summary,
      attached_artifact_ids_json, created_at
    ) VALUES (
      @id, @run_id, @from_run_step_id, @to_run_step_id, @summary,
      @ids_json, @now
    )
  `).run({
    id,
    run_id: input.runId,
    from_run_step_id: input.fromRunStepId,
    to_run_step_id: input.toRunStepId,
    summary: input.summary,
    ids_json: input.attachedArtifactIds && input.attachedArtifactIds.length
      ? JSON.stringify(input.attachedArtifactIds)
      : null,
    now,
  });

  // Phase 5F — Hook Event timeline. Excerpt only.
  const ev = safeCreateHookEvent({
    type: 'handoff_created',
    severity: 'info',
    source: 'orchestrator',
    runId: input.runId,
    runStepId: input.toRunStepId,
    handoffId: id,
    title: `Handoff created (${input.fromRunStepId.slice(0, 8)} → ${input.toRunStepId.slice(0, 8)})`,
    summary: makeExcerpt(input.summary),
    metadata: {
      fromRunStepId: input.fromRunStepId,
      toRunStepId: input.toRunStepId,
      attachedArtifactCount: input.attachedArtifactIds?.length ?? 0,
    },
  });
  // Phase 6-B — completes the handoff step of the *previous* RunStep's
  // workflow. The HookEvent carries the to-step id so the dispatcher
  // resolves the agent from there; the from-step's row is updated via the
  // handoff id below.
  safeUpdateWorkflowProgressFromHookEvent(ev);

  return getHandoff(id);
}

export function getHandoff(id: string): Handoff | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM handoffs WHERE id = ?').get(id) as
    | HandoffRow
    | undefined;
  return row ? rowToHandoff(row) : null;
}

export function listHandoffsByRun(runId: string): Handoff[] {
  const db = getDorothyDb();
  if (!db) return [];
  const rows = db.prepare(
    'SELECT * FROM handoffs WHERE run_id = ? ORDER BY created_at ASC'
  ).all(runId) as HandoffRow[];
  return rows.map(rowToHandoff);
}
