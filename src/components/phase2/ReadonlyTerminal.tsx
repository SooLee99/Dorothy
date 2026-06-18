'use client';

/**
 * PR-2-U0 — ReadonlyTerminal. Phase 0 /sessions/{id}/output 을 read-only 로 표시.
 *
 * ★read-only: 입력창·명령 전송·실행 없음. 서버가 마스킹한 텍스트를 ★un-mask/원복 금지(그대로 렌더).
 * ★props 중심 + fetcher 주입(테스트·승격 가능). 전역 스토어 강결합 없음.
 * sessionId=null → "라이브 세션 매핑 확인 불가" 빈 상태(가짜 터미널 0).
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as TermIcon } from 'lucide-react';
import { terminalView, type OutputResp } from './lib';

type Fetcher = (sessionId: string) => Promise<OutputResp>;

const defaultFetcher: Fetcher = async (sessionId) => {
  const res = await fetch(`/api/dorothy/sessions/${encodeURIComponent(sessionId)}/output?lines=200`, { cache: 'no-store' });
  return res.json();
};

export function ReadonlyTerminal({
  sessionId,
  fetcher = defaultFetcher,
  pollMs = 2500,
}: {
  sessionId: string | null;
  fetcher?: Fetcher;
  pollMs?: number;
}) {
  const [resp, setResp] = useState<OutputResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await fetcher(sessionId);
      setResp(r);
      setError(null);
    } catch {
      setError('출력을 가져오지 못했습니다');
    }
  }, [sessionId, fetcher]);

  useEffect(() => {
    if (!sessionId) { setResp(null); return; }
    load();
    // ★폴링은 화면이 보일 때만(document.hidden 시 스킵). 언마운트(탭 전환·모달 닫힘) 시 clearInterval.
    const run = () => { if (!document.hidden) load(); };
    const t = setInterval(run, pollMs);
    document.addEventListener('visibilitychange', run);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', run); };
  }, [sessionId, pollMs, load]);

  // 새 라인 도착 시 하단 자동 스크롤
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [resp]);

  // 빈 상태: 세션 매핑 없음(0a 에서 taskId observed:false 가 흔함)
  if (!sessionId) {
    return (
      <div className="rounded-lg border border-border bg-secondary/20 p-6 text-center text-sm text-muted-foreground">
        라이브 세션 매핑 확인 불가
        <p className="text-xs text-muted-foreground/70 mt-1">이 작업에 연결된 실행 세션이 없습니다.</p>
      </div>
    );
  }

  const v = terminalView(resp, Date.now());
  const activityBadge =
    v.activity === 'recent' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
    : v.activity === 'silent' ? 'bg-amber-500/10 text-amber-600 border-amber-500/30'
    : 'bg-muted text-muted-foreground border-border';

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {/* 헤더: 출력 N초 전 + recent|silent + read-only */}
      <div className="flex items-center justify-between px-3 py-2 bg-secondary/30 border-b border-border text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <TermIcon className="w-3.5 h-3.5" />
          <span className="font-mono">{sessionId.slice(0, 18)}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">
            {v.hasOutputAt ? `출력 ${v.secondsSince}초 전` : '출력 확인 불가'}
          </span>
          <span className={`px-1.5 py-0.5 border rounded text-[10px] font-medium ${activityBadge}`}>
            {v.activity === 'unknown' ? '확인 불가' : v.activity}
          </span>
          <span className="text-[10px] text-muted-foreground/60 border border-border rounded px-1">read-only</span>
        </span>
      </div>
      {/* 본문: 마스킹된 tail (서버 마스킹 그대로) */}
      <div ref={bodyRef} className="h-64 overflow-y-auto bg-black/30 px-3 py-2 font-mono text-[10px] leading-relaxed text-foreground/90">
        {error ? (
          <div className="text-rose-400">{error}</div>
        ) : v.lines.length === 0 ? (
          <div className="text-muted-foreground">출력 없음</div>
        ) : (
          v.lines.map((l) => (
            <div key={l.idx} className="whitespace-pre-wrap break-all">{l.text}</div>
          ))
        )}
      </div>
    </div>
  );
}
