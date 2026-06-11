'use client';

import { useEffect, useState } from 'react';
import { dorothyClient } from '@/lib/dorothyClient';
import TeamLoopStatus from '@/components/AutoCompany/TeamLoopStatus';
import {
  Workflow,
  RefreshCw,
  Loader2,
  Play,
  Square,
  RotateCw,
  Clock,
  Zap,
  FileText,
  ExternalLink,
  Copy,
  Check,
  X,
  AlertTriangle,
  Terminal,
} from 'lucide-react';
import { ko } from '@/i18n';
import { plainAutoStatus, toneClasses } from '@/lib/autoCompanyStatus';

interface AutoCompanyMeta {
  installPath?: string;
  loopScript?: string;
  stopScript?: string;
  statusScript?: string;
  stateFile?: string;
  consensusFile?: string;
  dashboardUrl?: string;
  launchdLabel?: string;
  dorothyWrapper?: string;
  dorothyStateFile?: string;
}

interface AutoCompanyData {
  meta: AutoCompanyMeta | null;
  state: Record<string, string>;
  runtime: unknown;
  consensusHead: string | null;
  log: { file: string; tail: string } | null;
  paused?: boolean;
  pidAlive?: boolean;
  dorothyBusy?: boolean;
  error?: string;
}

type Section = 'routing' | 'usage' | 'logs';

// Map a raw STATUS string from .auto-loop-state to a Korean status label + color.
function statusBadge(raw?: string): { label: string; cls: string } {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('run')) return { label: ko.status.running, cls: 'bg-green-500/15 text-green-500 border-green-500/30' };
  if (s.includes('cooldown') || s.includes('wait'))
    return { label: ko.status.cooldown, cls: 'bg-yellow-500/15 text-yellow-500 border-yellow-500/30' };
  if (s.includes('block')) return { label: ko.status.blocked, cls: 'bg-red-500/15 text-red-500 border-red-500/30' };
  if (s.includes('idle')) return { label: ko.status.idle, cls: 'bg-secondary text-muted-foreground border-border' };
  if (s.includes('done') || s.includes('complete'))
    return { label: ko.status.done, cls: 'bg-blue-500/15 text-blue-500 border-blue-500/30' };
  if (s.includes('error') || s.includes('fail'))
    return { label: ko.status.error, cls: 'bg-red-500/15 text-red-500 border-red-500/30' };
  return { label: raw || ko.status.unknown, cls: 'bg-secondary text-muted-foreground border-border' };
}

function boolText(v?: string): string {
  if (v == null) return '-';
  const s = v.toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return '예';
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return '아니오';
  return v;
}

