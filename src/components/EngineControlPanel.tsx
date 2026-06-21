'use client';

/**
 * 자동개발 엔진 스위치(대시보드) — 전체 멈춤/재개를 한 버튼으로.
 * team-loop(triplan·bueongi)·pm-tick·hermes cron 을 한 번에 토글(되돌릴 수 있음).
 * 이 채팅/대시보드와는 무관 — 자동으로 토큰 쓰는 동력만 켜고 끈다.
 */
import { useCallback, useEffect, useState } from 'react';
import { Power, Loader2, Play, Pause, RefreshCw } from 'lucide-react';

interface State {
  paused: boolean;
  teamLoop: 'paused' | 'running' | 'partial';
  flagsPresent: number;
  flagsTotal: number;
  cron: { active: number; total: number };
}

export default function EngineControlPanel() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/dorothy/engine-control', { cache: 'no-store' });
      setState(await r.json());
    } catch { /* */ }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  const toggle = async (action: 'pause' | 'resume') => {
    if (busy) return;
    if (action === 'pause' && !window.confirm('자동개발 엔진을 전부 멈출까요?\n(team-loop·pm-tick·cron — 토큰 소비 중단. 이 채팅/대시보드는 영향 없음)')) return;
    setBusy(true);
    try {
      const r = await fetch('/api/dorothy/engine-control', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      });
      const j = await r.json();
      setState(j.state ?? null);
      if (j.errors?.length) window.alert(`일부 실패:\n${j.errors.join('\n')}`);
    } finally { setBusy(false); }
  };

  if (!state) return null;
  const running = state.teamLoop !== 'paused' || state.cron.active > 0;

  return (
    <div className={`border rounded-xl p-4 ${running ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5'}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <Power className={`w-5 h-5 shrink-0 ${running ? 'text-emerald-500' : 'text-amber-500'}`} />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              자동개발 엔진 — {running ? '가동 중' : '전체 멈춤'}
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              team-loop {state.teamLoop === 'paused' ? '정지' : state.teamLoop === 'partial' ? '일부' : '가동'}
              {' · '}cron 활성 {state.cron.active}/{state.cron.total}
              {' · '}<span className="opacity-70">이 채팅/대시보드는 영향 없음</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={load} title="새로고침" className="p-1.5 text-muted-foreground hover:text-foreground"><RefreshCw className="w-3.5 h-3.5" /></button>
          {running ? (
            <button
              onClick={() => toggle('pause')}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 border border-amber-500/30 disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pause className="w-3.5 h-3.5" />} 전체 멈춤
            </button>
          ) : (
            <button
              onClick={() => toggle('resume')}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25 border border-emerald-500/30 disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} 전체 재개
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
