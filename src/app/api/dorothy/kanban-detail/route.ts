import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 재설계 ③ — 칸반 카드 상세 팝업의 깊은 데이터(시도 이력 runs + 이벤트 + 코멘트).
 *
 * ★죽은 /runs(Run 미러 미연결) 데이터를 hermes CLI 로 우회 접근: `hermes kanban show --json`
 *   이 task·runs·events·comments 를 모두 준다. 칸반 상세 모달의 '타임라인' 탭에서 소비.
 *
 * 안전: execFile(인자 배열 — 셸 인젝션 없음) + taskId 형식 검증. 실패해도 status 200 +
 *   빈 배열로 degrade(UI 가 안 깨지게).
 */
const pexec = promisify(execFile);

function hermesBin(): string {
  const p = path.join(os.homedir(), '.local', 'bin', 'hermes');
  return fs.existsSync(p) ? p : 'hermes';
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('taskId') || '';
  if (!/^[a-zA-Z0-9_-]{4,}$/.test(id)) {
    return NextResponse.json({ error: 'invalid taskId', runs: [], events: [], comments: [] }, { status: 400 });
  }
  try {
    const { stdout } = await pexec(hermesBin(), ['kanban', 'show', '--json', id], {
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const d = JSON.parse(stdout) as {
      task?: unknown;
      runs?: unknown[];
      events?: unknown[];
      comments?: unknown[];
    };
    return NextResponse.json({
      task: d.task ?? null,
      runs: Array.isArray(d.runs) ? d.runs : [],
      events: Array.isArray(d.events) ? d.events : [],
      comments: Array.isArray(d.comments) ? d.comments : [],
    });
  } catch (e) {
    // 죽은 task / hermes 미가용 등 — 빈 데이터로 안전 degrade(모달 안 깨짐).
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'failed', runs: [], events: [], comments: [] },
      { status: 200 },
    );
  }
}
