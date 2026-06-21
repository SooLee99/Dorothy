'use client';

/**
 * 전역 토큰/한도 경고 배너 — ★"나도 모르는데 한도까지 도달" 방지.
 *
 * 모든 화면 상단에 항상 떠서, 이미 추적 중인 데이터를 prominent 하게 노출한다:
 *  - /api/dorothy/provider-limit-state: codex/claude limited·cooldownUntil·safePause
 *  - /api/dorothy/usage-consumption: 5h 롤링 토큰 사용량(claude pctRemaining·codex remainingPercent)
 *
 * 정상(여유)일 땐 ★렌더 0(잡음 없음). 한도 도달/근접/안전정지/모니터링 stale 일 때만 배너.
 * 경고만 — 자동 정지는 하지 않는다(사용자 몫).
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, PauseCircle, Clock } from 'lucide-react';

interface LimitState {
  codex?: { limited?: boolean; cooldownUntil?: string | null };
  claude?: { limited?: boolean; cooldownUntil?: string | null };
  safePause?: { active?: boolean; reason?: string | null; until?: string | null; remainingMs?: number | null };
}
interface UsageState {
  stale?: boolean;
  ageSec?: number | null;
  windowHours?: number | null;
  claude?: { pctRemaining?: number | null; usedTokens?: number | null; budgetTokens?: number | null } | null;
  codex?: { remainingPercent?: number | null; usedPercent?: number | null; resetAt?: string | null } | null;
}
// ★세션 한도(429) — 5h 롤링 사용량과 다른 차원. "모르는 새 한도"의 진짜 정체.
interface SessionLimitState {
  limited?: boolean;
  detected?: boolean;
  resetLabel?: string;
  resetAt?: string | null;
  minutesUntilReset?: number;
}

const WARN_PCT = 20; // 남은 %가 이 아래면 '한도 근접' 경고

function relTime(iso?: string | null): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m <= 0) return '곧';
  if (m < 60) return `${m}분 후`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분 후`;
}

export default function ProviderLimitBanner() {
  const [limit, setLimit] = useState<LimitState | null>(null);
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [session, setSession] = useState<SessionLimitState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [l, u, s] = await Promise.all([
          fetch('/api/dorothy/provider-limit-state', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
          fetch('/api/dorothy/usage-consumption', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
          fetch('/api/dorothy/session-limit', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        ]);
        if (!cancelled) { setLimit(l); setUsage(u); setSession(s); }
      } catch { /* 무시 — 다음 폴링 */ }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!limit && !usage && !session) return null;

  // 심각도 판정
  const codexLimited = !!limit?.codex?.limited;
  const claudeLimited = !!limit?.claude?.limited;
  const paused = !!limit?.safePause?.active;
  const claudePct = usage?.claude?.pctRemaining;
  const codexPct = usage?.codex?.remainingPercent;
  const claudeLow = typeof claudePct === 'number' && claudePct < WARN_PCT;
  const codexLow = typeof codexPct === 'number' && codexPct < WARN_PCT;
  const stale = !!usage?.stale;
  const sessionLimited = !!session?.limited; // ★Claude 세션 한도(429) — 진짜 "모르는 새 한도"

  const danger = codexLimited || claudeLimited || paused || sessionLimited;
  const warn = claudeLow || codexLow;

  if (!danger && !warn && !stale) return null; // ★정상이면 배너 없음

  // 메시지 구성
  const msgs: string[] = [];
  if (sessionLimited) msgs.push(`★Claude 세션 한도 도달 — ${session?.resetLabel ?? ''} 리셋${typeof session?.minutesUntilReset === 'number' && session.minutesUntilReset > 0 ? ` (${session.minutesUntilReset >= 60 ? `${Math.floor(session.minutesUntilReset / 60)}시간 ${session.minutesUntilReset % 60}분` : `${session.minutesUntilReset}분`} 후)` : ''} · 5h 사용량과 별개`);
  if (claudeLimited) msgs.push(`claude 사용 한도 도달 — 리셋 ${relTime(limit?.claude?.cooldownUntil) || '대기'}`);
  if (codexLimited) msgs.push(`codex 사용 한도 도달 — 리셋 ${relTime(limit?.codex?.cooldownUntil) || '대기'}`);
  if (paused) msgs.push(`안전 정지 활성${limit?.safePause?.reason ? ` (${limit.safePause.reason})` : ''}${limit?.safePause?.until ? ` · ${relTime(limit.safePause.until)} 해제` : ''}`);
  if (!claudeLimited && claudeLow) msgs.push(`claude 한도 근접: ${claudePct?.toFixed(0)}% 남음${usage?.windowHours ? ` (최근 ${usage.windowHours}h)` : ''}`);
  if (!codexLimited && codexLow) msgs.push(`codex 한도 근접: ${codexPct?.toFixed(0)}% 남음${usage?.codex?.resetAt ? ` · 리셋 ${relTime(usage.codex.resetAt)}` : ''}`);

  const Icon = danger ? AlertTriangle : paused ? PauseCircle : warn ? AlertTriangle : Clock;
  const tone = danger
    ? 'border-rose-500/50 bg-rose-500/10 text-rose-600'
    : warn
      ? 'border-amber-500/50 bg-amber-500/10 text-amber-600'
      : 'border-border bg-secondary/40 text-muted-foreground';

  return (
    <div className={`flex items-center gap-2 px-3 py-2 mb-3 text-sm border rounded-lg ${tone}`} role="alert">
      <Icon className="w-4 h-4 shrink-0" />
      <div className="flex-1 min-w-0">
        {msgs.length > 0 ? (
          <span className="font-medium">{msgs.join(' · ')}</span>
        ) : (
          <span>토큰 사용량 모니터링 데이터가 오래됨{typeof usage?.ageSec === 'number' ? ` (${Math.round(usage.ageSec / 60)}분 전)` : ''} — PM-tick 동작 확인 필요</span>
        )}
        {stale && msgs.length > 0 && (
          <span className="ml-2 text-[11px] opacity-70">(사용량 데이터 {typeof usage?.ageSec === 'number' ? `${Math.round((usage!.ageSec as number) / 60)}분 전` : '오래됨'})</span>
        )}
      </div>
    </div>
  );
}
