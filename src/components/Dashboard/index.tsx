'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import DetailModal from '@/components/DetailModal'; // 홈 정보 분리 — 부가 패널 팝업
import EngineControlPanel from '@/components/EngineControlPanel'; // 자동개발 엔진 멈춤/재개 스위치
import {
  Loader2,
  BarChart3,
  Bot,
  FolderKanban,
  MessageSquare,
  Zap,
  Activity,
  Sparkles,
  Users,
  TrendingUp,
  Clock,
  History,
} from 'lucide-react';
import { useClaude } from '@/hooks/useClaude';
import { useElectronAgents } from '@/hooks/useElectron';
import StatsCard from './StatsCard';
import ControlCenter from './ControlCenter';
import AutonomyStatusPanel from './AutonomyStatusPanel';
import SystemStatusPanel from '@/components/SystemStatusPanel'; // 갭1: breaker-eye(eff·worker·④enforce·breaker) 홈 승격(고립 해소)

// Token pricing per million tokens (MTok) — 모듈 스코프 상수(렌더마다 재생성 X).
const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number; cacheHitsPerMTok: number; cache5mWritePerMTok: number }> = {
  'claude-opus-4-5-20251101': { inputPerMTok: 5, outputPerMTok: 25, cacheHitsPerMTok: 0.50, cache5mWritePerMTok: 6.25 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25, cacheHitsPerMTok: 0.50, cache5mWritePerMTok: 6.25 },
  'claude-opus-4-1': { inputPerMTok: 15, outputPerMTok: 75, cacheHitsPerMTok: 1.50, cache5mWritePerMTok: 18.75 },
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75, cacheHitsPerMTok: 1.50, cache5mWritePerMTok: 18.75 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75 },
  'claude-sonnet-3-7': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheHitsPerMTok: 0.10, cache5mWritePerMTok: 1.25 },
  'claude-haiku-3-5': { inputPerMTok: 0.80, outputPerMTok: 4, cacheHitsPerMTok: 0.08, cache5mWritePerMTok: 1 },
  'claude-haiku-3': { inputPerMTok: 0.25, outputPerMTok: 1.25, cacheHitsPerMTok: 0.03, cache5mWritePerMTok: 0.30 },
};

// Get pricing for a model (with fallback). 순수 함수 — 모듈 스코프.
function getModelPricing(modelId: string) {
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId];
  const lowerModel = modelId.toLowerCase();
  if (lowerModel.includes('opus-4-5') || lowerModel.includes('opus-4.5')) return MODEL_PRICING['claude-opus-4-5'];
  if (lowerModel.includes('opus-4')) return MODEL_PRICING['claude-opus-4'];
  if (lowerModel.includes('sonnet-4-5') || lowerModel.includes('sonnet-4.5')) return MODEL_PRICING['claude-sonnet-4-5'];
  if (lowerModel.includes('sonnet-4') || lowerModel.includes('sonnet')) return MODEL_PRICING['claude-sonnet-4'];
  if (lowerModel.includes('haiku-4-5') || lowerModel.includes('haiku-4.5')) return MODEL_PRICING['claude-haiku-4-5'];
  if (lowerModel.includes('haiku-3-5') || lowerModel.includes('haiku-3.5')) return MODEL_PRICING['claude-haiku-3-5'];
  if (lowerModel.includes('haiku')) return MODEL_PRICING['claude-haiku-3'];
  return MODEL_PRICING['claude-sonnet-4']; // Default
}

