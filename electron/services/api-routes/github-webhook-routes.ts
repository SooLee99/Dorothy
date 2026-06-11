/**
 * Dorothy MVP Phase 5A — GitHub webhook receiver.
 *
 *   POST /api/github/webhook
 *
 * Headers:
 *   x-github-event       e.g. 'pull_request', 'check_run', 'check_suite', 'workflow_run'
 *   x-github-delivery    unique delivery id (used for log lines, never logged with secrets)
 *   x-hub-signature-256  'sha256=<hex>' HMAC of the raw body using githubWebhookSecret
 *
 * Behaviour:
 *   - When `appSettings.githubWebhookSecret` is set, the signature MUST match
 *     or we return 401. We never log the secret or the full body.
 *   - When the secret is empty AND `appSettings.dorothyDevAllowUnsignedWebhook`
 *     is true (default false), we accept the request with a warning so a
 *     local developer can poke /api/github/webhook via curl.
 *   - Unsupported event types are 200-acknowledged but no-op.
 *
 * Run state transitions are GATED by `appSettings.dorothyPrCiAutoTransition`
 * (default false). When off, we mirror PR/CI rows only — no Run state moves.
 */

import * as crypto from 'crypto';
import { RouteApp, RouteContext } from './types';
import { getDorothyDb } from '../dorothy/db';
import {
  createOrUpdatePullRequest,
  getPullRequestByExternalRef,
  updatePullRequestState,
  type ListPullRequestsOptions as _PRListOpts,
} from '../dorothy/pr-service';
import {
  createOrUpdateCIRun,
} from '../dorothy/ci-run-service';
import { getRun, updateRunState, updateRunMode } from '../dorothy/run-service';
import { createArtifact } from '../dorothy/artifact-service';
import { createApprovalRequest } from '../dorothy/approval-request-service';
import { createImprovementSignal, fingerprintFor } from '../dorothy/improvement-signal-service';
import { decideRunMode } from '../dorothy/run-mode-router';
import { safeCreateHookEvent, makeExcerpt } from '../dorothy/hook-event-service';
import { safeDetectDiagnosticFromHookEvent } from '../dorothy/diagnostic-detector';
import { safeUpdateWorkflowProgressFromHookEvent } from '../dorothy/agent-workflow-progress-service';
import type {
  PullRequestState,
  CIRunState,
  PullRequestReviewer,
  ReviewerState,
  RunState,
} from '../../types/dorothy';

const SUPPORTED_EVENTS = new Set([
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
  'check_run',
  'check_suite',
  'workflow_run',
  'ping',
]);

/* ============================================================================
 * Phase 5C-A — user-gate keyword detector for review/issue comments.
 *
 * Word-boundary regexes so e.g. "deploy" matches "deploy" but not "redeployed"
 * (avoids false positives on plain English). Case-insensitive.
 *
 * Multi-word phrases like "delete from" are matched as substrings (they're
 * unlikely to occur in casual prose; the SQL context is intentional).
 * ========================================================================== */

interface KeywordHit {
  keyword: string;
  /** Index into comment body where the match started (for ordering only). */
  position: number;
}

const SINGLE_WORD_KEYWORDS = ['auth', 'production', 'push', 'secret', 'cost', 'drop', 'truncate', 'deploy', 'merge'];
const PHRASE_KEYWORDS = ['delete from'];
// SEC-1, SEC-2, … treated as a prefix family.
const SEC_PREFIX = /\bSEC-/i;

export function detectGateKeywords(body: string | null | undefined): KeywordHit[] {
  if (!body) return [];
  const hits: KeywordHit[] = [];
  const lower = body.toLowerCase();
  for (const w of SINGLE_WORD_KEYWORDS) {
    const re = new RegExp(`\\b${w}\\b`, 'i');
    const m = re.exec(body);
    if (m) hits.push({ keyword: w, position: m.index });
  }
  for (const p of PHRASE_KEYWORDS) {
    const idx = lower.indexOf(p);
    if (idx >= 0) hits.push({ keyword: p, position: idx });
  }
  const secMatch = SEC_PREFIX.exec(body);
  if (secMatch) {
    // Capture the actual SEC-<id> token if present.
    const expanded = /\bSEC-[A-Za-z0-9_-]+/i.exec(body);
    hits.push({ keyword: expanded ? expanded[0].toUpperCase() : 'SEC-', position: secMatch.index });
  }
  // Deduplicate by keyword, keep earliest position.
  const byKey = new Map<string, KeywordHit>();
  for (const h of hits) {
    const k = h.keyword.toLowerCase();
    const prev = byKey.get(k);
    if (!prev || h.position < prev.position) byKey.set(k, h);
  }
  return Array.from(byKey.values()).sort((a, b) => a.position - b.position);
}

