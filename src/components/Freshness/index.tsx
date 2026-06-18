'use client';

import { useEffect, useState } from 'react';

/**
 * fireauto 패턴 ① — 대시보드 자체의 실측(데이터 신선도). 청사진 §7-2.5 첫째.
 * "죽은 데이터로 멀쩡한 척 방지" = 척추(주장 아니라 실측)의 대시보드 버전.
 *
 * ★클라이언트측 — 마지막 성공 수신 시각(lastSuccessAt) 기준으로 ★1초마다 age 갱신.
 *   폴링이 멈추거나 fetch 실패하면 age 가 계속 커져 stale/down 으로 드러남(시스템 안 건드림).
 */
export type FreshState = 'fresh' | 'slow' | 'stale' | 'down';

export function useFreshness(
  lastSuccessAt: number | null,
  opts?: { pollMs?: number; ok?: boolean },
): { ageSec: number | null; state: FreshState } {
  const pollMs = opts?.pollMs ?? 15000;
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ageMs = lastSuccessAt == null ? null : Math.max(0, now - lastSuccessAt);
  const ageSec = ageMs == null ? null : Math.floor(ageMs / 1000);
  let state: FreshState = 'fresh';
  if (opts?.ok === false) state = 'down';        // 마지막 fetch 실패 = 폴링 죽음
  else if (ageMs == null) state = 'down';        // 아직 한 번도 못 받음
  else if (ageMs > pollMs * 3) state = 'stale';  // 폴링 주기 3배↑ 미갱신 = 죽은 데이터 의심
  else if (ageMs > pollMs * 1.5) state = 'slow';
  return { ageSec, state };
}

const COLOR: Record<FreshState, string> = { fresh: '#4cd47a', slow: '#ffb24c', stale: '#ff5c5c', down: '#ff5c5c' };

function ageText(ageSec: number | null, state: FreshState): string {
  if (state === 'down') return '연결 끊김';
  if (ageSec == null) return '—';
  if (ageSec < 60) return `${ageSec}초 전`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}분 전`;
  return `${Math.floor(ageSec / 3600)}시간 전`;
}

/** 신선도 배지 — dot(초록 fresh/노랑 slow/빨강 stale·down) + "N초 전" + stale 경고. read-only 표시. */
export function FreshnessBadge({
  lastSuccessAt, pollMs, ok, label,
}: { lastSuccessAt: number | null; pollMs?: number; ok?: boolean; label?: string }) {
  const { ageSec, state } = useFreshness(lastSuccessAt, { pollMs, ok });
  const color = COLOR[state];
  return (
    <span
      title={state === 'stale' ? '데이터가 오래됨 — 폴링 확인(죽은 데이터일 수 있음)' : state === 'down' ? '데이터 수신 실패 — 연결 확인' : '데이터 신선'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#8a8a9a' }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: state === 'fresh' ? `0 0 4px ${color}` : 'none', display: 'inline-block' }} />
      {label ? `${label} ` : ''}{ageText(ageSec, state)}
      {state === 'stale' && <span style={{ color: '#ff5c5c' }}>⚠ stale</span>}
    </span>
  );
}
