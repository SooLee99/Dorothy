'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import dynamic from 'next/dynamic';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Loader2, RefreshCw, Search, ChevronDown, FolderOpen, Building2, Users } from 'lucide-react';
import { useElectronKanban, useKanbanAgentSync } from '@/hooks/useElectronKanban';
import { dorothyClient } from '@/lib/dorothyClient';
import { isElectron as checkIsElectron } from '@/hooks/useElectron';
import type { KanbanTask, KanbanColumn as KanbanColumnType, KanbanTaskCreate } from '@/types/kanban';
import type { AgentStatus } from '@/types/electron';
import { KanbanColumn } from './components/KanbanColumn';
import { KanbanCard } from './components/KanbanCard';
import { NewTaskModal } from './components/NewTaskModal';
import { KanbanCardDetail } from './components/KanbanCardDetail';
import { KanbanDoneSummary } from './components/KanbanDoneSummary';
import { COLUMN_ORDER } from './constants';
// Phase 2 PR-2-U1 — Projects 영역(프로젝트 카드 + 클릭 필터, 별도 슬롯 AND 합성).
import { ProjectsStrip } from '@/components/phase2/ProjectsStrip';
import { matchesCapsule } from '@/components/phase2/lib';
import type { ProjectCardData } from '@/components/phase2/ProjectCard';
import { useStore } from '@/store'; // 재설계 ①단계 — 전역 ProjectSwitcher 연동

// Lazy load the terminal dialog
const AgentTerminalDialog = dynamic(
  () => import('@/components/AgentWorld/AgentTerminalDialog'),
  { ssr: false }
);

// --- Per-project grouping (normalized) -------------------------------------
// projectId/projectPath 값은 제각각(clean slug, path-encoded "-Users-soo-...",
// 빈 값). 실제 프로젝트별로 ★정확히 분리되도록 정규화한다.
//   - 알려진 묶음: dorothy / triplan(코어+하위레포+auth) / bueongi(부엉이) / 안심귀가.
//   - 그 외: projectPath basename → projectId 순으로 ★일반 키 생성(특정 프로젝트로
//     강제 매핑하지 않음). 과거엔 미지의 프로젝트를 전부 'triplan'으로 떨궈
//     bueongi·안심귀가가 triplan에 섞이는 ★필터 버그가 있었다 → 일반 폴백으로 수정.
// 정체 통일 — capsule 프로젝트는 triplan·bueongi 2개. raw 태그(9가지 변형)를 canonical 로 묶는다.
//   · triplan = triplan / triplan-frontend / triplan-travel-service / soo-auth-service
//   · bueongi = bueongi / 부엉이 / ★안심귀가(앱 이름) / frontend-src(부엉이 프론트엔드) / ansim·safe-return
//   · Dorothy(대시보드 앱)·.dorothy(런타임 설정)은 ★비프로젝트 → '미분류'(unknown).
//   resolveProjectId(capsule)는 자유텍스트 '안심귀가'를 못 잡아, 키워드 별칭으로 더 완전히 정규화.
function projectGroupKey(task: KanbanTask): string {
  const pp = typeof task.projectPath === 'string' ? task.projectPath.trim() : '';
  const pid = typeof task.projectId === 'string' ? task.projectId.trim() : '';
  const hay = `${pp} ${pid}`.toLowerCase();
  // 비프로젝트(대시보드 앱/런타임 설정)는 프로젝트 그룹이 아님 → 미분류.
  if (hay.includes('dorothy')) return 'unknown';
  if (hay.includes('triplan') || hay.includes('soo-auth') || hay.includes('travel-service')) return 'triplan';
  if (
    hay.includes('bueongi') || hay.includes('부엉') ||
    hay.includes('안심귀가') || hay.includes('ansim') || hay.includes('safe-return') ||
    hay.includes('frontend-src')
  ) return 'bueongi';
  // ★일반 폴백: 경로 basename → projectId → unknown (특정 프로젝트로 강제하지 않음)
  if (pp) {
    const base = pp.split('/').filter(Boolean).pop();
    if (base) return base.toLowerCase();
  }
  if (pid) return pid.toLowerCase();
  return 'unknown';
}

