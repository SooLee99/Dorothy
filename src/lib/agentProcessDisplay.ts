/**
 * Phase 6-N — process-based agent display registry (renderer-only).
 *
 * Maps an internal agentId (slug like `backend`, the .claude/agents file id, or
 * a configured-agent role) to a Korean *process-based* display name + role /
 * phase / inputs / outputs / next-agents. This is DISPLAY ONLY — internal
 * agentIds, provider, and model are never changed; they remain available as
 * secondary info on every screen.
 */

export interface ProcessAgentDisplay {
  agentId: string;
  processNameKo: string;
  processNameEn: string;
  shortNameKo: string;
  roleKo: string;
  phaseKo: string;
  descriptionKo: string;
  inputKo: string[];
  outputKo: string[];
  /** Next agentIds in the flow (resolve via resolveProcessDisplay). */
  nextAgents: string[];
  legacyAliases: string[];
}

export function normalizeAgentKey(id: string | null | undefined): string {
  if (!id) return '';
  return id.toLowerCase().replace(/[\s\-./]+/g, '_').replace(/^_+|_+$/g, '');
}

const REGISTRY: ProcessAgentDisplay[] = [
  {
    agentId: 'intake-planner',
    processNameKo: '요청 접수·기획 에이전트', processNameEn: 'Intake / Planner', shortNameKo: '요청 접수',
    roleKo: '요청 분류·요구사항 정리', phaseKo: '요청 접수',
    descriptionKo: '외부 요청을 분류하고 요구사항을 정리해 작업으로 분해합니다.',
    inputKo: ['사용자 요청', 'Kanban 카드'], outputKo: ['요구사항 요약', 'task 초안'],
    nextAgents: ['architect-plan'], legacyAliases: ['intake', 'planner'],
  },
  {
    agentId: 'architect-plan',
    processNameKo: '설계·계획 에이전트', processNameEn: 'Architect / Plan', shortNameKo: '설계·계획',
    roleKo: '설계·계획 수립', phaseKo: '설계·계획',
    descriptionKo: '요구사항을 설계로 옮기고 task와 검증 기준을 정의합니다.',
    inputKo: ['요구사항 요약'], outputKo: ['design.md', 'task 목록'],
    nextAgents: ['plan-validator', 'orchestrator'], legacyAliases: ['architect'],
  },
  {
    agentId: 'plan-validator',
    processNameKo: '계획 검증 에이전트', processNameEn: 'Plan Validator', shortNameKo: '계획 검증',
    roleKo: '위험도·정책 검증', phaseKo: '계획 검증',
    descriptionKo: '계획의 위험도·금지경로·검증명령을 점검하고 승인 여부를 결정합니다.',
    inputKo: ['Plan'], outputKo: ['승인/조건부/거절 판정'],
    nextAgents: ['orchestrator'], legacyAliases: ['approval', 'approval-validator', 'approval-manager', '승인 관리자'],
  },
  {
    agentId: 'orchestrator',
    processNameKo: '실행 오케스트레이터', processNameEn: 'Orchestrator', shortNameKo: '오케스트레이터',
    roleKo: 'RunStep 디스패치·조율', phaseKo: '실행 준비',
    descriptionKo: '승인된 계획의 RunStep을 위상정렬해 워커에게 디스패치하고 인계를 조율합니다.',
    inputKo: ['승인된 Plan'], outputKo: ['RunStep 디스패치', '인계 라우팅'],
    nextAgents: ['contract-agent', 'database-agent', 'frontend', 'backend'], legacyAliases: [],
  },
  {
    agentId: 'contract-agent',
    processNameKo: '계약/API 설계 에이전트', processNameEn: 'Contract Agent', shortNameKo: '계약/API',
    roleKo: 'API 계약 설계', phaseKo: '계약/API 설계',
    descriptionKo: 'FE/BE 공유 API 계약·DTO·에러코드를 확정합니다. 구현 코드는 작성하지 않습니다.',
    inputKo: ['요구사항', 'acceptanceCriteria'], outputKo: ['api-contract.md', 'dto-schema.json'],
    nextAgents: ['frontend', 'backend', 'qa-reviewer'], legacyAliases: ['contract', 'api-contract'],
  },
  {
    agentId: 'database-agent',
    processNameKo: '데이터베이스 에이전트', processNameEn: 'Database Agent', shortNameKo: 'DB',
    roleKo: 'DB 영향·마이그레이션 설계', phaseKo: '데이터베이스 검토',
    descriptionKo: 'DB 영향을 분석하고 마이그레이션/롤백 계획을 작성합니다. 실제 실행은 하지 않습니다.',
    inputKo: ['요구사항', 'design.md'], outputKo: ['db-impact-report.md', 'migration-plan.md'],
    nextAgents: ['backend', 'qa-reviewer'], legacyAliases: ['database', 'db', 'migration-agent'],
  },
  {
    agentId: 'frontend',
    processNameKo: '프론트엔드 개발 에이전트', processNameEn: 'Frontend Agent', shortNameKo: '프론트엔드',
    roleKo: 'UI 구현', phaseKo: '프론트엔드 개발',
    descriptionKo: '계약을 바탕으로 UI를 구현하고 검증 후 인계합니다.',
    inputKo: ['api-contract.md'], outputKo: ['frontend-handoff.md', '변경 파일'],
    nextAgents: ['qa-reviewer'], legacyAliases: ['프론트엔드 개발자'],
  },
  {
    agentId: 'backend',
    processNameKo: '백엔드 개발 에이전트', processNameEn: 'Backend Agent', shortNameKo: '백엔드',
    roleKo: 'API/서버 구현', phaseKo: '백엔드 개발',
    descriptionKo: '계약/DB 계획을 바탕으로 API·서버 로직을 구현하고 검증 후 인계합니다.',
    inputKo: ['api-contract.md', 'db-impact-report.md'], outputKo: ['backend-handoff.md', '변경 파일'],
    nextAgents: ['qa-reviewer'], legacyAliases: ['백엔드 개발자'],
  },
  {
    agentId: 'qa-reviewer',
    processNameKo: 'QA·리뷰 에이전트', processNameEn: 'QA / Reviewer', shortNameKo: 'QA·리뷰',
    roleKo: '테스트·리뷰', phaseKo: 'QA·리뷰',
    descriptionKo: '인계 문서를 읽고 acceptance criteria를 검증, 테스트를 실행하고 리뷰합니다.',
    inputKo: ['frontend/backend 인계'], outputKo: ['qa-review-report.md', 'change-request.md'],
    nextAgents: ['devops-reporter'], legacyAliases: ['qa', 'reviewer', 'QA'],
  },
  {
    agentId: 'devops-reporter',
    processNameKo: '문서·보고/DevOps 에이전트', processNameEn: 'DevOps / Reporter', shortNameKo: '문서·보고',
    roleKo: '보고·PR·CI', phaseKo: '문서·보고',
    descriptionKo: 'QA 결과를 정리해 결과 보고서·PR 본문을 작성하고 CI를 점검합니다.',
    inputKo: ['QA 인계'], outputKo: ['result-report.md', 'PR 본문'],
    nextAgents: [], legacyAliases: ['docs', 'reporter', 'devops', '문서화'],
  },
  {
    agentId: 'security-reviewer',
    processNameKo: '보안 검토 에이전트', processNameEn: 'Security Reviewer', shortNameKo: '보안 검토',
    roleKo: '보안 점검', phaseKo: 'QA·리뷰',
    descriptionKo: 'secret 노출·인증/인가·주입·CORS·의존성 취약점을 점검합니다.',
    inputKo: ['변경 diff'], outputKo: ['보안 검토 결과'],
    nextAgents: ['devops-reporter'], legacyAliases: ['security', '보안 검토'],
  },
  {
    agentId: 'ops',
    processNameKo: '운영 에이전트', processNameEn: 'Ops', shortNameKo: '운영',
    roleKo: '운영·배포 점검', phaseKo: '문서·보고',
    descriptionKo: '빌드/배포 절차·헬스체크·로그·런북을 점검합니다.',
    inputKo: ['운영 점검 요청'], outputKo: ['운영 점검 보고'],
    nextAgents: [], legacyAliases: ['운영 관리'],
  },
  {
    agentId: 'cost-optimizer',
    processNameKo: '비용 최적화 에이전트', processNameEn: 'Cost Optimizer', shortNameKo: '비용 최적화',
    roleKo: '비용 분석·절감', phaseKo: '문서·보고',
    descriptionKo: '쿼리/번들/인프라/엔진 비용을 분석하고 절감안을 제안합니다.',
    inputKo: ['비용 분석 요청'], outputKo: ['비용 절감 제안'],
    nextAgents: [], legacyAliases: ['비용 최적화'],
  },
  {
    agentId: 'pm',
    processNameKo: '기획 관리자 / PM', processNameEn: 'Project Manager', shortNameKo: 'PM',
    roleKo: '기획·조율', phaseKo: '요구사항 정리',
    descriptionKo: '요구사항을 분해하고 작업을 계획·분배하며 단계를 조율합니다.',
    inputKo: ['요청'], outputKo: ['작업 계획'],
    nextAgents: ['architect-plan'], legacyAliases: ['project-manager', 'PM (프로젝트 매니저)', 'pm-tick'],
  },
];

