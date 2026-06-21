'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Bot, Loader2, Search, ArrowUpDown, Building2, FolderKanban } from 'lucide-react';
import { useElectronAgents, useElectronFS, useElectronSkills, isElectron } from '@/hooks/useElectron';
import { useProjectScope } from '@/lib/useProjectScope'; // 재설계 ②-a — 전역 프로젝트 스위처 필터
import DomainTabs, { AGENT_DOMAIN } from '@/components/DomainTabs'; // 재설계 ②-b — 에이전트 도메인 탭
import { useElectronTemplates } from '@/hooks/useElectronTemplates';
import { useClaude } from '@/hooks/useClaude';
import { useAgentFiltering } from '@/hooks/useAgentFiltering';
import { useSuperAgent } from '@/hooks/useSuperAgent';
import { dorothyClient } from '@/lib/dorothyClient';
import type { AgentCharacter, AgentProvider } from '@/types/electron';
import NewChatModal from '@/components/NewChatModal';
import type { EditAgentData } from '@/components/NewChatModal/types';
import AgentTerminalDialog from '@/components/AgentWorld/AgentTerminalDialog';
import {
  DesktopRequiredMessage,
  AgentListHeader,
  ProjectFilterTabs,
  AgentManagementCard,
} from '@/components/AgentList';
import AgentRegistryPanel from '@/components/AgentRegistry';
import OrchestratorFallbackPanel from '@/components/AgentList/OrchestratorFallbackPanel';
import SkillProposalsPanel from '@/components/AgentList/SkillProposalsPanel';
import { STATUS_LABELS, STATUS_COLORS } from './constants';

type SortBy = 'created' | 'status' | 'activity' | 'name';

