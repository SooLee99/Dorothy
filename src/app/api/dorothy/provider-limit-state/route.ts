import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

/**
 * Phase 6-AR — Dual Provider Limit Safe Pause 상태(read-only).
 * provider-limit-state.json 은 PM-tick(provider-limit-state.py)이 매 틱 갱신한다.
 * 이 라우트는 그 파일을 읽고, agents.json 으로 orchestrator provider 만 보강한다.
 * 쓰기 없음 / secret 없음.
 */

const STATE = path.join(os.homedir(), '.dorothy', 'runtime', 'provider-limit-state.json');
const AGENTS = path.join(os.homedir(), '.dorothy', 'agents.json');
const USAGE = path.join(os.homedir(), '.dorothy', 'runtime', 'usage-consumption.json');

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return null; }
}

export async function GET() {
  const state = readJson<Record<string, unknown>>(STATE);
  const usage = readJson<{ claude?: { pctRemaining?: number }; codex?: { mode?: string } }>(USAGE);

  // orchestrator provider 보강(상태 파일이 오래됐어도 현재 디스크 기준 표시)
  const raw = readJson<unknown>(AGENTS);
  const list = Array.isArray(raw) ? raw : ((raw as { agents?: unknown[] } | null)?.agents ?? []);
  const orch = (list as Record<string, unknown>[]).find(a => a.id === 'orchestrator');
  const fb = (orch?.metadata as Record<string, unknown> | undefined)?.temporaryProviderFallback;

  const safePause = (state?.safePause as Record<string, unknown> | undefined) ?? { active: false, until: null, reason: null };
  const until = safePause.until as string | undefined;
  const safePauseRemainingMs = until ? Math.max(0, new Date(until).getTime() - Date.now()) : null;

  return NextResponse.json({
    updatedAt: state?.updatedAt ?? null,
    codex: state?.codex ?? { limited: false, cooldownUntil: null },
    claude: state?.claude ?? { limited: false, cooldownUntil: null },
    safePause: { ...safePause, remainingMs: safePauseRemainingMs },
    orchestrator: { provider: orch?.provider ?? null, fallbackActive: !!fb },
    usage: { claudePctRemaining: usage?.claude?.pctRemaining ?? null, codexMode: usage?.codex?.mode ?? null },
  });
}