/* ============================================================================
 * Signature verification — constant-time, log-safe.
 * ========================================================================== */

interface VerifyArgs {
  secret: string;
  signatureHeader: string | undefined;
  rawBody: Buffer | string;
}

/** Returns true when the HMAC matches. Constant-time comparison. */
export function verifyGithubSignature({ secret, signatureHeader, rawBody }: VerifyArgs): boolean {
  if (!secret) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');
  const expected = Buffer.from(`sha256=${expectedHex}`, 'utf8');
  const received = Buffer.from(signatureHeader, 'utf8');
  if (expected.length !== received.length) return false;
  try {
    return crypto.timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

/* ============================================================================
 * Payload typing
 *
 * We accept the small slice of GitHub's webhook payload we actually read,
 * everything else is `unknown`. The receiver never trusts these fields to be
 * present — every accessor uses optional chaining.
 * ========================================================================== */

interface PullRequestPayload {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    state?: 'open' | 'closed';
    draft?: boolean;
    merged?: boolean;
    merged_at?: string | null;
    closed_at?: string | null;
    html_url?: string;
    head?: { ref?: string };
    base?: { ref?: string };
    user?: { login?: string };
    requested_reviewers?: Array<{ login?: string }>;
  };
  repository?: { name?: string; owner?: { login?: string } };
}

interface WorkflowRunPayload {
  action?: string;
  workflow_run?: {
    id?: number;
    name?: string;
    status?: string;       // 'queued' | 'in_progress' | 'completed' | 'requested' | 'waiting'
    conclusion?: string | null; // 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null
    run_started_at?: string;
    updated_at?: string;
    html_url?: string;
    logs_url?: string;
    head_branch?: string;
    pull_requests?: Array<{ number?: number; head?: { ref?: string }; base?: { ref?: string } }>;
  };
  repository?: { name?: string; owner?: { login?: string } };
}

interface CheckRunPayload {
  action?: string;
  check_run?: {
    id?: number;
    name?: string;
    status?: string;
    conclusion?: string | null;
    started_at?: string;
    completed_at?: string | null;
    html_url?: string;
    output?: { summary?: string | null };
    check_suite?: { pull_requests?: Array<{ number?: number; head?: { ref?: string }; base?: { ref?: string } }> };
  };
  repository?: { name?: string; owner?: { login?: string } };
}

interface CheckSuitePayload {
  action?: string;
  check_suite?: {
    id?: number;
    status?: string;
    conclusion?: string | null;
    head_branch?: string;
    pull_requests?: Array<{ number?: number; head?: { ref?: string }; base?: { ref?: string } }>;
  };
  repository?: { name?: string; owner?: { login?: string } };
}

interface PullRequestReviewPayload {
  action?: string;
  review?: {
    id?: number;
    state?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | string;
    body?: string | null;
    html_url?: string;
    user?: { login?: string };
    submitted_at?: string;
  };
  pull_request?: {
    number?: number;
    state?: 'open' | 'closed';
    merged?: boolean;
  };
  repository?: { name?: string; owner?: { login?: string } };
}

interface ReviewCommentPayload {
  action?: string;
  comment?: {
    id?: number;
    body?: string | null;
    user?: { login?: string };
    html_url?: string;
    created_at?: string;
  };
  pull_request?: { number?: number };
  // `issue_comment` carries an `issue` and only the `pull_request` *URL* sub-object inside it.
  issue?: {
    number?: number;
    pull_request?: { url?: string; html_url?: string } | null;
  };
  repository?: { name?: string; owner?: { login?: string } };
}

/* ============================================================================
 * PR / CI state mapping
 * ========================================================================== */

export function mapPullRequestPayloadToState(pr: NonNullable<PullRequestPayload['pull_request']>): PullRequestState {
  if (pr.draft) return 'draft';
  if (pr.state === 'closed') {
    return pr.merged ? 'merged' : 'closed';
  }
  return 'open';
}

export function mapGithubRunToCIState(status: string | undefined, conclusion: string | null | undefined): CIRunState {
  switch (status) {
    case 'queued':
    case 'requested':
    case 'waiting':
      return 'queued';
    case 'in_progress':
      return 'running';
    case 'completed': {
      switch (conclusion) {
        case 'success': return 'success';
        case 'cancelled': return 'cancelled';
        case 'skipped': return 'skipped';
        case 'failure':
        case 'timed_out':
        case 'action_required':
        case 'neutral':
        default:
          return conclusion ? 'failed' : 'failed';
      }
    }
    case 'skipped':
      return 'skipped';
    default:
      return 'queued';
  }
}

/* ============================================================================
 * runId extraction
 *
 * The PR body or branch name may contain a Dorothy Run identifier so a
 * future Phase 5B UI can navigate PR ↔ Run. We accept two formats:
 *   - explicit `RUN-<uuid>` token
 *   - explicit `runId: <uuid>` line
 * ========================================================================== */

const RUN_ID_REGEX = /\b(?:RUN-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|runId:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))\b/i;

