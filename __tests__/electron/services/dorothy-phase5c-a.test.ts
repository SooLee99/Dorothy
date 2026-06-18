/**
 * Dorothy MVP Phase 5C-A — raw body HMAC + review/comment webhook events.
 *
 * Covers:
 *   - Raw body bytes (not a JSON re-serialization) are what gets HMAC'd
 *   - pull_request_review APPROVED / CHANGES_REQUESTED → reviewers_json update
 *   - merged / closed PRs aren't reverted to open/review by review events
 *   - issue_comment + pull_request_review_comment with gate keywords →
 *     ApprovalRequest{state:'pending'}
 *   - non-keyword comments are ignored
 *   - comments on PRs without a runId are safely ignored
 *   - existing pull_request / workflow_run / check_run paths unchanged
 *   - dbUnavailable still returns the graceful envelope
 *   - comment body and webhook secret are not leaked into the JSON response
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

import { initDorothyDb, closeDorothyDb } from '../../../electron/services/dorothy/db';
import { createRun, updateRunState, getRun } from '../../../electron/services/dorothy/run-service';
import {
  createOrUpdatePullRequest,
  getPullRequestByExternalRef,
} from '../../../electron/services/dorothy/pr-service';
import {
  registerGithubWebhookRoutes,
  verifyGithubSignature,
  detectGateKeywords,
  mapReviewState,
} from '../../../electron/services/api-routes/github-webhook-routes';
import { listApprovalRequests } from '../../../electron/services/dorothy/approval-request-service';

import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import type { AppSettings } from '../../../electron/types';

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase5c-a-${process.pid}`);
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let dbPath = '';

beforeEach(() => {
  dbPath = path.join(TEST_DIR, `dorothy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const r = initDorothyDb({ filePath: dbPath });
  if (!r.ok) throw new Error(`initDorothyDb failed: ${r.reason}`);
});

afterEach(() => {
  closeDorothyDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
});

/* ============================================================================
 * Test rig (mirrors phase 5a)
 * ========================================================================== */

interface FakeRoute {
  method: string;
  pattern: string | RegExp;
  handler: (req: RouteRequest, sendJson: (data: unknown, status?: number) => void, ctx: RouteContext) => void | Promise<void>;
}

function makeRouteApp(): { app: RouteApp; routes: FakeRoute[] } {
  const routes: FakeRoute[] = [];
  const app: RouteApp = {
    routes: routes as unknown as RouteApp['routes'],
    add(method, pattern, handler) { routes.push({ method, pattern, handler }); },
    get(pattern, handler) { routes.push({ method: 'GET', pattern, handler }); },
    post(pattern, handler) { routes.push({ method: 'POST', pattern, handler }); },
    put(pattern, handler) { routes.push({ method: 'PUT', pattern, handler }); },
    delete(pattern, handler) { routes.push({ method: 'DELETE', pattern, handler }); },
  };
  return { app, routes };
}

function buildSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    notificationsEnabled: false, notifyOnWaiting: false, notifyOnComplete: false,
    notifyOnStop: false, notifyOnError: false,
    telegramEnabled: false, telegramBotToken: '', telegramChatId: '',
    telegramAuthToken: '', telegramAuthorizedChatIds: [], telegramRequireMention: false,
    slackEnabled: false, slackBotToken: '', slackAppToken: '', slackSigningSecret: '', slackChannelId: '',
    jiraEnabled: false, jiraDomain: '', jiraEmail: '', jiraApiToken: '',
    socialDataEnabled: false, socialDataApiKey: '',
    xPostingEnabled: false, xApiKey: '', xApiSecret: '', xAccessToken: '', xAccessTokenSecret: '',
    tasmaniaEnabled: false, tasmaniaServerPath: '',
    gwsEnabled: false, gwsSkillsInstalled: false,
    verboseModeEnabled: false, chromeEnabled: false, autoCheckUpdates: false,
    cliPaths: { claude: '', codex: '', gemini: '', opencode: '', pi: '', gws: '', gcloud: '', gh: '', node: '', additionalPaths: [] },
    opencodeEnabled: false, opencodeDefaultModel: '',
    ...overrides,
  };
}

function buildCtx(settings: AppSettings): RouteContext {
  return {
    mainWindow: null,
    appSettings: settings,
    getAppSettings: () => settings,
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: () => {},
    sendNotificationCallback: () => {},
    initAgentPtyCallback: async () => 'pty',
    agentStatusEmitter: new EventEmitter(),
  };
}

