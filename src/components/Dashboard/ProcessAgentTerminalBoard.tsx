'use client';

/**
 * Phase 6-AA — Process Agent Terminal Board.
 *
 * ALWAYS renders one terminal slot per process-baseline agent (11), regardless
 * of whether a live PTY exists. Supersedes the PTY-only visibility so idle /
 * stopped agents never "disappear". Live PTY → live terminal + masked output
 * preview; no PTY → a waiting / none / failed / stale slot card.
 *
 * "Auto-setup" here means UI slot materialization only — it never starts the 11
 * agents as real Claude/Codex processes. Start/Warm-up is disabled (a future
 * confirm-required step), so this view costs zero tokens and never dispatches.
 *
 * Data: useElectronAgents (live ptyId/output/status) + useDorothyAgentIdleStatuses
 * (왜 idle) + useDorothyDispatchReadiness (차단 사유) merged onto the baseline by
 * buildTerminalSlots() (pure, unit-tested in src/lib/agentTerminalStatus.ts).
 */

import { useMemo, useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { TerminalSquare, RefreshCw, AlertCircle, Lock, Eye } from 'lucide-react';
import AgentTerminalPanel from '@/components/AgentTerminalPanel';
import { useElectronAgents } from '@/hooks/useElectron';
import { useDorothyAgentIdleStatuses, useDorothyDispatchReadiness } from '@/hooks/useDorothyRuns';
import { IDLE_REASON_KO, DISPATCH_BLOCKER_KO } from '@/lib/koreanLabels';
import { buildTerminalSlots, summarizeSlots, type TerminalSlotStatus, type ProcessAgentTerminalSlot } from '@/lib/agentTerminalStatus';
import { CORE_PROCESS_AGENT_IDS, AUXILIARY_AGENT_IDS } from '@/lib/agentProcessDisplay';
import type { AgentIdleReason, DispatchBlockerReason } from '@/types/dorothy';

const TERM_META: Record<TerminalSlotStatus, { ko: string; chip: string; dot: string }> = {
  live:    { ko: '라이브', chip: 'bg-green-500/15 text-green-400 border-green-500/30', dot: 'bg-green-500' },
  waiting: { ko: '작업 대기', chip: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30', dot: 'bg-yellow-500' },
  none:    { ko: '터미널 없음', chip: 'bg-muted text-muted-foreground border-border', dot: 'bg-gray-400' },
  failed:  { ko: '실패', chip: 'bg-red-500/15 text-red-400 border-red-500/30', dot: 'bg-red-500' },
  stale:   { ko: 'stale', chip: 'bg-orange-500/15 text-orange-400 border-orange-500/30', dot: 'bg-orange-500' },
};

const STATUS_KO: Record<string, string> = {
  running: '실행 중', waiting: '입력 대기', idle: '대기', completed: '완료', error: '오류', unknown: '미상',
};

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

function SlotCard({ slot, aux, onView, active }: { slot: ProcessAgentTerminalSlot; aux?: boolean; onView: (id: string) => void; active?: boolean }) {
  const meta = TERM_META[slot.terminalStatus];
  const task = (slot.currentTask || '').split('\n').map(s => s.trim()).find(Boolean) || '';
  return (
    <div className="p-2.5 border border-border rounded-md bg-secondary/40 flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="relative flex h-2 w-2 shrink-0">
          {slot.terminalStatus === 'live' && <span className={`absolute inline-flex h-full w-full rounded-full ${meta.dot} opacity-75 animate-ping`} />}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${meta.dot}`} />
        </span>
        <span className="text-xs font-medium text-foreground truncate flex-1" title={slot.role}>{slot.processName}</span>
        <span className={`text-[9px] px-1.5 py-0.5 border rounded ${aux ? 'bg-blue-500/10 text-blue-400 border-blue-500/30' : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'}`}>{aux ? '보조' : '프로세스'}</span>
        <span className={`text-[9px] px-1.5 py-0.5 border rounded ${meta.chip}`}>{meta.ko}</span>
      </div>
      <div className="flex items-center gap-1 flex-wrap text-[9px] text-muted-foreground">
        <span className="font-mono">{slot.agentId}</span>
        <span className="px-1.5 py-0.5 border border-border rounded bg-secondary">{STATUS_KO[slot.status] ?? slot.status}</span>
        <span className="px-1.5 py-0.5 border border-border rounded bg-secondary">PTY {slot.hasPty ? 'O' : 'X'}</span>
        {slot.lastActivity && <span>{timeAgo(slot.lastActivity)}</span>}
      </div>
      {task && <div className="text-[10px] text-muted-foreground line-clamp-1" title={slot.currentTask}>작업: {task}</div>}
      {slot.terminalStatus !== 'live' && (slot.dispatchBlocker || slot.idleReason) && (
        <div className="text-[10px] text-muted-foreground/80">
          {slot.dispatchBlocker ? `차단: ${slot.dispatchBlocker}` : `대기 이유: ${slot.idleReason}`}
        </div>
      )}
      {slot.outputPreview && (
        <div className="text-[10px] text-muted-foreground/70 font-mono line-clamp-1" title="출력 미리보기(마스킹됨)">{slot.outputPreview}</div>
      )}
      <div className="mt-0.5 flex items-center gap-1.5">
        <button
          onClick={() => onView(slot.agentId)}
          className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 border rounded cursor-pointer ${active ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'}`}
          title="실제 PTY 출력을 읽기 전용으로 봅니다(강제 실행 아님)"
        >
          <Eye className="w-2.5 h-2.5" /> 터미널 보기
        </button>
        <button
          disabled
          title="에이전트 실행/Warm-up은 별도 confirm 단계가 필요합니다(이번 단계 비활성). 자동 실행은 PM-tick→orchestrator 흐름이 담당."
          className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 border border-border rounded bg-muted text-muted-foreground cursor-not-allowed"
        >
          <Lock className="w-2.5 h-2.5" /> Start (confirm 필요)
        </button>
      </div>
    </div>
  );
}

export default function ProcessAgentTerminalBoard() {
  const { agents } = useElectronAgents();
  const { byAgent: idleByAgent } = useDorothyAgentIdleStatuses();
  const { readiness } = useDorothyDispatchReadiness();

  const { coreSlots, auxSlots } = useMemo(() => {
    const idleMap = new Map<string, string>();
    idleByAgent.forEach((v, k) => { idleMap.set(k, IDLE_REASON_KO[v.reason as AgentIdleReason] ?? v.reason); });
    const blockerMap = new Map<string, string>();
    for (const r of readiness) {
      if (!r.ready && r.reason) blockerMap.set(r.agentId, DISPATCH_BLOCKER_KO[r.reason as DispatchBlockerReason] ?? r.reason);
    }
    return {
      coreSlots: buildTerminalSlots({ agents, idleReasonByAgent: idleMap, dispatchBlockerByAgent: blockerMap, baseline: CORE_PROCESS_AGENT_IDS }),
      auxSlots: buildTerminalSlots({ agents, idleReasonByAgent: idleMap, dispatchBlockerByAgent: blockerMap, baseline: AUXILIARY_AGENT_IDS }),
    };
  }, [agents, idleByAgent, readiness]);

  const coreSummary = useMemo(() => summarizeSlots(coreSlots), [coreSlots]);
  const auxSummary = useMemo(() => summarizeSlots(auxSlots), [auxSlots]);
  const liveTotal = coreSummary.live + auxSummary.live;

  // Phase 6-AE — read-only terminal attach panel (toggle per agent).
  const [viewAgentId, setViewAgentId] = useState<string | null>(null);
  const onView = (id: string) => setViewAgentId(prev => (prev === id ? null : id));

  // Phase 6-AF — auto-open orchestrator's terminal when it becomes live (rising
  // edge), so the user sees the PM-tick cycle output without clicking. Does not
  // hijack a panel the user has open for a different agent.
  const orchestratorLive = useMemo(
    () => coreSlots.find(s => s.agentId === 'orchestrator')?.terminalStatus === 'live',
    [coreSlots],
  );
  const prevOrchLiveRef = useRef(false);
  useEffect(() => {
    if (orchestratorLive && !prevOrchLiveRef.current) {
      setViewAgentId(prev => (prev === null || prev === 'orchestrator' ? 'orchestrator' : prev));
    }
    prevOrchLiveRef.current = orchestratorLive;
  }, [orchestratorLive]);

  return (
    <section aria-label="Process Agent Terminal Board" className="border border-border bg-card/40 rounded-md p-3">
      <div className="flex items-center gap-2 mb-2">
        <TerminalSquare className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">프로세스 에이전트 터미널 보드</h2>
        <span className="text-[11px] text-muted-foreground">
          기본 {coreSummary.total} · 보조 {auxSummary.total} · <span className="text-green-400">{liveTotal} 라이브</span> · <span className="text-yellow-400">{coreSummary.waiting + auxSummary.waiting} 작업대기</span> · {coreSummary.none + auxSummary.none} 터미널없음
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Link href="/sessions" className="text-[11px] text-muted-foreground hover:text-foreground">Sessions</Link>
          <Link href="/runs" className="text-[11px] text-muted-foreground hover:text-foreground">Runs</Link>
          <button onClick={() => { if (typeof window !== 'undefined') window.location.reload(); }} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer" title="새로고침(강제 실행 아님)">
            <RefreshCw className="w-3 h-3" /> 새로고침
          </button>
        </span>
      </div>

      {liveTotal === 0 && (
        <div className="border border-dashed border-border rounded-md p-2.5 mb-2 bg-secondary/30">
          <p className="text-xs text-foreground flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 text-yellow-500" /> 터미널 대기 중
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">
            아직 실행 중인 AgentSession/PTY가 없습니다. 아래 기본 {coreSummary.total}개 슬롯은 항상 표시되며,
            자동 실행은 PM-tick → orchestrator → RunStep 흐름에서 시작됩니다. (이 화면은 강제 실행/dispatch를 하지 않습니다.)
          </p>
        </div>
      )}

      {/* 기본 프로세스 8개 — 항상 펼침 */}
      <div className="text-[10px] uppercase tracking-wider text-emerald-500/80 mb-1.5">기본 프로세스 {coreSummary.total}개</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
        {coreSlots.map(slot => <SlotCard key={slot.agentId} slot={slot} onView={onView} active={viewAgentId === slot.agentId} />)}
      </div>

      {/* 개발·검증 보조 에이전트 3개 — A안: 항상 표시 + 보조 배지 */}
      <div className="text-[10px] uppercase tracking-wider text-blue-400/80 mt-3 mb-1.5">개발·검증 보조 에이전트 {auxSummary.total}개</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
        {auxSlots.map(slot => <SlotCard key={slot.agentId} slot={slot} aux onView={onView} active={viewAgentId === slot.agentId} />)}
      </div>

      {/* Phase 6-AE — read-only PTY output panel for the selected agent */}
      {viewAgentId && (
        <div className="mt-3">
          <AgentTerminalPanel agentId={viewAgentId} onClose={() => setViewAgentId(null)} />
        </div>
      )}
    </section>
  );
}
