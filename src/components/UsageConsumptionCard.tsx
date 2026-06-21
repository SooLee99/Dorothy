'use client';

/**
 * 현재 사용 한도(5h 롤링) proactive 카드 — 경고 전에도 ★항상 볼 수 있게.
 * /api/dorothy/usage-consumption(PM-tick 갱신) 의 토큰 사용량을 진행 막대로 노출.
 * claude=budget-estimate(used/budget), codex=rate-limits(used%/reset). 데이터 없거나 stale면 안내.
 */
import { useEffect, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';

interface Usage {
  updatedAt?: string | null;
  ageSec?: number | null;
  stale?: boolean;
  windowHours?: number | null;
  claude?: { mode?: string; usedTokens?: number | null; budgetTokens?: number | null; remainingTokens?: number | null; pctRemaining?: number | null } | null;
  codex?: { mode?: string; usedPercent?: number | null; remainingPercent?: number | null; resetAt?: string | null } | null;
}

function fmtTok(n?: number | null): string {
  if (typeof n !== 'number') return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
function relTime(iso?: string | null): string {
  if (!iso) return '';
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (Number.isNaN(m)) return '';
  if (m <= 0) return '곧';
  return m < 60 ? `${m}분 후` : `${Math.floor(m / 60)}시간 ${m % 60}분 후`;
}

function Bar({ pctUsed, label, sub }: { pctUsed: number | null; label: string; sub: string }) {
  const used = typeof pctUsed === 'number' ? Math.min(100, Math.max(0, pctUsed)) : null;
  const tone = used == null ? 'bg-muted' : used >= 80 ? 'bg-rose-500' : used >= 60 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">{sub}</span>
      </div>
      <div className="w-full h-2.5 bg-secondary rounded-full overflow-hidden">
        {used != null && <div className={`h-full ${tone} transition-all`} style={{ width: `${used}%` }} />}
      </div>
    </div>
  );
}

export default function UsageConsumptionCard() {
  const [u, setU] = useState<Usage | null>(null);

  const load = async () => {
    try {
      const r = await fetch('/api/dorothy/usage-consumption', { cache: 'no-store' });
      setU(await r.json());
    } catch { /* 무시 */ }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  if (!u) return null;

  const c = u.claude;
  const x = u.codex;
  const claudeUsedPct = typeof c?.pctRemaining === 'number' ? 100 - c.pctRemaining : null;
  const codexUsedPct = typeof x?.usedPercent === 'number' ? x.usedPercent : (typeof x?.remainingPercent === 'number' ? 100 - x.remainingPercent : null);

  return (
    <div className="border border-border rounded-xl p-4 bg-card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Gauge className="w-4 h-4 text-primary" /> 현재 사용 한도 {u.windowHours ? `(최근 ${u.windowHours}h 롤링)` : ''}
        </h2>
        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
          {u.stale ? <span className="text-amber-500">데이터 오래됨{typeof u.ageSec === 'number' ? ` (${Math.round(u.ageSec / 60)}분 전)` : ''}</span>
            : <span>업데이트 {typeof u.ageSec === 'number' ? `${u.ageSec}s 전` : '—'}</span>}
          <button onClick={load} title="새로고침" className="ml-1 p-0.5 hover:text-foreground"><RefreshCw className="w-3 h-3" /></button>
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Bar
          pctUsed={claudeUsedPct}
          label="Claude"
          sub={c && typeof c.pctRemaining === 'number' ? `${c.pctRemaining.toFixed(0)}% 남음 · ${fmtTok(c.usedTokens)}/${fmtTok(c.budgetTokens)}` : '데이터 없음'}
        />
        <Bar
          pctUsed={codexUsedPct}
          label="Codex"
          sub={x && typeof codexUsedPct === 'number'
            ? `${(100 - codexUsedPct).toFixed(0)}% 남음${x.resetAt ? ` · 리셋 ${relTime(x.resetAt)}` : ''}`
            : (x?.mode === 'rate-limits' ? '스냅샷 대기(현재 한도 정보 없음)' : '데이터 없음')}
        />
      </div>
      <p className="text-[10px] text-muted-foreground/70 mt-2">
        출처: ~/.dorothy/runtime/usage-consumption.json (PM-tick). 한도 도달/근접 시 상단 경고 배너가 모든 화면에 표시됩니다.
      </p>
    </div>
  );
}
