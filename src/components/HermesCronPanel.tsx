'use client';

/**
 * 정합성 C4-e — hermes cron(실 자동개발 동력) read-only 패널.
 * /api/dorothy/hermes-cron(=~/.hermes/cron/jobs.json) 의 잡을 자동화 화면에 노출.
 * ★실제 도는 자동화(triplan/부엉이 QA·Orchestrator·Backend·Frontend 등)가 비로소 보임. 제어 X.
 */
import { useEffect, useState } from 'react';
import { Clock, RefreshCw, CheckCircle2, XCircle, PauseCircle } from 'lucide-react';

interface Job {
  id: string; name: string; schedule: string | null; enabled: boolean; state: string | null;
  nextRunAt: string | null; lastRunAt: string | null; lastStatus: string | null; lastError: string | null;
  deliver: string | null; provider: string | null; model: string | null; skills: string[];
}

function rel(iso: string | null): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return '—';
  const m = Math.round(ms / 60000);
  if (m === 0) return '곧';
  if (m > 0) return m < 60 ? `${m}분 후` : `${Math.floor(m / 60)}시간 후`;
  const am = -m;
  return am < 60 ? `${am}분 전` : `${Math.floor(am / 60)}시간 전`;
}

export default function HermesCronPanel() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/dorothy/hermes-cron', { cache: 'no-store' });
      const j = await r.json();
      setJobs(Array.isArray(j.jobs) ? j.jobs : []);
      setErr(j.error ?? null);
    } catch (e) { setErr(e instanceof Error ? e.message : 'load failed'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);

  if (jobs === null) return null;

  return (
    <div className="border border-border rounded-xl p-4 bg-card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Clock className="w-4 h-4 text-primary" /> Hermes 자동개발 cron <span className="text-xs font-normal text-muted-foreground">({jobs.length}·read-only)</span>
        </h2>
        <button onClick={load} title="새로고침" className="p-0.5 text-muted-foreground hover:text-foreground"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
      </div>
      {err && <p className="text-[11px] text-amber-500 mb-2">일부 데이터를 못 불러왔습니다: {err}</p>}
      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">cron 잡이 없습니다.</p>
      ) : (
        <div className="space-y-1.5">
          {jobs.map((j) => {
            const ok = j.lastStatus === 'ok' || j.lastStatus === 'success';
            const StatusIcon = !j.enabled ? PauseCircle : ok ? CheckCircle2 : j.lastStatus ? XCircle : Clock;
            const statusTone = !j.enabled ? 'text-muted-foreground' : ok ? 'text-emerald-500' : j.lastStatus ? 'text-rose-500' : 'text-muted-foreground';
            return (
              <div key={j.id} className="flex items-center gap-2 py-1.5 px-2 rounded border border-border/50 text-xs">
                <StatusIcon className={`w-3.5 h-3.5 shrink-0 ${statusTone}`} />
                <span className="font-medium text-foreground truncate flex-1 min-w-0" title={j.name}>{j.name}</span>
                {j.provider && <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground shrink-0">{j.provider}</span>}
                <span className="text-muted-foreground shrink-0 w-16 text-right">{j.schedule ?? '—'}</span>
                <span className="text-muted-foreground shrink-0 w-20 text-right" title={`다음 실행: ${j.nextRunAt ?? '—'}`}>다음 {rel(j.nextRunAt)}</span>
                <span className={`shrink-0 w-16 text-right ${j.lastError ? 'text-rose-500' : 'text-muted-foreground'}`} title={j.lastError ?? `마지막: ${j.lastRunAt ?? '—'}`}>
                  {j.lastError ? '오류' : j.lastStatus ?? '—'}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground/70 mt-2">출처: ~/.hermes/cron/jobs.json (실 자동개발 동력). 제어는 hermes cron CLI에서.</p>
    </div>
  );
}
