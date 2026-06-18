'use client';

/**
 * Part H / E-2 — 자율운영 상태 패널.
 *   /api/dorothy/autonomy-status 를 폴링해 liveness 4-state(EXTERNAL_PAUSE 포함)·pause 사유·감독 레벨·
 *   provider 한도·예산·복구 circuit/scope·플래그·에스컬레이션을 한 화면에 표시.
 */
import { useEffect, useState } from 'react';
import { ShieldCheck, PauseCircle, AlertTriangle, Activity, Clock, Layers } from 'lucide-react';

interface Status {
  liveness?: { state?: string; suppressForceRecovery?: boolean; anomaly?: unknown; counts?: { active?: number; dispatchable?: number; externalBlocked?: number; awaitingHuman?: number } } | null;
  pause?: { pausedUnits?: number; reasonCounts?: Record<string, number> };
  supervision?: { level?: string; soakGreen?: boolean | null };
  trust?: Record<string, { state?: string }> | null;
  budget?: { exhausted?: boolean; resetAt?: string } | null;
  providerLimit?: { codex?: { limited?: boolean; cooldownUntil?: string }; claude?: { limited?: boolean; cooldownUntil?: string } } | null;
  scopeBreakers?: { scopes?: Record<string, { tripped?: boolean }> } | null;
  soak?: { green?: boolean; masterSoak?: boolean; pass?: number; fail?: number } | null;
  flags?: { killSwitch?: boolean; configDegraded?: boolean; wakeCatchup?: boolean };
  escalations?: { kind?: string; at?: string }[];
  at?: string;
}