export function extractRunIdFrom(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = RUN_ID_REGEX.exec(text);
  if (!m) return null;
  return (m[1] ?? m[2] ?? '').toLowerCase() || null;
}

function resolveRunIdForPullRequest(
  branch: string | undefined,
  body: string | null | undefined,
  existingRunId: string | null | undefined,
): string | null {
  const fromBranch = extractRunIdFrom(branch ?? null);
  if (fromBranch) return fromBranch;
  const fromBody = extractRunIdFrom(body ?? null);
  if (fromBody) return fromBody;
  return existingRunId ?? null;
}

/* ============================================================================
 * Event handlers
 * ========================================================================== */

function handlePullRequestEvent(payload: PullRequestPayload, ctx: RouteContext): { eventOk: true; prId?: string } {
  const pr = payload.pull_request;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const number = pr?.number ?? payload.number;
  if (!pr || !owner || !repo || !number) return { eventOk: true };

  const branch = pr.head?.ref ?? '';
  const baseBranch = pr.base?.ref ?? '';
  const externalRef = `${owner}/${repo}#${number}`;
  const url = pr.html_url ?? '';
  const title = pr.title ?? '';
  const state = mapPullRequestPayloadToState(pr);

  // Reviewer state — we only have "requested" at this stage from the
  // pull_request event; pull_request_review events refine the per-reviewer
  // verdicts later (out of Phase 5A scope, but the field is reserved).
  const reviewers: PullRequestReviewer[] | undefined = pr.requested_reviewers
    ?.map(r => r.login)
    .filter((s): s is string => typeof s === 'string')
    .map(name => ({ name, state: 'pending' as const }));

  const existing = getPullRequestByExternalRef(externalRef);
  const runId = resolveRunIdForPullRequest(branch, pr.body, existing?.runId ?? null);

  const upserted = createOrUpdatePullRequest({
    externalRef,
    owner,
    repo,
    number,
    url,
    branch,
    baseBranch,
    state,
    title,
    runId,
    reviewers,
    mergedAt: pr.merged_at ?? null,
    closedAt: pr.closed_at ?? null,
    provider: 'github',
  });

  // Phase 5F — mirror as github_pr_event. We carry only title / state /
  // externalRef / action — never the PR body, signature, or secret.
  if (upserted) {
    safeCreateHookEvent({
      type: 'github_pr_event',
      severity: state === 'changes_requested' ? 'warning' : 'info',
      source: 'github_webhook',
      runId: runId ?? null,
      pullRequestId: upserted.id,
      title: `PR ${payload.action ?? state}: ${externalRef}`,
      summary: makeExcerpt(title, 200),
      metadata: {
        action: payload.action ?? null,
        externalRef,
        state,
        branch,
        baseBranch,
        merged: !!pr.merged,
        mergedAt: pr.merged_at ?? null,
      },
    });
  }

  // Phase 5E — PR title/body → RunMode hint. We *only* refine the mode when
  // the operator hasn't explicitly chosen one (modeSource ∈ {null, 'default'}).
  // Never overwrite a `manual` source; risk keywords stay on the ApprovalRequest
  // path regardless of mode.
  if (upserted && runId) {
    try {
      const linkedRun = getRun(runId);
      const safeToUpdate = !!linkedRun &&
        (linkedRun.modeSource === null || linkedRun.modeSource === undefined || linkedRun.modeSource === 'default');
      if (safeToUpdate) {
        const signalText = `${title}\n${pr.body ?? ''}`;
        const decision = decideRunMode(signalText, { sourceWhenDefault: 'default' });
        if (decision.source === 'keyword' && decision.mode !== linkedRun!.mode) {
          // `keyword` lets the router refine; never demote to a default-only
          // hint without a real match.
          updateRunMode({
            id: runId,
            mode: decision.mode,
            reason: `PR ${externalRef}: ${decision.reason}`,
            source: 'keyword',
          });
        }
      }
    } catch (err) {
      console.warn('[github-webhook] PR mode hint failed (ignored):', err instanceof Error ? err.message : 'unknown');
    }
  }

  // Optional: attach the PR body as an artifact when we know the Run.
  if (upserted && runId && pr.body) {
    try {
      createArtifact({
        runId,
        type: 'doc',
        producedByAgentId: 'devops-reporter',
        path: url,
        contentRef: 'inline:pr-body',
        meta: { pr_body: pr.body, externalRef },
      });
    } catch { /* ignore artifact failures — non-critical */ }
  }

  // Optional, gated Run transition — merged PR + Run reporting → completed.
  if (upserted && runId && state === 'merged' && ctx.getAppSettings().dorothyPrCiAutoTransition) {
    try {
      const run = getRun(runId);
      if (run && (run.state === 'reporting' || run.state === 'merge_ready' as RunState)) {
        updateRunState(runId, 'completed', { comment: `merged via ${externalRef}` });
      }
    } catch (err) {
      console.warn('[github-webhook] PR merge auto-transition failed:', err);
    }
  }

  return { eventOk: true, prId: upserted?.id };
}

