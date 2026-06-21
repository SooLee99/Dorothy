import { NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 세션 한도 가시성 — Claude ★세션 한도(429)를 한도 배너에 노출.
 *
 * 사용자 "모르는 새 한도"의 진짜 정체: usage-consumption(5시간 롤링 budget)은 여유 있어
 * 보여도, Claude 세션 한도(429 "You've hit your session limit · resets HH:MM")에 걸리면 멈춘다.
 * team-loop 역할 로그에 그 429 가 찍히므로 ★가장 최근 429 + 리셋 시각을 파싱해 limited 판정.
 * 리셋 시각이 지났으면 해소(limited=false) — 오경보 0.
 */
const LOG_DIRS = [
  path.join(os.homedir(), '.dorothy', 'logs', 'team-loop'),
  path.join(os.homedir(), '.dorothy', 'logs', 'team-loop-bueongi'),
];
// 한 줄: "2026-06-20T21:38:01+0900 [role] ... session limit · resets 12:40am ..."
const LINE_RE = /(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})([+-]\d{4}).*?session limit\s*[·•]?\s*resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

function offsetColon(off: string): string { return `${off.slice(0, 3)}:${off.slice(3)}`; } // +0900 → +09:00

function to24h(h12: number, ampm: string): number {
  const pm = ampm.toLowerCase() === 'pm';
  if (h12 === 12) return pm ? 12 : 0;
  return pm ? h12 + 12 : h12;
}

export function GET() {
  try {
    let best: { detected: number; line: string; date: string; off: string; rh: number; rm: number; resetLabel: string; role: string } | null = null;

    for (const dir of LOG_DIRS) {
      let files: string[] = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.log') && !f.endsWith('.err.log')); } catch { continue; }
      for (const f of files) {
        let raw = '';
        try {
          const fp = path.join(dir, f);
          const st = fs.statSync(fp);
          const start = Math.max(0, st.size - 200_000); // 최근 부분만
          const fd = fs.openSync(fp, 'r');
          const buf = Buffer.alloc(st.size - start);
          fs.readSync(fd, buf, 0, buf.length, start);
          fs.closeSync(fd);
          raw = buf.toString('utf-8');
        } catch { continue; }
        for (const line of raw.split('\n')) {
          const m = line.match(LINE_RE);
          if (!m) continue;
          const detected = new Date(`${m[1]}T${m[2]}${offsetColon(m[3])}`).getTime();
          if (Number.isNaN(detected)) continue;
          if (!best || detected > best.detected) {
            best = {
              detected, line: line.slice(0, 200), date: m[1], off: offsetColon(m[3]),
              rh: to24h(parseInt(m[4], 10), m[6]), rm: m[5] ? parseInt(m[5], 10) : 0,
              resetLabel: `${m[4]}${m[5] ? ':' + m[5] : ''}${m[6].toLowerCase()}`,
              role: (line.match(/\[([a-z][a-z0-9-]*)\]/i)?.[1]) ?? '',
            };
          }
        }
      }
    }

    if (!best) return NextResponse.json({ limited: false, detected: false });

    // 리셋 시각 = 감지일의 HH:MM, 그게 감지시각 이하면 다음날.
    const hh = String(best.rh).padStart(2, '0');
    const mm = String(best.rm).padStart(2, '0');
    let resetAt = new Date(`${best.date}T${hh}:${mm}:00${best.off}`).getTime();
    if (resetAt <= best.detected) resetAt += 24 * 3600 * 1000;

    const now = Date.now();
    const limited = now < resetAt;
    return NextResponse.json({
      limited,
      detected: true,
      role: best.role,
      detectedAt: new Date(best.detected).toISOString(),
      resetAt: new Date(resetAt).toISOString(),
      resetLabel: best.resetLabel,
      minutesUntilReset: limited ? Math.round((resetAt - now) / 60000) : 0,
    });
  } catch (e) {
    return NextResponse.json({ limited: false, detected: false, error: e instanceof Error ? e.message : 'failed' });
  }
}
