'use client';

/**
 * Phase 6-AG — always-on terminal surface for the Dashboard terminals area.
 *
 * The tab-based TerminalsView grid only renders live PTYs in the active tab, so
 * between PM-tick bursts it looks empty. This component instead always shows ONE
 * real agent terminal — the most relevant one (live → most-recent-with-output →
 * orchestrator) — via the read-only AgentTerminalPanel, so the user always sees
 * actual agent output here. Read-only; no start/dispatch.
 */

import { useMemo } from 'react';
import { useElectronAgents } from '@/hooks/useElectron';
import { pickTerminalAgentId } from '@/lib/agentTerminalStatus';
import AgentTerminalPanel from '@/components/AgentTerminalPanel';

export default function DashboardLiveTerminal() {
  const { agents } = useElectronAgents();
  const agentId = useMemo(() => pickTerminalAgentId(agents), [agents]);

  if (!agentId) {
    return (
      <div className="border border-dashed border-border rounded-md p-4 text-center text-muted-foreground text-xs">
        표시할 프로세스 에이전트가 없습니다.
      </div>
    );
  }

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
        현재/최근 에이전트 터미널 (읽기 전용 · 실행 중이면 라이브)
      </div>
      <AgentTerminalPanel agentId={agentId} />
    </div>
  );
}