const BY_KEY = new Map<string, ProcessAgentDisplay>();
for (const d of REGISTRY) {
  BY_KEY.set(normalizeAgentKey(d.agentId), d);
  for (const alias of d.legacyAliases) BY_KEY.set(normalizeAgentKey(alias), d);
}

/** Resolve a process display for an agentId, or null when there is no mapping. */
export function lookupProcessDisplay(agentId: string | null | undefined): ProcessAgentDisplay | null {
  return BY_KEY.get(normalizeAgentKey(agentId)) ?? null;
}

/**
 * Process-based display name with a graceful fallback to the original id /
 * fallback name when no mapping exists (e.g. ad-hoc agents).
 */
export function processDisplayName(agentId: string | null | undefined, fallback?: string): string {
  const d = lookupProcessDisplay(agentId);
  if (d) return d.processNameKo;
  return fallback?.trim() || agentId || '(미상)';
}

export function processShortName(agentId: string | null | undefined, fallback?: string): string {
  const d = lookupProcessDisplay(agentId);
  if (d) return d.shortNameKo;
  return fallback?.trim() || agentId || '(미상)';
}

export function listProcessDisplays(): ProcessAgentDisplay[] {
  return REGISTRY;
}

/**
 * Phase 6-AB — process roster split.
 *
 *  - CORE_PROCESS_AGENT_IDS (8): the canonical MVP *process* agents. These are
 *    the default Terminal Board roster, always shown.
 *  - AUXILIARY_AGENT_IDS (3): development / verification executors (backend,
 *    frontend, security-reviewer). Kept in agents.json, but shown as a separate
 *    "보조" section — not part of the core 8.
 *  - ALL_OPERATION_AGENT_IDS (11): core + auxiliary = the full managed roster.
 *
 * `PROCESS_BASELINE_IDS` aliases CORE (8) per the 6-AB spec (Terminal Board
 * default). Process-vs-legacy classification uses the broader 11 so the 3
 * auxiliary slugs are never mistaken for legacy. DISPLAY classification only.
 */