const LIVENESS_STYLE: Record<string, { label: string; cls: string }> = {
  PROGRESSING: { label: '진행 중', cls: 'bg-green-500/20 text-green-400 border-green-500/30' },
  EXTERNAL_PAUSE: { label: '외부 대기(EXTERNAL_PAUSE)', cls: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  IDLE_WAITING_HUMAN: { label: '사람 대기', cls: 'bg-sky-500/20 text-sky-400 border-sky-500/30' },
  LIVENESS_STALL: { label: 'STALL(헛돔)', cls: 'bg-red-500/20 text-red-400 border-red-500/30' },
};

export default function AutonomyStatusPanel() {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    const load = async () => {
      try { const r = await fetch('/api/dorothy/autonomy-status', { cache: 'no-store' }); if (r.ok) { setS(await r.json()); setErr(false); } else setErr(true); }
      catch { setErr(true); }
    };
    void load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  if (err && !s) return null; // dev 전용 라우트 미가동 시 조용히 숨김
  if (!s) return null;

  const lv = LIVENESS_STYLE[s.liveness?.state || ''] || { label: s.liveness?.state || '—', cls: 'bg-secondary text-muted-foreground border-border' };
  const reasons = s.pause?.reasonCounts || {};
  const cd = s.providerLimit?.codex, cl = s.providerLimit?.claude;
  const trippedScopes = Object.entries(s.scopeBreakers?.scopes || {}).filter(([, v]) => v?.tripped).map(([k]) => k);
  const fmtTime = (t?: string) => (t ? new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '');

  return (
    <div className="border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium flex items-center gap-2 text-foreground">
          <ShieldCheck className="w-4 h-4 text-muted-foreground" /> 자율운영 상태
        </h3>
        <span className="text-[10px] text-muted-foreground">{fmtTime(s.at)} 갱신</span>
      </div>

      {/* 상단 배지들 */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className={`text-xs px-2 py-1 border rounded ${lv.cls}`}><Activity className="w-3 h-3 inline mr-1" />{lv.label}</span>
        {s.liveness?.suppressForceRecovery && <span className="text-[10px] px-2 py-1 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded">강제복구 억제</span>}
        {!!s.liveness?.anomaly && <span className="text-[10px] px-2 py-1 bg-red-500/15 text-red-400 border border-red-500/30 rounded"><AlertTriangle className="w-3 h-3 inline mr-0.5" />회복 지연 이상</span>}
        <span className="text-xs px-2 py-1 bg-secondary border border-border rounded">감독: {s.supervision?.level || '—'}</span>
        <span className={`text-[10px] px-2 py-1 border rounded ${s.soak?.green ? 'bg-green-500/15 text-green-400 border-green-500/30' : 'bg-red-500/15 text-red-400 border-red-500/30'}`}>
          soak {s.soak?.green ? 'green' : 'red'}{s.soak?.masterSoak ? '(master)' : ''} {s.soak ? `${s.soak.pass}/${(s.soak.pass || 0) + (s.soak.fail || 0)}` : ''}
        </span>
        {s.flags?.killSwitch && <span className="text-[10px] px-2 py-1 bg-red-600/20 text-red-400 border border-red-500/40 rounded">KILL-SWITCH</span>}
        {s.flags?.configDegraded && <span className="text-[10px] px-2 py-1 bg-red-500/15 text-red-400 border border-red-500/30 rounded">config 손상(FAIL-CLOSED)</span>}
        {s.flags?.wakeCatchup && <span className="text-[10px] px-2 py-1 bg-sky-500/15 text-sky-400 border border-sky-500/30 rounded">wake catch-up</span>}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
        {/* provider 한도 */}
        <div className="p-2 bg-secondary border border-border rounded">
          <div className="text-muted-foreground mb-1">Provider</div>
          <div className={cd?.limited ? 'text-amber-400' : 'text-green-400'}>codex {cd?.limited ? `한도 ~${fmtTime(cd.cooldownUntil)}` : '가용'}</div>
          <div className={cl?.limited ? 'text-amber-400' : 'text-green-400'}>claude {cl?.limited ? `한도 ~${fmtTime(cl.cooldownUntil)}` : '가용'}</div>
        </div>
        {/* pause 사유 */}
        <div className="p-2 bg-secondary border border-border rounded">
          <div className="text-muted-foreground mb-1 flex items-center gap-1"><PauseCircle className="w-3 h-3" />Pause ({s.pause?.pausedUnits || 0})</div>
          {Object.keys(reasons).length === 0 ? <div className="text-muted-foreground">없음</div> :
            Object.entries(reasons).map(([k, v]) => <div key={k} className="text-foreground/80">{k}: {v}</div>)}
        </div>
        {/* 예산 */}
        <div className="p-2 bg-secondary border border-border rounded">
          <div className="text-muted-foreground mb-1">예산(F-4)</div>
          <div className={s.budget?.exhausted ? 'text-amber-400' : 'text-green-400'}>{s.budget?.exhausted ? `소진 ~${fmtTime(s.budget.resetAt)}` : '여유'}</div>
          {trippedScopes.length > 0 && <div className="text-red-400 mt-1">scope 차단: {trippedScopes.length}</div>}
        </div>
        {/* liveness counts */}
        <div className="p-2 bg-secondary border border-border rounded">
          <div className="text-muted-foreground mb-1 flex items-center gap-1"><Layers className="w-3 h-3" />작업</div>
          <div className="text-foreground/80">활성 {s.liveness?.counts?.active ?? '—'} / dispatch {s.liveness?.counts?.dispatchable ?? '—'}</div>
          <div className="text-foreground/80">외부대기 {s.liveness?.counts?.externalBlocked ?? '—'} / 사람대기 {s.liveness?.counts?.awaitingHuman ?? '—'}</div>
        </div>
      </div>

      {/* 최근 에스컬레이션 */}
      {s.escalations && s.escalations.length > 0 && (
        <div className="mt-3 pt-2 border-t border-border">
          <div className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1"><Clock className="w-3 h-3" />최근 에스컬레이션</div>
          <div className="flex flex-wrap gap-1">
            {s.escalations.slice(-8).reverse().map((e, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 bg-red-500/10 text-red-400/90 border border-red-500/20 rounded">{e.kind} {fmtTime(e.at)}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