interface CIEventInput {
  externalRef: string;
  workflow: string;
  state: CIRunState;
  conclusion?: string | null;
  startedAt?: string;
  completedAt?: string | null;
  url?: string | null;
  logsUrl?: string | null;
  summary?: string | null;
  branch?: string;
  prNumbers?: number[];
  owner?: string;
  repo?: string;
}

function handleCIEvent(input: CIEventInput, ctx: RouteContext): { eventOk: true; ciId?: string } {
  // Try to bind to a PR row that we already know about.
  let pullRequestId: string | null = null;
  let runId: string | null = null;

  if (input.owner && input.repo && input.prNumbers && input.prNumbers.length) {
    for (const num of input.prNumbers) {
      const ref = `${input.owner}/${input.repo}#${num}`;
      const pr = getPullRequestByExternalRef(ref);
      if (pr) {
        pullRequestId = pr.id;
        runId = pr.runId ?? runId;
        break;
      }
    }
  }
  if (!runId) {
    runId = extractRunIdFrom(input.branch ?? null);
  }

  const upserted = createOrUpdateCIRun({
    externalRef: input.externalRef,
    workflow: input.workflow,
    state: input.state,
    conclusion: input.conclusion ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? null,
    url: input.url ?? null,
    logsUrl: input.logsUrl ?? null,
    summary: input.summary ?? null,
    runId,
    pullRequestId,
    provider: 'github_actions',
  });

  // Phase 5F — mirror as github_ci_event + a dedicated ci_failed / ci_passed
  // marker for the terminal states (so timeline filters can isolate them).
  if (upserted) {
    safeCreateHookEvent({
      type: 'github_ci_event',
      severity: input.state === 'failed' ? 'error' : 'info',
      source: 'github_webhook',
      runId: runId ?? null,
      ciRunId: upserted.id,
      pullRequestId: pullRequestId ?? null,
      title: `CI ${input.state}: ${input.workflow}`,
      summary: makeExcerpt(input.summary ?? input.conclusion ?? null, 200),
      metadata: {
        externalRef: input.externalRef,
        workflow: input.workflow,
        state: input.state,
        conclusion: input.conclusion ?? null,
      },
    });
    if (input.state === 'failed') {
      const ev = safeCreateHookEvent({
        type: 'ci_failed',
        severity: 'error',
        source: 'github_webhook',
        runId: runId ?? null,
        ciRunId: upserted.id,
        pullRequestId: pullRequestId ?? null,
        title: `CI failed: ${input.workflow}`,
        summary: makeExcerpt(input.summary ?? input.conclusion ?? null, 200),
        metadata: {
          externalRef: input.externalRef,
          workflow: input.workflow,
          conclusion: input.conclusion ?? null,
        },
      });
      // Phase 6-A — surface failing workflows on /diagnostics for triage.
      safeDetectDiagnosticFromHookEvent(ev);
      // Phase 6-B — flip the DevOps / Reporter workflow ci_summary_check.
      safeUpdateWorkflowProgressFromHookEvent(ev);
    } else if (input.state === 'success') {
      const ev = safeCreateHookEvent({
        type: 'ci_passed',
        severity: 'info',
        source: 'github_webhook',
        runId: runId ?? null,
        ciRunId: upserted.id,
        pullRequestId: pullRequestId ?? null,
        title: `CI passed: ${input.workflow}`,
        metadata: { externalRef: input.externalRef, workflow: input.workflow },
      });
      safeUpdateWorkflowProgressFromHookEvent(ev);
    }
  }

  // Artifact mirror for terminal CI states (so the Run Detail Artifacts tab
  // surfaces test/review outcomes without an extra fetch).
  if (upserted && runId && (input.state === 'success' || input.state === 'failed')) {
    try {
      createArtifact({
        runId,
        type: input.state === 'failed' ? 'test' : 'review',
        producedByAgentId: 'github-actions',
        path: input.logsUrl ?? input.url ?? null,
        contentRef: `ci:${input.externalRef}`,
        meta: {
          ci_state: input.state,
          ci_conclusion: input.conclusion ?? null,
          workflow: input.workflow,
          summary: input.summary ?? null,
        },
      });
    } catch { /* ignore — non-critical */ }
  }

  // Phase 5C-B — CI failure → ImprovementSignal (dedupe by workflow per Run).
  if (upserted && runId && input.state === 'failed') {
    try {
      createImprovementSignal({
        runId,
        source: 'ci_failure',
        severity: 'high',
        title: `CI failed on ${input.workflow}`,
        summary: (input.summary ?? input.conclusion ?? 'CI marked the run as failed').slice(0, 400),
        evidenceArtifactIds: [],
        relatedAgentId: 'github-actions',
        fingerprint: fingerprintFor({
          source: 'ci_failure',
          runId,
          relatedAgentId: 'github-actions',
          normalizedTitle: `ci-failed:${input.workflow}`,
        }),
      });
    } catch { /* ignore */ }
  }

  // Optional, gated Run transition on CI failure.
  if (upserted && runId && input.state === 'failed' && ctx.getAppSettings().dorothyPrCiAutoTransition) {
    try {
      const run = getRun(runId);
      // Conservative: only flip 'reporting' to 'needs_fix'. Never auto-fail a
      // Run from here; needs_fix gives the orchestrator a chance to retry.
      if (run && run.state === 'reporting') {
        updateRunState(runId, 'needs_fix', { errorReason: `ci failed: ${input.workflow}` });
      }
    } catch (err) {
      console.warn('[github-webhook] CI failure auto-transition failed:', err);
    }
  }

  return { eventOk: true, ciId: upserted?.id };
}