export default function Dashboard() {
  const { data, loading, error } = useClaude();
  const { agents } = useElectronAgents();
  // 홈 정보 분리 — 부가 패널은 평소 메인에서 빼고 클릭 시 팝업(정보 손실 0).
  const [detail, setDetail] = useState<null | 'models' | 'hours' | 'messages'>(null);

  // Calculate stats
  const stats = data?.stats;
  const projects = data?.projects || [];
  const skills = data?.skills || [];
  const history = data?.history || [];
  const activeSessions = data?.activeSessions || [];

  // Get recent activity
  const recentActivity = useMemo(() => {
    if (!stats?.dailyActivity || stats.dailyActivity.length === 0) return null;
    const sorted = [...stats.dailyActivity].sort((a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    return sorted[0];
  }, [stats?.dailyActivity]);

  // Get recent tokens
  const recentTokens = useMemo(() => {
    if (!stats?.dailyModelTokens || stats.dailyModelTokens.length === 0) return 0;
    const sorted = [...stats.dailyModelTokens].sort((a, b) =>
      new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    const tokensByModel = sorted[0]?.tokensByModel;
    if (!tokensByModel) return 0;
    return Object.values(tokensByModel).reduce((a, b) => a + b, 0);
  }, [stats?.dailyModelTokens]);

  // Calculate total cost using accurate pricing
  const totalCost = useMemo(() => {
    if (!stats?.modelUsage) return 0;
    try {
      let cost = 0;
      Object.entries(stats.modelUsage).forEach(([modelId, usage]) => {
        const pricing = getModelPricing(modelId);
        const u = usage as { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number };
        cost += ((u.inputTokens || 0) / 1_000_000) * pricing.inputPerMTok;
        cost += ((u.outputTokens || 0) / 1_000_000) * pricing.outputPerMTok;
        cost += ((u.cacheReadInputTokens || 0) / 1_000_000) * pricing.cacheHitsPerMTok;
        cost += ((u.cacheCreationInputTokens || 0) / 1_000_000) * pricing.cache5mWritePerMTok;
      });
      return cost;
    } catch {
      return 0;
    }
  }, [stats?.modelUsage]);

  // Process hourCounts for display
  const hourData = useMemo(() => {
    if (!stats?.hourCounts) return { hours: Array(24).fill(0), maxCount: 1 };

    const hours = Array.from({ length: 24 }, (_, i) => {
      const count = stats.hourCounts[i.toString()] || 0;
      return count;
    });
    const maxCount = Math.max(...hours, 1);

    return { hours, maxCount };
  }, [stats?.hourCounts]);

  // Get recent history entries
  const recentHistory = useMemo(() => {
    if (!history || history.length === 0) return [];

    // Sort by timestamp descending and take last 10
    return [...history]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10);
  }, [history]);

  // Find agent for a project path
  const findAgentForProject = (projectPath: string) => {
    return agents.find(a => a.projectPath === projectPath);
  };

  // Agent stats
  const runningAgents = agents.filter(a => a.status === 'running').length;
  const idleAgents = agents.filter(a => a.status === 'idle').length;
  const waitingAgents = agents.filter(a => a.status === 'waiting').length;

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">Loading Claude Code data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center text-danger">
          <p className="mb-2">Failed to load Claude Code data</p>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  const characterEmojis: Record<string, string> = {
    robot: '🤖',
    ninja: '🥷',
    wizard: '🧙',
    astronaut: '👨‍🚀',
    knight: '⚔️',
    pirate: '🏴‍☠️',
    alien: '👽',
    viking: '🛡️',
    frog: '🐸',
  };

  return (
    <div className="space-y-4 lg:space-y-6 pt-4 lg:pt-6">
      {/* 자동개발 엔진 멈춤/재개 스위치 — 토큰 쓰는 동력 전체 토글(되돌릴 수 있음) */}
      <EngineControlPanel />

      {/* Phase 6-AL — 자동개발 관제 센터(홈 상단 요약) */}
      <ControlCenter />

      {/* Part H / E-2 — 자율운영 상태(liveness 4-state·pause·감독·예산·provider·에스컬레이션) */}
      <AutonomyStatusPanel />

      {/* 갭1 — breaker-eye 통제 패널(used% raw/eff·worker tracked/untracked·④ enforce·breaker 사유). 신선도 배지 상주. read-only */}
      <SystemStatusPanel />

      {/* Header — 로드맵 2번: 대시보드는 "한눈에 보는 요약". 실시간 뷰(터미널/보드/3D)는 /monitoring으로 분리. */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <BarChart3 className="w-6 h-6" /> 대시보드
          </h1>
          <p className="text-muted-foreground text-xs lg:text-sm mt-1 hidden sm:block">
            전체 현황 요약 — 실시간 감시는 <Link href="/monitoring" className="text-primary hover:underline">모니터링</Link>에서
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground hidden sm:block">
          <div className="flex items-center gap-2 justify-end">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
            </span>
            <span>활성 세션 {activeSessions.length}개</span>
          </div>
          <div className="mt-0.5">
            {new Date().toLocaleDateString('ko-KR', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </div>
        </div>
      </div>

      {/* Statistics summary — 로드맵 2번: 토글 뒤에 묻혀 도달 불가했던 stats 뷰를 대시보드 요약 섹션으로 부활. */}
      {/* Stats Grid - Row 1: Agents */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Total Agents"
          value={agents.length}
          subtitle={`${runningAgents} running, ${idleAgents} idle`}
          icon={Bot}
          color="cyan"
        />
        <StatsCard
          title="Running"
          value={runningAgents}
          subtitle={waitingAgents > 0 ? `${waitingAgents} waiting for input` : 'All agents responsive'}
          icon={Activity}
          color="green"
        />
        <StatsCard
          title="Projects"
          value={projects.length}
          subtitle={`${skills.length} skills installed`}
          icon={FolderKanban}
          color="amber"
        />
        <StatsCard
          title="Skills"
          value={skills.length}
          subtitle={`${skills.filter(s => s.source === 'user').length} user, ${skills.filter(s => s.source === 'project').length} project, ${skills.filter(s => s.source === 'plugin').length} plugin`}
          icon={Sparkles}
          color="purple"
        />
      </div>

      {/* Stats Grid - Row 2: Usage */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Recent Messages"
          value={recentActivity?.messageCount || 0}
          subtitle={`${recentActivity?.toolCallCount || 0} tool calls`}
          icon={MessageSquare}
          color="green"
        />
        <StatsCard
          title="Recent Tokens"
          value={`${(recentTokens / 1000).toFixed(0)}k`}
          subtitle={recentActivity?.date || 'No data'}
          icon={Zap}
          color="purple"
        />
        <StatsCard
          title="Total Sessions"
          value={stats?.totalSessions || 0}
          subtitle={`Since ${stats?.firstSessionDate ? new Date(stats.firstSessionDate).toLocaleDateString() : 'N/A'}`}
          icon={Users}
          color="cyan"
        />
        <StatsCard
          title="Total Cost"
          value={`$${totalCost.toFixed(2)}`}
          subtitle="All time usage"
          icon={TrendingUp}
          color="amber"
        />
      </div>

      {/* 부가 상세 — 메인 슬림: 핵심(위 통제·통계)은 한눈에, 상세는 클릭 팝업/이동(정보 손실 0). */}
      <div className="border border-border bg-card p-4">
        <h3 className="text-sm font-medium mb-3 flex items-center gap-2 text-foreground">
          <BarChart3 className="w-4 h-4 text-muted-foreground" /> 상세 보기
          <span className="text-xs text-muted-foreground font-normal">필요할 때만 펼쳐보세요</span>
        </h3>
        <div className="flex flex-wrap gap-2">
          {stats?.modelUsage && Object.keys(stats.modelUsage).length > 0 && (
            <button onClick={() => setDetail('models')} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-secondary hover:bg-secondary/70 border border-border rounded-lg transition-colors">
              <Bot className="w-3.5 h-3.5" /> 모델별 사용량
            </button>
          )}
          <button onClick={() => setDetail('hours')} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-secondary hover:bg-secondary/70 border border-border rounded-lg transition-colors">
            <Clock className="w-3.5 h-3.5" /> 시간대별 활동
          </button>
          {recentHistory.length > 0 && (
            <button onClick={() => setDetail('messages')} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-secondary hover:bg-secondary/70 border border-border rounded-lg transition-colors">
              <History className="w-3.5 h-3.5" /> 최근 메시지 {recentHistory.length}
            </button>
          )}
          {agents.length > 0 && (
            <Link href="/monitoring" className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-secondary hover:bg-secondary/70 border border-border rounded-lg transition-colors">
              <Bot className="w-3.5 h-3.5" /> 에이전트 전체 {agents.length} →
            </Link>
          )}
        </div>
      </div>

      {/* 모델별 사용량 팝업 (메인서 옮김·정보 손실 0) */}
      <DetailModal open={detail === 'models'} onClose={() => setDetail(null)} title="Model Usage" subtitle="모델별 토큰·비용" widthClass="max-w-3xl">
        {stats?.modelUsage && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Object.entries(stats.modelUsage).map(([model, usage]) => {
              const modelName = model.includes('opus') ? 'Opus 4.5' : model.includes('sonnet') ? 'Sonnet 4.5' : model;
              const totalTokens = usage.inputTokens + usage.outputTokens;
              return (
                <div key={model} className="p-4 bg-secondary border border-border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-foreground">{modelName}</span>
                    <span className="text-xs text-muted-foreground">${usage.costUSD?.toFixed(2) || '0.00'}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><span className="text-muted-foreground">Input:</span><span className="ml-1 text-foreground">{(usage.inputTokens / 1000).toFixed(0)}k</span></div>
                    <div><span className="text-muted-foreground">Output:</span><span className="ml-1 text-foreground">{(usage.outputTokens / 1000).toFixed(0)}k</span></div>
                    <div><span className="text-muted-foreground">Cache Read:</span><span className="ml-1 text-foreground">{(usage.cacheReadInputTokens / 1000000).toFixed(1)}M</span></div>
                    <div><span className="text-muted-foreground">Cache Create:</span><span className="ml-1 text-foreground">{(usage.cacheCreationInputTokens / 1000000).toFixed(1)}M</span></div>
                  </div>
                  <div className="mt-2 pt-2 border-t border-border text-xs text-muted-foreground">Total: {(totalTokens / 1000000).toFixed(2)}M tokens</div>
                </div>
              );
            })}
          </div>
        )}
      </DetailModal>

      {/* 시간대별 활동 팝업 */}
      <DetailModal open={detail === 'hours'} onClose={() => setDetail(null)} title="Activity by Hour" subtitle={`Total: ${hourData.hours.reduce((a, b) => a + b, 0)} sessions`} widthClass="max-w-2xl">
        <div className="flex items-end gap-1 h-24">
          {hourData.hours.map((count, hour) => {
            const height = (count / hourData.maxCount) * 100;
            return (
              <div key={hour} className="flex-1 flex flex-col items-center gap-1 group">
                <div className="relative w-full flex justify-center">
                  <div className="absolute -top-6 opacity-0 group-hover:opacity-100 transition-opacity bg-background border border-border px-1.5 py-0.5 text-[10px] whitespace-nowrap z-10 text-foreground">{hour}:00 - {count} sessions</div>
                  <div className={`w-full transition-all ${count > 0 ? 'bg-white' : 'bg-secondary'}`} style={{ height: `${Math.max(height, 4)}%`, minHeight: count > 0 ? '8px' : '4px' }} />
                </div>
                {hour % 6 === 0 && (<span className="text-[10px] text-muted-foreground">{hour}</span>)}
              </div>
            );
          })}
        </div>
        <div className="flex justify-between mt-1 text-[10px] text-muted-foreground">
          <span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>12 AM</span>
        </div>
      </DetailModal>

      {/* 최근 메시지 팝업 */}
      <DetailModal open={detail === 'messages'} onClose={() => setDetail(null)} title="Recent Messages" subtitle={`최근 ${recentHistory.length}건`} widthClass="max-w-2xl">
        <div className="space-y-3">
          {recentHistory.map((entry, index) => {
            const projectName = entry.project?.split('/').pop() || 'Unknown';
            const agent = entry.project ? findAgentForProject(entry.project) : null;
            const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            const date = new Date(entry.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return (
              <div key={`${entry.timestamp}-${index}`} className="p-3 bg-secondary border border-border">
                <div className="flex items-start gap-3">
                  <div className={`w-8 h-8 ${agent?.name?.toLowerCase() === 'bitwonka' ? 'bg-green-500/20' : 'bg-card'} flex items-center justify-center text-sm shrink-0`}>
                    {agent ? (agent.name?.toLowerCase() === 'bitwonka' ? '🐸' : (characterEmojis[agent.character || 'robot'] || '🤖')) : '💬'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {agent && (<span className="text-xs font-medium text-foreground">{agent.name || `Agent ${agent.id.slice(0, 6)}`}</span>)}
                      <span className="text-xs px-1.5 py-0.5 bg-white/10 text-muted-foreground">{projectName}</span>
                      <span className="text-xs text-muted-foreground ml-auto shrink-0">{date} {time}</span>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2">{entry.display}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </DetailModal>
    </div>
  );
}
