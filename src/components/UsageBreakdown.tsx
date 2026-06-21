'use client';

/**
 * 사용량 분석 — "무슨 일에 토큰 많이 썼나"(모델/플랫폼/툴별).
 * /api/dorothy/insights(=hermes insights 파싱)의 집계를 막대로 노출 + 토큰 먹보 강조.
 * ★주의: insights 는 에이전트별/프로젝트별이 없음(세션이 projectId 미보유). platform(cron=자동
 *   에이전트, slack=대화형)이 가용 프록시 → 친절 라벨로 정체 명확화.
 */
import { useEffect, useState } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';

interface Row { name: string; sessions?: number; tokens?: number; calls?: number; pct?: number }
interface Insights {
  days?: number;
  overview?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; sessions?: number; toolCalls?: number };
  models?: Row[];
  platforms?: Row[];
  tools?: Row[];
  generatedAt?: string;
  error?: string;
}

// 정체 명확화 — 플랫폼/모델 친절 라벨.
const PLATFORM_LABEL: Record<string, string> = {
  cron: '자동 에이전트 (cron 워커)',
  slack: '대화형 (Slack 세션)',
  cli: '터미널 (CLI)',
  telegram: '대화형 (Telegram)',
  discord: '대화형 (Discord)',
};
function fmt(n?: number): string {
  if (typeof n !== 'number') return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function Bars({ title, rows, valueKey, label }: { title: string; rows: Row[]; valueKey: 'tokens' | 'calls'; label?: (n: string) => string }) {
  const vals = rows.map((r) => (r[valueKey] as number) || 0);
  const max = Math.max(1, ...vals);
  const ranked = [...rows].sort((a, b) => ((b[valueKey] as number) || 0) - ((a[valueKey] as number) || 0)).slice(0, 8);
  if (ranked.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold text-foreground mb-2">{title}</h3>
      <div className="space-y-1.5">
        {ranked.map((r, i) => {
          const v = (r[valueKey] as number) || 0;
          const pct = Math.round((v / max) * 100);
          return (
            <div key={r.name}>
              <div className="flex items-center justify-between text-[11px] mb-0.5">
                <span className={`truncate ${i === 0 ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                  {i === 0 && '🔺 '}{label ? label(r.name) : r.name}
                </span>
                <span className="text-muted-foreground shrink-0 ml-2">
                  {valueKey === 'tokens' ? `${fmt(v)} tok` : `${v}회`}{typeof r.pct === 'number' ? ` · ${r.pct}%` : ''}
                </span>
              </div>
              <div className="w-full h-1.5 bg-secondary rounded-full overflow-hidden">
                <div className={`h-full ${i === 0 ? 'bg-primary' : 'bg-primary/40'}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function UsageBreakdown() {
  const [d, setD] = useState<Insights | null>(null);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);

  const load = async (n: number) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/dorothy/insights?days=${n}`, { cache: 'no-store' });
      setD(await r.json());
    } catch { /* 무시 */ } finally { setLoading(false); }
  };
  useEffect(() => { load(days); /* eslint-disable-next-line */ }, [days]);

  if (!d) return null;
  const ov = d.overview ?? {};

  return (
    <div className="border border-border rounded-xl p-4 bg-card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <BarChart3 className="w-4 h-4 text-primary" /> 무슨 일에 토큰을 썼나 (최근 {d.days ?? days}일)
        </h2>
        <div className="flex items-center gap-1">
          {[7, 30].map((n) => (
            <button key={n} onClick={() => setDays(n)}
              className={`px-2 py-0.5 text-[11px] rounded border ${days === n ? 'bg-primary/15 border-primary/40 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              {n}일
            </button>
          ))}
          <button onClick={() => load(days)} title="새로고침" className="ml-1 p-0.5 text-muted-foreground hover:text-foreground">
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Overview */}
      <div className="grid grid-cols-3 gap-2 mb-4 text-center">
        <div className="rounded-lg bg-secondary/40 py-2">
          <div className="text-sm font-bold text-foreground">{fmt(ov.totalTokens)}</div>
          <div className="text-[10px] text-muted-foreground">총 토큰</div>
        </div>
        <div className="rounded-lg bg-secondary/40 py-2">
          <div className="text-sm font-bold text-foreground">{fmt(ov.inputTokens)}/{fmt(ov.outputTokens)}</div>
          <div className="text-[10px] text-muted-foreground">입력/출력</div>
        </div>
        <div className="rounded-lg bg-secondary/40 py-2">
          <div className="text-sm font-bold text-foreground">{ov.sessions ?? '—'}</div>
          <div className="text-[10px] text-muted-foreground">세션</div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <Bars title="플랫폼별 (어디서)" rows={d.platforms ?? []} valueKey="tokens" label={(n) => PLATFORM_LABEL[n] ?? n} />
        <Bars title="모델별" rows={d.models ?? []} valueKey="tokens" />
        <Bars title="툴 사용 (무슨 도구)" rows={d.tools ?? []} valueKey="calls" />
      </div>

      <p className="text-[10px] text-muted-foreground/70 mt-3">
        출처: hermes insights. ⚠ 에이전트별·프로젝트별 토큰은 세션 데이터에 projectId가 없어 집계 불가 —
        플랫폼(자동 에이전트=cron / 대화형=slack)이 현재 가용한 구분입니다.
      </p>
    </div>
  );
}
