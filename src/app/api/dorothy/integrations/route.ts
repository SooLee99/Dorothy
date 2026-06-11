import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

/**
 * Phase 6-AH — Integration settings (GitHub / Slack / Kakao).
 *
 * SECURITY CONTRACT:
 *  - GET returns ONLY `*Configured` booleans + non-secret config. Raw secret
 *    values from app-settings.json are read solely to compute booleans and are
 *    NEVER echoed or logged.
 *  - POST persists ONLY non-secret config to ~/.dorothy/integration-settings.json
 *    (mode 0600). It refuses to write raw secrets — secret entry stays in the
 *    existing Settings flow (honors the "평문 저장 금지" rule).
 */

const APP_SETTINGS = path.join(os.homedir(), '.dorothy', 'app-settings.json');
const INTEGRATION_CFG = path.join(os.homedir(), '.dorothy', 'integration-settings.json');
const WEBHOOK_URL = '/api/github/webhook';

function readJson(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {};
    const v = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

function buildSettings() {
  const app = readJson(APP_SETTINGS);
  const cfg = readJson(INTEGRATION_CFG);
  const g = (cfg.github ?? {}) as Record<string, unknown>;
  const s = (cfg.slack ?? {}) as Record<string, unknown>;
  const k = (cfg.kakao ?? {}) as Record<string, unknown>;

  const kakaoApiKeyConfigured = nonEmpty(app.kakaoRestApiKey) || nonEmpty(k.apiKeyMarker);
  return {
    github: {
      enabled: g.enabled === true,
      webhookSecretConfigured: nonEmpty(app.githubWebhookSecret),
      tokenConfigured: nonEmpty(app.githubToken) || nonEmpty(app.githubAppToken),
      defaultOwner: typeof g.defaultOwner === 'string' ? g.defaultOwner : undefined,
      defaultRepo: typeof g.defaultRepo === 'string' ? g.defaultRepo : undefined,
      webhookUrl: WEBHOOK_URL,
    },
    slack: {
      enabled: s.enabled === true || app.slackEnabled === true,
      webhookConfigured: nonEmpty(app.slackWebhookUrl),
      botTokenConfigured: nonEmpty(app.slackBotToken),
      channel: typeof s.channel === 'string' ? s.channel : (typeof app.slackChannelId === 'string' ? app.slackChannelId : undefined),
    },
    kakao: {
      enabled: k.enabled === true,
      apiKeyConfigured: kakaoApiKeyConfigured,
      redirectUri: typeof k.redirectUri === 'string' ? k.redirectUri : undefined,
      status: (typeof k.status === 'string' ? k.status : (kakaoApiKeyConfigured ? 'configured' : 'not_configured')),
    },
  };
}

export async function GET() {
  return NextResponse.json({ settings: buildSettings() });
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }

  // Reject any raw-secret keys defensively — secrets are NOT persisted here.
  const SECRET_KEYS = /token|secret|api[_-]?key|password|webhookurl|bearer|client_secret|access_token|private_key/i;
  const cfg = readJson(INTEGRATION_CFG);
  const patch = (body.patch ?? {}) as Record<string, Record<string, unknown>>;

  for (const section of ['github', 'slack', 'kakao'] as const) {
    const incoming = patch[section];
    if (!incoming || typeof incoming !== 'object') continue;
    const cur = (cfg[section] ?? {}) as Record<string, unknown>;
    for (const [key, val] of Object.entries(incoming)) {
      if (SECRET_KEYS.test(key)) continue; // never persist secrets
      if (typeof val === 'string' || typeof val === 'boolean') cur[key] = val;
    }
    cfg[section] = cur;
  }

  try {
    fs.writeFileSync(INTEGRATION_CFG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
  return NextResponse.json({ ok: true, settings: buildSettings() });
}
