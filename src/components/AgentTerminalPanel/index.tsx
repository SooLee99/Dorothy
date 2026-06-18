'use client';

/**
 * Phase 6-AE — Agent Terminal Panel (read-only PTY output attach).
 *
 * Attaches READ-ONLY to a live agent's real PTY output. The electron
 * agent-manager already owns the PTY + output buffer for agents started via
 * `/api/agents/:id/start` (which is how the MCP orchestrator / PM-tick run the
 * fleet), and broadcasts each chunk on the `agent:output` IPC event. This panel
 * renders the snapshot (from useElectronAgents' agent.output) and appends the
 * live stream — masked, ANSI-stripped, never interactive.
 *
 * Safety: input is DISABLED (inputEnabled=false), no start/stop/kill, no
 * dispatch. All lines pass through maskLine() so secrets/tokens never render.
 * Live stream is Electron-only (IPC); a browser-dev tab shows the snapshot it
 * already has plus an "Electron 앱에서만 실시간" note.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { TerminalSquare, RefreshCw, X, Lock, AlertCircle } from 'lucide-react';
import { useElectronAgents, isElectron } from '@/hooks/useElectron';
import { useDorothyAgentTerminalSnapshot } from '@/hooks/useDorothyRuns';
import { processDisplayName } from '@/lib/agentProcessDisplay';
import { hasTerminal, terminalLines, maskLine } from '@/lib/agentTerminalStatus';
import type { AgentStatus, AgentEvent } from '@/types/electron';

const MAX_LINES = 1000;

export default function AgentTerminalPanel({ agentId, onClose }: { agentId: string; onClose?: () => void }) {
  const { agents, refresh } = useElectronAgents();
  const agent = useMemo<AgentStatus | undefined>(() => agents.find(a => a.id === agentId), [agents, agentId]);
  const electron = isElectron();

  // Phase 6-AE — browser-dev fallback: the live PTY output buffer lives only in
  // the electron main process, so a browser tab polls the read-only, masked REST
  // snapshot (~3s). In Electron we use agent.output + the live IPC stream below.
  const { snapshot } = useDorothyAgentTerminalSnapshot(electron ? undefined : agentId, { lines: MAX_LINES });

  const live = electron ? (!!agent && hasTerminal(agent)) : !!snapshot?.streamAvailable;

  const [liveLines, setLiveLines] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Snapshot lines: Electron reads the in-memory output buffer; browser uses the
  // already-masked outputLines from the REST snapshot.
  const snapshotLines = useMemo(
    () => electron ? terminalLines(agent?.output, MAX_LINES) : (snapshot?.outputLines ?? []),
    [electron, agent?.output, snapshot?.outputLines],
  );

  // Live stream — Electron only. Append masked chunks for THIS agent.
  useEffect(() => {
    setLiveLines([]);
    if (!isElectron() || !window.electronAPI?.agent?.onOutput) return;
    const off = window.electronAPI.agent.onOutput((event: AgentEvent) => {
      if (!event || event.agentId !== agentId || typeof event.data !== 'string') return;
      const cleaned = event.data
        // eslint-disable-next-line no-control-regex
        .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g'), '')
        .replace(/\r/g, '')
        .split('\n')
        .map(l => maskLine(l))
        .filter(l => l.length > 0);
      if (cleaned.length === 0) return;
      setUpdatedAt(new Date().toLocaleTimeString());
      setLiveLines(prev => {
        const next = [...prev, ...cleaned];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    });
    return () => { try { off?.(); } catch { /* ignore */ } };
  }, [agentId]);

  const lines = useMemo(() => {
    const merged = [...snapshotLines, ...liveLines];
    return merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged;
  }, [snapshotLines, liveLines]);

  // Even when the PTY has exited (agent idle), show the retained output buffer as
  // "최근 출력" so the user can read the last session instead of a blank panel.
  const hasRecentOutput = !live && lines.length > 0;
  const showOutput = live || hasRecentOutput;

  // Auto-scroll to bottom on new lines.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const processName = processDisplayName(agentId, agent?.name);

  return (
    <div className="border border-border rounded-md bg-background overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/40">
        <TerminalSquare className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs font-semibold text-foreground">{processName}</span>
        <span className="text-[10px] text-muted-foreground font-mono">{agentId}</span>
        <span className={`text-[9px] px-1.5 py-0.5 border rounded ${live ? 'bg-green-500/15 text-green-400 border-green-500/30' : hasRecentOutput ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' : 'bg-muted text-muted-foreground border-border'}`}>
          {live ? '라이브' : hasRecentOutput ? '최근 출력' : '터미널 없음'}
        </span>
        <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 border border-border rounded bg-muted text-muted-foreground" title="MVP: 입력 비활성(읽기 전용)">
          <Lock className="w-2.5 h-2.5" /> 입력 비활성
        </span>
        <span className="ml-auto flex items-center gap-2">
          {updatedAt && <span className="text-[9px] text-muted-foreground">갱신 {updatedAt}</span>}
          <button onClick={() => { refresh(); setUpdatedAt(new Date().toLocaleTimeString()); }} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground cursor-pointer" title="스냅샷 새로고침(읽기 전용)">
            <RefreshCw className="w-3 h-3" />
          </button>
          {onClose && (
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer" title="닫기"><X className="w-3.5 h-3.5" /></button>
          )}
        </span>
      </div>

      {!electron && (
        <div className="px-3 py-1.5 text-[10px] text-amber-500 bg-amber-500/10 border-b border-border flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> 브라우저: 읽기 전용 스냅샷을 ~3초마다 폴링합니다(실시간 스트림은 Electron 앱).
        </div>
      )}

      {showOutput ? (
        <>
          {hasRecentOutput && (
            <div className="px-3 py-1 text-[10px] text-cyan-400 bg-cyan-500/10 border-b border-border">
              터미널이 종료/대기 상태입니다 — 마지막 세션의 출력(스냅샷)을 표시합니다. PM-tick 다음 주기에 다시 라이브로 전환됩니다.
            </div>
          )}
          <div ref={scrollRef} className="h-64 overflow-y-auto px-3 py-2 font-mono text-[10px] leading-snug text-foreground/90 bg-black/30">
            {lines.length === 0 ? (
              <p className="text-muted-foreground">출력 버퍼가 비어 있습니다(에이전트가 방금 시작했거나 출력 없음). 읽기 전용.</p>
            ) : (
              lines.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all">{l}</div>)
            )}
          </div>
        </>
      ) : (
        <div className="px-3 py-6 text-center text-muted-foreground">
          <p className="text-xs">현재 연결된 터미널이 없습니다.</p>
          <p className="text-[11px] mt-1">이 에이전트는 자동 실행 대기 중이며 아직 출력 기록이 없습니다. PM-tick 또는 RunStep 할당 시 터미널이 생성됩니다.</p>
        </div>
      )}

      <div className="px-3 py-1.5 border-t border-border text-[9px] text-muted-foreground bg-secondary/30">
        읽기 전용 출력(마스킹됨) · 입력/시작/중지/dispatch 없음 · 강제 실행 안 함
      </div>
    </div>
  );
}
