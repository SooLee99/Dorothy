import fs from 'fs';
import path from 'path';
import os from 'os';
import { NextResponse } from 'next/server';

/**
 * 3번 — UI heartbeat ("보는 눈" 감지). 대시보드(보는 화면)가 열려있으면 ClientLayout이 주기(15s) ping →
 * 이 엔드포인트가 ui-heartbeat 파일 mtime을 갱신한다. pm-tick(triplan-pm-tick.sh)이 그 mtime staleness로
 * "사람이 보고 있나" 판정 → stale(grace 초과)이면 새 디스패치 SKIP = 일주일 위기(안 보는데 자동 가동 폭주) 차단.
 *
 * ★대시보드 자동 launch/복구 코드 ★전혀 없음 — 이건 ★감지만(mtime 갱신). 대시보드는 사람이 직접 열어야 한다.
 *   self-recovering = 사람이 다시 열면 ping 재개 → heartbeat 신선 → 다음 틱 실행(자동 실행 아님).
 */
const HB = path.join(os.homedir(), '.dorothy', 'runtime', 'ui-heartbeat');

export async function GET() {
  try {
    fs.mkdirSync(path.dirname(HB), { recursive: true });
    fs.writeFileSync(HB, new Date().toISOString()); // mtime 갱신 = 보는 눈 살아있음(감지만, 시스템 상태 안 건드림)
  } catch { /* best-effort */ }
  return NextResponse.json({ ok: true, at: new Date().toISOString() });
}
