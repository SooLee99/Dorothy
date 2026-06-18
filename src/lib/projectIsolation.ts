/**
 * Phase 6-AK — project isolation helpers (pure, testable).
 *
 * Ensures each App Factory project gets its OWN projectId / rootPath / env /
 * vault / ports / kanban so projects never collide with triplan or each other.
 * No filesystem or DB side effects — pure suggestion/normalization functions.
 */

import type { AppCandidate } from './../types/dorothy';
import type { AppProjectCapsule, CapsuleKanbanPreviewTask } from './../types/appProjectCapsule';
import { ALL_OPERATION_AGENT_IDS } from './agentProcessDisplay';

const HOME = '/Users/soo';
const APPS_ROOT = `${HOME}/workspace/source-code/apps`;

/** Slugify into a safe projectId (lowercase, dash-separated, ascii). */
export function normalizeProjectId(input: string | null | undefined): string {
  const s = (input ?? '').toString().trim().toLowerCase();
  const slug = s
    .replace(/[\s_]+/g, '-')        // spaces/underscores → dash FIRST
    .replace(/[^a-z0-9가-힣-]/g, '') // then strip invalid (keep dash)
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'project';
}

export function suggestProjectSlug(candidate: { projectSlug?: string; title?: string }): string {
  return normalizeProjectId(candidate.projectSlug || candidate.title || 'app');
}

export function suggestProjectRootPath(projectId: string): string {
  return `${APPS_ROOT}/${normalizeProjectId(projectId)}`;
}

export function suggestEnvNamespace(projectId: string): string {
  // UPPER_SNAKE, prefixed so it never overwrites triplan env.
  return `APP_${normalizeProjectId(projectId).toUpperCase().replace(/-/g, '_')}`;
}

export function suggestVaultNamespace(projectId: string): string {
  return `project:${normalizeProjectId(projectId)}`;
}

export function suggestReportsPath(projectId: string): string {
  return `${HOME}/.dorothy/reports/projects/${normalizeProjectId(projectId)}`;
}

export function suggestLogsPath(projectId: string): string {
  return `${HOME}/.dorothy/logs/projects/${normalizeProjectId(projectId)}`;
}

/**
 * Deterministic, collision-avoiding port pair derived from the projectId.
 * Frontend in 3600–3899, backend in 8100–8399 (away from triplan 3500/8080).
 */
export function suggestPorts(projectId: string): { frontendPort: number; backendPort: number } {
  const id = normalizeProjectId(projectId);
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return {
    frontendPort: 3600 + (h % 300),
    backendPort: 8100 + (h % 300),
  };
}

export function isSameProject(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeProjectId(a) === normalizeProjectId(b) && !!a && !!b;
}

/** projectId fallback: missing → 'triplan' (legacy), present → normalized. */
export function projectIdOrLegacy(projectId: string | null | undefined): string {
  if (!projectId || !projectId.toString().trim()) return 'triplan';
  return normalizeProjectId(projectId);
}

/**
 * Build a draft/ready capsule from a candidate — PURE (no fs/db). `now` and
 * `id` are injected by the caller (avoid Date.now()/random in pure code).
 */
export function buildCapsuleFromCandidate(
  candidate: AppCandidate,
  opts: { id: string; now: string; status?: 'draft' | 'ready' },
): AppProjectCapsule {
  const projectId = suggestProjectSlug(candidate);
  const ports = suggestPorts(projectId);
  const root = candidate.suggestedProjectPath || suggestProjectRootPath(projectId);
  return {
    id: opts.id,
    appCandidateId: candidate.id,
    projectId,
    projectName: candidate.title || projectId,
    companyName: candidate.companyName || `${projectId}-company`,
    status: opts.status ?? 'ready',
    rootPath: root,
    frontendPath: `${root}/frontend`,
    backendPath: `${root}/backend`,
    packageManager: 'mixed',
    techStack: [],
    frontendPort: ports.frontendPort,
    backendPort: ports.backendPort,
    envNamespace: suggestEnvNamespace(projectId),
    vaultNamespace: suggestVaultNamespace(projectId),
    kanbanProjectId: projectId,
    reportsPath: suggestReportsPath(projectId),
    logsPath: suggestLogsPath(projectId),
    dataSources: candidate.apiSources ?? [],
    mvpScope: candidate.coreMvpFeatures ?? [],
    outOfScope: [],
    riskPolicy: candidate.risks ?? [],
    createdAt: opts.now,
    updatedAt: opts.now,
  };
}

