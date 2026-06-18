/**
 * PR-0-common — 응답 엔벌로프 빌더.
 *
 * 기존 라우트는 평면 JSON({snapshots,updatedAt} 등)을 쓰지만, Phase 0 신규 신호 라우트
 * (/sessions·/providers)는 { meta, data } 엔벌로프를 쓴다(기존 평면과 공존).
 *   - meta.serverNow : 단조 서버 시각(server-clock)
 *   - meta.sources   : 이 응답의 데이터 출처(agent-manager / provider-limit-state.json / real-call ...)
 *   - meta.partial   : 일부 소스 누락/실패로 데이터가 불완전한가
 *
 * 순수 모듈.
 */
import { serverNow } from './server-clock';

export interface EnvelopeMeta {
  serverNow: string;
  generatedAt: string;
  sources: string[];
  partial: boolean;
}

export interface Envelope<D> {
  meta: EnvelopeMeta;
  data: D;
}

/** data 를 { meta, data } 엔벌로프로 감싼다. serverNow/generatedAt 는 단조 시계로 채움. */
export function envelope<D>(
  data: D,
  opts?: { sources?: string[]; partial?: boolean },
): Envelope<D> {
  const now = serverNow();
  return {
    meta: {
      serverNow: now.iso,
      generatedAt: now.iso,
      sources: opts?.sources ?? [],
      partial: opts?.partial ?? false,
    },
    data,
  };
}
