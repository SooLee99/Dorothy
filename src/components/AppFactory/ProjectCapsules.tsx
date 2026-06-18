'use client';

/**
 * Phase 6-AK — App Factory Project Capsules (preview/plan only).
 *
 * Lets the user create an isolated Project Capsule from a candidate, view the
 * Kanban preview + agent work-distribution policy, and generate a read-only
 * Resume Brief. Execution buttons (Start Autonomous Build) are confirm-required
 * and do NOT scaffold / create tasks / dispatch in this phase.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, RefreshCw, Plus, PlayCircle, Pause, RotateCcw, ListChecks, ShieldAlert, Trash2, Pencil, Save, X } from 'lucide-react';
import type { AppCandidate } from '@/types/dorothy';
import type { AppProjectCapsule, CapsuleKanbanPreviewTask, ResumeBrief } from '@/types/appProjectCapsule';
import {
  buildCapsuleFromCandidate,
  generateKanbanPreview,
  AGENT_DISTRIBUTION_POLICY,
  WIP_LIMITS,
  normalizeProjectId,
  suggestProjectRootPath,
  suggestEnvNamespace,
  suggestVaultNamespace,
  suggestReportsPath,
  suggestLogsPath,
  suggestPorts,
  PROJECT_ID_RE,
  RESERVED_PORTS,
  PROJECT_AGENT_FLOW,
} from '@/lib/projectIsolation';
import { ProjectEnvNotes } from './ProjectEnvNotes';

const APP_TYPES = ['지도 기반 앱', '검색/조회 앱', '체크리스트 앱', '공공데이터 카드 앱', 'B2B 도구', '생활 편의 앱', '복지/공공서비스 앱'];
const PACKAGE_MANAGERS = ['mixed', 'pnpm', 'npm', 'yarn'];
// triplan과 동일한 기술 스택(백엔드 Kotlin/Spring/Gradle + 프론트 TypeScript/React)을 기본값으로.
const TRIPLAN_TECH_STACK = 'Kotlin\nSpring Boot\nGradle\nJPA / Hibernate\nPostgreSQL\nTypeScript\nReact\nVite\nVitest';
const lines = (v: string) => v.split('\n').map(s => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean);

interface WizardState {
  projectName: string; projectId: string; projectIdEdited: boolean; companyName: string; description: string;
  appType: string; targetUsers: string; coreProblem: string;
  mvpScope: string; outOfScope: string; techStack: string; executionChecklist: string;
  dataSources: string; apiUrl: string; apiKeyRequired: boolean; dataRisk: string;
  frontendRepoUrl: string;
  packageManager: string; frontendPort: number; backendPort: number;
  appCandidateId: string; confirm: boolean; autoFlow: boolean;
}
const blankWizard = (): WizardState => ({
  projectName: '', projectId: '', projectIdEdited: false, companyName: '', description: '',
  appType: APP_TYPES[0], targetUsers: '', coreProblem: '',
  mvpScope: '', techStack: TRIPLAN_TECH_STACK,
  outOfScope: '로그인\n결제\n네이티브 앱\n푸시 알림\n관리자 페이지\n실시간 사용자 리뷰',
  executionChecklist: 'projectId 확인\n독립 경로 확인\n포트 충돌 확인\nAPI 키 필요 여부 확인\nKanban Preview 확인\n위험 작업 승인 필요 여부 확인',
  dataSources: '', apiUrl: '', apiKeyRequired: false, dataRisk: '', frontendRepoUrl: '',
  packageManager: 'mixed', frontendPort: 0, backendPort: 0, appCandidateId: '', confirm: false, autoFlow: true,
});

const STATUS_CHIP: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground border-border',
  ready: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  active: 'bg-green-500/15 text-green-400 border-green-500/30',
  paused: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  completed: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  blocked: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
};

export default function ProjectCapsules({ candidates }: { candidates: AppCandidate[] }) {
  const [capsules, setCapsules] = useState<AppProjectCapsule[]>([]);
  const [autoRun, setAutoRunState] = useState(false);
  const [gh, setGh] = useState<{ owner: string | null; email: string | null; configured: boolean }>({ owner: null, email: null, configured: false });
  const [ghForm, setGhForm] = useState({ owner: '', email: '', token: '' });
  const [showGh, setShowGh] = useState(false);
  const [envOpenId, setEnvOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selCandidate, setSelCandidate] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; tasks: CapsuleKanbanPreviewTask[] } | null>(null);
  const [brief, setBrief] = useState<{ id: string; data: ResumeBrief } | null>(null);
  // Phase 6-AN — CRUD: 직접 생성 + 편집 + 삭제
  const [showCreateModal, setShowCreateModal] = useState(false);
  // Phase 6-AS — 생성 마법사
  const [wiz, setWiz] = useState<WizardState>(blankWizard());
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [matConfirm, setMatConfirm] = useState(false);
  const [matMsg, setMatMsg] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ projectName: string; frontendPort: number; backendPort: number; status: string; mvpScope: string; techStack: string; outOfScope: string; dataSourceNotes: string; executionChecklist: string }>({ projectName: '', frontendPort: 0, backendPort: 0, status: 'ready', mvpScope: '', techStack: '', outOfScope: '', dataSourceNotes: '', executionChecklist: '' });

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/dorothy/project-capsules', { cache: 'no-store' });
      const j = await r.json();
      setCapsules(j.capsules ?? []);
      setAutoRunState(j.autoRun === true);
      if (j.githubAccount) {
        setGh(j.githubAccount);
        setGhForm(f => ({ ...f, owner: j.githubAccount.owner ?? f.owner, email: j.githubAccount.email ?? f.email }));
      }
    } finally { setLoading(false); }
  }, []);

  const saveGithub = useCallback(async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/dorothy/project-capsules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setGithubAccount', owner: ghForm.owner.trim(), email: ghForm.email.trim(), token: ghForm.token }),
      });
      const j = await r.json();
      setGhForm(f => ({ ...f, token: '' })); // 토큰 입력칸 즉시 비움(화면에 남기지 않음)
      setMsg(j.ok ? `GitHub 계정 저장됨: ${j.owner ?? '-'}${j.configured ? ' (토큰 설정됨)' : ''}` : (j.error || '저장 실패'));
      await load();
    } finally { setBusy(false); }
  }, [ghForm, load]);

  const toggleAutoRun = useCallback(async (value: boolean) => {
    setBusy(true);
    try {
      await fetch('/api/dorothy/project-capsules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setAutoRun', value }),
      });
      await load();
    } finally { setBusy(false); }
  }, [load]);
  useEffect(() => { void load(); }, [load]);

  const candidateMap = useMemo(() => new Map(candidates.map(c => [c.id, c])), [candidates]);

  const updateStatus = useCallback(async (id: string, status: string) => {
    setBusy(true);
    try {
      await fetch('/api/dorothy/project-capsules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateStatus', id, status }),
      });
      await load();
    } finally { setBusy(false); }
  }, [load]);

  const startEdit = useCallback((c: AppProjectCapsule) => {
    setEditingId(c.id);
    setEditDraft({
      projectName: c.projectName, frontendPort: c.frontendPort ?? 0, backendPort: c.backendPort ?? 0,
      status: c.status, mvpScope: (c.mvpScope ?? []).join(', '),
      techStack: (c.techStack ?? []).join(', '), outOfScope: (c.outOfScope ?? []).join(', '),
      dataSourceNotes: (c.dataSourceNotes ?? []).join('\n'), executionChecklist: (c.executionChecklist ?? []).join('\n'),
    });
  }, []);

  const saveEdit = useCallback(async (id: string) => {
    setBusy(true); setMsg(null);
    try {
      const csv = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean);
      const lines = (v: string) => v.split('\n').map(s => s.trim()).filter(Boolean);
      const patch = {
        projectName: editDraft.projectName.trim(),
        frontendPort: Number(editDraft.frontendPort) || undefined,
        backendPort: Number(editDraft.backendPort) || undefined,
        status: editDraft.status,
        mvpScope: csv(editDraft.mvpScope),
        techStack: csv(editDraft.techStack),
        outOfScope: csv(editDraft.outOfScope),
        dataSourceNotes: lines(editDraft.dataSourceNotes),
        executionChecklist: lines(editDraft.executionChecklist),
      };
      const r = await fetch('/api/dorothy/project-capsules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id, patch }),
      });
      const j = await r.json();
      if (!j.ok) setMsg(j.error || '수정 실패');
      else { setEditingId(null); await load(); }
    } finally { setBusy(false); }
  }, [editDraft, load]);

  const deleteCapsule = useCallback(async (c: AppProjectCapsule) => {
    if (typeof window !== 'undefined' && !window.confirm(`"${c.projectName}" 준비 카드를 삭제할까요?\n(계획 카드만 삭제 — 실제 디렉터리/코드/Kanban은 건드리지 않습니다)`)) return;
    setBusy(true);
    try {
      await fetch('/api/dorothy/project-capsules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: c.id }),
      });
      if (editingId === c.id) setEditingId(null);
      await load();
    } finally { setBusy(false); }
  }, [editingId, load]);

  const showPreview = useCallback((c: AppProjectCapsule) => {
    setBrief(null);
    setMatConfirm(false);
    setMatMsg(null);
    setPreview({ id: c.id, tasks: generateKanbanPreview(c) });
  }, []);

  // Phase 6-AN — 실제 칸반 작업으로 생성(confirm 필수).
  const materialize = useCallback(async (c: AppProjectCapsule) => {
    if (!matConfirm) return;
    setBusy(true); setMatMsg(null);
    try {
      const r = await fetch('/api/dorothy/project-capsules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'materializeKanbanPreview', capsuleId: c.id, confirm: true }),
      });
      const j = await r.json();
      if (!j.ok) setMatMsg(j.error || '생성 실패');
      else { setMatMsg(`칸반에 ${j.created}개 작업 생성됨 (총 ${j.total}, 기존 작업 보존). /kanban에서 projectId=${c.projectId}로 확인`); await load(); }
    } finally { setBusy(false); }
  }, [matConfirm, load]);

  const resume = useCallback(async (c: AppProjectCapsule) => {
    setPreview(null);
    setBusy(true);
    try {
      const r = await fetch('/api/dorothy/project-resume-brief', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: c.projectId, projectName: c.projectName, rootPath: c.rootPath, status: c.status, reportsPath: c.reportsPath }),
      });
      const j = await r.json();
      if (j.ok) setBrief({ id: c.id, data: j.brief });
    } finally { setBusy(false); }
  }, []);

  // Phase 6-AS — 마법사: 파생 기본값(projectId 기준 자동 분리)
  const wizPid = wiz.projectId || normalizeProjectId(wiz.projectName);
  const wizDerived = useMemo(() => {
    const root = suggestProjectRootPath(wizPid);
    const ports = suggestPorts(wizPid);
    return {
      root, frontendPath: `${root}/frontend`, backendPath: `${root}/backend`,
      env: suggestEnvNamespace(wizPid), vault: suggestVaultNamespace(wizPid),
      reports: suggestReportsPath(wizPid), logs: suggestLogsPath(wizPid), ports,
    };
  }, [wizPid]);
  const wizFePort = wiz.frontendPort || wizDerived.ports.frontendPort;
  const wizBePort = wiz.backendPort || wizDerived.ports.backendPort;

  const wizErrors = useMemo(() => {
    const e: string[] = [];
    if (!wiz.projectName.trim()) e.push('프로젝트 이름을 입력하세요.');
    if (!wizPid) e.push('projectId를 입력하세요.');
    else if (!PROJECT_ID_RE.test(wizPid)) e.push('projectId는 영문 소문자, 숫자, 하이픈만 사용할 수 있습니다.');
    else if (capsules.some(c => c.projectId === wizPid)) e.push('이미 존재하는 projectId입니다.');
    if (!(wizFePort > 0 && wizBePort > 0)) e.push('포트 번호를 확인하세요.');
    return e;
  }, [wiz.projectName, wizPid, wizFePort, wizBePort, capsules]);

  const wizWarnings = useMemo(() => {
    const w: string[] = [];
    if (RESERVED_PORTS.includes(wizFePort) || RESERVED_PORTS.includes(wizBePort)) w.push('triplan 예약 포트(3000/3500/8080)와 겹칩니다. 다른 포트를 권장합니다.');
    if (capsules.some(c => [c.frontendPort, c.backendPort].includes(wizFePort) || [c.frontendPort, c.backendPort].includes(wizBePort))) w.push('다른 준비 카드와 포트가 겹칩니다.');
    if (lines(wiz.mvpScope).length === 0) w.push('MVP 기능을 1개 이상 입력하는 것을 권장합니다.');
    return w;
  }, [wizFePort, wizBePort, capsules, wiz.mvpScope]);

  const openWizard = useCallback(async () => {
    setWiz(blankWizard()); setSelCandidate(''); setMsg(null); setShowCreateModal(true);
    try {
      const r = await fetch('/api/dorothy/companies', { cache: 'no-store' });
      const j = await r.json();
      const list = (j.companies ?? []) as { id: string; name: string }[];
      setCompanies(list);
      if (list[0]) setWiz(w => ({ ...w, companyName: list[0].name }));
    } catch { /* ignore */ }
  }, []);

  const setWizName = useCallback((name: string) => {
    setWiz(w => ({ ...w, projectName: name, projectId: w.projectIdEdited ? w.projectId : normalizeProjectId(name) }));
  }, []);

  const fillFromCandidate = useCallback((candId: string) => {
    setSelCandidate(candId);
    const cand = candidateMap.get(candId);
    if (!cand) return;
    const tmp = buildCapsuleFromCandidate(cand, { id: 'tmp', now: new Date().toISOString(), status: 'draft' });
    setWiz(w => ({
      ...w, appCandidateId: candId,
      projectName: tmp.projectName, projectId: tmp.projectId, projectIdEdited: true,
      companyName: tmp.companyName,
      mvpScope: (tmp.mvpScope ?? []).join('\n'),
      techStack: (tmp.techStack ?? []).join('\n') || w.techStack,
      outOfScope: (tmp.outOfScope ?? []).join('\n') || w.outOfScope,
      frontendPort: tmp.frontendPort ?? 0, backendPort: tmp.backendPort ?? 0,
      packageManager: tmp.packageManager ?? 'pnpm',
    }));
  }, [candidateMap]);

  const saveWizard = useCallback(async () => {
    if (wizErrors.length > 0 || !wiz.confirm) return;
    setBusy(true); setMsg(null);
    try {
      const now = new Date().toISOString();
      const pid = wizPid;
      const capsule = {
        id: `cap-${pid}-${now.slice(0, 10)}`,
        appCandidateId: wiz.appCandidateId || undefined,
        projectId: pid, projectName: wiz.projectName.trim(),
        companyName: wiz.companyName.trim() || wiz.projectName.trim(),
        description: wiz.description.trim() || undefined,
        appType: wiz.appType, targetUsers: wiz.targetUsers.trim() || undefined,
        coreProblem: wiz.coreProblem.trim() || undefined,
        status: 'draft',
        rootPath: wizDerived.root, frontendPath: wizDerived.frontendPath, backendPath: wizDerived.backendPath,
        packageManager: wiz.packageManager, frontendPort: wizFePort, backendPort: wizBePort,
        envNamespace: wizDerived.env, vaultNamespace: wizDerived.vault,
        kanbanProjectId: pid, reportsPath: wizDerived.reports, logsPath: wizDerived.logs,
        mvpScope: lines(wiz.mvpScope), outOfScope: lines(wiz.outOfScope),
        techStack: lines(wiz.techStack), executionChecklist: lines(wiz.executionChecklist),
        dataSourceNotes: [...lines(wiz.dataSources), ...(wiz.apiUrl.trim() ? [`API: ${wiz.apiUrl.trim()}`] : []), ...(wiz.dataRisk.trim() ? [`리스크: ${wiz.dataRisk.trim()}`] : [])],
        apiKeyRequired: wiz.apiKeyRequired,
        frontendRepoUrl: wiz.frontendRepoUrl.trim() || undefined,
        riskPolicy: [], createdAt: now, updatedAt: now,
      };
      const r = await fetch('/api/dorothy/project-capsules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', capsule }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg(j.error || '생성 실패'); return; }
      // Phase 6-AV/AY — 자동 진행: 생성 → (scaffold: 디렉터리+git init+레포 clone) → 칸반 작업 생성.
      if (wiz.autoFlow) {
        const created = (j.capsules as { id: string; projectId: string }[] | undefined)?.find(c => c.projectId === pid);
        if (created) {
          let scaffoldNote = '';
          // 실제 실행 준비: 디렉터리/git/clone (confirm)
          const sr = await fetch('/api/dorothy/project-capsules', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'scaffold', capsuleId: created.id, confirm: true }),
          });
          const sj = await sr.json();
          scaffoldNote = sj.ok ? ` · 스캐폴드 ${sj.steps?.length ?? 0}단계(${sj.cloneFrontend && sj.cloneFrontend !== 'skip' ? '레포 clone 포함' : 'git init'})` : ` · 스캐폴드 실패: ${sj.error}`;
          // 칸반 워크플로우 생성
          const mr = await fetch('/api/dorothy/project-capsules', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'materializeKanbanPreview', capsuleId: created.id, confirm: true }),
          });
          const mj = await mr.json();
          setMsg(mj.ok
            ? `프로젝트 생성 완료${scaffoldNote} · 칸반 작업 ${mj.created}개 생성 — 프로젝트별 자동 틱이 워크플로우를 진행합니다`
            : `프로젝트/스캐폴드는 됨(${pid})${scaffoldNote}, 칸반 생성 실패: ${mj.error}`);
        } else {
          setMsg(`준비 카드 생성됨: ${pid} (자동 진행 대상 못 찾음 — 수동 진행)`);
        }
      } else {
        setMsg(`준비 카드 생성됨: ${pid} (실제 디렉터리/패키지/Kanban task 생성 안 함)`);
      }
      setShowCreateModal(false);
      await load();
    } finally { setBusy(false); }
  }, [wiz, wizErrors, wizPid, wizDerived, wizFePort, wizBePort, load]);

  const confirmBuild = useCallback((c: AppProjectCapsule) => {
    // Phase 6-AK: 실제 실행은 다음 Phase(6-AL) confirm 게이트. 여기선 안내만.
    setMsg(`"${c.projectName}" 자동 빌드는 다음 단계(6-AL)에서 confirm 후 실행됩니다. 지금은 scaffold/Kanban 생성/dispatch를 하지 않습니다.`);
  }, []);

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center gap-2">
        <Boxes className="w-5 h-5 text-cyan-400" />
        <h2 className="text-lg font-semibold text-foreground">프로젝트 준비 카드</h2>
        <span className="text-[11px] text-muted-foreground" title="독립 projectId·경로·env·vault·port·kanban">독립 프로젝트 — 계획/미리보기 전용(실제 생성 없음)</span>
        <button onClick={() => { setLoading(true); void load(); }} className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> 새로고침
        </button>
      </div>

      {/* 새 프로젝트 만들기 — 팝업 */}
      <div className="flex items-center gap-2">
        <button onClick={openWizard} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-foreground text-background rounded">
          <Plus className="w-4 h-4" /> 새 프로젝트 만들기
        </button>
        <button onClick={() => setShowGh(v => !v)} className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 border border-border rounded px-2 py-1" title="App Factory 프로젝트 전용 GitHub 계정(현재 gh와 다른 계정)">
          🔗 GitHub 계정 {gh.configured ? `(연결됨: ${gh.owner ?? ''})` : '(미설정)'}
        </button>
        <label className="inline-flex items-center gap-1.5 text-[11px] cursor-pointer ml-auto rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1" title="켜면 프로젝트별 자동 틱이 스캐폴드된 active 프로젝트의 에이전트를 실제로 실행합니다(비용 발생).">
          <input type="checkbox" checked={autoRun} disabled={busy} onChange={e => toggleAutoRun(e.target.checked)} />
          <span className={autoRun ? 'text-amber-600 font-semibold' : 'text-muted-foreground'}>프로젝트 자율 실행 {autoRun ? 'ON(실제 에이전트 가동·비용)' : 'OFF(계획만)'}</span>
        </label>
      </div>

      {/* Phase 6-BA — App Factory 전용 GitHub 계정(다른 계정). 토큰은 화면에 표시되지 않음. */}
      {showGh && (
        <div className="rounded-md border border-border bg-card p-3 space-y-2">
          <div className="text-xs font-semibold text-foreground">GitHub 계정 (App Factory 전용 — 현재 gh와 다른 계정 가능)</div>
          <p className="text-[10px] text-muted-foreground">이 계정으로 새 프로젝트의 clone·commit·push 등 모든 git 작업을 수행합니다. 토큰은 0600 권한으로 저장되며 화면/로그에 다시 표시되지 않습니다. (triplan 레포는 영향 없음)</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="text-[11px] text-muted-foreground">GitHub 사용자명(owner)
              <input value={ghForm.owner} onChange={e => setGhForm({ ...ghForm, owner: e.target.value })} placeholder="예: my-company-bot" className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded font-mono" />
            </label>
            <label className="text-[11px] text-muted-foreground">커밋 이메일
              <input value={ghForm.email} onChange={e => setGhForm({ ...ghForm, email: e.target.value })} placeholder="bot@example.com" className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded" />
            </label>
            <label className="text-[11px] text-muted-foreground sm:col-span-2">Personal Access Token (repo 권한) {gh.configured && <span className="text-green-600">— 이미 설정됨(변경 시에만 입력)</span>}
              <input type="password" value={ghForm.token} onChange={e => setGhForm({ ...ghForm, token: e.target.value })} placeholder={gh.configured ? '••••••• (유지하려면 비워두세요)' : 'ghp_... (repo 스코프)'} autoComplete="off" className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded font-mono" />
            </label>
          </div>
          <div className="flex gap-2">
            <button onClick={saveGithub} disabled={busy} className="px-3 py-1.5 text-[11px] bg-foreground text-background rounded disabled:opacity-40">저장</button>
            <button onClick={() => setShowGh(false)} className="px-3 py-1.5 text-[11px] border border-border rounded text-muted-foreground">닫기</button>
          </div>
        </div>
      )}
      <div className="hidden">
      </div>
      {msg && <p className="text-[11px] text-cyan-400">{msg}</p>}

      {/* 생성 마법사 모달 (5개 섹션 한 화면) */}
      {showCreateModal && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setShowCreateModal(false)} />
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-2xl max-h-[88vh] overflow-y-auto bg-card border border-border rounded-lg shadow-xl p-5">
            <div className="flex items-center justify-between mb-3 sticky top-0 bg-card pb-2 -mt-1">
              <h3 className="text-base font-semibold text-foreground flex items-center gap-2"><Boxes className="w-4 h-4 text-cyan-400" /> 새 프로젝트 만들기 (준비 카드)</h3>
              <button onClick={() => setShowCreateModal(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>

            {/* 후보 빠른 채우기 */}
            <label className="block text-[11px] text-muted-foreground mb-1">앱 후보에서 채우기 (선택)</label>
            <select value={selCandidate} onChange={e => fillFromCandidate(e.target.value)} className="w-full px-3 py-2 text-sm bg-background border border-border rounded mb-3">
              <option value="">후보 선택 안 함(직접 입력)</option>
              {candidates.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>

            {/* A. 기본 정보 */}
            <div className="flex items-center gap-2 mt-1 mb-2 pb-1 border-b-2 border-cyan-500/30">
              <span className="w-5 h-5 rounded-md bg-cyan-500/15 text-cyan-500 text-[11px] font-bold flex items-center justify-center shrink-0">A</span>
              <span className="text-sm font-semibold text-foreground">기본 정보</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
              <label className="text-[11px] text-muted-foreground">프로젝트 이름 *
                <input value={wiz.projectName} onChange={e => setWizName(e.target.value)} placeholder="공중화장실 편의시설 찾기" className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded" />
              </label>
              <label className="text-[11px] text-muted-foreground">projectId * (영소문자/숫자/하이픈)
                <input value={wiz.projectId || (wiz.projectIdEdited ? '' : wizPid)} onChange={e => setWiz({ ...wiz, projectId: e.target.value, projectIdEdited: true })} placeholder="public-toilet-finder" className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded font-mono" />
              </label>
              <label className="text-[11px] text-muted-foreground">회사 선택
                <select
                  value={companies.some(c => c.name === wiz.companyName) ? wiz.companyName : '__custom__'}
                  onChange={e => { const v = e.target.value; setWiz({ ...wiz, companyName: v === '__custom__' ? '' : v }); }}
                  className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded">
                  {companies.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                  <option value="__custom__">기타(직접 입력)…</option>
                </select>
                {!companies.some(c => c.name === wiz.companyName) && (
                  <input value={wiz.companyName} onChange={e => setWiz({ ...wiz, companyName: e.target.value })} placeholder="새 회사명 직접 입력" className="mt-1 w-full px-2 py-1.5 text-sm bg-background border border-border rounded" />
                )}
              </label>
              <label className="text-[11px] text-muted-foreground">한 줄 설명
                <input value={wiz.description} onChange={e => setWiz({ ...wiz, description: e.target.value })} placeholder="위치 기반으로 공중화장실을 찾는 MVP" className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded" />
              </label>
            </div>

            {/* B. 앱 유형 / MVP 방향 */}
            <div className="flex items-center gap-2 mt-4 mb-2 pb-1 border-b-2 border-violet-500/30">
              <span className="w-5 h-5 rounded-md bg-violet-500/15 text-violet-500 text-[11px] font-bold flex items-center justify-center shrink-0">B</span>
              <span className="text-sm font-semibold text-foreground">앱 유형 / MVP 방향</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
              <label className="text-[11px] text-muted-foreground">앱 유형
                <select value={wiz.appType} onChange={e => setWiz({ ...wiz, appType: e.target.value })} className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded">
                  {APP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="text-[11px] text-muted-foreground">핵심 사용자
                <input value={wiz.targetUsers} onChange={e => setWiz({ ...wiz, targetUsers: e.target.value })} placeholder="외출 중 화장실이 급한 사람" className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded" />
              </label>
              <label className="text-[11px] text-muted-foreground sm:col-span-2">핵심 문제
                <input value={wiz.coreProblem} onChange={e => setWiz({ ...wiz, coreProblem: e.target.value })} placeholder="가까운 공중화장실을 빨리 못 찾음" className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded" />
              </label>
            </div>
            <label className="text-[11px] text-muted-foreground block mb-3">핵심 MVP 기능 (줄 단위, 1개 이상 권장)
              <textarea value={wiz.mvpScope} onChange={e => setWiz({ ...wiz, mvpScope: e.target.value })} rows={4} placeholder={'현재 위치 기반 검색\n필터\n상세 카드\n길찾기 링크\n데이터 출처 표시'} className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded resize-y" />
            </label>

            {/* C. 독립 실행 환경 — 에이전트 자동(입력 불필요) */}
            <div className="flex items-center gap-2 mt-4 mb-2 pb-1 border-b-2 border-emerald-500/30">
              <span className="w-5 h-5 rounded-md bg-emerald-500/15 text-emerald-500 text-[11px] font-bold flex items-center justify-center shrink-0">C</span>
              <span className="text-sm font-semibold text-foreground">독립 실행 환경</span>
              <span className="text-[10px] text-emerald-500">에이전트가 자동 설정</span>
            </div>
            <div className="text-[10px] text-muted-foreground space-y-0.5 mb-3 bg-secondary/30 rounded p-2">
              <div>경로·포트·env·vault·패키지매니저는 projectId 기준으로 <b className="text-foreground">자동 분리</b>되어 다른 프로젝트와 독립됩니다(입력 불필요).</div>
              <div className="font-mono text-muted-foreground/80">예: {wizDerived.root.replace('/Users/soo', '~')} · 포트 {wizDerived.ports.frontendPort}/{wizDerived.ports.backendPort} · {wizDerived.env}</div>
            </div>

            {/* D. 데이터 / API */}
            <div className="flex items-center gap-2 mt-4 mb-2 pb-1 border-b-2 border-amber-500/30">
              <span className="w-5 h-5 rounded-md bg-amber-500/15 text-amber-500 text-[11px] font-bold flex items-center justify-center shrink-0">D</span>
              <span className="text-sm font-semibold text-foreground">데이터 / API</span>
              <span className="text-[10px] text-muted-foreground">※ API 키 값은 입력하지 않음</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-1">
              <label className="text-[11px] text-muted-foreground sm:col-span-2">주요 데이터 출처 (줄 단위)
                <textarea value={wiz.dataSources} onChange={e => setWiz({ ...wiz, dataSources: e.target.value })} rows={2} placeholder={'전국공중화장실표준데이터'} className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded resize-y" />
              </label>
              <label className="text-[11px] text-muted-foreground">API URL
                <input value={wiz.apiUrl} onChange={e => setWiz({ ...wiz, apiUrl: e.target.value })} placeholder="https://www.data.go.kr/..." className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded" />
              </label>
              <label className="text-[11px] text-muted-foreground">데이터 최신성 리스크
                <input value={wiz.dataRisk} onChange={e => setWiz({ ...wiz, dataRisk: e.target.value })} placeholder="좌표/개방시간 정확도" className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded" />
              </label>
            </div>
            <label className="flex items-center gap-1.5 text-[11px] text-foreground mb-2 cursor-pointer">
              <input type="checkbox" checked={wiz.apiKeyRequired} onChange={e => setWiz({ ...wiz, apiKeyRequired: e.target.checked })} />
              API 키 필요 (※ 키 값은 저장하지 않음 — 나중에 Settings/Vault에서 연결)
            </label>
            <label className="text-[11px] text-muted-foreground block mb-3">프론트엔드 소스 GitHub 레포 (Figma AI → TypeScript)
              <input value={wiz.frontendRepoUrl} onChange={e => setWiz({ ...wiz, frontendRepoUrl: e.target.value })} placeholder="https://github.com/계정/레포 (Figma AI가 생성한 TS 프론트엔드)" className="mt-0.5 w-full px-2 py-1.5 text-sm bg-background border border-border rounded font-mono" />
              <span className="block text-[10px] text-muted-foreground mt-0.5">프론트엔드는 이 레포의 TypeScript 코드를 가져와 사용합니다. (URL만 저장, 자동 clone/실행 안 함)</span>
            </label>

            {/* E. 범위 설정 — 에이전트 자동(입력 불필요) */}
            <div className="flex items-center gap-2 mt-4 mb-2 pb-1 border-b-2 border-rose-500/30">
              <span className="w-5 h-5 rounded-md bg-rose-500/15 text-rose-500 text-[11px] font-bold flex items-center justify-center shrink-0">E</span>
              <span className="text-sm font-semibold text-foreground">범위 설정</span>
              <span className="text-[10px] text-rose-500">에이전트가 자동 진행</span>
            </div>
            <div className="text-[10px] text-muted-foreground mb-3 bg-secondary/30 rounded p-2">
              MVP 범위·제외 항목·실행 체크리스트·기술 스택(triplan 동일)은 <b className="text-foreground">intake-planner/architect 에이전트가 자동으로 정리</b>합니다(입력 불필요).
            </div>

            {/* F. 에이전트 업무 배분 (읽기 전용) */}
            <div className="flex items-center gap-2 mt-4 mb-2 pb-1 border-b-2 border-border">
              <span className="w-5 h-5 rounded-md bg-secondary text-muted-foreground text-[11px] font-bold flex items-center justify-center shrink-0">F</span>
              <span className="text-sm font-semibold text-foreground">담당 에이전트 흐름</span>
              <span className="text-[10px] text-muted-foreground">읽기 전용 · triplan 워크플로우 동일</span>
            </div>
            <div className="flex flex-wrap gap-1 mb-3">
              {PROJECT_AGENT_FLOW.map(a => (
                <span key={a.agentId} className="text-[10px] px-1.5 py-0.5 border border-border rounded bg-background text-muted-foreground font-mono" title={a.role}>{a.agentId}: {a.role}</span>
              ))}
            </div>

            {/* 확인 요약 */}
            <div className="rounded border border-border bg-secondary/30 p-2.5 mb-2">
              <p className="text-xs font-semibold text-foreground mb-1">확인</p>
              <div className="text-[10px] text-muted-foreground space-y-0.5">
                <div>{wiz.projectName || '(이름 없음)'} · <span className="font-mono">{wizPid}</span> · {wiz.appType}</div>
                <div className="font-mono">루트: {wizDerived.root.replace('/Users/soo', '~')} · 포트 {wizFePort}/{wizBePort}</div>
                <div className="font-mono">env: {wizDerived.env} · vault: {wizDerived.vault}</div>
                <div>MVP 기능 {lines(wiz.mvpScope).length}개 · 범위 외 {lines(wiz.outOfScope).length}개 · API 키 필요: {wiz.apiKeyRequired ? '예' : '아니오'}</div>
              </div>
            </div>
            {wizErrors.map((e, i) => <p key={i} className="text-[11px] text-rose-400">⚠ {e}</p>)}
            {wizWarnings.map((w, i) => <p key={i} className="text-[11px] text-amber-500">· {w}</p>)}

            {/* Phase 6-AV — 오케스트레이터 워크플로우 자동 진행 */}
            <label className="flex items-start gap-1.5 text-[11px] text-foreground mt-3 cursor-pointer rounded border border-cyan-500/30 bg-cyan-500/5 p-2">
              <input type="checkbox" className="mt-0.5" checked={wiz.autoFlow} onChange={e => setWiz({ ...wiz, autoFlow: e.target.checked })} />
              <span>
                <b>생성 후 자동 진행</b> — 오케스트레이터가 표준 워크플로우(요구정리→설계→…→QA→운영)대로 <b>칸반 작업을 자동 생성</b>하고 진행합니다.
                <span className="block text-[10px] text-muted-foreground mt-0.5">※ 실제 코드/디렉터리/패키지 설치/git은 하지 않습니다. 칸반 작업(계획)만 생성됩니다.</span>
              </span>
            </label>

            <label className="flex items-center gap-1.5 text-[11px] text-foreground mt-2 cursor-pointer">
              <input type="checkbox" checked={wiz.confirm} onChange={e => setWiz({ ...wiz, confirm: e.target.checked })} />
              {wiz.autoFlow
                ? '위 내용으로 프로젝트를 생성하고 칸반 워크플로우를 시작합니다(코드/디렉터리/git 미생성).'
                : '아직 실제 파일이나 작업을 만들지 않고 준비 카드만 생성합니다.'}
            </label>

            <div className="flex justify-end gap-2 mt-3 sticky bottom-0 bg-card pt-2">
              <button onClick={() => setShowCreateModal(false)} className="px-3 py-2 text-sm border border-border rounded text-muted-foreground hover:text-foreground">취소</button>
              <button onClick={saveWizard} disabled={busy || wizErrors.length > 0 || !wiz.confirm} className="inline-flex items-center gap-1 px-3 py-2 text-sm bg-foreground text-background rounded disabled:opacity-40 disabled:cursor-not-allowed">
                <Plus className="w-4 h-4" /> {wiz.autoFlow ? '프로젝트 생성 + 워크플로우 시작' : '준비 카드 생성'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Capsule list */}
      {capsules.length === 0 ? (
        <p className="text-sm text-muted-foreground">아직 준비 카드가 없습니다. 후보로 생성하거나 직접 만들어 보세요.</p>
      ) : (
        <div className="space-y-2">
          {capsules.map(c => (
            <div key={c.id} className="rounded-md border border-border bg-card p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-foreground">{c.projectName}</span>
                <span className="text-[10px] font-mono text-muted-foreground">{c.projectId}</span>
                <span className={`text-[10px] px-1.5 py-0.5 border rounded ${STATUS_CHIP[c.status] ?? ''}`}>{c.status}</span>
                <span className="text-[10px] text-muted-foreground">{c.companyName}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-0.5 mt-1.5 text-[10px] text-muted-foreground font-mono">
                <span>root: {c.rootPath.replace('/Users/soo', '~')}</span>
                <span>kanban: {c.kanbanProjectId}</span>
                <span>ports: {c.frontendPort}/{c.backendPort}</span>
                <span>pm: {c.packageManager}</span>
                <span>env: {c.envNamespace}</span>
                <span>vault: {c.vaultNamespace}</span>
                <span className="col-span-2">updated: {new Date(c.updatedAt).toLocaleString()}</span>
              </div>
              {/* Phase 6-AO — 상세 필드(있을 때만) */}
              {(c.techStack?.length || c.outOfScope?.length || c.executionChecklist?.length || c.dataSourceNotes?.length) ? (
                <div className="mt-1.5 space-y-0.5 text-[10px]">
                  {!!c.techStack?.length && <p><span className="text-muted-foreground">기술 스택:</span> <span className="text-foreground/80">{c.techStack.join(', ')}</span></p>}
                  {!!c.outOfScope?.length && <p><span className="text-muted-foreground">범위 외:</span> <span className="text-foreground/80">{c.outOfScope.join(', ')}</span></p>}
                  {!!c.dataSourceNotes?.length && <p><span className="text-muted-foreground">데이터 출처 메모:</span> <span className="text-foreground/80">{c.dataSourceNotes.length}건</span></p>}
                  {!!c.executionChecklist?.length && <p><span className="text-muted-foreground">실행 체크리스트:</span> <span className="text-foreground/80">{c.executionChecklist.length}개 항목</span></p>}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                <button onClick={() => showPreview(c)} className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-border rounded text-muted-foreground hover:text-foreground"><ListChecks className="w-3 h-3" /> 작업 계획 미리보기</button>
                <button onClick={() => resume(c)} disabled={busy} className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-border rounded text-muted-foreground hover:text-foreground disabled:opacity-40"><RotateCcw className="w-3 h-3" /> 이어서 시작 요약</button>
                <button onClick={() => confirmBuild(c)} className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-amber-500/40 text-amber-500 rounded" title="다음 단계에서 confirm 후 실행(scaffold/Kanban/dispatch 없음)"><PlayCircle className="w-3 h-3" /> 자동 빌드 시작 (확인 필요)</button>
                {c.status !== 'paused'
                  ? <button onClick={() => updateStatus(c.id, 'paused')} disabled={busy} className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-border rounded text-muted-foreground hover:text-foreground disabled:opacity-40"><Pause className="w-3 h-3" /> 일시중지</button>
                  : <button onClick={() => updateStatus(c.id, 'ready')} disabled={busy} className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-border rounded text-muted-foreground hover:text-foreground disabled:opacity-40">준비</button>}
                <span className="opacity-30">|</span>
                <button onClick={() => setEnvOpenId(envOpenId === c.id ? null : c.id)} disabled={busy} className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-amber-500/40 text-amber-600 rounded hover:bg-amber-500/10 disabled:opacity-40" title="환경변수/API 키 + 메모">🔑 환경변수·메모</button>
                <button onClick={() => startEdit(c)} disabled={busy} className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-border rounded text-muted-foreground hover:text-foreground disabled:opacity-40"><Pencil className="w-3 h-3" /> 편집</button>
                <button onClick={() => deleteCapsule(c)} disabled={busy} className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-rose-500/40 text-rose-400 rounded hover:bg-rose-500/10 disabled:opacity-40"><Trash2 className="w-3 h-3" /> 삭제</button>
              </div>

              {/* Phase 6-AN — 편집 폼 */}
              {envOpenId === c.id && <ProjectEnvNotes projectId={c.projectId} />}

              {editingId === c.id && (
                <div className="mt-2 border-t border-border pt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className="text-[10px] text-muted-foreground">이름
                    <input value={editDraft.projectName} onChange={e => setEditDraft({ ...editDraft, projectName: e.target.value })} className="mt-0.5 w-full px-2 py-1 text-xs bg-background border border-border rounded" />
                  </label>
                  <label className="text-[10px] text-muted-foreground">상태
                    <select value={editDraft.status} onChange={e => setEditDraft({ ...editDraft, status: e.target.value })} className="mt-0.5 w-full px-2 py-1 text-xs bg-background border border-border rounded">
                      {['draft', 'ready', 'active', 'paused', 'completed', 'blocked'].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  <label className="text-[10px] text-muted-foreground">프론트 포트
                    <input type="number" value={editDraft.frontendPort} onChange={e => setEditDraft({ ...editDraft, frontendPort: Number(e.target.value) })} className="mt-0.5 w-full px-2 py-1 text-xs bg-background border border-border rounded" />
                  </label>
                  <label className="text-[10px] text-muted-foreground">백엔드 포트
                    <input type="number" value={editDraft.backendPort} onChange={e => setEditDraft({ ...editDraft, backendPort: Number(e.target.value) })} className="mt-0.5 w-full px-2 py-1 text-xs bg-background border border-border rounded" />
                  </label>
                  <label className="text-[10px] text-muted-foreground sm:col-span-2">MVP 범위 (쉼표 구분)
                    <input value={editDraft.mvpScope} onChange={e => setEditDraft({ ...editDraft, mvpScope: e.target.value })} placeholder="지도, 검색, 즐겨찾기" className="mt-0.5 w-full px-2 py-1 text-xs bg-background border border-border rounded" />
                  </label>
                  <label className="text-[10px] text-muted-foreground">기술 스택 (쉼표 구분)
                    <input value={editDraft.techStack} onChange={e => setEditDraft({ ...editDraft, techStack: e.target.value })} placeholder="Next.js, API Routes, SQLite" className="mt-0.5 w-full px-2 py-1 text-xs bg-background border border-border rounded" />
                  </label>
                  <label className="text-[10px] text-muted-foreground">범위에서 제외 (쉼표 구분)
                    <input value={editDraft.outOfScope} onChange={e => setEditDraft({ ...editDraft, outOfScope: e.target.value })} placeholder="로그인, 결제, 네이티브 앱" className="mt-0.5 w-full px-2 py-1 text-xs bg-background border border-border rounded" />
                  </label>
                  <label className="text-[10px] text-muted-foreground sm:col-span-2">데이터 출처 상세 메모 (줄바꿈 구분)
                    <textarea value={editDraft.dataSourceNotes} onChange={e => setEditDraft({ ...editDraft, dataSourceNotes: e.target.value })} rows={2} placeholder="공공데이터포털 표준데이터 / API키 필요 여부 확인" className="mt-0.5 w-full px-2 py-1 text-xs bg-background border border-border rounded resize-y" />
                  </label>
                  <label className="text-[10px] text-muted-foreground sm:col-span-2">실행 전 체크리스트 (줄바꿈 구분)
                    <textarea value={editDraft.executionChecklist} onChange={e => setEditDraft({ ...editDraft, executionChecklist: e.target.value })} rows={3} placeholder={"projectId 확인\n독립 디렉터리 확인\nAPI 키 필요 여부 확인\nKanban Preview 확인\n위험 작업 승인 필요 여부"} className="mt-0.5 w-full px-2 py-1 text-xs bg-background border border-border rounded resize-y" />
                  </label>
                  <div className="sm:col-span-2 flex gap-1.5">
                    <button onClick={() => saveEdit(c.id)} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] bg-foreground text-background rounded disabled:opacity-40"><Save className="w-3 h-3" /> 저장</button>
                    <button onClick={() => setEditingId(null)} className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] border border-border rounded text-muted-foreground"><X className="w-3 h-3" /> 취소</button>
                  </div>
                </div>
              )}

              {/* Kanban preview */}
              {preview?.id === c.id && (
                <div className="mt-2 border-t border-border pt-2">
                  <p className="text-[11px] text-foreground mb-1">작업 계획 미리보기 (미저장 — projectId={c.projectId})</p>
                  <ol className="space-y-0.5">
                    {preview.tasks.map(t => (
                      <li key={t.order} className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                        <span className="font-mono text-foreground/70">{t.ownerAgentId}</span>
                        <span>{t.title}</span>
                        <span className={`px-1 rounded ${t.riskLevel === 'high' ? 'text-rose-400' : t.riskLevel === 'medium' ? 'text-amber-400' : 'text-muted-foreground'}`}>{t.riskLevel}</span>
                        {t.requiresApproval && <span className="text-amber-500 inline-flex items-center gap-0.5"><ShieldAlert className="w-2.5 h-2.5" />승인필요</span>}
                      </li>
                    ))}
                  </ol>
                  {/* Phase 6-AN — 실제 칸반 생성 confirm gate */}
                  <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/5 p-2">
                    <p className="text-[10px] text-muted-foreground mb-1">이 작업은 선택한 프로젝트의 Kanban에 작업을 추가합니다. 기존 작업은 삭제하지 않습니다.</p>
                    <label className="flex items-center gap-1.5 text-[11px] text-foreground cursor-pointer">
                      <input type="checkbox" checked={matConfirm} onChange={e => setMatConfirm(e.target.checked)} />
                      위 작업들을 실제 칸반 작업으로 생성하는 것을 확인합니다
                    </label>
                    <button onClick={() => materialize(c)} disabled={!matConfirm || busy}
                      className="mt-1.5 inline-flex items-center gap-1 px-2.5 py-1 text-[10px] bg-foreground text-background rounded disabled:opacity-40 disabled:cursor-not-allowed">
                      <ListChecks className="w-3 h-3" /> 실제 칸반 작업으로 생성
                    </button>
                    {matMsg && <p className="text-[10px] text-cyan-400 mt-1">{matMsg}</p>}
                  </div>
                </div>
              )}

              {/* Resume brief */}
              {brief?.id === c.id && (
                <div className="mt-2 border-t border-border pt-2 text-[10px] text-muted-foreground space-y-0.5">
                  <p className="text-[11px] text-foreground">이어서 시작 요약</p>
                  <p>rootPath 존재: {String(brief.data.rootPathExists)} · dirty: {brief.data.dirtyFileCount} · pkg: {brief.data.packageManager ?? '-'}</p>
                  <p>ongoing: {brief.data.ongoingTaskCount} · backlog: {brief.data.backlogTaskCount} · blocked: {brief.data.blockedTaskCount}</p>
                  <p>최근 보고서: {brief.data.lastReports.length ? brief.data.lastReports.join(', ') : '없음'}</p>
                  <p className="text-cyan-400">권장: {brief.data.recommendedNextAgent} → {brief.data.recommendedAction}</p>
                  {brief.data.notes.map((n, i) => <p key={i} className="text-amber-500/80">· {n}</p>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Agent distribution policy + WIP */}
      <div className="rounded-md border border-border bg-secondary/30 p-3">
        <p className="text-xs font-semibold text-foreground mb-1">프로젝트별 에이전트 배분 정책</p>
        <ul className="text-[11px] text-muted-foreground space-y-0.5 list-disc list-inside">
          {AGENT_DISTRIBUTION_POLICY.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
        <p className="text-[11px] text-foreground mt-2 mb-1">WIP limit (에이전트별 동시 active task)</p>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(WIP_LIMITS).map(([a, n]) => (
            <span key={a} className="text-[10px] px-1.5 py-0.5 border border-border rounded bg-background text-muted-foreground font-mono">{a}: {n}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