interface InvokeArgs {
  routes: FakeRoute[];
  event: string;
  body: Record<string, unknown>;
  rawBody?: Buffer;
  signature?: string;
  ctx: RouteContext;
}

function invokeWebhook({ routes, event, body, rawBody, signature, ctx }: InvokeArgs): { status: number; payload: unknown } {
  const route = routes.find(r => r.method === 'POST' && r.pattern === '/api/github/webhook');
  expect(route).toBeTruthy();
  let captured: { status: number; payload: unknown } = { status: 200, payload: null };
  const req: RouteRequest = {
    method: 'POST',
    pathname: '/api/github/webhook',
    url: new URL('http://127.0.0.1/api/github/webhook'),
    body,
    rawBody,
    raw: {
      headers: {
        'x-github-event': event,
        'x-github-delivery': 'test-delivery-id',
        ...(signature ? { 'x-hub-signature-256': signature } : {}),
      },
    } as unknown as RouteRequest['raw'],
    res: {} as unknown as RouteRequest['res'],
    params: {},
  };
  const sendJson = (data: unknown, status = 200) => { captured = { status, payload: data }; };
  void route!.handler(req, sendJson, ctx);
  return captured;
}

function signRaw(secret: string, raw: Buffer | string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

/* ============================================================================
 * Raw body HMAC
 * ========================================================================== */

describe('raw body HMAC', () => {
  it('verifyGithubSignature accepts a Buffer rawBody (production path)', () => {
    const secret = 'sk-prod';
    const raw = Buffer.from('{"x":1}', 'utf8');
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    expect(verifyGithubSignature({ secret, signatureHeader: sig, rawBody: raw })).toBe(true);
    // Bad signature still fails.
    expect(verifyGithubSignature({ secret, signatureHeader: 'sha256=ffff', rawBody: raw })).toBe(false);
  });

  it('route uses rawBody bytes — JSON re-serialization that differs is rejected', () => {
    const secret = 'sk';
    const settings = buildSettings({ githubWebhookSecret: secret });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    // The "canonical" GitHub payload includes whitespace and key order that
    // would differ from JSON.stringify(req.body) — we sign the raw bytes the
    // way GitHub does, and pass `body` already parsed from those same bytes.
    const rawString = '{\n  "action": "opened",\n  "number": 1,\n  "pull_request": {"number":1,"state":"open","html_url":"u","head":{"ref":"b"},"base":{"ref":"main"},"title":"t","draft":false},\n  "repository": {"name":"r","owner":{"login":"o"}}\n}';
    const rawBuf = Buffer.from(rawString, 'utf8');
    const body = JSON.parse(rawString);
    const sig = signRaw(secret, rawBuf);

    const ok = invokeWebhook({
      routes, event: 'pull_request', body, rawBody: rawBuf, signature: sig, ctx,
    });
    expect(ok.status).toBe(200);

    // Now mutate the rawBody by one byte — the signature must be rejected
    // (proves we actually HMAC the raw bytes, not the re-serialized body).
    const tampered = Buffer.from(rawString.replace('"opened"', '"OPENED"'), 'utf8');
    const bad = invokeWebhook({
      routes, event: 'pull_request', body, rawBody: tampered, signature: sig, ctx,
    });
    expect(bad.status).toBe(401);
  });

  it('falls back to JSON re-serialization when rawBody is undefined (test compat)', () => {
    // Older test entrypoints that don't pass rawBody should still work — we
    // use this in the phase 5a suite.
    const secret = 'sk-fallback';
    const settings = buildSettings({ githubWebhookSecret: secret });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const body = { action: 'opened' } as Record<string, unknown>;
    const sig = signRaw(secret, JSON.stringify(body));

    const res = invokeWebhook({ routes, event: 'ping', body, signature: sig, ctx });
    // 'ping' acks regardless of body shape; signature must still match.
    expect(res.status).toBe(200);
  });

  it('does not log secret or full body — sendJson payload excludes both', () => {
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);
    const body = { hello: 'world', extra: 'sensitive: token=abcdef' } as Record<string, unknown>;
    const res = invokeWebhook({ routes, event: 'ping', body, ctx });
    expect(res.status).toBe(200);
    const json = JSON.stringify(res.payload);
    expect(json).not.toContain('sensitive');
    expect(json).not.toContain('abcdef');
  });
});

/* ============================================================================
 * detectGateKeywords + mapReviewState
 * ========================================================================== */