export default function AutoCompanyPage() {
  const [data, setData] = useState<AutoCompanyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [section, setSection] = useState<Section>('routing');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = async () => {
    try {
      const json = (await dorothyClient.autoCompany.get()) as AutoCompanyData;
      setData(json);
    } catch (e) {
      setData({ meta: null, state: {}, runtime: null, consensusHead: null, log: null, error: String(e) });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    load();
  };

  // 화이트리스트 액션을 실제 실행한다(메인 프로세스가 정해진 스크립트만 실행).
  const runControl = async (action: string, label: string, confirmMsg?: string) => {
    if (confirmMsg && typeof window !== 'undefined' && !window.confirm(confirmMsg)) return;
    setBusyAction(action);
    setToast(null);
    try {
      const res = await dorothyClient.autoCompany.control(action);
      setToast(res?.error ? `실패: ${res.error}` : res?.message ?? `${label} 완료`);
    } catch (e) {
      setToast(`실패: ${String(e)}`);
    } finally {
      setBusyAction(null);
      setTimeout(() => setToast(null), 5000);
      setTimeout(() => load(), 1500); // 스크립트 반영 후 상태 갱신
    }
  };

  const meta = data?.meta;
  const state = data?.state ?? {};
  const badge = statusBadge(state.STATUS);
  const plain = plainAutoStatus({ state, paused: data?.paused, pidAlive: data?.pidAlive, dorothyBusy: data?.dorothyBusy });
  const tone = toneClasses[plain.tone];

  // 버튼 → 화이트리스트 액션 키. 실제 명령은 메인 프로세스가 companies.json 경로로 실행한다.
  const controlButtons: { label: string; icon: React.ReactNode; action: string; confirm?: string }[] = [
    { label: ko.button.start, icon: <Play className="w-4 h-4" />, action: 'start', confirm: '자동 루프(launchd 데몬)를 시작/재개할까요?' },
    { label: ko.button.stop, icon: <Square className="w-4 h-4" />, action: 'stop', confirm: '자동 루프를 중지(일시정지)할까요? 진행 중인 사이클이 중단됩니다.' },
    { label: ko.button.restart, icon: <RotateCw className="w-4 h-4" />, action: 'restart', confirm: '자동 루프를 재시작할까요?' },
    { label: ko.button.resumeAfterWait, icon: <Clock className="w-4 h-4" />, action: 'resume', confirm: '지금 재개할까요? (launchd 재로드)' },
    { label: '현재 cycle 강제 실행', icon: <Zap className="w-4 h-4" />, action: 'runOnce', confirm: '지금 1 사이클을 강제 실행할까요? (엔진 호출 · 토큰 사용)' },
  ];

  const engineButtons: { label: string; action: string; confirm: string }[] = [
    { label: 'Claude로 실행', action: 'runOnceClaude', confirm: 'Claude로 1 사이클을 실행할까요? (토큰 사용)' },
    { label: 'Codex로 실행', action: 'runOnceCodex', confirm: 'Codex로 1 사이클을 실행할까요?' },
    { label: 'Auto 라우팅으로 실행', action: 'runOnceAuto', confirm: 'Auto 라우팅으로 1 사이클을 실행할까요?' },
  ];

  const openButtons: { label: string; icon: React.ReactNode; action: string }[] = [
    { label: 'consensus.md 열기', icon: <FileText className="w-4 h-4" />, action: 'openConsensus' },
    { label: 'logs 열기', icon: <FileText className="w-4 h-4" />, action: 'openLogs' },
    { label: '대시보드 열기', icon: <ExternalLink className="w-4 h-4" />, action: 'openDashboard' },
  ];

  const StatusCard = ({ title, value, hint }: { title: string; value: React.ReactNode; hint?: string }) => (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        {title}
        {hint && <span className="text-[10px] opacity-60 font-mono">({hint})</span>}
      </div>
      <div className="text-sm font-medium mt-1 break-all">{value}</div>
    </div>
  );

  return (
    <div className="space-y-4 lg:space-y-6 pt-4 lg:pt-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Workflow className="w-6 h-6" /> {ko.nav.autoCompany}
          </h1>
          <p className="text-muted-foreground text-xs lg:text-sm mt-1">
            Auto-Company {ko.nav.autoLoop} 상태 모니터링 (제어 명령은 복사 전용)
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-secondary hover:bg-secondary/80 transition-colors rounded-md"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          {ko.button.refresh}
        </button>
      </div>

      {/* Rate-limit note */}
      <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 flex items-start gap-2 text-sm text-yellow-600 dark:text-yellow-500">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>실제 사용량 제한은 우회하지 않습니다. rate-limit 시 자동 대기 후 재개합니다.</span>
      </div>

      {/* 🅰 역할 팀 24h 루프 — 현재 활성 Auto-Company. 실행 상태·현재 단계·재가동 예정 시각 표시. */}
      <TeamLoopStatus />

      {/* 아래는 🅱 네이티브 Auto-Company 데몬(레거시) 모니터링 */}
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" /> 불러오는 중...
        </div>
      ) : data?.error ? (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-500 text-sm">{data.error}</div>
      ) : (
        <>
          {/* 쉬운 말 상태 요약 (Hero) */}
          <div className={`rounded-xl border p-5 ${tone.bg}`}>
            <div className="flex items-start gap-4">
              <div className="text-4xl leading-none mt-0.5">{plain.emoji}</div>
              <div className="min-w-0 flex-1">
                <div className={`text-lg font-bold ${tone.text}`}>{plain.headline}</div>
                <p className="text-sm text-muted-foreground mt-1">{plain.detail}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  오토컴퍼니는 사람이 지켜보지 않아도 PM·개발·QA·보안 에이전트가 24시간 스스로 작업을 찾아 진행하는 자동 개발 루프예요.
                </p>
              </div>
            </div>
          </div>

          {/* 제어 (주요 동작 먼저) */}
          <div className="bg-card border border-border rounded-lg p-4 space-y-3">
            <div>
              <div className="text-sm font-medium">자동 개발 켜기 / 끄기</div>
              <p className="text-xs text-muted-foreground mt-0.5">시작하면 24시간 스스로 작업하고, 중지하면 안전하게 멈춰요(작업 내용은 보존).</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {controlButtons.map((b) => (
                <button
                  key={b.action}
                  disabled={busyAction !== null}
                  onClick={() => runControl(b.action, b.label, b.confirm)}
                  className="flex items-center gap-2 px-3 py-2 text-sm bg-secondary hover:bg-secondary/80 transition-colors rounded-md disabled:opacity-50"
                >
                  {b.icon}
                  {b.label}
                </button>
              ))}
            </div>
            <div className="pt-2">
              <div className="text-sm font-medium">한 번만 실행해 보기</div>
              <p className="text-xs text-muted-foreground mt-0.5">자동 루프를 켜지 않고 딱 1번만 작업해 봐요. 어떤 AI로 할지 고를 수 있어요. (토큰이 사용돼요)</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {engineButtons.map((b) => (
                <button
                  key={b.action}
                  disabled={busyAction !== null}
                  onClick={() => runControl(b.action, b.label, b.confirm)}
                  className="flex items-center gap-2 px-3 py-2 text-sm bg-secondary hover:bg-secondary/80 transition-colors rounded-md disabled:opacity-50"
                >
                  <Zap className="w-4 h-4" />
                  {b.label}
                </button>
              ))}
            </div>
            <div className="pt-2">
              <div className="text-sm font-medium">파일·대시보드 열기</div>
              <p className="text-xs text-muted-foreground mt-0.5">진행 기록(consensus)·로그·웹 대시보드를 바로 열어봐요.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {openButtons.map((b) => (
                <button
                  key={b.action}
                  disabled={busyAction !== null}
                  onClick={() => runControl(b.action, b.label)}
                  className="flex items-center gap-2 px-3 py-2 text-sm bg-secondary hover:bg-secondary/80 transition-colors rounded-md disabled:opacity-50"
                >
                  {b.icon}
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          {/* 자세한 상태 (쉬운 라벨 + 원래 용어 보조) */}
          <details className="bg-card border border-border rounded-lg p-4">
            <summary className="text-sm font-medium cursor-pointer">자세한 상태 보기</summary>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mt-3">
              <StatusCard title="상태" value={<span className={`inline-block px-2 py-0.5 rounded border text-xs ${badge.cls}`}>{badge.label}</span>} hint="auto-loop STATUS" />
              <StatusCard title="사용 중인 AI" value={state.ENGINE ?? state.MODEL ?? '-'} hint="engine" />
              <StatusCard title="완료한 작업 수" value={state.LOOP_COUNT ?? state.CYCLE ?? '-'} hint="cycle" />
              <StatusCard title="마지막 작업 시각" value={state.LAST_RUN ?? '-'} hint="last run" />
              <StatusCard title="지금 멈춤?" value={data?.paused ? '예 (일시정지)' : '아니오'} hint="paused flag" />
              <StatusCard title="쉬는 중?" value={boolText(state.COOLDOWN ?? state.IN_COOLDOWN)} hint="cooldown" />
              <StatusCard title="사용량 한도 걸림?" value={boolText(state.RATE_LIMITED ?? state.RATE_LIMIT)} hint="rate-limit" />
              <StatusCard title="연속 실패" value={state.ERROR_COUNT ?? state.CONSECUTIVE_FAILURES ?? '-'} hint="errors" />
              <StatusCard title="자동 멈춤(안전장치)" value={boolText(state.CIRCUIT_BREAKER ?? state.BREAKER)} hint="circuit breaker" />
              <StatusCard title="설치 위치" value={meta?.installPath ?? '-'} />
            </div>
          </details>

          {/* Section tabs */}
          <div className="flex gap-1 border-b border-border">
            {(
              [
                ['routing', '엔진 라우팅'],
                ['usage', '사용량·대기'],
                ['logs', '실행 로그'],
              ] as [Section, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSection(key)}
                className={`px-4 py-2 text-sm transition-colors border-b-2 -mb-px ${
                  section === key
                    ? 'border-primary text-primary font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Section content */}
          {section === 'routing' && (
            <div className="bg-card border border-border rounded-lg p-4 space-y-2 text-sm">
              <div>
                <span className="text-muted-foreground">현재 engine: </span>
                <span className="font-mono">{state.ENGINE ?? '-'}</span>
              </div>
              <div>
                <span className="text-muted-foreground">현재 model: </span>
                <span className="font-mono">{state.MODEL ?? '-'}</span>
              </div>
              <p className="text-muted-foreground text-xs pt-2">
                narrow/parallel 작업은 Codex, deep-context 작업은 Claude로 라우팅됩니다 (auto 프로파일).
              </p>
            </div>
          )}

          {section === 'usage' && (
            <div className="bg-card border border-border rounded-lg p-4 space-y-2 text-sm">
              <div>
                <span className="text-muted-foreground">cooldown 상태: </span>
                {boolText(state.COOLDOWN ?? state.IN_COOLDOWN)}
              </div>
              <div>
                <span className="text-muted-foreground">rate-limit 감지: </span>
                {boolText(state.RATE_LIMITED ?? state.RATE_LIMIT)}
              </div>
              <div>
                <span className="text-muted-foreground">연속 실패 횟수: </span>
                {state.ERROR_COUNT ?? '-'}
              </div>
              <div>
                <span className="text-muted-foreground">circuit breaker: </span>
                {boolText(state.CIRCUIT_BREAKER ?? state.BREAKER)}
              </div>
              {data?.runtime != null && (
                <div className="pt-2">
                  <div className="text-muted-foreground text-xs mb-1">Dorothy 래퍼 런타임 상태:</div>
                  <pre className="text-xs bg-secondary/40 rounded p-2 overflow-auto max-h-48">
                    {JSON.stringify(data.runtime, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}

          {section === 'logs' && (
            <div className="space-y-4">
              <div className="bg-card border border-border rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-border font-medium text-sm">consensus.md 요약 (첫 40줄)</div>
                <pre className="p-4 text-xs whitespace-pre-wrap break-words text-muted-foreground max-h-[400px] overflow-auto">
                  {data?.consensusHead ?? '없음'}
                </pre>
              </div>
              <div className="bg-card border border-border rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-border font-medium text-sm">
                  최근 로그{data?.log?.file ? ` — ${data.log.file.split('/').pop()}` : ''}
                </div>
                <pre className="p-4 text-xs whitespace-pre-wrap break-words text-muted-foreground max-h-[400px] overflow-auto">
                  {data?.log?.tail ?? '없음'}
                </pre>
              </div>
            </div>
          )}
        </>
      )}

      {/* 실행 결과 토스트 */}
      {(toast || busyAction) && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg bg-card border border-border shadow-xl text-sm flex items-center gap-2 max-w-[90vw]">
          {busyAction ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> 실행 중…
            </>
          ) : (
            <span className={toast?.startsWith('실패') ? 'text-red-400' : 'text-foreground'}>{toast}</span>
          )}
        </div>
      )}
    </div>
  );
}
