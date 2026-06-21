import { NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * ⑤ 에이전트 동작 — team-loop 이 실제로 찍는 ★역할별 로그 tail(진짜 작업 출력).
 *
 * team-loop 은 ephemeral claude -p 를 띄우되 그 출력을 역할별 로그 파일에 append 한다:
 *   triplan : ~/.dorothy/logs/team-loop/<role>.log
 *   bueongi : ~/.dorothy/logs/team-loop-bueongi/<role>.log
 * currentRole(engine-live) → 이 라우트로 그 역할 로그의 마지막 N 바이트를 read-only tail.
 * ★읽기 전용(엔진 제어 X). role 은 화이트리스트 정규식으로 제한(경로 traversal 방지).
 */
const LOG_DIRS: Record<string, string> = {
  triplan: path.join(os.homedir(), '.dorothy', 'logs', 'team-loop'),
  bueongi: path.join(os.homedir(), '.dorothy', 'logs', 'team-loop-bueongi'),
};
const MAX_BYTES = 6000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get('project') ?? '';
  let role = url.searchParams.get('role') ?? '';
  const dir = LOG_DIRS[project];
  if (!dir) return NextResponse.json({ error: 'unknown project', tail: '' }, { status: 400 });

  // role 미지정/없음 → 가장 최근 갱신된 역할 로그 자동 선택(사이클 사이·cooldown 에도 실제 출력 표시).
  const SKIP = new Set(['team-loop.log', 'launchd.err.log', 'launchd.out.log']);
  let chosen = role;
  if (!chosen || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(chosen)) {
    try {
      const cands = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.log') && !SKIP.has(f) && !f.endsWith('.err.log') && !f.startsWith('e2e-'))
        .map((f) => ({ role: f.replace(/\.log$/, ''), m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      chosen = cands[0]?.role ?? '';
    } catch { chosen = ''; }
  }
  if (!chosen || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(chosen)) {
    return NextResponse.json({ project, role: '', tail: '', missing: true });
  }
  role = chosen;

  const file = path.join(dir, `${role}.log`);
  // 고정 디렉터리 밖이면 거부(이중 방어).
  if (!file.startsWith(dir + path.sep)) return NextResponse.json({ error: 'path', tail: '' }, { status: 400 });

  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - MAX_BYTES);
    const fd = fs.openSync(file, 'r');
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    let tail = buf.toString('utf-8');
    if (start > 0) tail = tail.slice(tail.indexOf('\n') + 1); // 잘린 첫 줄 버림
    return NextResponse.json({ project, role, file, size: stat.size, mtime: stat.mtimeMs, tail });
  } catch {
    return NextResponse.json({ project, role, tail: '', missing: true });
  }
}