const PROJECT_LABELS: Record<string, string> = {
  'triplan': 'triplan (여행)',
  'bueongi': 'bueongi (부엉이·안심귀가)',
  'unknown': '미분류',
};
function projectGroupLabel(key: string): string {
  return PROJECT_LABELS[key] ?? key;
}

export default function KanbanBoard() {
  const {
    tasks,
    isLoading,
    error,
    isElectron,
    createTask,
    updateTask,
    moveTask,
    deleteTask,
    reorderTasks,
    getTasksByColumn,
    refresh,
  } = useElectronKanban();

  // Enable agent sync
  useKanbanAgentSync(tasks, updateTask, moveTask);

  // Modal states
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [editingTask, setEditingTask] = useState<KanbanTask | null>(null);

  // Terminal dialog state
  const [terminalAgentId, setTerminalAgentId] = useState<string | null>(null);
  const [terminalAgent, setTerminalAgent] = useState<AgentStatus | null>(null);

  // Fetch agent when terminal is opened
  useEffect(() => {
    if (!terminalAgentId || !checkIsElectron()) {
      setTerminalAgent(null);
      return;
    }

    const fetchAgent = async () => {
      try {
        const agent = await window.electronAPI?.agent?.get(terminalAgentId);
        setTerminalAgent(agent || null);
      } catch (err) {
        console.error('Failed to fetch agent:', err);
        setTerminalAgent(null);
      }
    };

    fetchAgent();
  }, [terminalAgentId]);

  // Handle opening terminal for an agent
  const handleOpenTerminal = useCallback((agentId: string) => {
    setTerminalAgentId(agentId);
  }, []);

  // Handle closing terminal
  const handleCloseTerminal = useCallback(() => {
    setTerminalAgentId(null);
    setTerminalAgent(null);
  }, []);

  // Agent start/stop handlers for terminal dialog
  const handleAgentStart = useCallback(async (agentId: string, prompt: string) => {
    if (checkIsElectron() && window.electronAPI?.agent?.start) {
      await window.electronAPI.agent.start({ id: agentId, prompt });
      // Refresh agent state
      const agent = await window.electronAPI?.agent?.get(agentId);
      setTerminalAgent(agent || null);
    }
  }, []);

  const handleAgentStop = useCallback(async (agentId: string) => {
    if (checkIsElectron() && window.electronAPI?.agent?.stop) {
      await window.electronAPI.agent.stop(agentId);
      // Refresh agent state
      const agent = await window.electronAPI?.agent?.get(agentId);
      setTerminalAgent(agent || null);
    }
  }, []);

  // Filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [filterProject, setFilterProject] = useState<string | null>(null);
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  // Phase 6-AH — per-agent (담당자) filter so 칸반을 에이전트별로 볼 수 있음.
  const [filterAgent, setFilterAgent] = useState<string | null>(null);
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  // Phase 2 PR-2-U1 — 프로젝트 카드 클릭 필터(★별도 슬롯: 기존 filterProject 등을 덮어쓰지 않고 AND 합성).
  // 재설계 ①단계 — 선택 상태의 단일 소스를 전역 store.selectedProject 로 승격. 사이드바
  //   ProjectSwitcher 와 칸반 in-board ProjectsStrip 이 같은 store 를 공유해 동기화된다.
  //   filterProjectSel(=실제 capsule 필터에 쓰는 카드)은 store.selectedProject + 프로젝트 목록에서 파생.
  const selectedProject = useStore((s) => s.selectedProject);
  const setSelectedProject = useStore((s) => s.setSelectedProject);
  const [projectList, setProjectList] = useState<ProjectCardData[]>([]);
  const [filterProjectSel, setFilterProjectSel] = useState<ProjectCardData | null>(null);

  // 프로젝트 목록(카드+repos) 로드 — store.selectedProject(id) → 카드 해석용.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/dorothy/projects', { cache: 'no-store' });
        const j = await res.json();
        const list = j?.data?.projects;
        if (!cancelled && Array.isArray(list)) setProjectList(list);
      } catch { /* 실패 시 목록 비움 → 필터 미적용(안전) */ }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // store.selectedProject → filterProjectSel(카드) 파생. 못 찾으면 null(필터 미적용·안전).
  useEffect(() => {
    if (!selectedProject) { setFilterProjectSel(null); return; }
    setFilterProjectSel(projectList.find((p) => p.projectId === selectedProject) ?? null);
  }, [selectedProject, projectList]);

  // in-board ProjectsStrip 카드 클릭 → 전역 store 갱신(토글). 사이드바 스위처와 동기화.
  const handleSelectProject = useCallback((project: ProjectCardData | null) => {
    setSelectedProject(project && selectedProject !== project.projectId ? project.projectId : null);
  }, [selectedProject, setSelectedProject]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // --- 회사별 보기 (company filter) ---
  // companies.json 의 agentMappings(agentId→companyId) 로 태스크를 회사별로 거른다.
  // 태스크 자체엔 companyId 가 없으므로 task.assignedAgentId 를 통해 회사를 추적한다.
  // 옵션: 각 회사 / 미분류(에이전트 미배정·미매핑) / 전체 회사. (Dashboard 와 동일 패턴)
  const [companyInfo, setCompanyInfo] = useState<{
    selectedCompanyId: string | null;
    companies: { id: string; name: string }[];
    agentMappings: { agentId: string; companyId: string | null }[];
  }>({ selectedCompanyId: null, companies: [], agentMappings: [] });
  const [companyView, setCompanyView] = useState<string>(''); // '' 미설정, '__all__' 전체, '__unmapped__' 미분류
  const [companyDropdownOpen, setCompanyDropdownOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    dorothyClient.companies
      .get()
      .then((j) => {
        if (cancelled) return;
        setCompanyInfo({
          selectedCompanyId: j.selectedCompanyId ?? null,
          companies: j.companies ?? [],
          agentMappings: j.agentMappings ?? [],
        });
        setCompanyView((prev) => prev || j.selectedCompanyId || '__all__');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const agentCompanyMap = useMemo(() => {
    const m: Record<string, string | null> = {};
    for (const x of companyInfo.agentMappings) m[x.agentId] = x.companyId ?? null;
    return m;
  }, [companyInfo.agentMappings]);

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refresh();
    } finally {
      setTimeout(() => setIsRefreshing(false), 600);
    }
  }, [refresh, isRefreshing]);

  // Drag state
  const [activeTask, setActiveTask] = useState<KanbanTask | null>(null);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Filter tasks
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesSearch =
          task.title.toLowerCase().includes(query) ||
          task.description.toLowerCase().includes(query) ||
          task.labels.some((l) => l.toLowerCase().includes(query));
        if (!matchesSearch) return false;
      }

      // Project filter (normalized per-project group)
      if (filterProject && projectGroupKey(task) !== filterProject) {
        return false;
      }

      // Phase 2 PR-2-U1 — 프로젝트 카드 필터(별도 슬롯, AND 합성).
      // ★task.projectId(observed:false) 가 아니라 task.projectPath basename ∈ capsule.repos 로 조인.
      // ★repos 없으면(조인 불가) 필터 미적용 — 거짓 필터 금지(UI 에서 '매핑 확인 불가' 안내).
      if (filterProjectSel && Array.isArray(filterProjectSel.repos) && filterProjectSel.repos.length > 0) {
        if (!matchesCapsule(task.projectPath, filterProjectSel.repos)) return false;
      }

      // Agent filter (담당 에이전트별 보기). '__unassigned__' = 미배정.
      if (filterAgent) {
        const owner = task.assignedAgentId || '__unassigned__';
        if (owner !== filterAgent) return false;
      }

      // Company filter (task.assignedAgentId → companyId via agentMappings)
      // 미배정 태스크(담당 에이전트 없음)는 어느 회사 보기에서도 숨기지 않는다
      // — 새로 만든 backlog 태스크가 사라져 보이는 문제 방지. 다른 회사에 "배정된" 것만 숨김.
      if (companyView && companyView !== '__all__') {
        if (companyView === '__unmapped__') {
          // 미분류: 담당 미배정이거나 매핑에 없는 에이전트에 배정된 것만
          if (task.assignedAgentId && task.assignedAgentId in agentCompanyMap) return false;
        } else if (task.assignedAgentId) {
          // 특정 회사: 다른 회사 소속 에이전트에 배정된 태스크만 숨김(미배정은 표시)
          const taskCompany = agentCompanyMap[task.assignedAgentId];
          if (taskCompany && taskCompany !== companyView) return false;
        }
      }

      return true;
    });
  }, [tasks, searchQuery, filterProject, filterAgent, companyView, agentCompanyMap, filterProjectSel]);

  // Get filtered tasks by column
  const getFilteredTasksByColumn = useCallback(
    (column: KanbanColumnType) => {
      return filteredTasks
        .filter((t) => t.column === column)
        .sort((a, b) => a.order - b.order);
    },
    [filteredTasks]
  );

  // Get unique projects for filter (normalized groups + task counts)
  const projects = useMemo(() => {
    const counts = new Map<string, number>();
    tasks.forEach((task) => {
      const key = projectGroupKey(task);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, name: `${projectGroupLabel(id)} · ${count}` }));
  }, [tasks]);

  // Phase 6-AH — 담당 에이전트별 옵션(미배정 포함) + 작업 수.
  const agentOptions = useMemo(() => {
    const counts = new Map<string, number>();
    tasks.forEach((task) => {
      const owner = task.assignedAgentId || '__unassigned__';
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({
        id,
        name: `${id === '__unassigned__' ? '미배정' : id} · ${count}`,
      }));
  }, [tasks]);

  // Drag handlers
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const task = tasks.find((t) => t.id === active.id);
    if (task) {
      setActiveTask(task);
    }
  }, [tasks]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    // Could add visual feedback here
  }, []);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const activeTask = tasks.find((t) => t.id === activeId);
    if (!activeTask) return;

    // Check if dropped on a column
    const overColumn = COLUMN_ORDER.find((c) => c === overId);
    if (overColumn) {
      // Moving to a different column
      if (activeTask.column !== overColumn) {
        console.log(`Moving task to column: ${overColumn}`);
        const result = await moveTask(activeId, overColumn);
        if (result.agentSpawned) {
          console.log(`Agent ${result.agentId} spawned for task`);
        }
      }
      return;
    }

    // Check if dropped on another task
    const overTask = tasks.find((t) => t.id === overId);
    if (overTask) {
      if (activeTask.column === overTask.column) {
        // Reorder within same column
        const columnTasks = getFilteredTasksByColumn(activeTask.column);
        const oldIndex = columnTasks.findIndex((t) => t.id === activeId);
        const newIndex = columnTasks.findIndex((t) => t.id === overId);

        if (oldIndex !== newIndex) {
          const newOrder = [...columnTasks];
          const [removed] = newOrder.splice(oldIndex, 1);
          newOrder.splice(newIndex, 0, removed);
          await reorderTasks(
            newOrder.map((t) => t.id),
            activeTask.column
          );
        }
      } else {
        // Move to different column at specific position
        await moveTask(activeId, overTask.column, overTask.order);
      }
    }
  }, [tasks, moveTask, reorderTasks, getFilteredTasksByColumn]);

  // Task handlers
  const handleCreateTask = async (data: KanbanTaskCreate) => {
    await createTask(data);
    setShowNewTaskModal(false);
  };

  const handleEditTask = (task: KanbanTask) => {
    setEditingTask(task);
  };

  const handleDeleteTask = async (taskId: string) => {
    if (confirm('Are you sure you want to delete this task?')) {
      await deleteTask(taskId);
    }
  };

  const handleUpdateTask = async (data: Partial<KanbanTask>) => {
    if (editingTask) {
      await updateTask({ id: editingTask.id, ...data });
      setEditingTask(null);
    }
  };

  // Non-Electron fallback: if we managed to load tasks from /api/dorothy/kanban,
  // show the board read-only. Mutations (drag, create, delete) will still throw
  // because they call window.electronAPI.kanban directly — guarded with try/catch
  // by upstream handlers, but visible board is the priority.
  if (!isElectron && tasks.length === 0 && !isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>칸반 보드는 데스크톱 앱에서만 사용할 수 있습니다</p>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-4">
        <p className="text-red-400">{error}</p>
        <button
          onClick={handleRefresh}
          className="flex items-center gap-2 px-3 py-2 bg-secondary rounded-md hover:bg-secondary/80 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 lg:pt-6 mb-4">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground">작업 보드</h1>
          <p className="text-muted-foreground text-xs lg:text-sm mt-1 hidden sm:block">
            Planned로 드래그하면 에이전트가 자동 배정됩니다
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="검색..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-4 py-2 bg-secondary/50 border border-border/50 rounded-lg text-sm w-52 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all"
            />
          </div>

          {/* Company filter */}
          {companyInfo.companies.length > 1 && (
            <div className="relative">
              <button
                onClick={() => setCompanyDropdownOpen(v => !v)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-none bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors text-sm min-w-[160px]"
              >
                <Building2 className="w-4 h-4" />
                {companyView === '__all__' || !companyView
                  ? 'All Companies'
                  : companyView === '__unmapped__'
                    ? 'Unassigned'
                    : companyInfo.companies.find(c => c.id === companyView)?.name ?? companyView}
                <ChevronDown className="w-4 h-4 ml-auto" />
              </button>

              <AnimatePresence>
                {companyDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setCompanyDropdownOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 5 }}
                      className="absolute top-full mt-2 right-0 w-48 bg-card border border-border rounded-none shadow-lg z-20 py-2"
                    >
                      {[
                        { id: '__all__', name: 'All Companies' },
                        ...companyInfo.companies,
                        { id: '__unmapped__', name: 'Unassigned' },
                      ].map((c) => {
                        const isSelected = companyView === c.id || (c.id === '__all__' && !companyView);
                        return (
                          <button
                            key={c.id}
                            onClick={() => { setCompanyView(c.id); setCompanyDropdownOpen(false); }}
                            className={`w-full text-left px-4 py-2 text-sm hover:bg-secondary ${isSelected ? 'text-white' : 'text-muted-foreground'}`}
                          >
                            {c.name}
                          </button>
                        );
                      })}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Project filter */}
          {projects.length > 1 && (
            <div className="relative">
              <button
                onClick={() => setProjectDropdownOpen(v => !v)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-none bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors text-sm min-w-[160px]"
              >
                <FolderOpen className="w-4 h-4" />
                {filterProject ? projects.find(p => p.id === filterProject)?.name : '전체 프로젝트'}
                <ChevronDown className="w-4 h-4 ml-auto" />
              </button>

              <AnimatePresence>
                {projectDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setProjectDropdownOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 5 }}
                      className="absolute top-full mt-2 right-0 w-48 bg-card border border-border rounded-none shadow-lg z-20 py-2"
                    >
                      {[{ id: '', name: '전체 프로젝트' }, ...projects].map((p) => {
                        const isSelected = (p.id === '' && !filterProject) || filterProject === p.id;
                        return (
                          <button
                            key={p.id}
                            onClick={() => { setFilterProject(p.id || null); setProjectDropdownOpen(false); }}
                            className={`w-full text-left px-4 py-2 text-sm hover:bg-secondary ${isSelected ? 'text-white' : 'text-muted-foreground'}`}
                          >
                            {p.name}
                          </button>
                        );
                      })}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Phase 6-AH — Agent(담당자) filter: 칸반을 에이전트별로 보기 */}
          {agentOptions.length > 1 && (
            <div className="relative">
              <button
                onClick={() => setAgentDropdownOpen(v => !v)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-none bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors text-sm min-w-[160px]"
              >
                <Users className="w-4 h-4" />
                {filterAgent ? agentOptions.find(a => a.id === filterAgent)?.name : '전체 담당자'}
                <ChevronDown className="w-4 h-4 ml-auto" />
              </button>

              <AnimatePresence>
                {agentDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setAgentDropdownOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 5 }}
                      className="absolute top-full mt-2 right-0 w-56 max-h-80 overflow-y-auto bg-card border border-border rounded-none shadow-lg z-20 py-2"
                    >
                      {[{ id: '', name: '전체 담당자' }, ...agentOptions].map((a) => {
                        const isSelected = (a.id === '' && !filterAgent) || filterAgent === a.id;
                        return (
                          <button
                            key={a.id}
                            onClick={() => { setFilterAgent(a.id || null); setAgentDropdownOpen(false); }}
                            className={`w-full text-left px-4 py-2 text-sm hover:bg-secondary ${isSelected ? 'text-white' : 'text-muted-foreground'}`}
                          >
                            {a.name}
                          </button>
                        );
                      })}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Refresh button */}
          <button
            onClick={handleRefresh}
            className="p-2 rounded-lg hover:bg-secondary/50 transition-colors"
            title="새로고침"
          >
            <RefreshCw className={`w-4 h-4 text-muted-foreground transition-transform ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>

          {/* Add task button */}
          <button
            onClick={() => setShowNewTaskModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium text-sm"
          >
새 작업
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Phase 2 PR-2-U1 — Projects 영역(additive, 보드 위). 카드 클릭 → 프로젝트 필터(별도 슬롯). */}
      <ProjectsStrip selectedId={selectedProject} onSelect={handleSelectProject} />

      {/* Board */}
      <div className="flex-1 overflow-x-auto px-6 pb-6">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4 h-full w-full">
            {COLUMN_ORDER.map((column) => (
              <KanbanColumn
                key={column}
                column={column}
                tasks={getFilteredTasksByColumn(column)}
                onAddTask={column === 'backlog' ? () => setShowNewTaskModal(true) : undefined}
                onEditTask={handleEditTask}
                onDeleteTask={handleDeleteTask}
                onStartTask={moveTask}
                onOpenTerminal={handleOpenTerminal}
                activeTaskId={activeTask?.id}
              />
            ))}
          </div>

          {/* Drag overlay */}
          <DragOverlay>
            {activeTask && (
              <div className="w-[280px]">
                <KanbanCard task={activeTask} isDragging />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>

      {/* New task modal */}
      <AnimatePresence>
        {showNewTaskModal && (
          <NewTaskModal
            onClose={() => setShowNewTaskModal(false)}
            onCreate={handleCreateTask}
          />
        )}
      </AnimatePresence>

      {/* Detail/edit modal — backlog/planned/ongoing 클릭 시 상세보기 팝업 (done 은 별도 요약 모달) */}
      <AnimatePresence>
        {editingTask && editingTask.column !== 'done' && (
          <KanbanCardDetail
            task={editingTask}
            onClose={() => setEditingTask(null)}
            onUpdate={handleUpdateTask}
            onDelete={() => {
              handleDeleteTask(editingTask.id);
              setEditingTask(null);
            }}
          />
        )}
      </AnimatePresence>

      {/* Done task summary modal */}
      <AnimatePresence>
        {editingTask && editingTask.column === 'done' && (
          <KanbanDoneSummary
            task={editingTask}
            onClose={() => setEditingTask(null)}
            onDelete={() => {
              handleDeleteTask(editingTask.id);
              setEditingTask(null);
            }}
          />
        )}
      </AnimatePresence>

      {/* Agent Terminal Dialog - skip historical output to avoid display issues */}
      {terminalAgentId && terminalAgent && (
        <AgentTerminalDialog
          agent={terminalAgent}
          open={!!terminalAgentId}
          onClose={handleCloseTerminal}
          onStart={handleAgentStart}
          onStop={handleAgentStop}
          skipHistoricalOutput={true}
        />
      )}
    </div>
  );
}