function handleWorkflowRun(payload: WorkflowRunPayload, ctx: RouteContext) {
  const wr = payload.workflow_run;
  if (!wr || !wr.id) return { eventOk: true } as const;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const state = mapGithubRunToCIState(wr.status, wr.conclusion ?? null);
  return handleCIEvent({
    externalRef: `workflow_run:${wr.id}`,
    workflow: wr.name ?? 'unknown',
    state,
    conclusion: wr.conclusion ?? null,
    startedAt: wr.run_started_at ?? undefined,
    completedAt: state === 'queued' || state === 'running' ? null : (wr.updated_at ?? null),
    url: wr.html_url ?? null,
    logsUrl: wr.logs_url ?? null,
    branch: wr.head_branch,
    prNumbers: wr.pull_requests?.map(p => p.number).filter((n): n is number => typeof n === 'number'),
    owner,
    repo,
  }, ctx);
}

function handleCheckRun(payload: CheckRunPayload, ctx: RouteContext) {
  const cr = payload.check_run;
  if (!cr || !cr.id) return { eventOk: true } as const;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const state = mapGithubRunToCIState(cr.status, cr.conclusion ?? null);
  return handleCIEvent({
    externalRef: `check_run:${cr.id}`,
    workflow: cr.name ?? 'unknown',
    state,
    conclusion: cr.conclusion ?? null,
    startedAt: cr.started_at ?? undefined,
    completedAt: cr.completed_at ?? null,
    url: cr.html_url ?? null,
    summary: cr.output?.summary ?? null,
    prNumbers: cr.check_suite?.pull_requests?.map(p => p.number).filter((n): n is number => typeof n === 'number'),
    owner,
    repo,
  }, ctx);
}

function handleCheckSuite(payload: CheckSuitePayload, ctx: RouteContext) {
  const cs = payload.check_suite;
  if (!cs || !cs.id) return { eventOk: true } as const;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const state = mapGithubRunToCIState(cs.status, cs.conclusion ?? null);
  return handleCIEvent({
    externalRef: `check_suite:${cs.id}`,
    workflow: 'check_suite',
    state,
    conclusion: cs.conclusion ?? null,
    branch: cs.head_branch,
    prNumbers: cs.pull_requests?.map(p => p.number).filter((n): n is number => typeof n === 'number'),
    owner,
    repo,
  }, ctx);
}

/* ============================================================================
 * pull_request_review handler
 * ========================================================================== */

export function mapReviewState(state: string | undefined): ReviewerState {
  switch ((state ?? '').toUpperCase()) {
    case 'APPROVED':           return 'approved';
    case 'CHANGES_REQUESTED':  return 'changes_requested';
    case 'COMMENTED':          return 'commented';
    default:                   return 'pending';
  }
}

