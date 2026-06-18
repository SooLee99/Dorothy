'use client';

import { useEffect, useState, useCallback } from 'react';
import { Activity, Pause, Clock, CircleOff, RefreshCw, Info } from 'lucide-react';
import { dorothyClient } from '@/lib/dorothyClient';

// 🅰 역할 팀 24h 루프 상태 패널.
// /api/dorothy/team-loop/ 를 주기적으로 폴링해 실행 상태·현재 단계·에이전트별
// 재가동 예정 시각(사용량 한도 시)을 표시한다. Electron/웹 모두 동일하게 동작
// (Next API 라우트가 서버측에서 ~/.dorothy 상태 파일을 읽음).

interface AgentRow {
  role: string;
  label: string;
  name: string;
  engine: 'claude' | 'codex';
  status: string;
  cycle: number | string | null;
  lastRun: string | null;
  cooldownUntil: string | null;
  resumeInSeconds: number | null;
  consecutiveErrors: number | string;
  lastError: string | null;
  isCurrent: boolean;
  available: boolean; // 지금 사용 가능 여부(엔진 한도 기준)
  availableAt: string | null; // 사용 가능해지는 시각(ISO)
  availableInSeconds: number | null;
}

interface EngineAvail {
  available: boolean;
  until: string | null;
  resumeInSeconds: number | null;
}

interface UsageInfo {
  claude?: {
    mode?: string; usedTokens?: number | null; budgetTokens?: number | null;
    remainingTokens?: number; pctRemaining?: number | null; windowHours?: number;
  };
  codex?: {
    mode?: string; planType?: string; usedPercent?: number | null; remainingPercent?: number | null;
    windowMinutes?: number; resetAt?: string | null; snapshotAt?: string | null;
    secondaryUsedPercent?: number | null; secondaryResetAt?: string | null; note?: string;
  };
  updatedAt?: string;
}

interface TeamLoopPayload {
  overall: 'running' | 'cooldown' | 'paused' | 'stopped' | 'idle';
  running: boolean;
  paused: boolean;
  pidAlive: boolean;
  pid: number | null;
  currentRole: string | null;
  pass: string | null;
  soonestResume: string | null;
  intervalSeconds: number;
  engines: { claude: EngineAvail; codex: EngineAvail };
  usage?: UsageInfo;
  agents: AgentRow[];
  error?: string;
}

function fmtClock(iso?: string | null): string {
  if (!iso) return '-';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '-';
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

function Bar({ pct, color }: { pct: number; color: string }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-1.5 w-full rounded bg-secondary overflow-hidden">
      <div className={`h-full ${color}`} style={{ width: `${w}%` }} />
    </div>
  );
}

const OVERALL: Record<string, { label: string; cls: string; icon: React.ReactNode; desc: string }> = {
  running: {
    label: '실행 중',
    cls: 'bg-green-500/15 text-green-600 border-green-500/30',
    icon: <Activity className="w-4 h-4" />,
    desc: '역할 팀이 파이프라인 순서(승인관리자→PM→백엔드→프론트→QA→보안→운영→비용→문서)대로 한 명씩 작업 중입니다. 한 바퀴(패스)가 끝나면 잠시 쉬고 다음 패스를 시작합니다.',
  },
  cooldown: {
    label: '사용량 한도 — 대기 중',
    cls: 'bg-yellow-500/15 text-yellow-600 border-yellow-500/30',
    icon: <Clock className="w-4 h-4" />,
    desc: 'Claude/Codex 사용량 한도에 걸려 대기 중입니다. 한도가 풀리는 시각까지 자동으로 기다렸다가 사람이 손대지 않아도 그 지점부터 다시 이어서 작업합니다.',
  },
  paused: {
    label: '일시정지',
    cls: 'bg-secondary text-muted-foreground border-border',
    icon: <Pause className="w-4 h-4" />,
    desc: '정지 플래그(triplan-team-loop.paused)가 설정되어 멈춰 있습니다. 플래그를 제거하면 launchd 가 자동으로 다시 가동합니다.',
  },
  idle: {
    label: '대기(유휴)',
    cls: 'bg-secondary text-muted-foreground border-border',
    icon: <CircleOff className="w-4 h-4" />,
    desc: '지금 실행 중인 에이전트가 없습니다. PM 틱(매시간) 또는 칸반 카드 이동 시 필요한 에이전트가 자동 시작됩니다.',
  },
  stopped: {
    label: '중지됨',
    cls: 'bg-red-500/15 text-red-600 border-red-500/30',
    icon: <CircleOff className="w-4 h-4" />,
    desc: '실행 중인 에이전트가 없습니다.',
  },
};

const AGENT_STATUS: Record<string, { label: string; cls: string }> = {
  running: { label: '작업 중', cls: 'bg-green-500/15 text-green-600' },
  done: { label: '완료', cls: 'bg-blue-500/15 text-blue-600' },
  sleeping: { label: '대기', cls: 'bg-secondary text-muted-foreground' },
  waiting_limit: { label: '한도 대기', cls: 'bg-yellow-500/15 text-yellow-600' },
  error: { label: '오류', cls: 'bg-red-500/15 text-red-600' },
  pending: { label: '대기열', cls: 'bg-secondary text-muted-foreground' },
};

