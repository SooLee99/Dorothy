'use client';

/**
 * Phase 6-Z — Agent Terminal Overview.
 *
 * Always-visible, single-screen view of "is any agent terminal actually live,
 * and if not, why?". The Dashboard's default Terminals view (TerminalsView)
 * only renders agents that are members of the active tab/project AND have a live
 * PTY — so when every process agent is idle (no PTY) it looks empty and
 * confusing. This panel reads the live agent-manager state directly and shows,
 * per agent: process name, status, whether it has a terminal/PTY, current task,
 * idle reason, and a masked output preview — plus a clear empty state with
 * navigation (never a forced dispatch).
 *
 * Data source: useElectronAgents() (live electron agent-manager agents, which
 * carry ptyId/output/status) + useDorothyAgentIdleStatuses() for the "why idle"
 * reason. Process-slug based (agentProcessDisplay), not legacy UUID. Pure
 * classification lives in src/lib/agentTerminalStatus.ts (unit-tested).
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { TerminalSquare, RefreshCw, AlertCircle } from 'lucide-react';
import { useElectronAgents } from '@/hooks/useElectron';
import { useDorothyAgentIdleStatuses } from '@/hooks/useDorothyRuns';
import { processDisplayName } from '@/lib/agentProcessDisplay';
import { IDLE_REASON_KO } from '@/lib/koreanLabels';
import { hasTerminal, outputPreview, summarizeTerminals } from '@/lib/agentTerminalStatus';
import type { AgentStatus } from '@/types/electron';
import type { AgentIdleReason } from '@/types/dorothy';

const STATUS_KO: Record<string, string> = {
  running: '실행 중', waiting: '입력 대기', idle: '대기', completed: '완료', error: '오류',
};
const STATUS_DOT: Record<string, string> = {
  running: 'bg-green-500', waiting: 'bg-yellow-500', idle: 'bg-gray-400', completed: 'bg-cyan-500', error: 'bg-red-500',
};

export default function AgentTerminalOverview() {
  const { agents } = useElectronAgents();
  const { byAgent } = useDorothyAgentIdleStatuses();

  const rows = useMemo(() => {
    return [...agents].sort((a, b) => {
      const rank = (x: AgentStatus) => (hasTerminal(x) ? 0 : x.currentTask ? 1 : 2);
      const d = rank(a) - rank(b);
      if (d !== 0) return d;
      return processDisplayName(a.id, a.name).localeCompare(processDisplayName(b.id, b.name));
    });
  }, [agents]);

  const summary = useMemo(() => summarizeTerminals(agents), [agents]);

  return (
    <section aria-label="Agent Terminal Overview" className="border border-border bg-card/40 rounded-md p-3">
      <div className="flex items-center gap-2 mb-2">
        <TerminalSquare className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Agent Terminal Overview</h2>
        <span className="text-[11px] text-muted-foreground">
          총 {summary.total} · <span className="text-green-400">{summary.terminal} 실행 터미널</span> · <span className="text-yellow-400">{summary.waiting} 작업 대기</span> · {summary.none} 터미널 없음 · 자동 실행: {summary.autoState}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Link href="/sessions" className="text-[11px] text-muted-foreground hover:text-foreground">Sessions</Link>
          <Link href="/runs" className="text-[11px] text-muted-foreground hover:text-foreground">Runs</Link>
          <Link href="/agents" className="text-[11px] text-muted-foreground hover:text-foreground">Agents</Link>
          <button
            onClick={() => { if (typeof window !== 'undefined') window.location.reload(); }}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
            title="새로고침(강제 실행 아님)"
          >
            <RefreshCw className="w-3 h-3" /> 새로고침
          </button>
        </span>
      </div>

      {/* Empty state — no live terminals */}
      {summary.terminal === 0 && (
        <div className="border border-dashed border-border rounded-md p-3 mb-2 bg-secondary/30">
          <p className="text-xs text-foreground flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 text-yellow-500" />
            현재 실행 중인 에이전트 터미널이 없습니다.
          </p>
          <ul className="mt-1.5 ml-5 list-disc text-[11px] text-muted-foreground space-y-0.5">
            <li>아직 할당된 RunStep이 없습니다.</li>
            <li>PM-tick이 다음 주기에서 orchestrator를 실행할 예정입니다.</li>
            <li>모든 에이전트가 대기 상태입니다.</li>
            <li>Electron API가 방금 복구되어 세션이 아직 재생성되지 않았을 수 있습니다.</li>
          </ul>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            확인: 위의 <strong className="text-foreground">에이전트 운영 현황</strong> ·{' '}
            <Link href="/sessions" className="text-primary hover:underline">/sessions</Link> ·{' '}
            <Link href="/runs" className="text-primary hover:underline">/runs</Link> · PM-tick 로그. (등록된 {summary.total}개 에이전트는 준비됨 — 자동 실행은 PM-tick/RunStep/Dispatch Readiness에 따라 시작됩니다.)
          </p>
        </div>
      )}

      {/* Per-agent rows */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-1.5">
        {rows.map(a => {
          const term = hasTerminal(a);
          const idle = byAgent.get(a.id);
          const reasonKo = idle ? (IDLE_REASON_KO[idle.reason as AgentIdleReason] ?? idle.reason) : '';
          const preview = term ? outputPreview(a.output) : '';
          const task = (a.currentTask || '').split('\n').map(s => s.trim()).find(Boolean) || '';
          return (
            <div key={a.id} className="flex items-start gap-2 p-2 border border-border rounded bg-secondary/40">
              <span className="relative flex h-2 w-2 mt-1 shrink-0">
                {a.status === 'running' && <span className={`absolute inline-flex h-full w-full rounded-full ${STATUS_DOT[a.status]} opacity-75 animate-ping`} />}
                <span className={`relative inline-flex h-2 w-2 rounded-full ${STATUS_DOT[a.status] ?? STATUS_DOT.idle}`} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-medium text-foreground truncate">{processDisplayName(a.id, a.name)}</span>
                  <span className="text-[9px] text-muted-foreground">{a.id}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 border rounded ${term ? 'bg-green-500/10 text-green-400 border-green-500/30' : 'bg-muted text-muted-foreground border-border'}`}>
                    터미널 {term ? '있음' : '없음'}
                  </span>
                  <span className="text-[9px] px-1.5 py-0.5 border border-border rounded bg-secondary text-muted-foreground">{STATUS_KO[a.status] ?? a.status}</span>
                </div>
                {task && <div className="text-[10px] text-muted-foreground line-clamp-1 mt-0.5" title={a.currentTask}>작업: {task}</div>}
                {!term && reasonKo && <div className="text-[10px] text-muted-foreground/80 mt-0.5">대기 이유: {reasonKo}</div>}
                {preview && <div className="text-[10px] text-muted-foreground/70 mt-0.5 font-mono line-clamp-1" title="출력 미리보기(마스킹됨)">{preview}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
