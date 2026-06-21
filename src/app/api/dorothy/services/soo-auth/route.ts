/**
 * soo-auth-service(triplan 인증 백엔드, :18080) 기동/정지/상태 — 작업보드 버튼 전용.
 *
 * 왜 별도 라우트인가: soo-auth 는 triplan 의 ★두 번째 백엔드(travel-service=8080 과 별개)라
 *   capsule(fe/be 2슬롯) 모델에 안 들어간다. capsule 에 추가하면 /api/projects 가 이를
 *   프로젝트로 노출해 유령 프로젝트가 생긴다. 그래서 capsule 을 건드리지 않고 여기서 직접 제어.
 * 기동 명령은 ~/.dorothy/scripts/start-soo-auth.sh (local 프로파일 H2·JWT/KAKAO=.env·CORS=3000).
 */
import { NextRequest, NextResponse } from 'next/server';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PORT = 18080;
const SCRIPT = path.join(os.homedir(), '.dorothy', 'scripts', 'start-soo-auth.sh');
const LOG_DIR = path.join(os.homedir(), '.dorothy', 'logs', 'services');
const LOG_FILE = path.join(LOG_DIR, 'soo-auth.log');
const execFileP = promisify(execFile);

/** 포트 LISTEN 여부(=서버 떠있나). 상태코드 무관, 연결만 확인. */
function portUp(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (v: boolean) => { try { sock.destroy(); } catch { /* noop */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, '127.0.0.1');
  });
}

/** 해당 포트 LISTEN PID 목록(정지용). */
async function listenerPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileP('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 4000 });
    return stdout.split('\n').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n));
  } catch { return []; }
}

export async function GET() {
  const up = await portUp(PORT);
  return NextResponse.json({ ok: true, service: 'soo-auth', port: PORT, up });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = body?.action as 'start' | 'stop' | undefined;

  if (action === 'stop') {
    const pids = await listenerPids(PORT);
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* 이미 죽음 */ } }
    return NextResponse.json({ ok: true, service: 'soo-auth', action: 'stop', killed: pids });
  }

  if (action === 'start') {
    if (await portUp(PORT)) {
      return NextResponse.json({ ok: true, service: 'soo-auth', action: 'start', message: `이미 가동 중(:${PORT})`, alreadyUp: true });
    }
    if (!fs.existsSync(SCRIPT)) {
      return NextResponse.json({ ok: false, service: 'soo-auth', message: `기동 스크립트 없음: ${SCRIPT}` }, { status: 500 });
    }
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const fd = fs.openSync(LOG_FILE, 'a');
    const child = spawn('bash', [SCRIPT], { detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    fs.closeSync(fd);
    return NextResponse.json({
      ok: true, service: 'soo-auth', action: 'start', pid: child.pid,
      message: `기동 시작(pid ${child.pid}). gradle 빌드+부팅 30~60초 후 :${PORT} 바인딩.`,
    });
  }

  return NextResponse.json({ ok: false, message: "action 은 'start' 또는 'stop'" }, { status: 400 });
}
