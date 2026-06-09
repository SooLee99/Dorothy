/**
 * PR-0-common — observed 래퍼.
 *
 * 북극성: 주장 아니라 실측. ★낙관 기본값 금지 — 모르면 unknown(observed:false).
 *   observed:true 는 *관측된 사실*(ptyAlive·lastOutputAt·byteCount·실측 호출결과)에만.
 *   self-report·예측·추측은 observed:false. "대충 맞으면 채움" 금지(§1.3).
 *
 * 순수 모듈.
 */

/** observed:false 의 사유 코드(스펙 §3). */
export type ObservedReason =
  | 'not-implemented'   // 기능 미구현
  | 'source-missing'    // 소스 파일/상태 부재
  | 'probe-pending'     // 프로브 대기(아직 실측 없음)
  | 'stale'             // 신선도 미달
  | 'mapping-uncertain'; // 매핑 불확실(§1.3 미충족)

export type Observed<T extends object = Record<string, never>> =
  | ({ observed: true } & T)
  | { observed: false; reason: ObservedReason };

/**
 * 관측된 사실. payload 를 그대로 펼쳐 observed:true 로 만든다.
 *   observed({ value: 'triplan' })           → { observed:true, value:'triplan' }
 *   observed({ alive:true, pid:48213 })       → { observed:true, alive:true, pid:48213 }
 *   observed({ ts: '2026-...' })              → { observed:true, ts:'2026-...' }
 */
export function observed<T extends object>(payload: T): { observed: true } & T {
  return { observed: true, ...payload };
}

/** 관측 안 됨 — 사유만 남기고 값은 절대 넣지 않는다(낙관 기본값 금지). */
export function unknown(reason: ObservedReason): { observed: false; reason: ObservedReason } {
  return { observed: false, reason };
}

/**
 * nullable payload 를 관측으로 변환. null/undefined 면 unknown(reason).
 * ★헬퍼가 기본값으로 메우지 않도록 — 값이 없으면 강제로 unknown.
 */
export function observedOr<T extends object>(
  payload: T | null | undefined,
  reason: ObservedReason,
): Observed<T> {
  return payload == null ? unknown(reason) : observed(payload);
}
