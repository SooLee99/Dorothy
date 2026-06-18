import fs from 'fs';
import path from 'path';
import os from 'os';
import { NextResponse } from 'next/server';

/**
 * 자동 가동 "볼 눈" — 통제 상태(used%·worker·④ enforce·breaker)를 ★읽기 전용으로 노출.
 * 청사진 548 빈틈: used% 가 대시보드에 없어 통제 불가 → 여기서 breaker-eye 뷰 제공.
 *
 * ★read-only: rate-limits.json·breaker 로그·reconciler shadow·pm-tick.sh·pause flag 를 ★읽기만.
 *   시스템 쓰기/변경/액션 0(관측 도구 원칙). secret 미노출(used%·count·flag 만).
 * ★진동 정직: used% 는 멀티세션으로 진동(raw) → breaker 가 쓰는 eff(recent-max)를 함께 노출.
 */
const H = os.homedir();
const R = (...p: string[]) => path.join(H, '.dorothy', ...p);

function readJson<T = unknown>(f: string): T | null {
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')) as T; } catch { return null; }
}
function lastLine(f: string): string | null {
  try {
    const ls = fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean);
    return ls.length ? ls[ls.length - 1] : null;
  } catch { return null; }
}

export async function GET() {
  const rate = readJson<{ five_hour?: { used_percentage?: number }; seven_day?: { used_percentage?: number } }>(R('rate-limits.json')) || {};
  const baseline = readJson<{ five_hour?: number; seven_day?: number }>(R('runtime', 'resume-baseline.json')) || {};

  // breaker 로그 최신 — eff(recent-max, 통제 기준)·action·breaches.
  let eff5h: number | null = null, eff7d: number | null = null;
  let breakerAt: string | null = null, breakerAction: string | null = null;
  let breaches: string[] = [];
  const bl = lastLine(R('runtime', 'resume-circuit-breaker.jsonl'));
  if (bl) {
    try {
      const e = JSON.parse(bl);
      eff5h = e.metrics?.eff5h ?? e.metrics?.fiveH ?? null;
      eff7d = e.metrics?.eff7d ?? e.metrics?.sevenD ?? null;
      breakerAt = e.at ?? null; breakerAction = e.action ?? null; breaches = Array.isArray(e.breaches) ? e.breaches : [];
    } catch { /* ignore */ }
  }

  // worker 추적 — reconciler shadow 최신(tracked/untracked/dead + tick_at staleness).
  let workers: { tracked: number | null; untracked: number | null; dead: number | null; at: string | null } =
    { tracked: null, untracked: null, dead: null, at: null };
  const rl = lastLine(R('runtime', 'process-reconcile.shadow.jsonl'));
  if (rl) {
    try {
      const e = JSON.parse(rl);
      workers = {
        tracked: Array.isArray(e.tracked) ? e.tracked.length : null,
        untracked: Array.isArray(e.untracked) ? e.untracked.length : null,
        dead: Array.isArray(e.dead) ? e.dead.length : null,
        at: e.tick_at ?? null,
      };
    } catch { /* ignore */ }
  }

  // pm-tick pause 상태.
  let paused = false, pauseReason: string | null = null;
  try {
    const pf = R('runtime', 'triplan-pm-tick.paused');
    if (fs.existsSync(pf)) { paused = true; pauseReason = (fs.readFileSync(pf, 'utf-8').split('\n')[0] || '').trim() || null; }
  } catch { /* ignore */ }

  // ④ enforce flag — pm-tick.sh 의 done-gate 라인에서 탐지(read-only).
  let enforce: { gate: string; scope: string | null } = { gate: 'off', scope: null };
  try {
    const sh = fs.readFileSync(R('scripts', 'triplan-pm-tick.sh'), 'utf-8');
    const m = sh.match(/DOROTHY_CI_GATE=(\w+)(?:\s+DOROTHY_CI_GATE_SCOPE=(\S+))?/);
    if (m) enforce = { gate: m[1], scope: m[2] || null };
  } catch { /* ignore */ }

  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    usage: {
      fiveHour: { raw: num(rate.five_hour?.used_percentage), eff: eff5h, base: num(baseline.five_hour) },
      sevenDay: { raw: num(rate.seven_day?.used_percentage), eff: eff7d, base: num(baseline.seven_day) },
      note: 'raw=진동하는 원값(멀티세션) · eff=breaker가 쓰는 recent-max(통제 기준)',
    },
    workers,
    enforce,
    breaker: { paused, pauseReason, lastAction: breakerAction, lastAt: breakerAt, breaches },
  });
}