export default function AgentsPage() {
  const {
    agents,
    isLoading: agentsLoading,
    isElectron: hasElectron,
    createAgent,
    updateAgent,
    startAgent,
    stopAgent,
    removeAgent,
  } = useElectronAgents();
  const { projects, openFolderDialog } = useElectronFS();
  const { installedSkills, refresh: refreshSkills } = useElectronSkills();
  const { create: createTemplate } = useElectronTemplates();
  const { data: claudeData } = useClaude();

  // Local state
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [showSuperAgentModal, setShowSuperAgentModal] = useState(false);
  const [viewAgentId, setViewAgentId] = useState<string | null>(null);  // terminal dialog
  const [editAgentId, setEditAgentId] = useState<string | null>(null);  // edit dialog
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('created');


  // Custom hooks
  const { superAgent, isCreatingSuperAgent, handleSuperAgentClick } = useSuperAgent({
    agents,
    startAgent,
    onAgentCreated: (id) => setEditAgentId(id),
    onCreateNew: () => setShowSuperAgentModal(true),
  });

  const { filteredAgents, uniqueProjects } = useAgentFiltering({
    agents,
    projectFilter,
    statusFilter,
    searchQuery,
    sortBy,
  });

  // 재설계 ②-a — 전역 프로젝트 스위처를 기존 필터 위에 AND 로 추가(식별자: agent.projectPath).
  // 정합성 C2-c — resolveProjectId/projects 로 프로젝트→역할 2단 그룹.
  const { matches: matchesProject, resolveProjectId, projects: scopeProjects } = useProjectScope();
  const scopedAgents = useMemo(
    () => filteredAgents.filter((a) => matchesProject({ projectPath: a.projectPath })),
    [filteredAgents, matchesProject],
  );

  const runningCount = agents.filter(a => a.status === 'running' || a.status === 'waiting').length;

  // --- 회사별 격리 (company isolation) ---
  // companies.json 의 selectedCompanyId + agentMappings 로 에이전트를 회사별로 묶는다.
  // 매핑이 없는 에이전트는 '미분류'로 표시한다. agents.json 은 변경하지 않는다.
  const [companyInfo, setCompanyInfo] = useState<{
    selectedCompanyId: string | null;
    companies: { id: string; name: string }[];
    agentMappings: { agentId: string; companyId: string | null }[];
  }>({ selectedCompanyId: null, companies: [], agentMappings: [] });
  const [companyView, setCompanyView] = useState<string>(''); // '' 미설정, '__all__' 전체

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

  const { companyAgents, unmappedAgents, isAllView } = useMemo(() => {
    const isAll = companyView === '__all__' || !companyView;
    if (isAll) return { companyAgents: scopedAgents, unmappedAgents: [], isAllView: true };
    const inCompany = scopedAgents.filter((a) => agentCompanyMap[a.id] === companyView);
    const unmapped = scopedAgents.filter((a) => !(a.id in agentCompanyMap));
    return { companyAgents: inCompany, unmappedAgents: unmapped, isAllView: false };
  }, [scopedAgents, agentCompanyMap, companyView]);

  const currentCompanyName =
    companyInfo.companies.find((c) => c.id === companyView)?.name ?? companyView;

  const renderAgentGrid = (list: typeof filteredAgents) => (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 pb-4">
      {list.map((agent) => (
        <AgentManagementCard
          key={agent.id}
          agent={agent}
          onClick={() => setViewAgentId(agent.id)}
          onEdit={() => setEditAgentId(agent.id)}
          onStart={() => handleStartAgent(agent.id)}
          onStop={() => stopAgent(agent.id)}
          onRemove={() => handleRemoveAgent(agent.id)}
          onSaveAsTemplate={() => handleSaveAsTemplate(agent.id)}
        />
      ))}
    </div>
  );

  // Phase 6-AM — 역할별 그룹: 개발 / 계획·검증 / 운영·보고 (그 외=기타).
  // 정합성 C2 — bueongi 개발 에이전트도 '개발'로(이전엔 '기타'로 떨어졌음).
  const ROLE_DEV = ['backend', 'frontend', 'bueongi-backend', 'bueongi-dev'];
  const ROLE_OPS = ['devops-reporter'];
  const ROLE_PLAN = ['intake-planner', 'architect-plan', 'orchestrator', 'plan-validator', 'contract-agent', 'database-agent', 'qa-reviewer', 'security-reviewer'];
  const renderRoleGrouped = (list: typeof filteredAgents) => {
    const dev = list.filter(a => ROLE_DEV.includes(a.id));
    const plan = list.filter(a => ROLE_PLAN.includes(a.id));
    const ops = list.filter(a => ROLE_OPS.includes(a.id));
    const other = list.filter(a => !ROLE_DEV.includes(a.id) && !ROLE_PLAN.includes(a.id) && !ROLE_OPS.includes(a.id));
    const Section = ({ title, desc, items }: { title: string; desc: string; items: typeof filteredAgents }) =>
      items.length === 0 ? null : (
        <section>
          <h3 className="text-sm font-semibold text-foreground mb-0.5">{title} <span className="text-xs font-normal text-muted-foreground">({items.length})</span></h3>
          <p className="text-[11px] text-muted-foreground mb-2">{desc}</p>
          {renderAgentGrid(items)}
        </section>
      );
    return (
      <div className="space-y-5">
        <Section title="개발 에이전트" desc="실제 코드 구현 담당 · Claude 기반 · 위험 작업은 승인 게이트를 따름" items={dev} />
        <Section title="계획·검증 에이전트" desc="요구사항 정리·작업 배분·설계·검증 담당 · Codex 기반 자동 진행" items={plan} />
        <Section title="운영·보고 에이전트" desc="결과 보고서·운영 문서·배포 준비 정리" items={ops} />
        <Section title="기타 에이전트" desc="기준선 11개 외 에이전트" items={other} />
      </div>
    );
  };

  // 정합성 C2-c — 프로젝트(1차) → 역할(2차) 2단 그룹. 1차 키는 agent.projectPath 를
  //   useProjectScope.resolveProjectId 로 정규화(9가지 변형 흡수). 미해석은 '미분류'.
  const renderByProject = (list: typeof filteredAgents) => {
    const byProject = new Map<string, typeof filteredAgents>();
    for (const a of list) {
      const pid = resolveProjectId({ projectPath: a.projectPath, projectId: a.id }) ?? '__unresolved__';
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid)!.push(a);
    }
    // 정렬: 알려진 프로젝트(capsule 순) 먼저, 미분류 마지막.
    const order = [...scopeProjects.map((p) => p.projectId), '__unresolved__'];
    const keys = [...byProject.keys()].sort((x, y) => order.indexOf(x) - order.indexOf(y));
    const nameOf = (pid: string) =>
      pid === '__unresolved__' ? '미분류 (프로젝트 매핑 없음)' : scopeProjects.find((p) => p.projectId === pid)?.name || pid;
    return (
      <div className="space-y-8">
        {keys.map((pid) => (
          <section key={pid}>
            <div className="flex items-center gap-2 mb-3 pb-1.5 border-b border-border">
              <FolderKanban className="w-4 h-4 text-primary" />
              <h2 className="text-base font-semibold text-foreground">{nameOf(pid)}</h2>
              <span className="text-xs text-muted-foreground">({byProject.get(pid)!.length})</span>
            </div>
            {renderRoleGrouped(byProject.get(pid)!)}
          </section>
        ))}
      </div>
    );
  };

  // Build edit agent data from editAgentId
  const editAgentData: EditAgentData | null = useMemo(() => {
    if (!editAgentId) return null;
    const agent = agents.find(a => a.id === editAgentId);
    if (!agent) return null;
    return {
      id: agent.id,
      name: agent.name,
      character: agent.character,
      projectPath: agent.projectPath,
      secondaryProjectPath: agent.secondaryProjectPath,
      skills: agent.skills,
      permissionMode: agent.permissionMode ?? (agent.skipPermissions ? 'auto' : 'normal'),
      effort: agent.effort,
      provider: agent.provider,
      model: agent.model,
      localModel: agent.localModel,
      branchName: agent.branchName,
      obsidianVaultPaths: agent.obsidianVaultPaths,
      savedPrompt: agent.savedPrompt,
    };
  }, [editAgentId, agents]);

  // Handlers
  const handleCreateAgent = useCallback(async (
    projectPath: string,
    skills: string[],
    prompt: string,
    model?: string,
    worktree?: { enabled: boolean; branchName: string },
    character?: AgentCharacter,
    name?: string,
    secondaryProjectPath?: string,
    permissionMode?: 'normal' | 'auto' | 'bypass',
    provider?: AgentProvider,
    localModel?: string,
    obsidianVaultPaths?: string[],
    effort?: 'low' | 'medium' | 'high',
  ) => {
    try {
      const resolvedModel = (provider !== 'local' && model && model !== 'default') ? model : undefined;
      const agent = await createAgent({ projectPath, skills, worktree, character, name, secondaryProjectPath, permissionMode, effort, provider, model: resolvedModel, localModel, obsidianVaultPaths });
      // 영구 매핑은 useElectronAgents.createAgent 가 선택 회사로 수행한다.
      // 여기서는 즉시 화면에 반영되도록 로컬 상태만 낙관적으로 갱신한다.
      const cid = companyInfo.selectedCompanyId;
      if (agent?.id && cid) {
        setCompanyInfo((prev) => ({
          ...prev,
          agentMappings: [
            ...prev.agentMappings.filter((m) => m.agentId !== agent.id),
            { agentId: agent.id, companyId: cid },
          ],
        }));
      }
      if (prompt) {
        const options = { model: resolvedModel, provider, localModel };
        await startAgent(agent.id, prompt, options);
      }
      setShowNewChatModal(false);
    } catch (error) {
      console.error('Failed to create agent:', error);
    }
  }, [createAgent, startAgent, companyInfo.selectedCompanyId]);

  const handleUpdateAgent = useCallback(async (id: string, updates: {
    skills?: string[];
    secondaryProjectPath?: string | null;
    permissionMode?: 'normal' | 'auto' | 'bypass';
    effort?: 'low' | 'medium' | 'high';
    name?: string;
    character?: AgentCharacter;
    model?: string | null;
    provider?: AgentProvider;
    localModel?: string | null;
    savedPrompt?: string | null;
    obsidianVaultPaths?: string[];
    worktree?: { enabled: boolean; branchName: string };
  }) => {
    try {
      await updateAgent({ id, ...updates });
      setEditAgentId(null);
    } catch (error) {
      console.error('Failed to update agent:', error);
    }
  }, [updateAgent]);

  const handleStartAgent = useCallback(async (agentId: string, prompt?: string) => {
    await startAgent(agentId, prompt || '');
  }, [startAgent]);

  const handleRemoveAgent = useCallback((agentId: string) => {
    removeAgent(agentId);
  }, [removeAgent]);

  const handleSaveAsTemplate = useCallback(async (agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;
    const suggested = agent.name?.trim() || `Agent ${agent.id.slice(0, 4)}`;
    const name = window.prompt('Save as template — name?', suggested);
    if (!name?.trim()) return;
    const result = await createTemplate({
      displayName: name.trim(),
      description: `Saved from agent "${agent.name ?? ''}"`.trim(),
      icon: '📦',
      character: agent.character,
      provider: agent.provider,
      model: agent.model,
      localModel: agent.localModel,
      permissionMode: agent.permissionMode ?? (agent.skipPermissions ? 'auto' : 'normal'),
      effort: agent.effort,
      skills: agent.skills,
      obsidianVaultPaths: agent.obsidianVaultPaths,
      savedPrompt: agent.savedPrompt,
    });
    if (!result.success) {
      alert(`Could not save template: ${result.error ?? 'unknown error'}`);
    }
  }, [agents, createTemplate]);

  const agentCountByProject = useCallback((path: string) => {
    return agents.filter(a => a.projectPath === path).length;
  }, [agents]);

  const cycleSortBy = useCallback(() => {
    setSortBy(prev => {
      if (prev === 'created') return 'status';
      if (prev === 'status') return 'activity';
      if (prev === 'activity') return 'name';
      return 'created';
    });
  }, []);

  // Early returns
  // Web fallback: if ~/.dorothy/agents.json was loaded via /api/dorothy/agents,
  // show the list (read-only). Otherwise fall back to desktop-required message.
  if (!hasElectron && typeof window !== 'undefined' && !agentsLoading && agents.length === 0) {
    return <DesktopRequiredMessage />;
  }

  if (agentsLoading && agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-accent-blue mx-auto mb-4" />
          <p className="text-text-secondary">Loading agents...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-3rem)] flex flex-col pt-4 lg:pt-6">
      <DomainTabs tabs={AGENT_DOMAIN} title="에이전트" bare />
      <AgentListHeader
        superAgent={superAgent}
        isCreatingSuperAgent={isCreatingSuperAgent}
        onSuperAgentClick={handleSuperAgentClick}
        onNewAgentClick={() => setShowNewChatModal(true)}
      />

      <ProjectFilterTabs
        uniqueProjects={uniqueProjects}
        projectFilter={projectFilter}
        totalAgentCount={agents.length}
        agentCountByProject={agentCountByProject}
        onFilterChange={setProjectFilter}
      />

      {/* Phase 6-AP — Codex 한도 시 orchestrator Claude fallback(confirm) 패널 */}
      <OrchestratorFallbackPanel />

      {/* Phase 6-AU — 스킬 자기개선 제안(저위험 자동·고위험 승인) */}
      <SkillProposalsPanel />

      {/* Phase 6-AM — 에이전트 운영 상태 요약 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-xs text-muted-foreground shrink-0">
        <span className="text-foreground font-medium">에이전트 운영 상태</span>
        <span>전체 <b className="text-foreground">{agents.length}</b></span>
        <span className="text-green-400">실행 {agents.filter(a => a.status === 'running').length}</span>
        <span className="text-amber-400">대기 {agents.filter(a => a.status === 'waiting').length}</span>
        <span className="text-rose-400">막힘 {agents.filter(a => a.status === 'error').length}</span>
        <span className="text-muted-foreground/70">유휴 {agents.filter(a => a.status === 'idle' || a.status === 'completed').length}</span>
        <span className="opacity-40">·</span>
        <span>개발 {agents.filter(a => ['backend', 'frontend'].includes(a.id)).length}</span>
        <span>계획·검증 {agents.filter(a => ['intake-planner', 'architect-plan', 'orchestrator', 'plan-validator', 'contract-agent', 'database-agent', 'qa-reviewer', 'security-reviewer'].includes(a.id)).length}</span>
        <span>운영·보고 {agents.filter(a => a.id === 'devops-reporter').length}</span>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {/* Status tabs */}
        <div className="flex items-center gap-1 [&_button]:cursor-pointer">
          <button
            onClick={() => setStatusFilter(null)}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition-colors ${
              !statusFilter ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            전체
            <span className={`px-1 py-px text-[10px] ${!statusFilter ? 'bg-background/20' : 'bg-muted'}`}>
              {agents.length}
            </span>
          </button>
          {Object.entries(STATUS_LABELS).map(([key, label]) => {
            const count = agents.filter(a => a.status === key).length;
            const colors = STATUS_COLORS[key as keyof typeof STATUS_COLORS];
            return (
              <button
                key={key}
                onClick={() => setStatusFilter(statusFilter === key ? null : key)}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition-colors capitalize ${
                  statusFilter === key ? `${colors.bg} ${colors.text}` : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
                {count > 0 && (
                  <span className={`px-1 py-px text-[10px] ${statusFilter === key ? 'bg-background/20' : colors.bg} ${statusFilter !== key ? colors.text : ''}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="에이전트 검색..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-border bg-card text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
          />
        </div>

        {/* Sort toggle */}
        <button
          onClick={cycleSortBy}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border bg-card hover:bg-accent/50 transition-colors cursor-pointer"
          title={`Sort by: ${sortBy}`}
        >
          <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-muted-foreground capitalize">{sortBy}</span>
        </button>

        {/* Count summary */}
        <div className="text-xs text-muted-foreground ml-auto hidden sm:flex items-center gap-3">
          <span>전체 {agents.length}</span>
          <span className="text-primary">실행 {runningCount}</span>
        </div>
      </div>

      {/* 회사별 보기 필터 */}
      {companyInfo.companies.length > 0 && (
        <div className="flex items-center gap-2 mb-3 text-sm shrink-0">
          <Building2 className="w-4 h-4 text-muted-foreground" />
          <span className="text-muted-foreground">회사별 보기</span>
          <select
            value={companyView}
            onChange={(e) => setCompanyView(e.target.value)}
            className="px-2 py-1 rounded-md border border-border bg-background text-sm"
          >
            {companyInfo.companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
            <option value="__all__">전체 회사</option>
          </select>
          {!isAllView && (
            <span className="text-xs text-muted-foreground">
              {currentCompanyName} {companyAgents.length}개 · 미분류 {unmappedAgents.length}개
            </span>
          )}
        </div>
      )}

      {/* Agent Grid */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Phase 6-AM — 고급 레지스트리는 기본 접힘 처리(기능 유지). */}
        <details className="mb-3 rounded-md border border-border bg-secondary/30">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
            고급: 에이전트 정의 / 레지스트리 (정의 파일 · 등록 · 라이브 세션 · 통신 · 재로드)
          </summary>
          <div className="p-2 border-t border-border">
            <AgentRegistryPanel />
          </div>
        </details>
        {scopedAgents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Bot className="w-12 h-12 text-muted-foreground/30 mb-4" />
            <p className="text-muted-foreground text-sm mb-2">
              {agents.length === 0 ? '아직 에이전트가 없습니다' : '필터에 맞는 에이전트가 없습니다'}
            </p>
            {agents.length === 0 ? (
              <button
                onClick={() => setShowNewChatModal(true)}
                className="text-primary text-sm hover:underline cursor-pointer"
              >
                첫 에이전트 만들기
              </button>
            ) : (
              <button
                onClick={() => { setProjectFilter(null); setStatusFilter(null); setSearchQuery(''); }}
                className="text-primary text-sm hover:underline cursor-pointer"
              >
                필터 초기화
              </button>
            )}
          </div>
        ) : isAllView ? (
          renderByProject(scopedAgents)
        ) : (
          <div className="space-y-5">
            <section>
              <h3 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2">
                <Building2 className="w-4 h-4" /> {currentCompanyName}
                <span className="text-xs font-normal">({companyAgents.length})</span>
              </h3>
              {companyAgents.length > 0 ? (
                renderAgentGrid(companyAgents)
              ) : (
                <p className="text-sm text-muted-foreground py-4">이 회사에 표시할 에이전트가 없습니다.</p>
              )}
            </section>
            {unmappedAgents.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2">
                  미분류 <span className="text-xs font-normal">({unmappedAgents.length})</span>
                </h3>
                {renderAgentGrid(unmappedAgents)}
              </section>
            )}
          </div>
        )}
      </div>

      {/* Create Modal */}
      <NewChatModal
        open={showNewChatModal}
        onClose={() => setShowNewChatModal(false)}
        onSubmit={handleCreateAgent}
        projects={projects.map(p => ({ path: p.path, name: p.name }))}
        onBrowseFolder={isElectron() ? openFolderDialog : undefined}
        installedSkills={installedSkills}
        allInstalledSkills={claudeData?.skills || []}
        onRefreshSkills={refreshSkills}
      />

      {/* Super Agent Create Modal */}
      <NewChatModal
        open={showSuperAgentModal}
        onClose={() => setShowSuperAgentModal(false)}
        onSubmit={handleCreateAgent}
        projects={projects.map(p => ({ path: p.path, name: p.name }))}
        onBrowseFolder={isElectron() ? openFolderDialog : undefined}
        installedSkills={installedSkills}
        allInstalledSkills={claudeData?.skills || []}
        onRefreshSkills={refreshSkills}
        initialOrchestrator
      />

      {/* Edit Modal — reuses NewChatModal pre-filled with agent data */}
      <NewChatModal
        open={!!editAgentId}
        onClose={() => setEditAgentId(null)}
        onSubmit={handleCreateAgent}
        onUpdate={handleUpdateAgent}
        editAgent={editAgentData}
        projects={projects.map(p => ({ path: p.path, name: p.name }))}
        onBrowseFolder={isElectron() ? openFolderDialog : undefined}
        installedSkills={installedSkills}
        allInstalledSkills={claudeData?.skills || []}
        onRefreshSkills={refreshSkills}
        initialStep={1}
      />

      {/* Terminal Dialog — click card body to view */}
      <AgentTerminalDialog
        agent={viewAgentId ? agents.find(a => a.id === viewAgentId) || null : null}
        open={!!viewAgentId}
        onClose={() => setViewAgentId(null)}
        onStart={(id, prompt) => handleStartAgent(id, prompt)}
        onStop={stopAgent}
        projects={projects.map(p => ({ path: p.path, name: p.name }))}
        agents={agents}
        onBrowseFolder={isElectron() ? openFolderDialog : undefined}
      />
    </div>
  );
}
