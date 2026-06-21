import { NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 흐름 뷰 ⑤ 라이브 신호 — 프로젝트별 team-loop 이 ★지금 무슨 역할을 돌리는지.
 *
 * agent-activity 의 status 는 agents.json 기반이라 저장 시 idle 로 되돌아가, team-loop 이
 * spawn 하는 ephemeral `claude -p` 작업을 못 잡는다. 진짜 fresh 신호는 team-loop-state.json
 * (status/currentRole/pass/updatedAt). 이 라우트가 두 프로젝트 상태를 read-only 로 준다.
 */
const RUNTIME = path.join(os.homedir(), '.dorothy', 'runtime');
const PROJECTS = ['triplan', 'bueongi'] as const;

function pidAlive(pidFile: string): boolean {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

export async function GET() {
  const out: Record<string, unknown> = {};
  for (const p of PROJECTS) {
    let state: { status?: string; currentRole?: string; pass?: string; updatedAt?: string } = {};
    try { state = JSON.parse(fs.readFileSync(path.join(RUNTIME, `${p}-team-loop-state.json`), 'utf-8')); } catch { /* */ }
    const paused = fs.existsSync(path.join(RUNTIME, `${p}-team-loop.paused`));
    const alive = pidAlive(path.join(RUNTIME, `${p}-team-loop.pid`));
    out[p] = {
      running: alive && !paused && state.status === 'running',
      paused,
      pidAlive: alive,
      status: state.status ?? null,
      currentRole: state.currentRole ?? null,
      pass: state.pass ?? null,
      updatedAt: state.updatedAt ?? null,
    };
  }
  return NextResponse.json(out);
}
