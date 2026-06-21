import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 사용량 분석(read-only) — "무슨 일에 토큰 많이 썼나".
 *
 * `hermes insights --days N`(토큰/비용 ground-truth·모델/플랫폼/툴/스킬별 집계)는 --json 이
 * 없어 텍스트 출력을 파싱한다. 토큰은 세션 메시지에서 집계되며 구조화 소스가 없어 이게 유일.
 * ★에이전트별/프로젝트별은 insights 에 없음(세션이 projectId 미보유). platform(cron/slack)이 프록시.
 *
 * 결과 캐시(10분). 실패/형식변경 시 빈 섹션으로 degrade(화면 안 깨짐).
 */
const pexec = promisify(execFile);

function hermesBin(): string {
  const p = path.join(os.homedir(), '.local', 'bin', 'hermes');
  return fs.existsSync(p) ? p : 'hermes';
}
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}
function toNum(s: string): number {
  const n = Number(String(s).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

interface Row { name: string; sessions?: number; tokens?: number; calls?: number; pct?: number }
const cache = new Map<number, { data: unknown; ts: number }>();
const TTL = 10 * 60 * 1000;

export async function GET(req: Request) {
  const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get('days')) || 7));
  const hit = cache.get(days);
  if (hit && Date.now() - hit.ts < TTL) return NextResponse.json(hit.data);

  try {
    const { stdout } = await pexec(hermesBin(), ['insights', '--days', String(days)], {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const text = stripAnsi(stdout);
    const lines = text.split('\n');

    const overview: Record<string, number> = {};
    const grab = (label: string): number | undefined => {
      const m = text.match(new RegExp(`${label}:\\s*([\\d,]+)`));
      return m ? toNum(m[1]) : undefined;
    };
    overview.totalTokens = grab('Total tokens') ?? 0;
    overview.inputTokens = grab('Input tokens') ?? 0;
    overview.outputTokens = grab('Output tokens') ?? 0;
    overview.sessions = grab('Sessions') ?? 0;
    overview.toolCalls = grab('Tool calls') ?? 0;

    // 섹션 추출: 헤더(이모지 라벨) 다음의 표 행을 다음 섹션 전까지 읽음.
    const sectionRows = (header: RegExp, parse: (cols: string[], raw: string) => Row | null): Row[] => {
      const out: Row[] = [];
      let i = lines.findIndex((l) => header.test(l));
      if (i < 0) return out;
      i += 1;
      // 구분선/헤더행 스킵
      for (; i < lines.length; i++) {
        const raw = lines[i];
        const t = raw.trim();
        if (!t) { if (out.length) break; else continue; }
        if (/^[─-]+$/.test(t)) continue;
        if (/^(Model|Platform|Tool|Skill)\b/.test(t)) continue; // 표 헤더
        if (/[🤖📱🔧🧠📋📊⏱️💰]/.test(raw)) break; // 다음 섹션
        if (/^\.\.\. and /.test(t)) break;
        const cols = t.split(/\s{2,}/).filter(Boolean);
        const row = parse(cols, t);
        if (row) out.push(row);
        if (out.length >= 12) break;
      }
      return out;
    };

    const models = sectionRows(/Models Used/, (_c, raw) => {
      // 이름 ... sessions tokens (뒤 두 숫자)
      const m = raw.match(/^(.+?)\s+([\d,]+)\s+([\d,]+)$/);
      if (!m) return null;
      return { name: m[1].trim(), sessions: toNum(m[2]), tokens: toNum(m[3]) };
    });
    const platforms = sectionRows(/Platforms/, (_c, raw) => {
      // 이름 sessions messages tokens (뒤 세 숫자)
      const m = raw.match(/^(.+?)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)$/);
      if (!m) return null;
      return { name: m[1].trim(), sessions: toNum(m[2]), tokens: toNum(m[4]) };
    });
    const tools = sectionRows(/Top Tools/, (_c, raw) => {
      const m = raw.match(/^(.+?)\s+([\d,]+)\s+([\d.]+)%$/);
      if (!m) return null;
      return { name: m[1].trim(), calls: toNum(m[2]), pct: Number(m[3]) };
    });

    const result = { days, overview, models, platforms, tools, generatedAt: new Date().toISOString() };
    cache.set(days, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { days, overview: {}, models: [], platforms: [], tools: [], error: e instanceof Error ? e.message : 'failed' },
      { status: 200 },
    );
  }
}
