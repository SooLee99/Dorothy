'use client';

/**
 * 프로젝트 흐름 뷰 — "부엉이 누르면 프롬프트→분담→진행→테스트 한 흐름".
 *
 * 기능별 화면(칸반/에이전트/테스트)에 흩어진 걸 ★프로젝트 중심 4섹션으로 모은다.
 * 전부 실데이터(/api/dorothy: kanban·agent-activity·test-results). ★빈 곳은 정직히 "기록 없음"
 * (배정 미기록·리포트 없음·타임라인 희소·태스크↔테스트 링크 없음) — 가짜 0(false-completion 규율).
 * 상세 프롬프트는 DetailModal 재사용, "업무 추가"는 기존 NewTaskModal 재사용.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { FileText, Users, Activity, FlaskConical, Plus, AlertCircle, CheckCircle2, XCircle, Circle, CircleDot, GitCommit, MessageSquare, TerminalSquare } from 'lucide-react';
import { useStore } from '@/store';
import DetailModal from '@/components/DetailModal';
import { NewTaskModal } from '@/components/KanbanBoard/components/NewTaskModal';
import { useElectronKanban } from '@/hooks/useElectronKanban';
import StructuredPrompt from './StructuredPrompt';
import { promptSummary, promptSections } from '@/lib/parsePrompt';

type GroupKey = 'triplan' | 'bueongi';
const PROJECTS: { id: GroupKey; label: string; rootPath: string }[] = [
  { id: 'triplan', label: 'triplan (여행)', rootPath: '/Users/soo/workspace/source-code/triplan' },
  { id: 'bueongi', label: 'bueongi (부엉이·안심귀가)', rootPath: '/Users/soo/workspace/source-code/apps/bueongi' },
];

// 역할 슬러그 → 사람이 이해하는 한국어(⑤ 라이브 표시).
const ROLE_KO: Record<string, string> = {
  'approval-manager': '승인 관리', backend: '백엔드', frontend: '프론트엔드', ops: '운영',
  qa: 'QA·검증', 'qa-reviewer': 'QA 검토', 'architect-plan': '설계', 'intake-planner': '기획',
  orchestrator: '오케스트레이터', 'plan-validator': '계획 검증', 'contract-agent': '계약·API',
  'database-agent': 'DB', 'security-reviewer': '보안 검토', 'devops-reporter': '데브옵스·보고',
  'bueongi-backend': '백엔드', 'bueongi-dev': '개발',
};

// 칸반 projectGroupKey 와 동일한 키워드 정규화(raw 태그·경로·자유텍스트 → 프로젝트).
function flowGroupKey(hay: string): GroupKey | null {
  const h = (hay || '').toLowerCase();
  if (h.includes('triplan') || h.includes('soo-auth') || h.includes('travel-service')) return 'triplan';
  if (h.includes('bueongi') || h.includes('부엉') || h.includes('안심귀가') || h.includes('ansim') || h.includes('safe-return') || h.includes('frontend-src')) return 'bueongi';
  return null;
}

interface KanbanTask { id: string; title: string; description?: string; projectId?: string; projectPath?: string; column?: string; assignedAgentId?: string | null; requiredSkills?: string[]; priority?: string; }
interface ActAgent { agentId: string; roleId: string; name: string; status: string; projectId?: string; reports?: unknown[]; recentCommits?: unknown[]; outputTail?: string; currentTask?: string | null; statusLine?: string | null; lastActivity?: string | null; }

export default function ProjectFlowView() {
  const storeSelected = useStore((s) => s.selectedProject);
  const setSelectedProject = useStore((s) => s.setSelectedProject);
  const { createTask } = useElectronKanban();

  const initial: GroupKey = (storeSelected && flowGroupKey(storeSelected)) || 'triplan';
  const [active, setActive] = useState<GroupKey>(initial);
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [agents, setAgents] = useState<ActAgent[]>([]);
  const [tests, setTests] = useState<{ ok?: boolean; runs?: unknown[]; repo?: string; error?: string } | null>(null);
  const [promptTask, setPromptTask] = useState<KanbanTask | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [loading, setLoading] = useState(true);
  // 가독성 — 상태 필터 + 더보기(카드 많을 때).
  const [statusFilter, setStatusFilter] = useState<'all' | 0 | 1 | 2>('all');
  const [visible, setVisible] = useState(6);
  // ⑤ 라이브 — team-loop-state(지금 도는 역할). agent-activity status 보다 fresh.
  const [live, setLive] = useState<Record<string, { running?: boolean; paused?: boolean; currentRole?: string | null; pass?: string | null; status?: string | null }>>({});

  const load = useCallback(async (proj: GroupKey) => {
    setLoading(true);
    try {
      const [k, a, t] = await Promise.allSettled([
        fetch('/api/dorothy/kanban', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/dorothy/agent-activity', { cache: 'no-store' }).then((r) => r.json()),
        fetch(`/api/dorothy/test-results?project=${proj}`, { cache: 'no-store' }).then((r) => r.json()),
      ]);
      if (k.status === 'fulfilled') {
        const all: KanbanTask[] = Array.isArray(k.value) ? k.value : (k.value.tasks ?? []);
        setTasks(all);
      }
      if (a.status === 'fulfilled') setAgents(a.value.agents ?? []);
      if (t.status === 'fulfilled') setTests(t.value);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(active); }, [active, load]);

  // ⑤ 에이전트 동작 — 라이브 느낌으로 agent-activity + engine-live 5초 폴링(가벼움·관측 전용).
  useEffect(() => {
    let alive = true;
    const tick = () => {
      fetch('/api/dorothy/agent-activity', { cache: 'no-store' }).then((r) => r.json()).then((d) => { if (alive) setAgents(d.agents ?? []); }).catch(() => {});
      fetch('/api/dorothy/engine-live', { cache: 'no-store' }).then((r) => r.json()).then((d) => { if (alive) setLive(d ?? {}); }).catch(() => {});
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const selectProject = (p: GroupKey) => { setActive(p); setSelectedProject(p); };

  // 프로젝트별 필터(키워드 정규화로 견고하게).
  const projTasks = useMemo(
    () => tasks.filter((t) => flowGroupKey(`${t.projectId ?? ''} ${t.projectPath ?? ''} ${t.title ?? ''} ${t.description ?? ''}`) === active),
    [tasks, active],
  );
  // 역할 로스터 — agentId 중복 제거(같은 ops 가 여러 번 와도 1개). 중복 key 에러 방지.
  const projAgents = useMemo(() => {
    const seen = new Set<string>();
    return agents.filter((a) => a.projectId === active && a.agentId && !seen.has(a.agentId) && seen.add(a.agentId));
  }, [agents, active]);
  // ⑤ 동작 중(running/waiting) 에이전트만 — 꺼진 건 숨김(C1/모니터링 일관).
  const activeAgents = useMemo(() => projAgents.filter((a) => a.status === 'running' || a.status === 'waiting'), [projAgents]);

  // 상태 필터 + 더보기.
  const filteredTasks = useMemo(
    () => (statusFilter === 'all' ? projTasks : projTasks.filter((t) => stepOf(t.column) === statusFilter)),
    [projTasks, statusFilter],
  );
  const visibleTasks = filteredTasks.slice(0, visible);
  useEffect(() => { setVisible(6); }, [active, statusFilter]);

  const stepCounts = useMemo(() => { const c = [0, 0, 0]; projTasks.forEach((t) => { c[stepOf(t.column)]++; }); return c; }, [projTasks]);
  const [waitN, doingN, doneN] = stepCounts;
  const done = doneN; const ongoing = doingN;
  const assignedCount = projTasks.filter((t) => t.assignedAgentId).length;
  const totalReports = projAgents.reduce((s, a) => s + (a.reports?.length ?? 0), 0);
  const proj = PROJECTS.find((p) => p.id === active)!;

  return (
    <div className="space-y-4 pt-4 lg:pt-6 max-w-[1100px] mx-auto">
      {/* 헤더 + 프로젝트 선택 + 요약 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground">프로젝트 흐름</h1>
          <p className="text-muted-foreground text-xs mt-1">프롬프트 → 분담 → 진행 → 테스트를 프로젝트 중심으로</p>
        </div>
        <div className="flex gap-2">
          {PROJECTS.map((p) => (
            <button key={p.id} onClick={() => selectProject(p.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${active === p.id ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary text-muted-foreground border-border hover:text-foreground'}`}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* 한눈에 요약 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="태스크" value={`${projTasks.length}`} />
        <Kpi label="완료 / 진행중" value={`${done} / ${ongoing}`} />
        <Kpi label="참여 역할" value={`${projAgents.length}`} />
        <Kpi label="진행률" value={projTasks.length ? `${Math.round((done / projTasks.length) * 100)}%` : '—'} />
      </div>

      {loading && <p className="text-sm text-muted-foreground">불러오는 중…</p>}

      {/* ① 프롬프트 */}
      <Section icon={FileText} title="① 프롬프트 · 무엇을 시켰나" badge={`${projTasks.length}건`}
        action={<button onClick={() => setShowNewTask(true)} className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 border border-primary/30"><Plus className="w-3.5 h-3.5" /> 업무 추가</button>}>
        {/* 상태 필터(보고 싶은 것만) */}
        {projTasks.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {([['all', '전체', projTasks.length], [0, '대기', waitN], [1, '진행중', doingN], [2, '완료', doneN]] as const).map(([val, label, n]) => (
              <button key={label} onClick={() => setStatusFilter(val)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-full border transition-colors ${statusFilter === val ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary/60 text-muted-foreground border-border hover:text-foreground'}`}>
                {label} {n}
              </button>
            ))}
          </div>
        )}
        {projTasks.length === 0 ? (
          <Empty>이 프로젝트의 태스크가 없습니다.</Empty>
        ) : filteredTasks.length === 0 ? (
          <Empty>이 상태의 업무가 없습니다.</Empty>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {visibleTasks.map((t) => {
                const sections = promptSections(t.description ?? '');
                const summary = promptSummary(t.description ?? '');
                const step = stepOf(t.column);
                const stripe = step === 2 ? 'border-l-emerald-500' : step === 1 ? 'border-l-amber-500' : 'border-l-muted-foreground/30';
                return (
                  <button key={t.id} onClick={() => setPromptTask(t)} className={`text-left p-3 pl-3.5 rounded-xl border border-border/60 border-l-[3px] ${stripe} hover:border-primary/40 hover:bg-secondary/40 transition-colors flex flex-col gap-2`}>
                    <span className="text-[13px] font-semibold text-foreground line-clamp-2 leading-snug">{t.title}</span>
                    <StatusSteps column={t.column} />
                    {summary && <span className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">{summary}</span>}
                    {sections.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {sections.map((s) => <span key={s} className="text-[9px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{s}</span>)}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            {filteredTasks.length > visible && (
              <button onClick={() => setVisible((v) => v + 6)} className="w-full mt-2.5 py-2 text-xs font-medium text-primary hover:bg-primary/5 rounded-lg border border-border">
                더보기 ({filteredTasks.length - visible}건 남음)
              </button>
            )}
          </>
        )}
      </Section>

      {/* ② 업무 분담 — 정직: 태스크별 배정 기록 없음 */}
      <Section icon={Users} title="② 업무 분담 · 누가 맡나" badge={`역할 ${projAgents.length}`}>
        <Honest>
          태스크별 배정 기록 없음(assignedAgentId {assignedCount}/{projTasks.length}) — 아래는 이 프로젝트의 <b>역할 로스터</b>로 대체 표시.
        </Honest>
        {projAgents.length === 0 ? (
          <Empty>이 프로젝트에 등록된 역할이 없습니다.</Empty>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
            {projAgents.map((a, i) => (
              <div key={`${a.agentId}-${i}`} className="flex items-center gap-2 p-2 rounded-lg border border-border/60 text-xs">
                <span className="font-medium text-foreground truncate flex-1">{a.name}<span className="text-muted-foreground ml-1">· {a.roleId}</span></span>
                <span className="text-[10px] text-muted-foreground shrink-0">리포트 {a.reports?.length ?? 0}</span>
              </div>
            ))}
          </div>
        )}
        {totalReports === 0 && <Honest tone="warn">이 프로젝트의 에이전트 리포트가 0건입니다(작업 산출 기록 없음).</Honest>}
      </Section>

      {/* ③ 진행 — 정직: 타임라인 희소 */}
      <Section icon={Activity} title="③ 진행 · 어떻게 되고 있나" badge={`${done}/${projTasks.length} 완료`}>
        {projTasks.length === 0 ? <Empty>진행 데이터 없음.</Empty> : (
          <>
            <div className="flex h-2.5 rounded-full overflow-hidden bg-secondary mt-1">
              <div className="bg-emerald-500" style={{ width: `${(done / projTasks.length) * 100}%` }} />
              <div className="bg-amber-500" style={{ width: `${(ongoing / projTasks.length) * 100}%` }} />
            </div>
            <div className="flex gap-3 mt-2 text-[11px] text-muted-foreground">
              <span><span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1" />완료 {done}</span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-amber-500 mr-1" />진행중 {ongoing}</span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-secondary mr-1" />대기 {projTasks.length - done - ongoing}</span>
            </div>
          </>
        )}
        <Honest>세밀 실행 타임라인(runs/events)은 희소합니다 — 자세한 진행은 <Link href="/agent-activity" className="text-primary hover:underline">에이전트 활동</Link>·<Link href="/kanban" className="text-primary hover:underline">칸반</Link>에서.</Honest>
      </Section>

      {/* ④ 테스트 — 정직: 프로젝트 레벨만 */}
      <Section icon={FlaskConical} title="④ 테스트 · 검증됐나" badge={tests?.ok === undefined ? '—' : tests.ok ? '통과' : '실패'}>
        {!tests || tests.error ? (
          <Empty>테스트 결과를 불러오지 못했습니다{tests?.error ? `: ${tests.error}` : ''}.</Empty>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            {tests.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <XCircle className="w-4 h-4 text-rose-500" />}
            <span className="text-foreground">{tests.repo ?? proj.label}</span>
            <span className="text-muted-foreground text-xs">실행 {Array.isArray(tests.runs) ? tests.runs.length : 0}건</span>
            <Link href="/test-results" className="text-primary hover:underline text-xs ml-auto">전체 결과 →</Link>
          </div>
        )}
        <Honest>테스트는 <b>프로젝트 레벨</b>만 — 개별 태스크↔테스트 직접 링크는 아직 없음.</Honest>
      </Section>

      {/* ⑤ 에이전트 동작 — team-loop 라이브(지금 도는 역할) + 활성 터미널(관측 전용) */}
      <Section icon={TerminalSquare} title="⑤ 에이전트 동작 · 지금 일하는 모습"
        badge={live[active]?.running ? '동작 중' : live[active]?.paused ? '멈춤' : '대기'}
        action={<Link href="/monitoring" className="text-xs text-primary hover:underline">모니터링에서 제어 →</Link>}>
        {/* team-loop 라이브 역할(fresh 신호·agent-activity status 보다 정확) */}
        {live[active]?.running && live[active]?.currentRole && (
          <div className="flex items-center gap-2 p-2.5 mb-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            <span className="text-xs text-foreground">지금 작업 중인 역할: <b>{ROLE_KO[live[active]!.currentRole!] ?? live[active]!.currentRole}</b></span>
            {live[active]?.pass && <span className="text-[10px] text-muted-foreground ml-auto">사이클 {live[active]!.pass}</span>}
          </div>
        )}
        {live[active]?.paused && (
          <Honest tone="warn">이 프로젝트 team-loop 이 멈춰 있습니다. 대시보드 상단 <b>[전체 재개]</b> 또는 모니터링에서 켜세요.</Honest>
        )}
        {/* 실제 작업 출력 — currentRole(없으면 가장 최근 역할) 의 team-loop 로그 tail(진짜 터미널 출력) */}
        <AgentLogTail project={active} role={live[active]?.currentRole ?? ''} />
        {!live[active]?.running && !live[active]?.paused && (
          <Honest>team-loop 사이클 사이/대기 중일 수 있습니다 — 위는 가장 최근 작업한 역할의 실제 출력입니다.</Honest>
        )}
        {activeAgents.length === 0 ? (
          <>
            {!live[active]?.running && <Empty>실시간으로 잡히는 활성 에이전트 터미널이 없습니다{live[active]?.running ? '' : ' (team-loop 사이클 사이거나 엔진 대기 중)'}.</Empty>}
            <Honest>에이전트 출력은 사이클 중 갱신됩니다(5초). 실시간 전체 터미널·제어는 <Link href="/monitoring" className="text-primary hover:underline">모니터링</Link>에서 (흐름 뷰는 관측 전용).</Honest>
          </>
        ) : (
          <div className="space-y-2.5">
            {activeAgents.map((a) => (
              <div key={`${a.projectId}-${a.agentId}`} className="rounded-xl border border-border overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-secondary/50 border-b border-border">
                  <span className={`w-2 h-2 rounded-full ${a.status === 'running' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                  <span className="text-xs font-semibold text-foreground">{a.name}</span>
                  <span className="text-[10px] text-muted-foreground">· {a.roleId}</span>
                  <span className="text-[10px] text-muted-foreground ml-auto">{a.status === 'running' ? '실행 중' : '입력 대기'}</span>
                </div>
                {a.currentTask && <div className="px-3 py-1 text-[11px] text-muted-foreground border-b border-border/50 truncate">현재: {a.currentTask}</div>}
                <pre className="text-[10.5px] leading-relaxed font-mono text-foreground/85 bg-background p-2.5 max-h-44 overflow-auto whitespace-pre-wrap break-words">{(a.outputTail || '(출력 없음)').slice(-1200)}</pre>
              </div>
            ))}
            <Honest>실시간 전체 터미널·제어(켜고 끄기)는 <Link href="/monitoring" className="text-primary hover:underline">모니터링</Link>에서 (흐름 뷰는 관측 전용·5초 갱신).</Honest>
          </div>
        )}
      </Section>

      {/* 상세 프롬프트 팝업(재사용 DetailModal) */}
      <DetailModal open={!!promptTask} onClose={() => setPromptTask(null)} title={promptTask?.title ?? ''} subtitle={`${active} · ${promptTask?.column ?? ''}`} widthClass="max-w-2xl">
        {promptTask && (
          <div className="space-y-4">
            {/* 진행 단계 */}
            <StatusSteps column={promptTask.column} />
            {promptTask.requiredSkills && promptTask.requiredSkills.length > 0 && (
              <div className="flex flex-wrap gap-1">{promptTask.requiredSkills.map((s) => <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{s}</span>)}</div>
            )}
            {/* 구조화 프롬프트(날것 X) */}
            <div className="border-t border-border pt-3"><StructuredPrompt body={promptTask.description ?? ''} /></div>
            {/* 업무별 타임라인(있으면·없으면 정직) */}
            <div className="border-t border-border pt-3"><TaskTimeline taskId={promptTask.id} /></div>
          </div>
        )}
      </DetailModal>

      {/* 업무 추가(재사용 NewTaskModal·이 프로젝트 자동 선택) */}
      {showNewTask && (
        <NewTaskModal
          initialProjectPath={proj.rootPath}
          onClose={() => setShowNewTask(false)}
          onCreate={async (data) => { await createTask(data); setShowNewTask(false); load(active); }}
        />
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border rounded-xl p-3 bg-card">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  );
}

function Section({ icon: Icon, title, badge, action, children }: { icon: React.ComponentType<{ className?: string }>; title: string; badge?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-xl p-4 bg-card">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Icon className="w-4 h-4 text-primary" /> {title}
          {badge && <span className="text-[11px] font-normal text-muted-foreground">({badge})</span>}
        </h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground py-2">{children}</p>;
}

// 업무 진행 단계: 대기 → 진행 → 완료 (column 으로 현재 단계 판정).
function stepOf(column?: string): 0 | 1 | 2 {
  const c = (column || '').toLowerCase();
  if (c === 'done' || c === 'completed') return 2;
  if (c === 'ongoing' || c === 'in_progress' || c === 'doing' || c === 'review') return 1;
  return 0;
}
function StatusSteps({ column }: { column?: string }) {
  const cur = stepOf(column);
  const steps = ['대기', '진행', '완료'];
  return (
    <div className="flex items-center gap-1">
      {steps.map((label, i) => (
        <span key={label} className="flex items-center gap-1">
          {i < cur ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            : i === cur ? <CircleDot className="w-3.5 h-3.5 text-amber-500" />
            : <Circle className="w-3.5 h-3.5 text-muted-foreground/40" />}
          <span className={`text-[10px] ${i === cur ? 'text-foreground font-medium' : i < cur ? 'text-emerald-600' : 'text-muted-foreground/50'}`}>{label}</span>
          {i < steps.length - 1 && <span className={`w-4 h-px ${i < cur ? 'bg-emerald-500/50' : 'bg-border'}`} />}
        </span>
      ))}
    </div>
  );
}

// ⑤ 실제 작업 출력 — currentRole 의 team-loop 로그 tail(진짜 터미널 출력·5초 폴링·읽기 전용).
function AgentLogTail({ project, role }: { project: string; role: string }) {
  const [tail, setTail] = useState<string | null>(null);
  const [shownRole, setShownRole] = useState(role);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = () => fetch(`/api/dorothy/agent-log?project=${encodeURIComponent(project)}&role=${encodeURIComponent(role)}`, { cache: 'no-store' })
      .then((r) => r.json()).then((d) => { if (!alive) return; setTail(d.tail ?? ''); setShownRole(d.role || role); setMissing(!!d.missing); }).catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [project, role]);

  if (tail === null) return <p className="text-[11px] text-muted-foreground mt-2">출력 불러오는 중…</p>;
  if (missing || !tail.trim()) {
    return <Honest>아직 실제 출력 로그가 없습니다 (team-loop 사이클 시작 전이거나 이 프로젝트 로그 없음).</Honest>;
  }
  const roleLabel = ROLE_KO[shownRole] ?? shownRole;
  // 너무 긴 JSON 한 줄은 잘라 가독성 유지(원문 보존·표시만 클램프).
  const lines = tail.split('\n').filter((l) => l.trim()).slice(-40).map((l) => (l.length > 400 ? l.slice(0, 400) + '…' : l));
  return (
    <div className="mt-2 rounded-xl border border-border overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-secondary/50 border-b border-border">
        <TerminalSquare className="w-3.5 h-3.5 text-emerald-500" />
        <span className="text-[11px] font-medium text-foreground">{roleLabel} 실제 출력</span>
        <span className="text-[10px] text-muted-foreground ml-auto">team-loop 로그 · 5초 갱신</span>
      </div>
      <pre className="text-[10.5px] leading-relaxed font-mono text-foreground/85 bg-background p-2.5 max-h-56 overflow-auto whitespace-pre-wrap break-words">{lines.join('\n')}</pre>
    </div>
  );
}

// 이벤트 타입 → 사람이 이해하는 한국어(기술 용어 X).
const EVENT_KO: Record<string, string> = {
  created: '업무 생성됨', claimed: '담당자 배정', assigned: '담당자 배정', started: '작업 시작',
  comment: '코멘트 남김', commented: '코멘트 남김', run_started: '실행 시작', run_completed: '실행 완료',
  completed: '완료됨', done: '완료됨', blocked: '막힘 발생', unblocked: '막힘 해제',
  moved: '단계 이동', status_changed: '상태 변경', archived: '보관됨', heartbeat: '진행 신호',
};
function eventKo(type?: string): string {
  if (!type) return '이벤트';
  return EVENT_KO[type] ?? type.replace(/_/g, ' ');
}
function fmtWhen(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  if (m < 1440) return `${Math.floor(m / 60)}시간 전`;
  return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

// 업무별 타임라인 — kanban-detail(hermes kanban show) events 를 ★시간순·사람 말로. 없으면 정직히 표기.
function TaskTimeline({ taskId }: { taskId: string }) {
  const [data, setData] = useState<{ runs?: unknown[]; events?: { type?: string; at?: string; created_at?: string }[]; comments?: unknown[]; error?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/dorothy/kanban-detail?taskId=${encodeURIComponent(taskId)}`, { cache: 'no-store' })
      .then((r) => r.json()).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData({ error: 'load' }); });
    return () => { alive = false; };
  }, [taskId]);

  const runs = data?.runs?.length ?? 0;
  const comments = data?.comments?.length ?? 0;
  const events = useMemo(() => {
    const ev = [...(data?.events ?? [])];
    ev.sort((a, b) => new Date(a.at ?? a.created_at ?? 0).getTime() - new Date(b.at ?? b.created_at ?? 0).getTime());
    return ev;
  }, [data]);

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-primary mb-2 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" /> 진행 타임라인</h4>
      {!data ? <p className="text-[11px] text-muted-foreground">불러오는 중…</p>
        : (runs === 0 && events.length === 0 && comments === 0) ? (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground/80"><AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" /> 아직 실행 기록이 없는 업무입니다 (진행 타임라인 없음).</p>
        ) : (
          <div>
            <div className="flex gap-3 text-[11px] text-muted-foreground mb-2">
              <span className="inline-flex items-center gap-1"><GitCommit className="w-3 h-3" /> 실행 {runs}회</span>
              <span className="inline-flex items-center gap-1"><MessageSquare className="w-3 h-3" /> 코멘트 {comments}개</span>
            </div>
            {/* 시간순 세로 타임라인 */}
            <ol className="relative border-l border-border ml-1.5 space-y-2.5">
              {events.slice(0, 15).map((e, i) => (
                <li key={i} className="ml-3 relative">
                  <span className="absolute -left-[1.05rem] top-1 w-2 h-2 rounded-full bg-primary/70 ring-2 ring-card" />
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12px] text-foreground">{eventKo(e.type)}</span>
                    <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{fmtWhen(e.at ?? e.created_at)}</span>
                  </div>
                </li>
              ))}
            </ol>
            {events.length > 15 && <p className="text-[10px] text-muted-foreground mt-2 ml-3">…외 {events.length - 15}건</p>}
          </div>
        )}
    </div>
  );
}

function Honest({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <p className={`flex items-start gap-1.5 text-[11px] mt-2 ${tone === 'warn' ? 'text-amber-600' : 'text-muted-foreground/80'}`}>
      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" /> <span>{children}</span>
    </p>
  );
}
