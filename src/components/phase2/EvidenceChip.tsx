'use client';

/**
 * PR-2-U0 — EvidenceChip (순수 presentational, 부수효과 0).
 * ★G1: verified===true 일 때만 초록('검증됨'). kanban done 이어도 그 외엔 '미검증'/'확인 불가'.
 */
import { evidenceView, TONE_CLASS, type EvidenceLike } from './lib';

export function EvidenceChip({ evidence }: { evidence?: EvidenceLike }) {
  const v = evidenceView(evidence);
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium border rounded ${TONE_CLASS[v.tone]}`}
      title={v.basis ? `근거: ${v.basis}` : undefined}
    >
      {v.label}
      {v.basis && <span className="opacity-70">· {v.basis}</span>}
    </span>
  );
}