describe('detectGateKeywords', () => {
  it('finds canonical keywords with word boundaries', () => {
    const hits = detectGateKeywords('Please deploy to production — secret rotation handled.');
    const keywords = hits.map(h => h.keyword.toLowerCase());
    expect(keywords).toContain('deploy');
    expect(keywords).toContain('production');
    expect(keywords).toContain('secret');
  });

  it('matches the SEC- prefix family with expanded id', () => {
    const hits = detectGateKeywords('please cross-check SEC-127 before merge');
    const keys = hits.map(h => h.keyword);
    expect(keys.some(k => k.startsWith('SEC-'))).toBe(true);
    expect(keys.map(k => k.toLowerCase())).toContain('merge');
  });

  it('does NOT match keyword fragments inside larger words', () => {
    // "redeployed" should not match "deploy" (word boundary).
    expect(detectGateKeywords('we redeployed yesterday')).toEqual([]);
  });

  it('matches the SQL phrase DELETE FROM', () => {
    const hits = detectGateKeywords('be careful: DELETE FROM users where id = 1');
    expect(hits.map(h => h.keyword.toLowerCase())).toContain('delete from');
  });

  it('returns [] for plain prose', () => {
    expect(detectGateKeywords('lgtm, nice cleanup!')).toEqual([]);
  });
});

describe('mapReviewState', () => {
  it.each([
    ['APPROVED',           'approved'],
    ['CHANGES_REQUESTED',  'changes_requested'],
    ['COMMENTED',          'commented'],
    ['PENDING',            'pending'],
    ['DISMISSED',          'pending'],
    [undefined,            'pending'],
  ] as const)('maps %s → %s', (input, expected) => {
    expect(mapReviewState(input as string | undefined)).toBe(expected);
  });
});

/* ============================================================================
 * pull_request_review handler
 * ========================================================================== */

describe('pull_request_review event', () => {
  function seedOpenPr() {
    return createOrUpdatePullRequest({
      externalRef: 'foo/bar#7', owner: 'foo', repo: 'bar', number: 7,
      url: 'https://github.com/foo/bar/pull/7',
      branch: 'feat/x', baseBranch: 'main',
      state: 'open', title: 'feat: x',
      runId: '00000000-0000-0000-0000-000000000007',
    });
  }

  it('APPROVED merges into reviewers_json', () => {
    seedOpenPr();
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const res = invokeWebhook({
      routes, event: 'pull_request_review',
      body: {
        action: 'submitted',
        review: { id: 1, state: 'APPROVED', user: { login: 'alice' }, html_url: 'https://github.com/foo/bar/pull/7#review-1', body: 'lgtm' },
        pull_request: { number: 7, state: 'open' },
        repository: { name: 'bar', owner: { login: 'foo' } },
      },
      ctx,
    });
    expect(res.status).toBe(200);
    const pr = getPullRequestByExternalRef('foo/bar#7')!;
    expect(pr.reviewers?.find(r => r.name === 'alice')?.state).toBe('approved');
    // open + an approval → stays open (or moves to 'review' if a previous
    // change-request existed; we have neither here, so it stays open).
    expect(pr.state).toBe('open');
  });

  it('CHANGES_REQUESTED pins PR to changes_requested', () => {
    seedOpenPr();
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    invokeWebhook({
      routes, event: 'pull_request_review',
      body: {
        action: 'submitted',
        review: { id: 2, state: 'CHANGES_REQUESTED', user: { login: 'bob' } },
        pull_request: { number: 7, state: 'open' },
        repository: { name: 'bar', owner: { login: 'foo' } },
      },
      ctx,
    });
    const pr = getPullRequestByExternalRef('foo/bar#7')!;
    expect(pr.state).toBe('changes_requested');
    expect(pr.reviewers?.find(r => r.name === 'bob')?.state).toBe('changes_requested');
  });

  it('does NOT roll back a merged PR', () => {
    createOrUpdatePullRequest({
      externalRef: 'foo/bar#8', owner: 'foo', repo: 'bar', number: 8,
      url: 'u', branch: 'b', baseBranch: 'main',
      state: 'merged', title: 't',
      mergedAt: '2026-06-03T10:00:00Z',
    });
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    invokeWebhook({
      routes, event: 'pull_request_review',
      body: {
        action: 'submitted',
        review: { id: 3, state: 'APPROVED', user: { login: 'carol' } },
        pull_request: { number: 8, state: 'closed', merged: true },
        repository: { name: 'bar', owner: { login: 'foo' } },
      },
      ctx,
    });
    const pr = getPullRequestByExternalRef('foo/bar#8')!;
    expect(pr.state).toBe('merged'); // unchanged
    expect(pr.mergedAt).toBe('2026-06-03T10:00:00Z');
  });

  it('does NOT roll back a closed PR', () => {
    createOrUpdatePullRequest({
      externalRef: 'foo/bar#9', owner: 'foo', repo: 'bar', number: 9,
      url: 'u', branch: 'b', baseBranch: 'main',
      state: 'closed', title: 't',
      closedAt: '2026-06-03T10:00:00Z',
    });
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    invokeWebhook({
      routes, event: 'pull_request_review',
      body: {
        action: 'submitted',
        review: { id: 4, state: 'COMMENTED', user: { login: 'dave' } },
        pull_request: { number: 9, state: 'closed', merged: false },
        repository: { name: 'bar', owner: { login: 'foo' } },
      },
      ctx,
    });
    expect(getPullRequestByExternalRef('foo/bar#9')!.state).toBe('closed');
  });

  it('safely ignores a review for an unknown PR (no row inserted)', () => {
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const res = invokeWebhook({
      routes, event: 'pull_request_review',
      body: {
        action: 'submitted',
        review: { id: 5, state: 'APPROVED', user: { login: 'eve' } },
        pull_request: { number: 999, state: 'open' },
        repository: { name: 'bar', owner: { login: 'foo' } },
      },
      ctx,
    });
    expect(res.status).toBe(200);
    expect(getPullRequestByExternalRef('foo/bar#999')).toBeNull();
  });
});

