'use client';

/**
 * Phase 6-AT — 업무 프로세스 단계 추적.
 * 칸반/실행 업무가 현재 파이프라인의 어디를 거쳤는지 한눈에 보여준다.
 * 단계별 감사 이력은 저장되지 않으므로, 현재 담당 에이전트(assignedAgentId)를
 * 표준 파이프라인 순서에 매핑해 "거쳐온 단계 / 현재 단계 / 예정 단계"를 추정 표시한다.
 */

import { CheckCircle2, Circle, Loader2, Sparkles } from 'lucide-react';

const PIPELINE: { id: string; label: string }[] = [
  { id: 'intake-planner', label: '요구 정리' },
  { id: 'architect-plan', label: '설계' },
  { id: 'plan-validator', label: '검증' },
  { id: 'contract-agent', label: 'API 계약' },
  { id: 'database-agent', label: '데이터' },
  { id: 'backend', label: '백엔드' },
  { id: 'frontend', label: '프론트' },
  { id: 'qa-reviewer', label: 'QA' },
  { id: 'security-reviewer', label: '보안' },
  { id: 'devops-reporter', label: '운영/문서' },
];

/** 카드용 짧은 단계 표기: "3/10 검증" | "완료" | "조율" | null */
export function taskStageShort(assignedAgentId?: string | null, column?: string): string | null {
  if (column === 'done') return '완료';
  if (assignedAgentId === 'orchestrator') return '조율';
  const i = PIPELINE.findIndex(p => p.id === assignedAgentId);
  return i >= 0 ? `${i + 1}/${PIPELINE.length} ${PIPELINE[i].label}` : null;
}

interface StageEntry { at: string; agentId: string | null; column: string }

export function TaskProcessStage({ assignedAgentId, column, progress, stageHistory }: { assignedAgentId?: string | null; column: string; progress?: number; stageHistory?: StageEntry[] }) {
  const idx = PIPELINE.findIndex(p => p.id === assignedAgentId);
  const isOrch = assignedAgentId === 'orchestrator';
  const done = column === 'done';

  // 실제 이동 이력 기반 방문 단계(추정 아님). 마지막=현재 담당.
  const hist = Array.isArray(stageHistory) ? stageHistory : [];
  const visited = new Set(hist.map(h => h.agentId).filter((a): a is string => !!a));
  const hasHistory = hist.length > 0;
  // 이력에 담당 변경(에이전트가 바뀐 transition)이 2회 이상이면 "실제 이동" 있음
  const moves = hist.filter((h, i) => i === 0 ? h.agentId : h.agentId !== hist[i - 1].agentId);

  const summary = done ? '완료'
    : isOrch ? '오케스트레이터 조율 중'
    : idx >= 0 ? `${idx + 1}/${PIPELINE.length}단계 · ${PIPELINE[idx].label}`
    : '아직 배정 안 됨';

  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-foreground">진행 단계 (업무 프로세스)</span>
        <span className="text-[10px] text-muted-foreground">{summary}</span>
      </div>
      <div className="flex items-center gap-0.5 overflow-x-auto pb-1">
        {PIPELINE.map((p, i) => {
          // 실제 이력(stageHistory)이 있으면 방문 단계를 "거쳐옴"으로 표시(추정 아님).
          // 이력이 없으면 현재 담당 단계만 강조하고 나머지는 중립.
          const state = done ? 'done'
            : i === idx ? 'current'
            : (hasHistory && visited.has(p.id)) ? 'passed'
            : 'other';
          return (
            <div key={p.id} className="flex items-center shrink-0">
              <div className="flex flex-col items-center gap-0.5 w-[50px]">
                {(state === 'done' || state === 'passed') ? <CheckCircle2 className="w-4 h-4 text-green-500" />
                  : state === 'current' ? <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />
                  : <Circle className="w-4 h-4 text-muted-foreground/30" />}
                <span className={`text-[9px] text-center leading-tight ${state === 'current' ? 'text-cyan-400 font-semibold' : (state === 'done' || state === 'passed') ? 'text-green-600' : 'text-muted-foreground/50'}`}>{p.label}</span>
              </div>
              {i < PIPELINE.length - 1 && <div className={`h-0.5 w-2 ${done ? 'bg-green-500' : 'bg-border'}`} />}
            </div>
          );
        })}
      </div>
      {isOrch && (
        <p className="text-[10px] text-cyan-400 mt-1 inline-flex items-center gap-1"><Sparkles className="w-3 h-3" /> 오케스트레이터가 전 단계를 조율합니다.</p>
      )}
      {typeof progress === 'number' && progress > 0 && !done && (
        <div className="mt-1.5">
          <div className="h-1 bg-secondary rounded-full overflow-hidden"><div className="h-full bg-cyan-400" style={{ width: `${Math.min(100, progress)}%` }} /></div>
          <span className="text-[9px] text-muted-foreground">현재 단계 진행 {progress}%</span>
        </div>
      )}
      {/* 실제 이동 이력(2개 이상 담당을 거친 경우만 표시) */}
      {moves.length > 1 && (
        <div className="mt-2 border-t border-border/40 pt-1.5">
          <p className="text-[10px] font-semibold text-foreground mb-0.5">실제 이동 이력</p>
          <ol className="text-[9px] text-muted-foreground space-y-0.5">
            {moves.map((m, i) => (
              <li key={i} className="flex items-center gap-1">
                <span className="text-green-600">{m.agentId || '미배정'}</span>
                <span className="text-muted-foreground/60">{m.column}</span>
                <span className="text-muted-foreground/40">· {new Date(m.at).toLocaleString()}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="text-[9px] text-muted-foreground/70 mt-1.5">
        {hasHistory
          ? '※ 초록 ✓ = 실제로 거쳐간 담당(단계), 시안 = 현재 담당. PM-tick이 담당/컬럼 변화를 기록한 실데이터입니다(기록 시작 이후 이동만 반영).'
          : '※ 아직 이동 이력이 없습니다. 현재 담당 단계만 표시되며, 다음 틱부터 이동이 기록됩니다.'}
      </p>
    </div>
  );
}
