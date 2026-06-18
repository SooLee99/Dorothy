/**
 * PR-0b — provider 가용성 상태 도출(순수 로직).
 *
 * ★불변식: `available` 은 **실측 ok**(probeOk)일 때만. 예측 recoveryAt 도달만으론 금지.
 *   예측 limited 라도 실측 ok 면 즉시 available(실측 우선).
 *
 * 입력 신호(2종, 라우트에서 수집):
 *   - predicted : provider-limit-state.json (authoritative 예측). { predLimited, predRecoveryAt }
 *   - probe(real-call) : 실제 호출 결과 재사용.
 *       probeOk      = 그 provider 에이전트 세션이 최근(<PROBE_FRESH) 출력 중(=토큰 실소비=한도 아님)
 *       probeLimited = rate_limit_events 에 그 provider 미해소(active) 한도 이벤트 존재
 *   (mini-probe `claude --version` 은 A 판정이나 real-call 재사용으로 충분 → 미구현. README 참조)
 *
 * 순수 모듈.
 */

export type ProviderState = 'available' | 'limited' | 'recovering' | 'unknown';

export interface ProviderSignalInput {
  probeOk: boolean;          // 실측 ok(세션 최근 출력)
  probeLimited: boolean;     // 실측 limited(미해소 한도 이벤트)
  predLimited: boolean;      // 예측 한도(provider-limit-state)
  predRecoveryAt: string | null;
}

export function computeProviderState(s: ProviderSignalInput): ProviderState {
  if (s.probeOk) return 'available';                                  // ★실측 ok 불변식(예측 무관)
  if (s.probeLimited) return 'limited';                               // 확인된 limited
  if (s.predLimited) return s.predRecoveryAt ? 'recovering' : 'limited'; // 예측 한도: 확인대기→recovering
  return 'unknown';                                                   // 확인·예측 모두 없음
}
