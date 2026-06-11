'use client';

/**
 * Phase 6-J — Agent Operation Summary.
 *
 * Always-visible Command Center strip that answers "are my agents actually
 * working, and if not, why?" — independent of the Dashboard view mode
 * (Terminals / Board / 3D). Reads the registry, idle reasons, sessions, and
 * dispatch readiness; every chip links to the relevant screen.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { Bot, RefreshCw } from 'lucide-react';
import {
  useDorothyAgentDefinitions,
  useDorothyAgentIdleStatuses,
  useDorothySessions,
  useDorothyDispatchReadiness,
  useDorothyWarmupTargets,
} from '@/hooks/useDorothyRuns';
import { DISPATCH_BLOCKER_KO } from '@/lib/koreanLabels';
import { isProcessBaselineAgent, isLegacyConfiguredAgent } from '@/lib/agentProcessDisplay';

function Chip({ label, value, cls, href, title }: {
  label: string; value: number; cls: string; href: string; title?: string;
}) {
  return (
    <Link
      href={href}
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-0.5 border text-[11px] hover:opacity-90 ${cls}`}
    >
      {label}: <span className="tabular-nums">{value}</span>
    </Link>
  );
}

export default function AgentOperationSummary() {
  const { definitions, dbUnavailable } = useDorothyAgentDefinitions();
  const { statuses: idle } = useDorothyAgentIdleStatuses();
  const { sessions } = useDorothySessions({ active: true, limit: 200 });
  const { counts: readiness } = useDorothyDispatchReadiness();
  const { targets: warmupTargets } = useDorothyWarmupTargets();

  const warmup = useMemo(() => {
    const possible = warmupTargets.filter(t => t.canWarmup).length;
    const running = warmupTargets.filter(t => t.alreadyRunning).length;
    const blocked = warmupTargets.filter(t => !t.canWarmup && !t.alreadyRunning).length;
    return { possible, running, blocked, total: warmupTargets.length };
  }, [warmupTargets]);

  const def = useMemo(() => {
    const registered = definitions.filter(d => d.isRegistered).length;
    const liveLoaded = definitions.filter(d => d.isLiveLoaded).length;
    const spawnable = definitions.filter(d => d.isSpawnable).length;
    const reloadRequired = definitions.filter(d => d.isRegistered && !d.isLiveLoaded).length;
    // Phase 6-S — process baseline vs legacy split so the count strip reflects
    // the process-based roster, not a flat total mixing legacy UUID agents.
    const processBaseline = definitions.filter(d => isProcessBaselineAgent(d.id)).length;
    const legacy = definitions.filter(d => isLegacyConfiguredAgent(d.id)).length;
    return { registered, liveLoaded, spawnable, reloadRequired, processBaseline, legacy, total: definitions.length };
  }, [definitions]);

  const idleCounts = useMemo(() => {
    const c = { active: 0, idle: 0, blocked: 0, rateLimited: 0, waitingApproval: 0, waitingDependency: 0, noStep: 0 };
    for (const s of idle) {
      switch (s.reason) {
        case 'active': c.active++; break;
        case 'no_assigned_runstep': c.noStep++; break;
        case 'completed': case 'unknown': c.idle++; break;
        case 'blocked_by_runmode_policy': case 'orchestrator_autospawn_disabled': c.blocked++; break;
        case 'blocked_by_rate_limit': case 'auto_resume_dry_run': c.rateLimited++; break;
        case 'waiting_for_approval': c.waitingApproval++; break;
        case 'waiting_for_dependency': case 'waiting_for_handoff': case 'waiting_for_validation': c.waitingDependency++; break;
      }
    }
    return c;
  }, [idle]);

  const activeSessions = sessions.filter(s => !s.exitedAt).length;

  return (
    <section aria-label="Agent Operation Summary" className="border border-border bg-card/40 rounded-md p-3 mb-4">
      <div className="flex items-center gap-2 mb-2">
        <Bot className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">에이전트 운영 현황</h2>
        <span className="text-[11px] text-muted-foreground">
          프로세스 기준선 {def.processBaseline} · 레거시 {def.legacy} · {def.spawnable} 실행가능
        </span>
        <Link href="/agents" className="ml-auto text-[11px] text-muted-foreground hover:text-foreground">/agents 열기 →</Link>
      </div>

      {dbUnavailable && (
        <p className="text-[11px] text-yellow-500 mb-2">dorothy.db 사용 불가 — 파일+등록 스캔만 집계됩니다.</p>
      )}

      {/* Phase 6-Y — 시스템 런타임 / 자동 실행 상태. 이 화면이 렌더되는 동안
          Electron API(31415)는 정상(렌더러가 Electron이 서빙). half-state(API
          다운)는 wrapper watchdog가 자동 복구하며, 외부 점검은 check-dorothy-dashboard.sh. */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">시스템 런타임</span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 border text-[11px] bg-emerald-500/10 text-emerald-500 border-emerald-500/30">
          Electron API: 정상
        </span>
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 border text-[11px] ${dbUnavailable ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30' : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'}`}>
          DB: {dbUnavailable ? '미가용' : '정상'}
        </span>
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 border text-[11px] ${
          dbUnavailable
            ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
            : (Math.max(idleCounts.active, activeSessions) > 0 || readiness.ready > 0)
              ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
              : 'bg-muted text-muted-foreground border-border'
        }`}>
          자동 실행: {dbUnavailable ? '불안정' : (Math.max(idleCounts.active, activeSessions) > 0 || readiness.ready > 0) ? '활성' : '유휴'}
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 border text-[11px] bg-muted text-muted-foreground border-border" title="half-state(Next만 살아있고 Electron API 다운) 시 wrapper watchdog가 정리 후 자동 재시작합니다.">
          자동 복구: 활성
        </span>
      </div>

      {/* Registry / spawnable row */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">등록 상태</span>
        <Chip label="등록됨" value={def.registered} cls="bg-emerald-500/10 text-emerald-500 border-emerald-500/30" href="/agents" />
        <Chip label="라이브 로드됨" value={def.liveLoaded} cls="bg-cyan-500/10 text-cyan-500 border-cyan-500/30" href="/agents" />
        <Chip label="실행 가능" value={def.spawnable} cls="bg-emerald-500/10 text-emerald-500 border-emerald-500/30" href="/agents" />
        {def.reloadRequired > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 border text-[11px] bg-amber-500/10 text-amber-500 border-amber-500/30" title="Registered in agents.json but not yet in the live agent manager. Open /agents → Reload Live Agents.">
            <RefreshCw className="w-3 h-3" /> 재로드 필요: <span className="tabular-nums">{def.reloadRequired}</span>
          </span>
        )}
      </div>

      {/* Live operation row */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">실행 상태</span>
        <Chip label="실행 중" value={Math.max(idleCounts.active, activeSessions)} cls="bg-emerald-500/10 text-emerald-500 border-emerald-500/30" href="/sessions" title="Active agent sessions" />
        <Chip label="대기 중" value={idleCounts.idle + idleCounts.noStep} cls="bg-muted text-muted-foreground border-border" href="/agents" />
        <Chip label="차단됨" value={idleCounts.blocked} cls="bg-orange-500/10 text-orange-500 border-orange-500/30" href="/runs" />
        <Chip label="사용량 제한" value={idleCounts.rateLimited} cls="bg-rose-500/10 text-rose-500 border-rose-500/30" href="/usage" />
        <Chip label="승인 대기" value={idleCounts.waitingApproval} cls="bg-amber-500/10 text-amber-500 border-amber-500/30" href="/approvals" />
        <Chip label="의존성 대기" value={idleCounts.waitingDependency} cls="bg-blue-500/10 text-blue-500 border-blue-500/30" href="/runs" />
        <Chip label="할당 작업 없음" value={idleCounts.noStep} cls="bg-muted text-muted-foreground border-border" href="/runs" />
      </div>

      {/* Dispatch readiness row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">자동 실행 준비</span>
        <Chip label="실행 준비됨" value={readiness.ready} cls="bg-emerald-500/10 text-emerald-500 border-emerald-500/30" href="/runs" title="Pending steps ready to dispatch right now" />
        <Chip label="차단됨" value={readiness.blocked} cls="bg-orange-500/10 text-orange-500 border-orange-500/30" href="/runs" />
        {Object.entries(readiness.byReason).map(([reason, n]) => (
          <span key={reason} className="inline-flex items-center gap-1 px-2 py-0.5 border text-[11px] bg-muted text-muted-foreground border-border">
            {DISPATCH_BLOCKER_KO[reason as keyof typeof DISPATCH_BLOCKER_KO] ?? reason}: <span className="tabular-nums">{n as number}</span>
          </span>
        ))}
        {readiness.total === 0 && (
          <span className="text-[11px] text-muted-foreground">대기 중인 자동 실행 작업이 없습니다.</span>
        )}
      </div>

      {/* Phase 6-Q — warm-up row */}
      {warmup.total > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">Warm-up</span>
          <Chip label="Warm-up 가능" value={warmup.possible} cls="bg-emerald-500/10 text-emerald-500 border-emerald-500/30" href="/agents" />
          <Chip label="실행 중" value={warmup.running} cls="bg-cyan-500/10 text-cyan-500 border-cyan-500/30" href="/sessions" />
          <Chip label="제외" value={warmup.blocked} cls="bg-muted text-muted-foreground border-border" href="/agents" />
        </div>
      )}
    </section>
  );
}
