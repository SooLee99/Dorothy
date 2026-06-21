import { NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const pexec = promisify(execFile);

/**
 * 자동개발 엔진 켜고 끄기(대시보드 스위치) — read + 제어.
 *
 * 멈춤/재개 메커니즘(되돌릴 수 있음):
 *  - team-loop(triplan·bueongi): runtime/<p>-team-loop.paused 플래그. launchd KeepAlive PathState
 *    가 "플래그 없을 때만 가동" 이라, 플래그 생성=정지·삭제=launchd 자동 재시작.
 *  - pm-tick: runtime/triplan-pm-tick.paused 플래그(스크립트가 확인).
 *  - hermes cron: `hermes cron pause/resume <id>`.
 * 토큰을 쓰는 자동 동력 전부를 한 번에 멈추거나 재개한다. (이 채팅/대시보드는 무관.)
 */
const RUNTIME = path.join(os.homedir(), '.dorothy', 'runtime');
const FLAGS = [
  path.join(RUNTIME, 'triplan-team-loop.paused'),
  path.join(RUNTIME, 'bueongi-team-loop.paused'),
  path.join(RUNTIME, 'triplan-pm-tick.paused'),
];
const JOBS_FILE = path.join(os.homedir(), '.hermes', 'cron', 'jobs.json');
const HERMES = path.join(os.homedir(), '.local', 'bin', 'hermes');

interface RawJob { id?: string; enabled?: boolean; paused_at?: string | null }
function readJobs(): RawJob[] {
  try {
    const d = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
    return Array.isArray(d) ? d : (d.jobs ?? []);
  } catch { return []; }
}
const isActive = (j: RawJob) => j.enabled !== false && !j.paused_at;

function readState() {
  const flagsPresent = FLAGS.filter((f) => fs.existsSync(f)).length;
  const jobs = readJobs();
  const active = jobs.filter(isActive).length;
  // 동력이 하나라도 살아있으면 'running'. 전부 멈췄으면 'paused'.
  const paused = flagsPresent === FLAGS.length && active === 0;
  return {
    paused,
    teamLoop: flagsPresent === FLAGS.length ? 'paused' : flagsPresent === 0 ? 'running' : 'partial',
    flagsPresent,
    flagsTotal: FLAGS.length,
    cron: { active, total: jobs.length },
  };
}

export async function GET() {
  return NextResponse.json(readState());
}

export async function POST(req: Request) {
  let action = '';
  try { action = (await req.json())?.action ?? ''; } catch { /* */ }
  if (action !== 'pause' && action !== 'resume') {
    return NextResponse.json({ error: "action 은 'pause' 또는 'resume'" }, { status: 400 });
  }

  const errors: string[] = [];

  // 1) team-loop · pm-tick 플래그
  for (const f of FLAGS) {
    try {
      if (action === 'pause') fs.writeFileSync(f, new Date().toISOString());
      else if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (e) { errors.push(`${path.basename(f)}: ${e instanceof Error ? e.message : 'fail'}`); }
  }

  // 2) hermes cron — pause: 활성 잡 전부 / resume: 멈춘 잡 전부
  const jobs = readJobs();
  const targets = jobs.filter((j) => j.id && (action === 'pause' ? isActive(j) : !isActive(j)));
  for (const j of targets) {
    try { await pexec(HERMES, ['cron', action, j.id!], { timeout: 15000 }); }
    catch (e) { errors.push(`cron ${action} ${j.id}: ${e instanceof Error ? e.message : 'fail'}`); }
  }

  return NextResponse.json({ ok: errors.length === 0, action, errors, state: readState() });
}
