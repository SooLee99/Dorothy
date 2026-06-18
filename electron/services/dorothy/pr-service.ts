/**
 * Dorothy MVP Phase 5A — PullRequest service.
 *
 * Upserts on `external_ref` (`owner/repo#number`) so successive webhooks for
 * the same PR fold into one row. We do not own the PR lifecycle on GitHub —
 * we mirror it. Returns null on every read/write when dorothy.db is absent
 * so callers (the github-webhook receiver, frontend hooks) degrade
 * gracefully.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import type {
  PullRequest,
  PullRequestProvider,
  PullRequestState,
  PullRequestReviewer,
  UpsertPullRequestInput,
  UpdatePullRequestStateInput,
} from '../../types/dorothy';

interface PullRequestRow {
  id: string;
  run_id: string | null;
  provider: string;
  external_ref: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  branch: string;
  base_branch: string;
  state: string;
  title: string;
  body_artifact_id: string | null;
  author_agent_id: string | null;
  reviewers_json: string | null;
  ci_run_ids_json: string | null;
  merged_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToPullRequest(r: PullRequestRow): PullRequest {
  let reviewers: PullRequestReviewer[] | undefined;
  if (r.reviewers_json) {
    try { reviewers = JSON.parse(r.reviewers_json) as PullRequestReviewer[]; } catch { /* ignore */ }
  }
  let ciRunIds: string[] = [];
  if (r.ci_run_ids_json) {
    try { ciRunIds = JSON.parse(r.ci_run_ids_json) as string[]; } catch { /* ignore */ }
  }
  return {
    id: r.id,
    runId: r.run_id,
    provider: r.provider as PullRequestProvider,
    externalRef: r.external_ref,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    url: r.url,
    branch: r.branch,
    baseBranch: r.base_branch,
    state: r.state as PullRequestState,
    title: r.title,
    bodyArtifactId: r.body_artifact_id,
    authorAgentId: r.author_agent_id,
    reviewers,
    ciRunIds,
    mergedAt: r.merged_at,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ============================================================================
 * Upsert / read
 * ========================================================================== */

export function createOrUpdatePullRequest(input: UpsertPullRequestInput): PullRequest | null {
  const db = getDorothyDb();
  if (!db) return null;

  const existing = db
    .prepare('SELECT * FROM pull_requests WHERE external_ref = ?')
    .get(input.externalRef) as PullRequestRow | undefined;

  const now = new Date().toISOString();
  const reviewersJson = input.reviewers ? JSON.stringify(input.reviewers) : null;
  // PR-side ciRunIds is a denormalized list; ci-run-service.ts keeps the
  // authoritative row, but maintaining it here lets the UI render without a
  // second query.
  const ciRunIdsJson = input.ciRunIds && input.ciRunIds.length
    ? JSON.stringify(input.ciRunIds)
    : (existing?.ci_run_ids_json ?? null);

  if (!existing) {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO pull_requests (
        id, run_id, provider, external_ref, owner, repo, number, url, branch, base_branch,
        state, title, body_artifact_id, author_agent_id, reviewers_json, ci_run_ids_json,
        merged_at, closed_at, created_at, updated_at
      ) VALUES (
        @id, @run_id, @provider, @external_ref, @owner, @repo, @number, @url, @branch, @base_branch,
        @state, @title, @body_artifact_id, @author_agent_id, @reviewers_json, @ci_run_ids_json,
        @merged_at, @closed_at, @now, @now
      )
    `).run({
      id,
      run_id: input.runId ?? null,
      provider: input.provider ?? 'github',
      external_ref: input.externalRef,
      owner: input.owner,
      repo: input.repo,
      number: input.number,
      url: input.url,
      branch: input.branch,
      base_branch: input.baseBranch,
      state: input.state,
      title: input.title,
      body_artifact_id: input.bodyArtifactId ?? null,
      author_agent_id: input.authorAgentId ?? null,
      reviewers_json: reviewersJson,
      ci_run_ids_json: ciRunIdsJson,
      merged_at: input.mergedAt ?? null,
      closed_at: input.closedAt ?? null,
      now,
    });
    return getPullRequest(id);
  }

  // Existing row → preserve runId / bodyArtifactId / authorAgentId when the
  // incoming payload doesn't carry them. GitHub webhooks for the same PR may
  // arrive without these enrichments (e.g. check_run events).
  db.prepare(`
    UPDATE pull_requests SET
      run_id            = COALESCE(@run_id, run_id),
      url               = @url,
      branch            = @branch,
      base_branch       = @base_branch,
      state             = @state,
      title             = @title,
      body_artifact_id  = COALESCE(@body_artifact_id, body_artifact_id),
      author_agent_id   = COALESCE(@author_agent_id, author_agent_id),
      reviewers_json    = COALESCE(@reviewers_json, reviewers_json),
      ci_run_ids_json   = COALESCE(@ci_run_ids_json, ci_run_ids_json),
      merged_at         = COALESCE(@merged_at, merged_at),
      closed_at         = COALESCE(@closed_at, closed_at),
      updated_at        = @now
    WHERE external_ref = @external_ref
  `).run({
    run_id: input.runId ?? null,
    url: input.url,
    branch: input.branch,
    base_branch: input.baseBranch,
    state: input.state,
    title: input.title,
    body_artifact_id: input.bodyArtifactId ?? null,
    author_agent_id: input.authorAgentId ?? null,
    reviewers_json: reviewersJson,
    ci_run_ids_json: ciRunIdsJson,
    merged_at: input.mergedAt ?? null,
    closed_at: input.closedAt ?? null,
    external_ref: input.externalRef,
    now,
  });
  return getPullRequest(existing.id);
}

export function getPullRequest(id: string): PullRequest | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM pull_requests WHERE id = ?').get(id) as
    | PullRequestRow
    | undefined;
  return row ? rowToPullRequest(row) : null;
}

export function getPullRequestByExternalRef(ref: string): PullRequest | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM pull_requests WHERE external_ref = ?').get(ref) as
    | PullRequestRow
    | undefined;
  return row ? rowToPullRequest(row) : null;
}

export interface ListPullRequestsOptions {
  state?: PullRequestState | PullRequestState[];
  runId?: string;
  owner?: string;
  repo?: string;
  limit?: number;
  offset?: number;
}

export function listPullRequests(opts: ListPullRequestsOptions = {}): PullRequest[] {
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
  if (opts.runId) { where.push('run_id = @run_id'); params.run_id = opts.runId; }
  if (opts.owner) { where.push('owner = @owner'); params.owner = opts.owner; }
  if (opts.repo)  { where.push('repo = @repo');   params.repo  = opts.repo;  }

  const sql = `
    SELECT * FROM pull_requests
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC
    LIMIT @limit OFFSET @offset
  `;
  const rows = db.prepare(sql).all({
    ...params,
    limit: opts.limit ?? 200,
    offset: opts.offset ?? 0,
  }) as PullRequestRow[];
  return rows.map(rowToPullRequest);
}

export function listPullRequestsByRun(runId: string): PullRequest[] {
  return listPullRequests({ runId });
}

/* ============================================================================
 * Mutations
 * ========================================================================== */

export function linkPullRequestToRun(pullRequestId: string, runId: string | null): PullRequest | null {
  const db = getDorothyDb();
  if (!db) return null;
  const now = new Date().toISOString();
  db.prepare('UPDATE pull_requests SET run_id = @run_id, updated_at = @now WHERE id = @id')
    .run({ id: pullRequestId, run_id: runId, now });
  return getPullRequest(pullRequestId);
}

export function updatePullRequestState(input: UpdatePullRequestStateInput): PullRequest | null {
  const db = getDorothyDb();
  if (!db) return null;
  const current = getPullRequest(input.id);
  if (!current) return null;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE pull_requests SET
      state          = @state,
      merged_at      = COALESCE(@merged_at, merged_at),
      closed_at      = COALESCE(@closed_at, closed_at),
      reviewers_json = COALESCE(@reviewers_json, reviewers_json),
      updated_at     = @now
    WHERE id = @id
  `).run({
    id: input.id,
    state: input.state,
    merged_at: input.mergedAt ?? null,
    closed_at: input.closedAt ?? null,
    reviewers_json: input.reviewers ? JSON.stringify(input.reviewers) : null,
    now,
  });
  return getPullRequest(input.id);
}

/** Append a CIRun id to the PR's denormalized list. Used by ci-run-service
 *  when a webhook ties a CI run to a known PR. */
export function appendCiRunIdToPullRequest(pullRequestId: string, ciRunId: string): PullRequest | null {
  const db = getDorothyDb();
  if (!db) return null;
  const pr = getPullRequest(pullRequestId);
  if (!pr) return null;
  if (pr.ciRunIds.includes(ciRunId)) return pr;
  const next = [...pr.ciRunIds, ciRunId];
  const now = new Date().toISOString();
  db.prepare('UPDATE pull_requests SET ci_run_ids_json = @json, updated_at = @now WHERE id = @id')
    .run({ id: pullRequestId, json: JSON.stringify(next), now });
  return getPullRequest(pullRequestId);
}