function mergeReviewerInto(
  reviewers: PullRequestReviewer[] | undefined,
  name: string,
  state: ReviewerState,
): PullRequestReviewer[] {
  const next = (reviewers ?? []).filter(r => r.name !== name);
  next.push({ name, state });
  return next;
}

function handlePullRequestReviewEvent(payload: PullRequestReviewPayload): { eventOk: true; prId?: string } {
  const review = payload.review;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const number = payload.pull_request?.number;
  if (!review || !owner || !repo || !number) return { eventOk: true };

  const externalRef = `${owner}/${repo}#${number}`;
  const existing = getPullRequestByExternalRef(externalRef);
  if (!existing) {
    // We've never seen this PR — without the parent pull_request payload we
    // don't have title/branch/baseBranch to insert one, so we silently ack.
    // The next pull_request webhook will create the row and a subsequent
    // review re-fire will populate reviewers normally.
    return { eventOk: true };
  }

  const reviewerName = review.user?.login ?? 'unknown';
  const reviewerState = mapReviewState(review.state);
  const reviewers = mergeReviewerInto(existing.reviewers, reviewerName, reviewerState);

  // PullRequest state transition policy:
  //   - Never reverse 'merged' or 'closed'.
  //   - Any 'changes_requested' reviewer pins PR state to 'changes_requested'.
  //   - Otherwise leave state untouched (the parent pull_request webhook is
  //     the authoritative source of open/draft/review).
  let nextPrState: PullRequestState = existing.state;
  if (existing.state !== 'merged' && existing.state !== 'closed') {
    const hasChanges = reviewers.some(r => r.state === 'changes_requested');
    if (hasChanges) {
      nextPrState = 'changes_requested';
    } else if (existing.state === 'changes_requested') {
      // All blocking reviews resolved → fall back to 'review' for visibility.
      const hasAnyReview = reviewers.some(r => r.state !== 'pending');
      nextPrState = hasAnyReview ? 'review' : 'open';
    }
  }

  const updated = updatePullRequestState({
    id: existing.id,
    state: nextPrState,
    reviewers,
  });

  // Phase 5F — Hook Event timeline. We never store the review body — only
  // the reviewer name + verdict + PR ref so the timeline can render a row.
  if (updated) {
    const ev = safeCreateHookEvent({
      type: 'github_review_event',
      severity: reviewerState === 'changes_requested' ? 'warning' : 'info',
      source: 'github_webhook',
      runId: existing.runId ?? null,
      pullRequestId: updated.id,
      title: `Review ${reviewerState} on ${externalRef} by @${reviewerName}`,
      metadata: {
        externalRef,
        reviewer: reviewerName,
        reviewerState,
        action: payload.action ?? null,
      },
    });
    // Phase 6-A — only changes_requested becomes a Diagnostic; approved /
    // commented reviews are normal flow and don't need triage.
    if (reviewerState === 'changes_requested') {
      safeDetectDiagnosticFromHookEvent(ev);
    }
  }

  // Optional artifact mirror for the review itself.
  if (updated && existing.runId && review.html_url) {
    try {
      createArtifact({
        runId: existing.runId,
        type: 'review',
        producedByAgentId: 'github-review',
        path: review.html_url,
        contentRef: `review:${review.id ?? 'unknown'}`,
        meta: {
          reviewer: reviewerName,
          reviewer_state: reviewerState,
          externalRef,
          // Body is intentionally truncated; we keep at most 400 chars and
          // never log the full content.
          excerpt: typeof review.body === 'string' ? review.body.slice(0, 400) : null,
        },
      });
    } catch { /* artifact failures are non-critical */ }
  }

  // Phase 5C-B — CHANGES_REQUESTED → ImprovementSignal so it shows up in the
  // self-improvement loop.
  if (updated && existing.runId && reviewerState === 'changes_requested') {
    try {
      createImprovementSignal({
        runId: existing.runId,
        source: 'review_changes_requested',
        severity: 'medium',
        title: `Reviewer requested changes on ${externalRef}`,
        summary: `@${reviewerName} requested changes. Address feedback before merging.`,
        relatedAgentId: 'github-review',
        fingerprint: fingerprintFor({
          source: 'review_changes_requested',
          runId: existing.runId,
          relatedAgentId: 'github-review',
          normalizedTitle: `changes:${externalRef}:${reviewerName}`,
        }),
      });
    } catch { /* ignore */ }
  }

  return { eventOk: true, prId: updated?.id };
}