/** The 10-step pipeline → preview tasks (NOT persisted). ownerAgentId is one of the 11 baseline. */
const PIPELINE: { ownerAgentId: string; title: string; description: string; riskLevel: 'low' | 'medium' | 'high'; requiresApproval: boolean }[] = [
  { ownerAgentId: 'intake-planner',    title: '요구사항 정리',        description: 'MVP 범위·사용자·수용 기준 정리', riskLevel: 'low', requiresApproval: false },
  { ownerAgentId: 'architect-plan',    title: '기술 구조 설계',        description: '아키텍처·의존성·전략(/deep-analysis)', riskLevel: 'low', requiresApproval: false },
  { ownerAgentId: 'plan-validator',    title: '범위/위험 검증',        description: '위험도 분류·승인 게이트 판정', riskLevel: 'medium', requiresApproval: false },
  { ownerAgentId: 'contract-agent',    title: 'API/data contract',     description: 'FE/BE 공유 API·데이터 계약', riskLevel: 'low', requiresApproval: false },
  { ownerAgentId: 'database-agent',    title: 'DB/데이터 적재 설계',   description: '스키마·인덱스·ingestion 설계', riskLevel: 'medium', requiresApproval: false },
  { ownerAgentId: 'backend',           title: '백엔드 구현',           description: 'API/도메인/서비스 구현', riskLevel: 'medium', requiresApproval: false },
  { ownerAgentId: 'frontend',          title: '프론트엔드 구현',       description: 'UI/UX/상태/연동(/frontend-design)', riskLevel: 'medium', requiresApproval: false },
  { ownerAgentId: 'qa-reviewer',       title: 'QA/테스트',             description: '경계면 교차검증·회귀', riskLevel: 'low', requiresApproval: false },
  { ownerAgentId: 'security-reviewer', title: '보안/secret/API key 검토', description: '보안 점검(/code-review-security)', riskLevel: 'high', requiresApproval: true },
  { ownerAgentId: 'devops-reporter',   title: '보고서/실행 문서',      description: '결과 보고·운영 문서(/devops)', riskLevel: 'low', requiresApproval: false },
];

export function generateKanbanPreview(capsule: Pick<AppProjectCapsule, 'projectId' | 'kanbanProjectId'>): CapsuleKanbanPreviewTask[] {
  const baseline = new Set(ALL_OPERATION_AGENT_IDS);
  return PIPELINE.map((p, i) => {
    const ownerAgentId = baseline.has(p.ownerAgentId) ? p.ownerAgentId : 'orchestrator';
    return {
      projectId: capsule.projectId,
      kanbanProjectId: capsule.kanbanProjectId,
      ownerAgentId,
      title: p.title,
      description: p.description,
      riskLevel: p.riskLevel,
      requiresApproval: p.requiresApproval,
      order: i,
    };
  });
}

/** Per-agent work-distribution policy + WIP limits (display + planning). */
export const AGENT_DISTRIBUTION_POLICY: string[] = [
  '기본 프로세스 8개(intake/architect/plan-validator/contract/database/qa/devops/orchestrator)는 계획·검증·문서·오케스트레이션 중심',
  'backend/frontend는 실제 구현 중심',
  'security-reviewer는 보안 검토 중심',
  '한 에이전트는 동시에 한 프로젝트의 active task만 수행',
  'orchestrator는 project priority · blocked status · owner role · WIP limit 기준으로 배정',
  '위험 작업(SEC/auth/push/secret/DB/production)은 ApprovalRequest로 분리',
];

export const WIP_LIMITS: Record<string, number> = {
  orchestrator: 1, 'intake-planner': 1, 'architect-plan': 1, 'plan-validator': 1,
  'contract-agent': 1, 'database-agent': 1, backend: 1, frontend: 1,
  'qa-reviewer': 1, 'security-reviewer': 1, 'devops-reporter': 1,
};

// Phase 6-AS — 생성 마법사 검증/표시용 상수.
/** projectId 허용 형식: 영문 소문자·숫자·하이픈만. */
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** triplan 등 기존 점유 포트(충돌 경고용). */
export const RESERVED_PORTS: number[] = [3000, 3500, 8080];
/** 마법사 마지막 단계에 읽기전용으로 보여줄 에이전트 업무 흐름. */
export const PROJECT_AGENT_FLOW: { agentId: string; role: string }[] = [
  { agentId: 'intake-planner', role: '요구사항 정리' },
  { agentId: 'architect-plan', role: '구조 설계' },
  { agentId: 'plan-validator', role: '범위/위험 검증' },
  { agentId: 'contract-agent', role: 'API 계약' },
  { agentId: 'database-agent', role: '데이터 모델' },
  { agentId: 'backend', role: '백엔드 구현' },
  { agentId: 'frontend', role: '프론트엔드 구현' },
  { agentId: 'qa-reviewer', role: '테스트/검증' },
  { agentId: 'security-reviewer', role: '보안/secret/API 키 검토' },
  { agentId: 'devops-reporter', role: '보고서/운영 문서' },
  { agentId: 'orchestrator', role: '전체 조율' },
];