/* ============================================================================
 * comment events
 * ========================================================================== */

describe('issue_comment + pull_request_review_comment events', () => {
  it('issue_comment with gate keywords creates a pending ApprovalRequest', () => {
    const run = createRun({ title: 'gated', source: 'user' })!;
    updateRunState(run.id, 'planned'); updateRunState(run.id, 'approved'); updateRunState(run.id, 'running');
    createOrUpdatePullRequest({
      externalRef: 'foo/bar#42', owner: 'foo', repo: 'bar', number: 42,
      url: 'u', branch: 'b', baseBranch: 'main',
      state: 'open', title: 't', runId: run.id,
    });

    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const res = invokeWebhook({
      routes, event: 'issue_comment',
      body: {
        action: 'created',
        comment: { id: 100, body: 'Please verify before we deploy to production.', user: { login: 'eng-mgr' }, html_url: 'https://github.com/foo/bar/pull/42#issuecomment-100' },
        issue: { number: 42, pull_request: { url: 'u' } },
        repository: { name: 'bar', owner: { login: 'foo' } },
      },
      ctx,
    });
    expect(res.status).toBe(200);
    const apps = listApprovalRequests({ runId: run.id });
    expect(apps).toHaveLength(1);
    expect(apps[0].state).toBe('pending');
    expect(apps[0].topic).toMatch(/^gate:/);
  });

  it('pull_request_review_comment also opens a pending approval', () => {
    const run = createRun({ title: 'gated-2', source: 'user' })!;
    createOrUpdatePullRequest({
      externalRef: 'foo/bar#43', owner: 'foo', repo: 'bar', number: 43,
      url: 'u', branch: 'b', baseBranch: 'main',
      state: 'open', title: 't', runId: run.id,
    });
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    invokeWebhook({
      routes, event: 'pull_request_review_comment',
      body: {
        comment: { id: 200, body: 'SEC-3: do not merge without rotating the secret.', user: { login: 'security' } },
        pull_request: { number: 43 },
        repository: { name: 'bar', owner: { login: 'foo' } },
      },
      ctx,
    });
    expect(listApprovalRequests({ runId: run.id })).toHaveLength(1);
  });

  it('comments without gate keywords are ignored — no ApprovalRequest', () => {
    const run = createRun({ title: 'no-gate', source: 'user' })!;
    createOrUpdatePullRequest({
      externalRef: 'foo/bar#44', owner: 'foo', repo: 'bar', number: 44,
      url: 'u', branch: 'b', baseBranch: 'main',
      state: 'open', title: 't', runId: run.id,
    });
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    invokeWebhook({
      routes, event: 'issue_comment',
      body: {
        action: 'created',
        comment: { id: 300, body: 'lgtm, looks clean.', user: { login: 'reviewer' } },
        issue: { number: 44, pull_request: { url: 'u' } },
        repository: { name: 'bar', owner: { login: 'foo' } },
      },
      ctx,
    });
    expect(listApprovalRequests({ runId: run.id })).toHaveLength(0);
  });

  it('comments on PRs without a runId are acked but skip ApprovalRequest creation', () => {
    createOrUpdatePullRequest({
      externalRef: 'foo/bar#45', owner: 'foo', repo: 'bar', number: 45,
      url: 'u', branch: 'b', baseBranch: 'main',
      state: 'open', title: 't',
      // no runId
    });
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const res = invokeWebhook({
      routes, event: 'issue_comment',
      body: {
        action: 'created',
        comment: { id: 400, body: 'please deploy this carefully', user: { login: 'pm' } },
        issue: { number: 45, pull_request: { url: 'u' } },
        repository: { name: 'bar', owner: { login: 'foo' } },
      },
      ctx,
    });
    expect(res.status).toBe(200);
    // No Run → no approval rows.
    expect(listApprovalRequests({})).toHaveLength(0);
  });

  it('does not leak the comment body or webhook secret into the response', () => {
    const run = createRun({ title: 'safe-log', source: 'user' })!;
    createOrUpdatePullRequest({
      externalRef: 'foo/bar#46', owner: 'foo', repo: 'bar', number: 46,
      url: 'u', branch: 'b', baseBranch: 'main',
      state: 'open', title: 't', runId: run.id,
    });
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true, githubWebhookSecret: 'TOP-SECRET-DO-NOT-LEAK' });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const sensitiveBody = 'production password=trythis123 deploy ASAP';
    const res = invokeWebhook({
      routes, event: 'issue_comment',
      body: {
        action: 'created',
        comment: { id: 500, body: sensitiveBody, user: { login: 'attacker' } },
        issue: { number: 46, pull_request: { url: 'u' } },
        repository: { name: 'bar', owner: { login: 'foo' } },
      },
      // We deliberately skip signature here because the dev override is on.
      ctx,
    });
    const asJson = JSON.stringify(res.payload);
    expect(asJson).not.toContain('TOP-SECRET-DO-NOT-LEAK');
    expect(asJson).not.toContain('trythis123');
    expect(asJson).not.toContain(sensitiveBody);
  });
});

