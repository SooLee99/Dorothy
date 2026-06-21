import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 토큰 사용량/한도 가시성(read-only) — "모르는 새 한도 도달" 방지.
 *
 * `~/.dorothy/runtime/usage-consumption.json` (PM-tick 갱신) 의 5h 롤링 윈도 토큰 사용량을
 * 그대로 노출한다. claude=budget-estimate(usedTokens/budgetTokens/pctRemaining),
 * codex=rate-limits(usedPercent/remainingPercent/resetAt). ★ground-truth·새로 만들지 않고 노출만.
 *
 * stale: updatedAt 이 너무 오래면(PM-tick 미동작) 모니터링 공백 신호 → ageSec/stale 동봉.
 */
const USAGE = path.join(os.homedir(), '.dorothy', 'runtime', 'usage-consumption.json');
const STALE_AFTER_SEC = 30 * 60; // 30분 넘으면 stale

export async function GET() {
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE, 'utf-8')) as {
      updatedAt?: string;
      windowHours?: number;
      claude?: Record<string, unknown>;
      codex?: Record<string, unknown>;
    };
    const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
    const ageSec = updatedAt ? Math.max(0, Math.round((Date.now() - new Date(updatedAt).getTime()) / 1000)) : null;
    return NextResponse.json({
      updatedAt,
      ageSec,
      stale: ageSec == null || ageSec > STALE_AFTER_SEC,
      windowHours: raw.windowHours ?? null,
      claude: raw.claude ?? null,
      codex: raw.codex ?? null,
    });
  } catch (e) {
    // 파일 없음/파싱 실패 → 모니터링 공백(stale=true)로 안전 degrade.
    return NextResponse.json(
      { updatedAt: null, ageSec: null, stale: true, claude: null, codex: null, error: e instanceof Error ? e.message : 'failed' },
      { status: 200 },
    );
  }
}
