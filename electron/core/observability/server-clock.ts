/**
 * PR-0-common — 서버 단조 시계(serverNow).
 *
 * Date.now() 는 NTP 보정/수동 시계변경으로 ★역행할 수 있어, 두 응답의 serverNow 가
 * 거꾸로 가거나 같은 ms 에 묶일 수 있다. 부팅 시점의 wall-clock 기준점에
 * process.hrtime(단조 증가, 시계변경 영향 없음) 경과를 더해 '절대 역행하지 않는'
 * epoch 를 만든다. meta.serverNow 는 이 값을 쓴다(관측 신호의 기준 시각).
 *
 * 순수 모듈(electron/IPC import 없음) — 단위테스트 가능.
 */

const _bootWallMs = Date.now();
// process.hrtime() 배열형([sec, nsec]) 사용 — BigInt 리터럴 회피(루트 tsconfig target<ES2020 호환).
const _bootHr = process.hrtime();

export interface ServerNow {
  /** ISO-8601 (단조 epoch 기반) */
  iso: string;
  /** 부팅 wall-clock + 단조 경과 = 역행하지 않는 epoch(ms) */
  epochMs: number;
  /** 부팅 이후 단조 경과(ms) — 상대 측정용 */
  monotonicMs: number;
}

/** 현재 서버 시각(단조). 연속 호출 시 epochMs 는 절대 감소하지 않는다. */
export function serverNow(): ServerNow {
  const [s, ns] = process.hrtime(_bootHr); // 부팅 기준 경과 [초, 나노초]
  const monotonicMs = s * 1000 + Math.floor(ns / 1000000);
  const epochMs = _bootWallMs + monotonicMs;
  return { iso: new Date(epochMs).toISOString(), epochMs, monotonicMs };
}