/* ============================================================================
 * Comment handlers (pull_request_review_comment / issue_comment)
 *
 * Both events flow through the same logic: detect user-gate keywords in the
 * comment body, and (when we know the Run) write a pending ApprovalRequest
 * pointing at it. We *never* auto-approve from a comment.
 * ========================================================================== */

function extractPrNumberFromCommentPayload(payload: ReviewCommentPayload): number | null {
  if (typeof payload.pull_request?.number === 'number') return payload.pull_request.number;
  // issue_comment for a PR carries the number on `issue`, and the presence of
  // `issue.pull_request` proves the issue is a PR (not a regular issue).
  if (payload.issue && payload.issue.pull_request && typeof payload.issue.number === 'number') {
    return payload.issue.number;
  }
  return null;
}

function handleCommentEvent(payload: ReviewCommentPayload, eventName: string): {
  eventOk: true;
  approvalId?: string;
  ignored?: boolean;
  reason?: string;
} {
  const comment = payload.comment;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const number = extractPrNumberFromCommentPayload(payload);
  const body = comment?.body ?? '';

  // issue_comment fires for non-PR issues too — silently ignore those.
  if (!comment || !owner || !repo || !number) {
    return { eventOk: true, ignored: true, reason: 'not-a-pr-comment' };
  }

  const hits = detectGateKeywords(body);
  if (hits.length === 0) {
    return { eventOk: true, ignored: true, reason: 'no-gate-keywords' };
  }

  const externalRef = `${owner}/${repo}#${number}`;
  const pr = getPullRequestByExternalRef(externalRef);
  if (!pr) {
    return { eventOk: true, ignored: true, reason: 'unknown-pr' };
  }
  if (!pr.runId) {
    // We saw a gate keyword on a PR we know about, but it isn't linked to a
    // Run. Leave a lightweight artifact for traceability but skip the
    // ApprovalRequest — there's nothing to gate against.
    try {
      createArtifact({
        // artifacts require a runId, so skip the row when we have none —
        // we keep the ack lean per the spec.
        runId: pr.id, // never reached; see comment above
        type: 'other',
        producedByAgentId: 'github-comment',
        path: comment.html_url ?? null,
        contentRef: `comment:${comment.id ?? 'unknown'}`,
        meta: { externalRef, commenter: comment.user?.login ?? 'unknown', keywords: hits.map(h => h.keyword) },
      });
    } catch { /* no-op — required runId not present */ }
    return { eventOk: true, ignored: true, reason: 'pr-without-run' };
  }

  const commenter = comment.user?.login ?? 'unknown';
  const keywordList = hits.map(h => h.keyword).join(', ');
  const decisionNote = `${eventName} by @${commenter} on ${externalRef} — gate keywords: ${keywordList}`;
  // The keyword that ranks highest is used for the ApprovalRequest.topic so
  // /approvals can group by gate.
  const topic = `gate:${hits[0].keyword.toLowerCase()}`;

  let approvalId: string | undefined;
  try {
    const req = createApprovalRequest({
      runId: pr.runId,
      planId: null,
      // Comments default to medium risk — the orchestrator's plan-validator
      // re-evaluates anyway when the Run reaches its next decision point.
      riskLevel: 'medium',
      topic,
      state: 'pending',
    });
    approvalId = req?.id;
    // Mirror a compact summary into the Run's artifacts (no full body!).
    if (req && pr.runId) {
      try {
        createArtifact({
          runId: pr.runId,
          type: 'other',
          producedByAgentId: 'github-comment',
          path: comment.html_url ?? null,
          contentRef: `comment:${comment.id ?? 'unknown'}`,
          meta: {
            externalRef,
            commenter,
            event: eventName,
            keywords: hits.map(h => h.keyword),
            approval_request_id: req.id,
            decision_note: decisionNote,
            excerpt: body.slice(0, 240),
          },
        });
      } catch { /* artifact mirror failures are non-critical */ }
    }
  } catch (err) {
    console.warn('[github-webhook] createApprovalRequest from comment failed:', err instanceof Error ? err.message : 'unknown');
  }

  // Phase 5C-B — gate-keyword comments also surface as an ImprovementSignal
  // so the operator can spot recurring policy-sensitive PRs.
  if (approvalId) {
    try {
      createImprovementSignal({
        runId: pr.runId,
        source: 'approval_required',
        severity: 'medium',
        title: `Gate keyword detected on ${externalRef}`,
        summary: `Keywords: ${keywordList}. Commenter @${commenter}. Approval queued.`,
        relatedAgentId: 'github-comment',
        fingerprint: fingerprintFor({
          source: 'approval_required',
          runId: pr.runId,
          relatedAgentId: 'github-comment',
          normalizedTitle: `gate:${hits[0].keyword.toLowerCase()}`,
        }),
      });
    } catch { /* ignore */ }
  }

  // Phase 5F — mirror the gate keyword detection. We never store the raw
  // comment body — only the keyword list + commenter + PR ref.
  safeCreateHookEvent({
    type: 'github_comment_gate',
    severity: 'warning',
    source: 'github_webhook',
    runId: pr.runId ?? null,
    pullRequestId: pr.id,
    approvalRequestId: approvalId ?? null,
    title: `Gate keywords on ${externalRef}: ${keywordList}`,
    metadata: {
      externalRef,
      commenter,
      event: eventName,
      keywords: hits.map(h => h.keyword),
      approvalRequestId: approvalId ?? null,
    },
  });

  return { eventOk: true, approvalId };
}

