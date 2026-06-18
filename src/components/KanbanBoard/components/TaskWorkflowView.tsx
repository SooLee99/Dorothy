'use client';

/**
 * Phase 6-AT+ — 작업 워크플로우 상세(사용자 친화).
 * 칸반/실행기록의 작업을 클릭하면: (1) 파이프라인 어디까지 거쳤는지(스테퍼),
 * (2) 담당 에이전트가 지금 이 단계를 수행 중인지 라이브 상태로 연동해 보여준다.
 */

import { useEffect, useState } from 'react';
import { Activity, Bot, Loader2, CircleDot } from 'lucide-react';
import { TaskProcessStage } from './TaskProcessStage';

export interface WorkflowTask {
  title: string;
  description?: string;
  column: string;
  progress?: number;
  assignedAgentId?: string | null;
  labels?: string[];
  priority?: string;
  stageHistory?: { at: string; agentId: string | null; column: string }[];
}

interface LiveAgent {
  agentId: string; roleId: string; name: string; status: string;
  currentTask?: string; statusLine?: string; outputTail?: string; lastActivity?: string;
}

const STATUS_KO: Record<string, string> = {
  running: '실행 중', waiting: '입력 대기', idle: '유휴', completed: '완료', error: '오류', unknown: '확인 중',
};
const STATUS_TONE: Record<string, string> = {
  running: 'bg-green-500/15 text-green-500', waiting: 'bg-amber-500/15 text-amber-500',
  error: 'bg-rose-500/15 text-rose-400', idle: 'bg-secondary text-muted-foreground', unknown: 'bg-secondary text-muted-foreground',
};

function fmtAge(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || isNaN(ms)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  return `${Math.floor(m / 60)}시간 전`;
}

export function TaskWorkflowView({ task }: { task: WorkflowTask }) {
  const [agents, setAgents] = useState<LiveAgent[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/dorothy/agent-activity', { cache: 'no-store' });
        const j = await r.json();
        if (alive) { setAgents(j.agents ?? []); setLoaded(true); }
      } catch { if (alive) setLoaded(true); }
    };
    load();
    const id = setInterval(load, 10000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const owner = task.assignedAgentId
    ? agents.find(a => a.roleId === task.assignedAgentId || a.agentId === task.assignedAgentId)
    : undefined;
  const done = task.column === 'done';
  const ownerStatus = owner?.status || 'unknown';
  const activelyWorking = !done && ownerStatus === 'running';

  return (
    <div className="space-y-3">
      {/* 진행 단계 스테퍼 */}
      <TaskProcessStage assignedAgentId={task.assignedAgentId} column={task.column} progress={task.progress} stageHistory={task.stageHistory} />

      {/* 현재 수행 상황(라이브) */}
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-2">
          <Activity className="w-3.5 h-3.5 text-cyan-400" /> 현재 수행 상황
        </div>
        {done ? (
          <p className="text-[12px] text-green-600">✅ 이 작업은 완료(done) 처리되었습니다.</p>
        ) : !task.assignedAgentId ? (
          <p className="text-[12px] text-muted-foreground">아직 담당 에이전트가 배정되지 않았습니다. 오케스트레이터가 배정하면 여기에 진행 상황이 표시됩니다.</p>
        ) : !loaded ? (
          <p className="text-[12px] text-muted-foreground inline-flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> 라이브 상태 확인 중…</p>
        ) : owner ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <Bot className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium text-foreground">{owner.name || owner.roleId}</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_TONE[ownerStatus] ?? STATUS_TONE.unknown}`}>{STATUS_KO[ownerStatus] ?? ownerStatus}</span>
              {owner.lastActivity && <span className="text-[10px] text-muted-foreground">· {fmtAge(owner.lastActivity)}</span>}
            </div>
            <p className={`text-[12px] inline-flex items-center gap-1 ${activelyWorking ? 'text-green-600' : 'text-muted-foreground'}`}>
              <CircleDot className="w-3.5 h-3.5" />
              {activelyWorking
                ? '지금 이 단계를 수행 중입니다.'
                : ownerStatus === 'waiting'
                  ? '담당 에이전트가 입력/승인을 기다리고 있습니다.'
                  : '담당 에이전트가 현재 이 작업을 활발히 수행하고 있지 않습니다(유휴 또는 다른 작업).'}
            </p>
            {(owner.currentTask || owner.statusLine) && (
              <div className="text-[11px] text-muted-foreground">
                <span className="text-foreground/70">현재 작업:</span> {owner.currentTask || owner.statusLine}
              </div>
            )}
            {owner.outputTail && (
              <details className="text-[10px]">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">최근 터미널 출력</summary>
                <pre className="mt-1 bg-background border border-border rounded p-1.5 max-h-32 overflow-auto whitespace-pre-wrap">{owner.outputTail.slice(-700)}</pre>
              </details>
            )}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">담당: <b className="text-foreground">{task.assignedAgentId}</b> — 라이브 세션 정보를 찾지 못했습니다(미기동/레거시).</p>
        )}
      </div>
    </div>
  );
}
