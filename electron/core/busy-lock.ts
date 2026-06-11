import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { agents } from './agent-manager';

// Dorothy 상호 배제 락.
// Dorothy 에이전트가 활발히 작업 중일 때 ~/.dorothy/runtime/dorothy-busy.lock 을 주기적으로 갱신한다.
// Auto-Company 데몬(auto-loop.sh)이 이 락이 신선하면 사이클을 양보(skip)하여 triplan 동시 편집을 막는다.
// 모든 에이전트가 유휴가 되면 락을 제거 → 데몬이 자동 재개.

const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
const BUSY_LOCK = path.join(RUNTIME_DIR, 'dorothy-busy.lock');

// '작업 중'으로 볼 상태: running(작업) / waiting(사용자 입력 대기 — 아직 점유 중)
function activeAgentNames(): string[] {
  return Array.from(agents.values())
    .filter((a) => a.status === 'running' || a.status === 'waiting')
    .map((a) => a.name || a.id.slice(0, 6));
}

// 현재 에이전트 상태에 맞춰 락을 쓰거나 지운다.
export function refreshBusyLock(): void {
  try {
    const names = activeAgentNames();
    if (names.length > 0) {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      fs.writeFileSync(
        BUSY_LOCK,
        JSON.stringify({ ts: new Date().toISOString(), activeCount: names.length, agents: names }),
      );
    } else if (fs.existsSync(BUSY_LOCK)) {
      fs.rmSync(BUSY_LOCK, { force: true });
    }
  } catch {
    /* 락 갱신 실패는 무시 (권한/디스크 등) */
  }
}

// 에이전트 시작 즉시 점유 표시 (30초 메인테이너를 기다리지 않고 데몬과의 경합 최소화).
export function touchBusyLock(): void {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(BUSY_LOCK, JSON.stringify({ ts: new Date().toISOString(), activeCount: 1, agents: ['(시작 중)'] }));
  } catch {
    /* ignore */
  }
}

// 락이 현재 신선한지(=Dorothy 작업 중으로 간주) — UI 표시에 사용.
export function isBusyLockFresh(maxAgeSec = 300): boolean {
  try {
    const st = fs.statSync(BUSY_LOCK);
    return (Date.now() - st.mtimeMs) / 1000 <= maxAgeSec;
  } catch {
    return false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startBusyLockMaintainer(): void {
  if (timer) return;
  refreshBusyLock();
  timer = setInterval(refreshBusyLock, 30000); // 30초마다 갱신/해제
}