/* ============================================================================
 * Phase 5A regression smoke
 * ========================================================================== */

describe('Phase 5A behaviour still works under 5C-A wiring', () => {
  it('pull_request webhook still creates a PR row', () => {
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    invokeWebhook({
      routes, event: 'pull_request',
      body: {
        action: 'opened', number: 60,
        pull_request: {
          number: 60, state: 'open', draft: false, html_url: 'u',
          head: { ref: 'feat' }, base: { ref: 'main' }, title: 't',
        },
        repository: { name: 'bar', owner: { login: 'foo' } },
      },
      ctx,
    });
    expect(getPullRequestByExternalRef('foo/bar#60')).toBeTruthy();
  });

  it('CI failed without auto-transition flag does NOT flip Run state', () => {
    const r = createRun({ title: 'no-flip', source: 'user' })!;
    updateRunState(r.id, 'planned'); updateRunState(r.id, 'approved'); updateRunState(r.id, 'running'); updateRunState(r.id, 'reporting');
    createOrUpdatePullRequest({
      externalRef: 'a/b#1', owner: 'a', repo: 'b', number: 1,
      url: 'u', branch: 'br', baseBranch: 'main',
      state: 'open', title: 't', runId: r.id,
    });
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    invokeWebhook({
      routes, event: 'workflow_run',
      body: {
        workflow_run: { id: 1, name: 'test', status: 'completed', conclusion: 'failure', run_started_at: '2026-06-03T09:00:00Z', pull_requests: [{ number: 1 }] },
        repository: { name: 'b', owner: { login: 'a' } },
      },
      ctx,
    });
    expect(getRun(r.id)?.state).toBe('reporting');
  });

  it('graceful dbUnavailable response when DB is closed', () => {
    closeDorothyDb();
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const res = invokeWebhook({
      routes, event: 'pull_request_review',
      body: {
        review: { state: 'APPROVED', user: { login: 'x' } },
        pull_request: { number: 1, state: 'open' },
        repository: { name: 'r', owner: { login: 'o' } },
      },
      ctx,
    });
    expect((res.payload as { dbUnavailable?: boolean }).dbUnavailable).toBe(true);
    initDorothyDb({ filePath: dbPath }); // restore for afterEach
  });
});
