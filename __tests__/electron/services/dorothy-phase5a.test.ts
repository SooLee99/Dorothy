/**
 * Dorothy MVP Phase 5A — PR / CI tracking + GitHub webhook receiver.
 *
 * Covers every checkbox in the Phase 5A spec:
 *   - PullRequest createOrUpdate upserts on externalRef
 *   - CIRun createOrUpdate upserts on externalRef
 *   - PR/CI lookup by runId
 *   - pull_request webhook → PullRequest row
 *   - workflow_run / check_run webhooks → CIRun rows
 *   - signature verification (good + bad)
 *   - missing secret + dev-allow-unsigned policy gates
 *   - CI failed does NOT auto-fail Run unless the feature flag is on
 *   - The flag flips reporting → needs_fix on CI failure, no other state
 *   - dorothy.db unavailable → graceful response
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

import {
  initDorothyDb,
  closeDorothyDb,
} from '../../../electron/services/dorothy/db';
import {
  createRun,
  getRun,
  updateRunState,
} from '../../../electron/services/dorothy/run-service';
import {
  createOrUpdatePullRequest,
  getPullRequestByExternalRef,
  listPullRequestsByRun,
  getPullRequest,
  updatePullRequestState,
} from '../../../electron/services/dorothy/pr-service';
import {
  createOrUpdateCIRun,
  getCIRunByExternalRef,
  listCIRunsByRun,
  listCIRunsByPullRequest,
} from '../../../electron/services/dorothy/ci-run-service';
import {
  registerGithubWebhookRoutes,
  verifyGithubSignature,
  mapPullRequestPayloadToState,
  mapGithubRunToCIState,
  extractRunIdFrom,
} from '../../../electron/services/api-routes/github-webhook-routes';
import { listArtifactsByRun } from '../../../electron/services/dorothy/artifact-service';

import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import type { AppSettings } from '../../../electron/types';

/* ============================================================================
 * Test rig
 * ========================================================================== */

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase5a-${process.pid}`);
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
 * Minimal RouteApp / RouteContext mocks
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

function invokeWebhook({
  routes, event, body, signature, ctx,
}: {
  routes: FakeRoute[];
  event: string;
  body: Record<string, unknown>;
  signature?: string;
  ctx: RouteContext;
}): { status: number; payload: unknown } {
  const route = routes.find(r => r.method === 'POST' && r.pattern === '/api/github/webhook');
  expect(route).toBeTruthy();
  let captured: { status: number; payload: unknown } = { status: 200, payload: null };
  const req: RouteRequest = {
    method: 'POST',
    pathname: '/api/github/webhook',
    url: new URL('http://127.0.0.1/api/github/webhook'),
    body,
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
  // The route returns void or Promise<void>; we wait synchronously since
  // all handlers above are sync.
  void route!.handler(req, sendJson, ctx);
  return captured;
}

function signature(secret: string, body: Record<string, unknown>): string {
  const canonical = JSON.stringify(body);
  return 'sha256=' + crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

/* ============================================================================
 * Service-level: upsert + lookup
 * ========================================================================== */

describe('PullRequest service', () => {
  it('upserts on externalRef and keeps existing runId/bodyArtifactId', () => {
    const created = createOrUpdatePullRequest({
      externalRef: 'foo/bar#1', owner: 'foo', repo: 'bar', number: 1,
      url: 'https://github.com/foo/bar/pull/1',
      branch: 'feat/x', baseBranch: 'main',
      state: 'open', title: 'feat',
      runId: '00000000-0000-0000-0000-000000000001',
      bodyArtifactId: 'art-1',
      provider: 'github',
    })!;
    expect(created.id).toBeTruthy();
    expect(created.externalRef).toBe('foo/bar#1');

    // Second event missing runId / bodyArtifactId should preserve them.
    const updated = createOrUpdatePullRequest({
      externalRef: 'foo/bar#1', owner: 'foo', repo: 'bar', number: 1,
      url: 'https://github.com/foo/bar/pull/1',
      branch: 'feat/x', baseBranch: 'main',
      state: 'review', title: 'feat',
    })!;
    expect(updated.id).toBe(created.id);
    expect(updated.state).toBe('review');
    expect(updated.runId).toBe('00000000-0000-0000-0000-000000000001');
    expect(updated.bodyArtifactId).toBe('art-1');
  });

  it('lists by run id', () => {
    const r = createRun({ title: 'pr-link', source: 'user' })!;
    createOrUpdatePullRequest({
      externalRef: 'foo/bar#2', owner: 'foo', repo: 'bar', number: 2,
      url: 'u', branch: 'b', baseBranch: 'main',
      state: 'open', title: 't', runId: r.id,
    });
    const prs = listPullRequestsByRun(r.id);
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(2);
  });

  it('updatePullRequestState records merged/closed timestamps', () => {
    const pr = createOrUpdatePullRequest({
      externalRef: 'foo/bar#3', owner: 'foo', repo: 'bar', number: 3,
      url: 'u', branch: 'b', baseBranch: 'main',
      state: 'open', title: 't',
    })!;
    const merged = updatePullRequestState({
      id: pr.id, state: 'merged', mergedAt: '2026-06-03T10:00:00Z',
    });
    expect(merged?.state).toBe('merged');
    expect(merged?.mergedAt).toBe('2026-06-03T10:00:00Z');
  });
});

describe('CIRun service', () => {
  it('upserts on externalRef and binds to PR/Run', () => {
    const r = createRun({ title: 'ci-link', source: 'user' })!;
    const pr = createOrUpdatePullRequest({
      externalRef: 'a/b#1', owner: 'a', repo: 'b', number: 1,
      url: 'u', branch: 'br', baseBranch: 'main',
      state: 'open', title: 't', runId: r.id,
    })!;
    const created = createOrUpdateCIRun({
      externalRef: 'workflow_run:111',
      workflow: 'test',
      state: 'queued',
      pullRequestId: pr.id,
      runId: r.id,
    })!;
    expect(created.state).toBe('queued');

    const updated = createOrUpdateCIRun({
      externalRef: 'workflow_run:111',
      workflow: 'test',
      state: 'success',
      conclusion: 'success',
      completedAt: '2026-06-03T11:00:00Z',
    })!;
    expect(updated.id).toBe(created.id);
    expect(updated.state).toBe('success');
    expect(updated.runId).toBe(r.id); // preserved
    expect(updated.pullRequestId).toBe(pr.id);

    // listByRun + listByPullRequest find it.
    expect(listCIRunsByRun(r.id)).toHaveLength(1);
    expect(listCIRunsByPullRequest(pr.id)).toHaveLength(1);

    // PR's denormalized ciRunIds was kept in sync.
    const refreshedPR = getPullRequest(pr.id)!;
    expect(refreshedPR.ciRunIds).toContain(created.id);
  });
});

/* ============================================================================
 * Payload mapping primitives
 * ========================================================================== */

describe('payload mapping', () => {
  it('mapPullRequestPayloadToState covers draft / open / merged / closed / review hint', () => {
    expect(mapPullRequestPayloadToState({ draft: true, state: 'open' })).toBe('draft');
    expect(mapPullRequestPayloadToState({ state: 'open' })).toBe('open');
    expect(mapPullRequestPayloadToState({ state: 'closed', merged: true })).toBe('merged');
    expect(mapPullRequestPayloadToState({ state: 'closed', merged: false })).toBe('closed');
  });
  it('mapGithubRunToCIState covers queued / in_progress / completed-success / completed-failure / cancelled / skipped', () => {
    expect(mapGithubRunToCIState('queued', null)).toBe('queued');
    expect(mapGithubRunToCIState('in_progress', null)).toBe('running');
    expect(mapGithubRunToCIState('completed', 'success')).toBe('success');
    expect(mapGithubRunToCIState('completed', 'failure')).toBe('failed');
    expect(mapGithubRunToCIState('completed', 'timed_out')).toBe('failed');
    expect(mapGithubRunToCIState('completed', 'cancelled')).toBe('cancelled');
    expect(mapGithubRunToCIState('completed', 'skipped')).toBe('skipped');
    expect(mapGithubRunToCIState('skipped', null)).toBe('skipped');
  });
  it('extractRunIdFrom finds RUN-<uuid> or runId: <uuid>', () => {
    expect(extractRunIdFrom('RUN-12345678-1234-1234-1234-123456789abc')).toBe('12345678-1234-1234-1234-123456789abc');
    expect(extractRunIdFrom('foo runId: 12345678-1234-1234-1234-123456789abc bar')).toBe('12345678-1234-1234-1234-123456789abc');
    expect(extractRunIdFrom('no run id here')).toBeNull();
    expect(extractRunIdFrom(null)).toBeNull();
  });
});

/* ============================================================================
 * Webhook receiver — signature + flow + flag
 * ========================================================================== */

describe('GitHub webhook receiver', () => {
  it('verifyGithubSignature: good signature OK, bad rejected, missing rejected', () => {
    const secret = 's3cret';
    const body = JSON.stringify({ x: 1 });
    const good = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyGithubSignature({ secret, signatureHeader: good, rawBody: body })).toBe(true);
    expect(verifyGithubSignature({ secret, signatureHeader: 'sha256=ffff', rawBody: body })).toBe(false);
    expect(verifyGithubSignature({ secret, signatureHeader: undefined, rawBody: body })).toBe(false);
    expect(verifyGithubSignature({ secret: '', signatureHeader: good, rawBody: body })).toBe(false);
  });

  it('rejects when secret is set and signature wrong (401)', () => {
    const settings = buildSettings({ githubWebhookSecret: 'top-secret' });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const res = invokeWebhook({
      routes, event: 'pull_request',
      body: { action: 'opened' },
      signature: 'sha256=deadbeef',
      ctx,
    });
    expect(res.status).toBe(401);
    expect((res.payload as { error: string }).error).toMatch(/signature/i);
  });

  it('rejects unsigned by default when no secret AND dev flag is off (401)', () => {
    const settings = buildSettings(); // no secret, dev flag off
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const res = invokeWebhook({
      routes, event: 'pull_request', body: {}, ctx,
    });
    expect(res.status).toBe(401);
  });

  it('accepts unsigned when dorothyDevAllowUnsignedWebhook=true (dev mode)', () => {
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const res = invokeWebhook({
      routes, event: 'ping', body: {}, ctx,
    });
    expect(res.status).toBe(200);
    expect((res.payload as { pong: boolean }).pong).toBe(true);
  });

  it('pull_request webhook creates a PullRequest row (good signature)', () => {
    const settings = buildSettings({ githubWebhookSecret: 'sk' });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const body = {
      action: 'opened',
      number: 42,
      pull_request: {
        number: 42, title: 'feat: x', state: 'open', draft: false,
        html_url: 'https://github.com/foo/bar/pull/42',
        head: { ref: 'feat/x' }, base: { ref: 'main' },
        body: 'closes #1\nrunId: 12345678-1234-1234-1234-123456789abc',
      },
      repository: { name: 'bar', owner: { login: 'foo' } },
    };
    const sig = signature('sk', body);
    const res = invokeWebhook({ routes, event: 'pull_request', body, signature: sig, ctx });
    expect(res.status).toBe(200);

    const pr = getPullRequestByExternalRef('foo/bar#42');
    expect(pr).toBeTruthy();
    expect(pr!.title).toBe('feat: x');
    expect(pr!.state).toBe('open');
    // runId extracted from body.
    expect(pr!.runId).toBe('12345678-1234-1234-1234-123456789abc');
  });

  it('workflow_run webhook creates a CIRun row linked to PR and Run when known', () => {
    // Seed a PR + Run first.
    const r = createRun({ title: 'r1', source: 'user' })!;
    createOrUpdatePullRequest({
      externalRef: 'foo/bar#7', owner: 'foo', repo: 'bar', number: 7,
      url: 'u', branch: 'b', baseBranch: 'main', state: 'open', title: 't',
      runId: r.id,
    });

    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const body = {
      action: 'completed',
      workflow_run: {
        id: 9999, name: 'test', status: 'completed', conclusion: 'failure',
        run_started_at: '2026-06-03T09:00:00Z',
        updated_at: '2026-06-03T09:05:00Z',
        html_url: 'https://github.com/foo/bar/actions/runs/9999',
        logs_url: 'https://example.com/logs',
        head_branch: 'b',
        pull_requests: [{ number: 7 }],
      },
      repository: { name: 'bar', owner: { login: 'foo' } },
    };
    const res = invokeWebhook({ routes, event: 'workflow_run', body, ctx });
    expect(res.status).toBe(200);

    const ci = getCIRunByExternalRef('workflow_run:9999');
    expect(ci).toBeTruthy();
    expect(ci!.state).toBe('failed');
    expect(ci!.conclusion).toBe('failure');
    expect(ci!.runId).toBe(r.id);
    // CI failure must NOT have flipped the Run (flag is off).
    expect(getRun(r.id)?.state).toBe('created');
  });

  it('check_run webhook creates a CIRun row', () => {
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const body = {
      action: 'completed',
      check_run: {
        id: 12345, name: 'lint', status: 'completed', conclusion: 'success',
        started_at: '2026-06-03T09:00:00Z', completed_at: '2026-06-03T09:01:00Z',
        html_url: 'https://github.com/foo/bar/runs/12345',
        check_suite: { pull_requests: [{ number: 1 }] },
        output: { summary: 'lint passed' },
      },
      repository: { name: 'bar', owner: { login: 'foo' } },
    };
    const res = invokeWebhook({ routes, event: 'check_run', body, ctx });
    expect(res.status).toBe(200);
    const ci = getCIRunByExternalRef('check_run:12345');
    expect(ci?.state).toBe('success');
    expect(ci?.workflow).toBe('lint');
    expect(ci?.summary).toBe('lint passed');
  });

  it('CI failed does NOT flip Run.state when feature flag is off (default)', () => {
    const r = createRun({ title: 'no-flag', source: 'user' })!;
    updateRunState(r.id, 'planned'); updateRunState(r.id, 'approved');
    updateRunState(r.id, 'running'); updateRunState(r.id, 'verifying');
    updateRunState(r.id, 'reporting');
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
        workflow_run: {
          id: 1, name: 'test', status: 'completed', conclusion: 'failure',
          run_started_at: '2026-06-03T09:00:00Z',
          pull_requests: [{ number: 1 }],
        },
        repository: { name: 'b', owner: { login: 'a' } },
      },
      ctx,
    });
    // Flag is off — Run.state stays 'reporting'.
    expect(getRun(r.id)?.state).toBe('reporting');
  });

  it('CI failed flips reporting → needs_fix ONLY when flag is on', () => {
    const r = createRun({ title: 'with-flag', source: 'user' })!;
    updateRunState(r.id, 'planned'); updateRunState(r.id, 'approved');
    updateRunState(r.id, 'running'); updateRunState(r.id, 'verifying');
    updateRunState(r.id, 'reporting');
    createOrUpdatePullRequest({
      externalRef: 'a/b#2', owner: 'a', repo: 'b', number: 2,
      url: 'u', branch: 'br', baseBranch: 'main',
      state: 'open', title: 't', runId: r.id,
    });
    const settings = buildSettings({
      dorothyDevAllowUnsignedWebhook: true,
      dorothyPrCiAutoTransition: true,
    });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    invokeWebhook({
      routes, event: 'workflow_run',
      body: {
        workflow_run: {
          id: 2, name: 'test', status: 'completed', conclusion: 'failure',
          run_started_at: '2026-06-03T09:00:00Z',
          pull_requests: [{ number: 2 }],
        },
        repository: { name: 'b', owner: { login: 'a' } },
      },
      ctx,
    });
    expect(getRun(r.id)?.state).toBe('needs_fix');

    // Same flag-on for merged PR — reporting → completed.
    const r2 = createRun({ title: 'merge-flag', source: 'user' })!;
    updateRunState(r2.id, 'planned'); updateRunState(r2.id, 'approved');
    updateRunState(r2.id, 'running'); updateRunState(r2.id, 'verifying');
    updateRunState(r2.id, 'reporting');
    invokeWebhook({
      routes, event: 'pull_request',
      body: {
        action: 'closed', number: 11,
        pull_request: {
          number: 11, title: 'feat', state: 'closed', draft: false, merged: true,
          merged_at: '2026-06-03T10:00:00Z',
          html_url: 'u', head: { ref: 'b' }, base: { ref: 'main' },
          body: `RUN-${r2.id}`,
        },
        repository: { name: 'b', owner: { login: 'a' } },
      },
      ctx,
    });
    expect(getRun(r2.id)?.state).toBe('completed');
  });

  it('records a CI artifact for terminal states (success/failure)', () => {
    const r = createRun({ title: 'artifact-link', source: 'user' })!;
    createOrUpdatePullRequest({
      externalRef: 'foo/bar#5', owner: 'foo', repo: 'bar', number: 5,
      url: 'u', branch: 'b', baseBranch: 'main',
      state: 'open', title: 't', runId: r.id,
    });
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    invokeWebhook({
      routes, event: 'workflow_run',
      body: {
        workflow_run: {
          id: 5, name: 'test', status: 'completed', conclusion: 'success',
          run_started_at: '2026-06-03T09:00:00Z',
          pull_requests: [{ number: 5 }],
          logs_url: 'https://logs',
        },
        repository: { name: 'bar', owner: { login: 'foo' } },
      },
      ctx,
    });
    const arts = listArtifactsByRun(r.id);
    expect(arts.length).toBeGreaterThan(0);
    const ciArt = arts.find(a => a.producedByAgentId === 'github-actions');
    expect(ciArt).toBeTruthy();
    expect(ciArt!.contentRef).toContain('workflow_run:5');
  });

  it('returns dbUnavailable when dorothy.db is closed', () => {
    closeDorothyDb();
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const res = invokeWebhook({
      routes, event: 'pull_request', body: { pull_request: {} }, ctx,
    });
    expect((res.payload as { dbUnavailable?: boolean }).dbUnavailable).toBe(true);

    // Re-init so afterEach can close cleanly.
    initDorothyDb({ filePath: dbPath });
  });

  it('ignores unsupported events with 200 ack', () => {
    const settings = buildSettings({ dorothyDevAllowUnsignedWebhook: true });
    const ctx = buildCtx(settings);
    const { app, routes } = makeRouteApp();
    registerGithubWebhookRoutes(app, ctx);

    const res = invokeWebhook({ routes, event: 'star', body: {}, ctx });
    expect(res.status).toBe(200);
    expect((res.payload as { ignored?: boolean }).ignored).toBe(true);
  });
});

// Silence the "createRun unused" lint if a test path skips it.
void createRun;
