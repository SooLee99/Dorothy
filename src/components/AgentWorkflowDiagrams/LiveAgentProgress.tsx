'use client';

/**
 * Phase 6-AN+ — 에이전트별 "현재 수행 중인 단계"(라이브) + 실제 에이전트 소통 피드.
 *
 * 라이브 데이터(읽기 전용):
 *  - useDorothyAgentTerminalSnapshots: 11 기준선 에이전트의 status·현재 작업·최근 출력
 *  - useDorothyRecentAgentCommunication: 에이전트 간 실제 소통(위임/핸드오프/메시지)
 * 강제 dispatch/PTY input 없음. 표시 전용.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { Activity, MessagesSquare, TerminalSquare } from 'lucide-react';
import { useDorothyAgentTerminalSnapshots, useDorothyRecentAgentCommunication } from '@/hooks/useDorothyRuns';
import { AGENT_STATUS_KO } from '@/lib/koreanLabels';

const ROLE_GROUP: Record<string, string> = {
  backend: '개발', frontend: '개발',
  'intake-planner': '계획·검증', 'architect-plan': '계획·검증', orchestrator: '계획·검증',
  'plan-validator': '계획·검증', 'contract-agent': '계획·검증', 'database-agent': '계획·검증',
  'qa-reviewer': '계획·검증', 'security-reviewer': '계획·검증',
  'devops-reporter': '운영·보고',
};

function statusTone(s: string): string {
  if (s === 'running') return 'text-green-400';
  if (s === 'waiting') return 'text-amber-400';
  if (s === 'error') return 'text-rose-400';
  return 'text-muted-foreground';
}

function firstLine(s?: string): string {
  if (!s) return '';
  const l = s.split('\n').map(x => x.trim()).filter(Boolean)[0] ?? '';
  return l.length > 90 ? l.slice(0, 90) + '…' : l;
}

// 실제 "소통"으로 볼 의미있는 타입만(hook_event/diagnostic/rate_limit/resume 등 잡음 제외).
const MEANINGFUL_COMM = new Set(['handoff', 'comment', 'approval', 'workflow_update', 'artifact']);
const COMM_TYPE_KO: Record<string, string> = {
  handoff: '핸드오프', comment: '메시지', approval: '승인요청', workflow_update: '진행갱신', artifact: '산출물',
};
// 레거시 UUID → 프로세스 slug (team-orchestration 6-T 매핑)
const LEGACY_ID_MAP: Record<string, string> = {
  '484bb96c': 'orchestrator', 'e7eb7e08': 'backend', 'c8e4738f': 'frontend',
  'be6484d7': 'qa-reviewer', '86c94705': 'devops-reporter', '5e8303fc': 'plan-validator',
};
function readableAgent(id?: string): string {
  if (!id) return '시스템';
  const short = id.slice(0, 8);
  if (LEGACY_ID_MAP[short]) return LEGACY_ID_MAP[short];
  // 비-UUID(이미 slug)면 그대로, UUID면 짧게
  return /^[0-9a-f]{8}-/i.test(id) ? short : id;
}

export default function LiveAgentProgress() {
  const { snapshots } = useDorothyAgentTerminalSnapshots({ lines: 3 });
  const { events, dbUnavailable } = useDorothyRecentAgentCommunication({ limit: 200 });

  const liveCount = useMemo(() => snapshots.filter(s => s.status === 'running' || s.status === 'waiting').length, [snapshots]);

  // 의미있는 소통만 필터 + 최신 12개
  const commEvents = useMemo(
    () => events.filter(e => MEANINGFUL_COMM.has(e.type)).slice(0, 12),
    [events],
  );

  return (
    <div className="space-y-4 mb-5">
      {/* 현재 진행 상황 */}
      <section className="rounded-md border border-border bg-card p-3">
        <div className="flex items-center gap-2 mb-2">
          <Activity className="w-4 h-4 text-green-400" />
          <h2 className="text-sm font-semibold text-foreground">에이전트별 현재 진행 상황</h2>
          <span className="text-[11px] text-muted-foreground">실시간 · {liveCount}/{snapshots.length} 활동 중 · 읽기 전용</span>
          <Link href="/sessions" className="ml-auto inline-flex items-center gap-1 text-[11px] text-primary hover:underline"><TerminalSquare className="w-3 h-3" /> 터미널 보기</Link>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          {snapshots.map(s => {
            const live = s.status === 'running' || s.status === 'waiting';
            const step = firstLine(s.currentTask) || (live ? '작업 준비 중' : '현재 작업 없음');
            const out = firstLine(s.outputPreview);
            return (
              <div key={s.agentId} className="rounded border border-border bg-background/50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${live ? 'bg-green-400' : 'bg-muted-foreground/40'}`} />
                  <span className="text-xs font-medium text-foreground">{s.processName ?? s.agentId}</span>
                  <span className="text-[10px] px-1 rounded bg-secondary text-muted-foreground">{ROLE_GROUP[s.agentId] ?? '기타'}</span>
                  <span className={`text-[10px] ml-auto ${statusTone(s.status)}`}>{AGENT_STATUS_KO[s.status] ?? s.status}</span>
                </div>
                <p className="text-[11px] text-foreground/80 mt-1 line-clamp-2" title={s.currentTask}>↳ {step}</p>
                {out && <p className="text-[10px] text-muted-foreground mt-0.5 font-mono truncate" title={s.outputPreview}>{out}</p>}
              </div>
            );
          })}
          {snapshots.length === 0 && <p className="text-xs text-muted-foreground">라이브 에이전트 정보를 불러오는 중…</p>}
        </div>
      </section>

      {/* 실제 에이전트 소통 */}
      <section className="rounded-md border border-border bg-card p-3">
        <div className="flex items-center gap-2 mb-2">
          <MessagesSquare className="w-4 h-4 text-cyan-400" />
          <h2 className="text-sm font-semibold text-foreground">최근 에이전트 소통</h2>
          <span className="text-[11px] text-muted-foreground">핸드오프·메시지·승인·산출물 (실측, 시스템 로그 제외)</span>
        </div>
        {dbUnavailable ? (
          <p className="text-[11px] text-muted-foreground">소통 기록은 Electron 앱에서 표시됩니다(브라우저 제한).</p>
        ) : commEvents.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">최근 에이전트 간 소통(핸드오프·메시지·승인)이 없습니다. 오케스트레이터가 위임·인계를 시작하면 표시됩니다.</p>
        ) : (
          <ol className="space-y-1">
            {commEvents.map(e => (
              <li key={e.id} className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                <span className="font-mono text-foreground/70">{readableAgent(e.fromAgentId)}</span>
                <span className="opacity-50">→</span>
                <span className="font-mono text-foreground/70">{readableAgent(e.toAgentId)}</span>
                <span className="px-1 rounded bg-secondary text-[9px]">{COMM_TYPE_KO[e.type] ?? e.type}</span>
                <span className="truncate">{e.title}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
