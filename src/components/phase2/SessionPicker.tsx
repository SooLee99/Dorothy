'use client';

/**
 * PR-2-U2 — SessionPicker. /api/dorothy/sessions 목록에서 ★사용자가 직접 세션을 고른다.
 * ★거짓 자동연결 금지(§2): 어느 세션이 이 task 인지 추측해 자동 선택하지 않는다. 사용자가 선택.
 * 폴링은 picker 가 보일 때만(document.hidden 시 스킵).
 */
import { useEffect, useState } from 'react';

interface SessionItem {
  agentId: string;
  pty?: { observed?: boolean; alive?: boolean };
  lastOutputAt?: { observed?: boolean; ts?: string };
  derived?: { outputActivity?: string; secondsSinceLastOutput?: number | null };
}

export function SessionPicker({ onPick, pollMs = 3000 }: { onPick: (agentId: string) => void; pollMs?: number }) {
  const [sessions, setSessions] = useState<SessionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/dorothy/sessions', { cache: 'no-store' });
        const j = await r.json();
        if (cancelled) return;
        const list = j?.data?.sessions;
        if (Array.isArray(list)) { setSessions(list); setError(null); }
        else setError(j?.meta?.error || '세션 신호 없음');
      } catch {
        if (!cancelled) setError('세션을 가져오지 못했습니다');
      }
    };
    load();
    const run = () => { if (!document.hidden) load(); };
    const t = setInterval(run, pollMs);
    document.addEventListener('visibilitychange', run);
    return () => { cancelled = true; clearInterval(t); document.removeEventListener('visibilitychange', run); };
  }, [pollMs]);

  if (error) return <div className="text-xs text-rose-400">세션 신호 오류: {error}</div>;
  if (sessions === null) return <div className="text-xs text-muted-foreground">세션 로딩…</div>;

  const liveCount = sessions.filter((s) => s.pty?.observed).length;
  if (liveCount === 0) {
    return (
      <div className="rounded-lg border border-border bg-secondary/20 p-4 text-center text-sm text-muted-foreground">
        라이브 세션 없음
        <p className="text-xs text-muted-foreground/70 mt-1">현재 가동 중인 에이전트 세션이 없습니다.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">세션을 선택하면 그 출력을 read-only 로 표시합니다.</p>
      {sessions.map((s) => {
        const observedPty = s.pty?.observed === true;
        const alive = observedPty ? s.pty?.alive : null;
        const act = s.derived?.outputActivity || 'unknown';
        const sec = s.lastOutputAt?.observed ? s.derived?.secondsSinceLastOutput : null;
        const dot = alive === true ? 'bg-emerald-500' : alive === false ? 'bg-rose-500' : 'bg-muted-foreground/40';
        const actCls = act === 'recent' ? 'text-emerald-500' : act === 'silent' ? 'text-amber-600' : 'text-muted-foreground';
        return (
          <button
            key={s.agentId}
            type="button"
            disabled={!observedPty}
            onClick={() => observedPty && onPick(s.agentId)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs rounded border border-border transition-colors text-left ${
              observedPty ? 'hover:border-primary/50' : 'opacity-50 cursor-not-allowed'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
            <span className="font-medium text-foreground w-32 truncate">{s.agentId}</span>
            <span className={actCls}>{observedPty ? act : '세션 없음'}</span>
            <span className="ml-auto text-muted-foreground">{sec != null ? `${sec}초 전` : '확인 불가'}</span>
          </button>
        );
      })}
    </div>
  );
}