export const CORE_PROCESS_AGENT_IDS: readonly string[] = [
  'intake-planner', 'architect-plan', 'orchestrator', 'plan-validator',
  'contract-agent', 'database-agent', 'qa-reviewer', 'devops-reporter',
];

export const AUXILIARY_AGENT_IDS: readonly string[] = [
  'backend', 'frontend', 'security-reviewer',
];

export const ALL_OPERATION_AGENT_IDS: readonly string[] = [
  ...CORE_PROCESS_AGENT_IDS,
  ...AUXILIARY_AGENT_IDS,
];

/** 6-AB: PROCESS_BASELINE_IDS = the core 8 (Terminal Board default roster). */
export const PROCESS_BASELINE_IDS: readonly string[] = CORE_PROCESS_AGENT_IDS;

const CORE_SET = new Set(CORE_PROCESS_AGENT_IDS.map(normalizeAgentKey));
const AUX_SET = new Set(AUXILIARY_AGENT_IDS.map(normalizeAgentKey));
const OPERATION_SET = new Set(ALL_OPERATION_AGENT_IDS.map(normalizeAgentKey));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** True for one of the 8 core process agents. */
export function isCoreProcessAgent(id: string | null | undefined): boolean {
  return CORE_SET.has(normalizeAgentKey(id));
}

/** True for one of the 3 development/verification auxiliary agents. */
export function isAuxiliaryAgent(id: string | null | undefined): boolean {
  return AUX_SET.has(normalizeAgentKey(id));
}

/** True for any managed operation agent (8 core + 3 auxiliary = 11). */
export function isOperationAgent(id: string | null | undefined): boolean {
  return OPERATION_SET.has(normalizeAgentKey(id));
}

/**
 * Process-vs-legacy classification. "Baseline" here means "a managed process
 * agent" (the full 11), so the 3 auxiliary slugs are NOT shown as legacy. The
 * Terminal Board's *core 8* uses PROCESS_BASELINE_IDS / isCoreProcessAgent.
 */
export function isProcessBaselineAgent(id: string | null | undefined): boolean {
  return OPERATION_SET.has(normalizeAgentKey(id));
}

/**
 * True when an agent is a legacy configured record (UUID-keyed) that is NOT part
 * of the managed operation roster — the old Korean-named / codex+opus agents the
 * automation engine still references by UUID. Kept for compatibility, excluded
 * from the default roster.
 */
export function isLegacyConfiguredAgent(id: string | null | undefined): boolean {
  if (isOperationAgent(id)) return false;
  return UUID_RE.test(id ?? '');
}
