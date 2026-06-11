'use client';

/**
 * Phase 6-AL — 자동개발 관제 센터 (홈 상단 요약).
 * 사용자가 홈에서 바로 보는 것: 자동개발 상태 / 에이전트 상태 / 막힌 항목 / 프로젝트.
 * 내부 용어(PTY·endpoint·snapshot)는 노출하지 않고 쉬운 문구로만 표시.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, Bot, ShieldAlert, FolderKanban, TerminalSquare, PauseCircle, Clock } from 'lucide-react';
import { useDorothyPmTickStatus, useDorothyAgentTerminalSnapshots } from '@/hooks/useDorothyRuns';

interface ProviderLimit {
  codex: { limited: boolean; cooldownUntil: string | null };
  claude: { limited: boolean; cooldownUntil: string | null };
  safePause: { active: boolean; until: string | null; remainingMs: number | null };
}

function fmtRemaining(ms: number | null): string {
  if (ms == null || ms <= 0) return '곧';
  const m = Math.ceil(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `약 ${h}시간 ${m % 60}분 후` : `약 ${m}분 후`;
}

export default function ControlCenter() {
  const { latest, available } = useDorothyPmTickStatus();
  const { snapshots } = useDorothyAgentTerminalSnapshots({ lines: 2 });
  const [kanban, setKanban] = useState<{ ongoing: number; backlog: number; blocked: number }>({ ongoing: 0, backlog: 0, blocked: 0 });
  const [pls, setPls] = useState<ProviderLimit | null>(null);
  const [doneNotLive, setDoneNotLive] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/dorothy/kanban', { cache: 'no-store' });
        const j = await r.json();
        const tasks = Array.isArray(j) ? j : (j.tasks ?? []);
        if (!alive) return;
        setKanban({
          ongoing: tasks.filter((t: { column?: string }) => t.column === 'ongoing').length,
          backlog: tasks.filter((t: { column?: string }) => t.column === 'backlog').length,
          blocked: tasks.filter((t: { labels?: string[] }) => (t.labels || []).includes('approval-required') || (t.labels || []).includes('blocked')).length,
        });
      } catch { /* ignore */ }
      try {
        const r2 = await fetch('/api/dorothy/provider-limit-state', { cache: 'no-store' });
        if (alive) setPls(await r2.json());
      } catch { /* ignore */ }
      try {
        const r3 = await fetch('/api/dorothy/done-live-gate', { cache: 'no-store' });
        const j3 = await r3.json();
        if (alive) setDoneNotLive(j3.doneNotLive ?? 0);
      } catch { /* ignore */ }
    };
    load();
    const id = setInterval(load, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // 일시중지 사유 계산(사용 한도 / 안전 대기)
  const pause = useMemo(() => {
    if (!pls) return null;
    const cx = pls.codex?.limited, cl = pls.claude?.limited, sp = pls.safePause?.active;
    if (!cx && !cl && !sp) return null;
    let reason: string; let until: string | null; let remainingMs: number | null = null;
    if (sp) { reason = '모든 모델(Codex·Claude) 사용 한도'; until = pls.safePause.until; remainingMs = pls.safePause.remainingMs; }
    else if (cx && cl) { reason = 'Codex·Claude 사용 한도'; until = pls.codex.cooldownUntil || pls.claude.cooldownUntil; }
    else if (cx) { reason = 'Codex 사용 한도'; until = pls.codex.cooldownUntil; }
    else { reason = 'Claude 사용 한도'; until = pls.claude.cooldownUntil; }
    if (remainingMs == null && until) remainingMs = Math.max(0, new Date(until).getTime() - Date.now());
    return { reason, until, remainingMs };
  }, [pls]);

  const agentStats = useMemo(() => {
    let running = 0, waiting = 0, idle = 0, error = 0;
    for (const s of snapshots) {
      if (s.status === 'running') running++;
      else if (s.status === 'waiting') waiting++;
      else if (s.status === 'error') error++;
      else idle++;
    }
    return { running, waiting, idle, error };
  }, [snapshots]);

  // 자동개발 상태 한 줄
  const devState = useMemo(() => {
    if (pause) return { label: '일시중지 (사용 한도)', tone: 'text-amber-400', dot: 'bg-amber-400' };
    if (!available || !latest) return { label: '상태 확인 중', tone: 'text-muted-foreground', dot: 'bg-muted-foreground/40' };
    if (latest.kind === 'ERROR') return { label: '오류 발생', tone: 'text-rose-400', dot: 'bg-rose-400' };
    if (agentStats.running > 0) return { label: '정상 실행 중', tone: 'text-green-400', dot: 'bg-green-400' };
    if (latest.kind === 'SKIP') return { label: '작업 진행 중', tone: 'text-green-400', dot: 'bg-green-400' };
    return { label: '대기 중', tone: 'text-amber-400', dot: 'bg-amber-400' };
  }, [pause, available, latest, agentStats.running]);

  return (
    <>
    {/* 일시중지 사유 배너 — 왜 에이전트가 멈춰 있는지 한눈에 */}
    {pause && (
      <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 flex items-start gap-2">
        <PauseCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">자동개발 일시중지 — {pause.reason}</div>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            사용 한도에 도달해 새 작업을 시작하지 않고 안전 대기 중입니다. 한도가 회복되면 <b className="text-foreground">자동으로 다시 시작</b>됩니다.
            칸반 대기 <b className="text-foreground">{kanban.backlog}건</b>은 그때 순서대로 배정됩니다.
          </p>
          {pause.until && (
            <p className="text-[12px] text-amber-600 mt-0.5 inline-flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" /> 자동 재개 예정: {new Date(pause.until).toLocaleString()} ({fmtRemaining(pause.remainingMs)})
            </p>
          )}
        </div>
      </div>
    )}
    {/* done≠라이브 게이트: 완료됐다고 표시됐지만 실제 서비스 미반영(미커밋/서버 stale) */}
    {doneNotLive > 0 && (
      <div className="mb-3 rounded-md border border-orange-500/40 bg-orange-500/10 p-2.5 flex items-start gap-2">
        <ShieldAlert className="w-4 h-4 text-orange-500 shrink-0 mt-0.5" />
        <div className="text-[12px] text-foreground">
          <b>done이지만 라이브 미반영: {doneNotLive}건</b>
          <span className="text-muted-foreground"> — 완료 표시됐으나 코드가 미커밋이거나 서버가 재기동되지 않아 실제 서비스에 반영되지 않았습니다. (칸반에서 <span className="font-mono">라이브-미반영</span> 라벨로 확인 · 반영하려면 커밋 + 서버 재기동 필요)</span>
        </div>
      </div>
    )}
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
      {/* 자동개발 상태 */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1"><Activity className="w-3.5 h-3.5" /> 자동개발 상태</div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${devState.dot}`} />
          <span className={`text-base font-semibold ${devState.tone}`}>{devState.label}</span>
        </div>
        {latest && <p className="text-[10px] text-muted-foreground mt-1 truncate" title={latest.line}>최근: {latest.kind}</p>}
      </div>

      {/* 에이전트 상태 */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1"><Bot className="w-3.5 h-3.5" /> 에이전트</div>
        <div className="text-sm text-foreground">
          <span className="text-green-400 font-semibold">{agentStats.running}</span> 실행 ·{' '}
          <span className="text-amber-400">{agentStats.waiting}</span> 대기 ·{' '}
          <span className="text-muted-foreground">{agentStats.idle}</span> 유휴
        </div>
        <Link href="/sessions" className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline mt-1"><TerminalSquare className="w-3 h-3" /> 터미널 보기</Link>
      </div>

      {/* 현재 작업(프로젝트) */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1"><FolderKanban className="w-3.5 h-3.5" /> 작업</div>
        <div className="text-sm text-foreground">
          <span className="text-green-400 font-semibold">{kanban.ongoing}</span> 진행 ·{' '}
          <span className="text-muted-foreground">{kanban.backlog}</span> 대기
        </div>
        <Link href="/kanban" className="text-[10px] text-primary hover:underline mt-1 inline-block">칸반으로 →</Link>
      </div>

      {/* 막힌 항목 */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1"><ShieldAlert className="w-3.5 h-3.5" /> 막힘 / 승인 필요</div>
        <div className={`text-base font-semibold ${(kanban.blocked + agentStats.error) > 0 ? 'text-amber-400' : 'text-muted-foreground'}`}>
          {kanban.blocked + agentStats.error}건
        </div>
        <Link href="/approvals" className="text-[10px] text-primary hover:underline mt-1 inline-block">승인 대기로 →</Link>
      </div>
    </div>
    </>
  );
}