function fmtResume(iso: string | null, seconds: number | null): string {
  if (!iso || seconds == null) return '-';
  const t = new Date(iso);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (seconds <= 0) return `${hhmm} (곧 재개)`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `약 ${m}분 후 (${hhmm})`;
  const h = Math.floor(m / 60);
  return `약 ${h}시간 ${m % 60}분 후 (${hhmm})`;
}

export default function TeamLoopStatus() {
  const [data, setData] = useState<TeamLoopPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // 패키지 앱: Electron IPC, 개발/웹: Next API 폴백 (dorothyClient 가 분기).
      const j = (await dorothyClient.teamLoop.get()) as TeamLoopPayload;
      if (j.error) setErr(j.error);
      else {
        setData(j);
        setErr(null);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000); // 10초마다 새로고침
    return () => clearInterval(t);
  }, [load]);

  if (loading && !data) {
    return <div className="text-sm text-muted-foreground p-4">역할 팀 루프 상태를 불러오는 중…</div>;
  }
  if (err && !data) {
    return <div className="text-sm text-red-500 p-4">상태를 불러오지 못했습니다: {err}</div>;
  }
  if (!data) return null;

  const o = OVERALL[data.overall] ?? OVERALL.stopped;

  return (
    <section className="border border-border rounded-none bg-card p-4 space-y-4">
      {/* 헤더 + 전체 상태 */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold">역할 팀 24h 루프 (Auto-Company)</h2>
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs ${o.cls}`}>
            {o.icon}
            {o.label}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>패스 #{data.pass ?? '-'}</span>
          <span>현재 단계: {data.agents.find((a) => a.isCurrent)?.label ?? '-'}</span>
          <button onClick={load} className="p-1 hover:bg-secondary rounded" title="새로고침">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 동작 설명 */}
      <p className="text-xs text-muted-foreground flex items-start gap-2 leading-relaxed">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        {o.desc}
      </p>

      {/* 엔진별 가용성 요약 — Claude/Codex 사용량 한도를 엔진 단위로 공유 */}
      <div className="grid grid-cols-2 gap-2">
        {(['claude', 'codex'] as const).map((eng) => {
          const e = data.engines?.[eng] ?? { available: true, until: null, resumeInSeconds: null };
          const name = eng === 'claude' ? 'Claude (Anthropic)' : 'GPT (Codex)';
          const users = data.agents.filter((a) => a.engine === eng).map((a) => a.label);
          return (
            <div
              key={eng}
              className={`rounded border px-3 py-2 text-sm ${
                e.available
                  ? 'border-green-500/30 bg-green-500/10 text-green-700'
                  : 'border-yellow-500/30 bg-yellow-500/10 text-yellow-700'
              }`}
            >
              <div className="flex items-center gap-2 font-medium">
                <span className={`w-2 h-2 rounded-full ${e.available ? 'bg-green-500' : 'bg-yellow-500'}`} />
                {name}: {e.available ? '사용 가능' : '재충전 대기'}
              </div>
              <div className="text-[11px] mt-0.5 text-muted-foreground">
                {e.available
                  ? `지금 토큰 사용 가능 · ${users.join(', ') || '담당 없음'}`
                  : `재충전 완료 예정: ${fmtResume(e.until, e.resumeInSeconds)}`}
              </div>
            </div>
          );
        })}
      </div>

      {/* 사용량(앞으로 남은 양) — Claude=예산 대비 추정 · Codex=실측 사용률 */}
      {data.usage && (
        <div className="grid grid-cols-2 gap-2">
          {/* Claude: 예산 대비 잔여(추정) */}
          <div className="rounded border border-border bg-secondary/30 px-3 py-2">
            <div className="flex items-center justify-between text-xs font-medium">
              <span className="text-orange-700">Claude 사용량</span>
              <span className="text-[10px] text-muted-foreground">예산대비 추정 · {data.usage.claude?.windowHours ?? 5}h</span>
            </div>
            {typeof data.usage.claude?.pctRemaining === 'number' ? (
              <>
                <div className="my-1"><Bar pct={data.usage.claude.pctRemaining} color="bg-orange-500" /></div>
                <div className="text-[11px] text-muted-foreground">
                  잔여 약 <strong className="text-foreground">{data.usage.claude.pctRemaining}%</strong>
                  {' · '}{Math.round((data.usage.claude.usedTokens ?? 0) / 1000)}K / {Math.round((data.usage.claude.budgetTokens ?? 0) / 1000)}K 토큰
                </div>
              </>
            ) : (
              <div className="text-[11px] text-muted-foreground mt-1">
                소비 {Math.round((data.usage.claude?.usedTokens ?? 0) / 1000)}K 토큰 · 예산 미설정(usage-budget.json)
              </div>
            )}
          </div>
          {/* Codex: 실측 사용률 */}
          <div className="rounded border border-border bg-secondary/30 px-3 py-2">
            <div className="flex items-center justify-between text-xs font-medium">
              <span className="text-green-700">Codex 사용량</span>
              <span className="text-[10px] text-muted-foreground">
                실측{data.usage.codex?.planType ? ` · ${data.usage.codex.planType}` : ''} · {Math.round((data.usage.codex?.windowMinutes ?? 300) / 60)}h
              </span>
            </div>
            {typeof data.usage.codex?.remainingPercent === 'number' ? (
              <>
                <div className="my-1"><Bar pct={data.usage.codex.remainingPercent} color="bg-green-600" /></div>
                <div className="text-[11px] text-muted-foreground">
                  잔여 <strong className="text-foreground">{data.usage.codex.remainingPercent}%</strong>
                  {data.usage.codex.resetAt ? ` · 리셋 ${fmtClock(data.usage.codex.resetAt)}` : ''}
                  {typeof data.usage.codex.secondaryUsedPercent === 'number' ? ` · 주간 ${(100 - data.usage.codex.secondaryUsedPercent).toFixed(0)}%` : ''}
                </div>
                {data.usage.codex.snapshotAt && (
                  <div className="text-[10px] text-muted-foreground/70">측정시점 {fmtClock(data.usage.codex.snapshotAt)}</div>
                )}
              </>
            ) : (
              <div className="text-[11px] text-muted-foreground mt-1">측정 불가(codex 미실행/데이터 없음)</div>
            )}
          </div>
        </div>
      )}

      {/* 사용량 한도 시 재가동 안내(배너) */}
      {data.overall === 'cooldown' && data.soonestResume && (
        <div className="px-3 py-2 rounded border border-yellow-500/30 bg-yellow-500/10 text-yellow-700 text-sm flex items-center gap-2">
          <Clock className="w-4 h-4" />
          사용량 한도로 대기 중 — 가장 이른 재가동 예정:{' '}
          <strong>
            {fmtResume(
              data.soonestResume,
              data.agents
                .filter((a) => a.resumeInSeconds != null)
                .sort((a, b) => (a.resumeInSeconds! - b.resumeInSeconds!))[0]?.resumeInSeconds ?? null,
            )}
          </strong>
        </div>
      )}

      {/* 에이전트별 표 */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground border-b border-border">
            <tr>
              <th className="text-left py-1.5 px-2 font-medium">에이전트</th>
              <th className="text-left py-1.5 px-2 font-medium">엔진</th>
              <th className="text-left py-1.5 px-2 font-medium">사용 가능</th>
              <th className="text-left py-1.5 px-2 font-medium">상태</th>
              <th className="text-left py-1.5 px-2 font-medium">사이클</th>
              <th className="text-left py-1.5 px-2 font-medium">재충전까지</th>
              <th className="text-left py-1.5 px-2 font-medium">마지막 실행</th>
            </tr>
          </thead>
          <tbody>
            {data.agents.map((a) => {
              const s = AGENT_STATUS[a.status] ?? { label: a.status, cls: 'bg-secondary text-muted-foreground' };
              return (
                <tr key={a.role} className={`border-b border-border/50 ${a.isCurrent ? 'bg-primary/5' : ''}`}>
                  <td className="py-1.5 px-2 font-medium text-foreground">
                    {a.isCurrent && <span className="text-primary mr-1">▶</span>}
                    {a.label}
                  </td>
                  <td className="py-1.5 px-2">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        a.engine === 'codex' ? 'bg-green-600/15 text-green-700' : 'bg-orange-500/15 text-orange-700'
                      }`}
                    >
                      {a.engine === 'codex' ? 'GPT' : 'Claude'}
                    </span>
                  </td>
                  <td className="py-1.5 px-2">
                    {a.available ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-500/15 text-green-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> 사용 가능
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-500/15 text-yellow-700" title={`재충전 완료: ${a.availableAt ?? ''}`}>
                        <Clock className="w-3 h-3" /> 재충전 대기
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 px-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${s.cls}`}>{s.label}</span>
                  </td>
                  <td className="py-1.5 px-2 text-muted-foreground">{a.cycle ?? '-'}</td>
                  <td className={`py-1.5 px-2 ${!a.available ? 'text-yellow-700 font-medium' : 'text-muted-foreground'}`}>
                    {!a.available ? fmtResume(a.availableAt, a.availableInSeconds) : '-'}
                  </td>
                  <td className="py-1.5 px-2 text-muted-foreground">{a.lastRun?.replace('T', ' ').slice(0, 16) ?? '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground">
        패스 사이 대기: {Math.round(data.intervalSeconds / 60)}분 · 순차 실행이라 같은 저장소를 동시에 고치지 않습니다 ·
        사용량 한도는 자동 대기 후 재개(우회 아님).
      </p>
    </section>
  );
}
