'use client';

/**
 * Phase 6-S — All Agents Panel (process-baseline first).
 *
 * Single-screen roster of every agent, split so the dashboard reads as a
 * PROCESS-based system:
 *   1) 프로세스 기준선 — the 10 canonical process agents (B안), shown by default.
 *   2) 레거시 / 자동실행 엔진 — UUID-keyed legacy agents (old Korean / codex+opus)
 *      that PM-tick & team-orchestration still reference by UUID. Kept for
 *      compatibility but collapsed out of the default execution list.
 *
 * This is a DISPLAY classification only — it never removes records or changes
 * runtime behaviour. Legacy agents reporting "running" with no backing process
 * (e.g. a cross-wired session id) are phantom/automation and are visually
 * separated from the active process baseline.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Bot, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { useElectronAgents } from '@/hooks/useElectron';
import ProviderBadge from '@/components/ProviderBadge';
import {
  lookupProcessDisplay,
  processShortName,
  isProcessBaselineAgent,
  isLegacyConfiguredAgent,
} from '@/lib/agentProcessDisplay';
import type { AgentStatus } from '@/types/agent';

const STATUS_META: Record<string, { ko: string; dot: string; chip: string }> = {
  running: { ko: '실행 중', dot: 'bg-green-500', chip: 'bg-green-500/15 text-green-400 border-green-500/30' },
  waiting: { ko: '입력 대기', dot: 'bg-yellow-500', chip: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
  completed: { ko: '완료', dot: 'bg-cyan-500', chip: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' },
  error: { ko: '오류', dot: 'bg-red-500', chip: 'bg-red-500/15 text-red-400 border-red-500/30' },
  idle: { ko: '대기', dot: 'bg-gray-400', chip: 'bg-muted text-muted-foreground border-border' },
};

const STATUS_ORDER: Record<string, number> = { running: 0, waiting: 1, error: 2, completed: 3, idle: 4 };

function firstLine(s: string | undefined, max = 90): string {
  if (!s) return '';
  const line = s.split('\n').map(t => t.trim()).find(Boolean) ?? '';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

function sortAgents(list: AgentStatus[]): AgentStatus[] {
  return [...list].sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 9;
    const sb = STATUS_ORDER[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    const pa = processShortName(a.id, a.name);
    const pb = processShortName(b.id, b.name);
    if (pa !== pb) return pa.localeCompare(pb);
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
}

function AgentCard({ agent, legacy }: { agent: AgentStatus; legacy: boolean }) {
  const disp = lookupProcessDisplay(agent.id) ?? lookupProcessDisplay(agent.name);
  const title = disp ? disp.processNameKo : (agent.name || agent.id);
  const meta = STATUS_META[agent.status] ?? STATUS_META.idle;
  const project = agent.projectPath ? agent.projectPath.split('/').pop() : '';
  const task = firstLine(agent.currentTask);

  return (
    <div className="p-2.5 bg-secondary border border-border rounded-md flex flex-col gap-1.5 hover:border-white/30 transition-all">
      <div className="flex items-center gap-1.5">
        <span className="relative flex h-2 w-2 shrink-0">
          {agent.status === 'running' && (
            <span className={`absolute inline-flex h-full w-full rounded-full ${meta.dot} opacity-75 animate-ping`} />
          )}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${meta.dot}`} />
        </span>
        <span className="font-medium text-xs truncate text-foreground flex-1" title={title}>{title}</span>
        {agent.provider && <ProviderBadge provider={agent.provider} className="!text-[9px] !px-1 !py-0" />}
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        <span className={`text-[9px] px-1.5 py-0.5 border rounded ${meta.chip}`}>{meta.ko}</span>
        <span className={`text-[9px] px-1.5 py-0.5 border rounded ${legacy ? 'bg-amber-500/10 text-amber-500 border-amber-500/30' : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'}`}>
          {legacy ? '레거시' : '프로세스'}
        </span>
        {project && <span className="text-[9px] text-muted-foreground truncate" title={agent.projectPath}>{project}</span>}
      </div>

      <div className="text-[9px] text-muted-foreground truncate" title={agent.id}>
        {legacy ? `${agent.name} · ${agent.id.slice(0, 8)}` : agent.id}
      </div>

      {task && <div className="text-[10px] text-muted-foreground line-clamp-2 leading-snug" title={agent.currentTask}>{task}</div>}
    </div>
  );
}

export default function AllAgentsPanel() {
  const { agents } = useElectronAgents();
  const [collapsed, setCollapsed] = useState(false);
  const [showLegacy, setShowLegacy] = useState(false);

  const { baseline, legacy, other } = useMemo(() => {
    const baseline: AgentStatus[] = [];
    const legacy: AgentStatus[] = [];
    const other: AgentStatus[] = [];
    for (const a of agents) {
      if (isProcessBaselineAgent(a.id)) baseline.push(a);
      else if (isLegacyConfiguredAgent(a.id)) legacy.push(a);
      else other.push(a);
    }
    return { baseline: sortAgents(baseline), legacy: sortAgents([...legacy, ...other]), other };
  }, [agents]);

  const baseCounts = useMemo(() => {
    const c = { running: 0, waiting: 0, idle: 0 };
    for (const a of baseline) {
      if (a.status === 'running') c.running++;
      else if (a.status === 'waiting') c.waiting++;
      else if (a.status === 'idle') c.idle++;
    }
    return c;
  }, [baseline]);

  const legacyRunning = legacy.filter(a => a.status === 'running' || a.status === 'waiting').length;

  return (
    <section aria-label="All Agents" className="border border-border bg-card/40 rounded-md p-3">
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => setCollapsed(v => !v)}
          className="flex items-center gap-1.5 text-sm font-semibold hover:text-foreground/80 cursor-pointer"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          <Bot className="w-4 h-4 text-muted-foreground" />
          전체 에이전트
        </button>
        <span className="text-[11px] text-muted-foreground">
          프로세스 기준선 {baseline.length} · <span className="text-green-400">{baseCounts.running} 실행</span> · <span className="text-yellow-400">{baseCounts.waiting} 대기입력</span> · {baseCounts.idle} 유휴 · 레거시 {legacy.length}
        </span>
        <Link href="/agents" className="ml-auto text-[11px] text-muted-foreground hover:text-foreground">/agents 열기 →</Link>
      </div>

      {!collapsed && (
        <>
          {/* 프로세스 기준선 — 기본 표시 */}
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-emerald-500/80">프로세스 기준선 (B안 · 기본 실행 대상)</div>
          {baseline.length === 0 ? (
            <p className="text-[11px] text-muted-foreground mb-3">프로세스 기준선 에이전트가 없습니다.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2 mb-3">
              {baseline.map(a => <AgentCard key={a.id} agent={a} legacy={false} />)}
            </div>
          )}

          {/* 레거시 / 자동실행 엔진 — 분리, 접힘 */}
          {legacy.length > 0 && (
            <div className="border-t border-border pt-2">
              <button
                onClick={() => setShowLegacy(v => !v)}
                className="flex items-center gap-1.5 text-[11px] text-amber-500 hover:text-amber-400 cursor-pointer"
              >
                {showLegacy ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                <AlertTriangle className="w-3.5 h-3.5" />
                레거시 / 자동실행 엔진 전용 ({legacy.length}) — 기본 실행 목록 제외
                {legacyRunning > 0 && <span className="text-muted-foreground">· {legacyRunning} 실행/대기(일부 phantom 가능)</span>}
              </button>
              {showLegacy && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2 mt-2">
                  {legacy.map(a => <AgentCard key={a.id} agent={a} legacy={true} />)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
