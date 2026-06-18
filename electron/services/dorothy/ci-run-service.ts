/**
 * Dorothy MVP Phase 5A — CIRun service.
 *
 * Mirrors GitHub Actions workflow_run / check_run / check_suite events. Like
 * pr-service, every read/write degrades to null/[] when dorothy.db is
 * unavailable.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import { appendCiRunIdToPullRequest } from './pr-service';
import type {
  CIRun,
  CIProvider,
  CIRunState,
  UpsertCIRunInput,
  UpdateCIRunStateInput,
} from '../../types/dorothy';

interface CIRunRow {
  id: string;
  run_id: string | null;
  pull_request_id: string | null;
  provider: string;
  workflow: string;
  external_ref: string;
  url: string | null;
  state: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
  logs_url: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

function rowToCIRun(r: CIRunRow): CIRun {
  return {
    id: r.id,
    runId: r.run_id,
    pullRequestId: r.pull_request_id,
    provider: r.provider as CIProvider,
    workflow: r.workflow,
    externalRef: r.external_ref,
    url: r.url,
    state: r.state as CIRunState,
    conclusion: r.conclusion,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    logsUrl: r.logs_url,
    summary: r.summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createOrUpdateCIRun(input: UpsertCIRunInput): CIRun | null {
  const db = getDorothyDb();
  if (!db) return null;

  const existing = db
    .prepare('SELECT * FROM ci_runs WHERE external_ref = ?')
    .get(input.externalRef) as CIRunRow | undefined;

  const now = new Date().toISOString();
  const startedAt = input.startedAt ?? existing?.started_at ?? now;

  if (!existing) {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO ci_runs (
        id, run_id, pull_request_id, provider, workflow, external_ref, url,
        state, conclusion, started_at, completed_at, logs_url, summary,
        created_at, updated_at
      ) VALUES (
        @id, @run_id, @pr_id, @provider, @workflow, @external_ref, @url,
        @state, @conclusion, @started_at, @completed_at, @logs_url, @summary,
        @now, @now
      )
    `).run({
      id,
      run_id: input.runId ?? null,
      pr_id: input.pullRequestId ?? null,
      provider: input.provider ?? 'github_actions',
      workflow: input.workflow,
      external_ref: input.externalRef,
      url: input.url ?? null,
      state: input.state,
      conclusion: input.conclusion ?? null,
      started_at: startedAt,
      completed_at: input.completedAt ?? null,
      logs_url: input.logsUrl ?? null,
      summary: input.summary ?? null,
      now,
    });
    // Maintain PR.ciRunIds denormalized list, best-effort.
    if (input.pullRequestId) {
      try { appendCiRunIdToPullRequest(input.pullRequestId, id); } catch { /* ignore */ }
    }
    return getCIRun(id);
  }

  db.prepare(`
    UPDATE ci_runs SET
      run_id          = COALESCE(@run_id, run_id),
      pull_request_id = COALESCE(@pr_id, pull_request_id),
      workflow        = @workflow,
      url             = COALESCE(@url, url),
      state           = @state,
      conclusion      = COALESCE(@conclusion, conclusion),
      started_at      = @started_at,
      completed_at    = COALESCE(@completed_at, completed_at),
      logs_url        = COALESCE(@logs_url, logs_url),
      summary         = COALESCE(@summary, summary),
      updated_at      = @now
    WHERE external_ref = @external_ref
  `).run({
    run_id: input.runId ?? null,
    pr_id: input.pullRequestId ?? null,
    workflow: input.workflow,
    url: input.url ?? null,
    state: input.state,
    conclusion: input.conclusion ?? null,
    started_at: startedAt,
    completed_at: input.completedAt ?? null,
    logs_url: input.logsUrl ?? null,
    summary: input.summary ?? null,
    external_ref: input.externalRef,
    now,
  });

  if (input.pullRequestId) {
    try { appendCiRunIdToPullRequest(input.pullRequestId, existing.id); } catch { /* ignore */ }
  }
  return getCIRun(existing.id);
}

export function getCIRun(id: string): CIRun | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM ci_runs WHERE id = ?').get(id) as CIRunRow | undefined;
  return row ? rowToCIRun(row) : null;
}

export function getCIRunByExternalRef(ref: string): CIRun | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM ci_runs WHERE external_ref = ?').get(ref) as
    | CIRunRow
    | undefined;
  return row ? rowToCIRun(row) : null;
}

export interface ListCIRunsOptions {
  state?: CIRunState | CIRunState[];
  runId?: string;
  pullRequestId?: string;
  workflow?: string;
  limit?: number;
  offset?: number;
}

export function listCIRuns(opts: ListCIRunsOptions = {}): CIRun[] {
  const db = getDorothyDb();
  if (!db) return [];

  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.state) {
    if (Array.isArray(opts.state)) {
      const placeholders = opts.state.map((_, i) => `@state${i}`);
      opts.state.forEach((s, i) => { params[`state${i}`] = s; });
      where.push(`state IN (${placeholders.join(',')})`);
    } else {
      where.push('state = @state');
      params.state = opts.state;
    }
  }
  if (opts.runId)        { where.push('run_id = @run_id');         params.run_id        = opts.runId; }
  if (opts.pullRequestId){ where.push('pull_request_id = @pr_id'); params.pr_id         = opts.pullRequestId; }
  if (opts.workflow)     { where.push('workflow = @workflow');     params.workflow      = opts.workflow; }

  const sql = `
    SELECT * FROM ci_runs
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY started_at DESC
    LIMIT @limit OFFSET @offset
  `;
  const rows = db.prepare(sql).all({
    ...params,
    limit: opts.limit ?? 200,
    offset: opts.offset ?? 0,
  }) as CIRunRow[];
  return rows.map(rowToCIRun);
}

export function listCIRunsByRun(runId: string): CIRun[] {
  return listCIRuns({ runId });
}

export function listCIRunsByPullRequest(pullRequestId: string): CIRun[] {
  return listCIRuns({ pullRequestId });
}

export function updateCIRunState(input: UpdateCIRunStateInput): CIRun | null {
  const db = getDorothyDb();
  if (!db) return null;
  const current = getCIRun(input.id);
  if (!current) return null;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE ci_runs SET
      state         = @state,
      conclusion    = COALESCE(@conclusion, conclusion),
      completed_at  = COALESCE(@completed_at, completed_at),
      summary       = COALESCE(@summary, summary),
      logs_url      = COALESCE(@logs_url, logs_url),
      updated_at    = @now
    WHERE id = @id
  `).run({
    id: input.id,
    state: input.state,
    conclusion: input.conclusion ?? null,
    completed_at: input.completedAt ?? null,
    summary: input.summary ?? null,
    logs_url: input.logsUrl ?? null,
    now,
  });
  return getCIRun(input.id);
}