/* ============================================================================
 * Route registration
 * ========================================================================== */

export function registerGithubWebhookRoutes(app: RouteApp, ctx: RouteContext): void {
  app.post('/api/github/webhook', (req, sendJson) => {
    const event = req.raw.headers['x-github-event'];
    const delivery = req.raw.headers['x-github-delivery'];
    const signature = req.raw.headers['x-hub-signature-256'];
    const eventStr = typeof event === 'string' ? event : '';
    const deliveryStr = typeof delivery === 'string' ? delivery : '';

    if (!eventStr) {
      sendJson({ error: 'missing x-github-event header' }, 400);
      return;
    }

    const settings = ctx.getAppSettings();
    const secret = (settings.githubWebhookSecret ?? '').trim();
    const allowUnsigned = !!settings.dorothyDevAllowUnsignedWebhook;

    // Signature gate — Phase 5C-A: HMAC the raw request bytes (api-server.ts
    // hands them over via `req.rawBody` for `/api/github/webhook`). We fall
    // back to a canonical re-serialization only if rawBody is somehow absent,
    // which keeps unit tests that bypass the HTTP layer compatible.
    if (secret) {
      const sigStr = typeof signature === 'string' ? signature : undefined;
      const rawBody: Buffer | string = req.rawBody ?? JSON.stringify(req.body ?? {});
      const ok = verifyGithubSignature({ secret, signatureHeader: sigStr, rawBody });
      if (!ok) {
        // Intentionally do NOT log the signature, secret, or body. Delivery
        // id + event name are enough to correlate with GitHub's UI.
        console.warn(`[github-webhook] signature rejected for delivery=${deliveryStr} event=${eventStr}`);
        sendJson({ error: 'signature verification failed' }, 401);
        return;
      }
    } else if (!allowUnsigned) {
      console.warn(`[github-webhook] secret unset and dev-allow-unsigned off — rejecting delivery=${deliveryStr}`);
      sendJson({ error: 'webhook secret not configured' }, 401);
      return;
    } else {
      console.warn(`[github-webhook] accepting UNSIGNED delivery=${deliveryStr} (dev mode)`);
    }

    // ping events keep GitHub's UI green; just ack.
    if (eventStr === 'ping') {
      sendJson({ ok: true, pong: true });
      return;
    }

    if (!SUPPORTED_EVENTS.has(eventStr)) {
      sendJson({ ok: true, ignored: true, event: eventStr });
      return;
    }

    if (!getDorothyDb()) {
      sendJson({ ok: false, dbUnavailable: true });
      return;
    }

    try {
      let result: { eventOk: true; prId?: string; ciId?: string; approvalId?: string; ignored?: boolean; reason?: string } = { eventOk: true };
      if (eventStr === 'pull_request') {
        result = handlePullRequestEvent(req.body as PullRequestPayload, ctx);
      } else if (eventStr === 'pull_request_review') {
        result = handlePullRequestReviewEvent(req.body as PullRequestReviewPayload);
      } else if (eventStr === 'pull_request_review_comment' || eventStr === 'issue_comment') {
        result = handleCommentEvent(req.body as ReviewCommentPayload, eventStr);
      } else if (eventStr === 'workflow_run') {
        result = handleWorkflowRun(req.body as WorkflowRunPayload, ctx);
      } else if (eventStr === 'check_run') {
        result = handleCheckRun(req.body as CheckRunPayload, ctx);
      } else if (eventStr === 'check_suite') {
        result = handleCheckSuite(req.body as CheckSuitePayload, ctx);
      }
      sendJson({ ok: true, event: eventStr, ...result });
    } catch (err) {
      console.error('[github-webhook] handler failed:', err instanceof Error ? err.message : 'unknown');
      sendJson({ ok: false, error: err instanceof Error ? err.message : 'unknown' }, 500);
    }
  });
}
