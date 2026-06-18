/**
 * Phase 6-L — static agent process diagrams (global + per-agent).
 *
 * Pure data. The component merges live registry status (available / missing /
 * blocked / spawnable) onto nodes that carry an `agentId`. No new UI library —
 * rendered with CSS node cards + arrow connectors.
 */

export type ProcessNodeStatus = 'available' | 'missing' | 'blocked' | 'running' | 'idle';

export interface AgentProcessNode {
  id: string;
  label: string;
  agentId?: string;
  description?: string;
}

export interface AgentProcessEdge {
  from: string;
  to: string;
  label?: string;
}

export interface AgentProcessDiagram {
  id: string;
  title: string;
  scope: 'global' | 'agent';
  agentId?: string;
  nodes: AgentProcessNode[];
  edges: AgentProcessEdge[];
}

/** Linear helper — turns a list of nodes into a chain of edges. */
function chain(nodes: AgentProcessNode[]): AgentProcessEdge[] {
  const edges: AgentProcessEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) edges.push({ from: nodes[i].id, to: nodes[i + 1].id });
  return edges;
}

/* ============================================================================
 * Global development process
 * ========================================================================== */

const GLOBAL_NODES: AgentProcessNode[] = [
  { id: 'request', label: '요청 접수', description: '사용자 / Kanban / PM-tick 요청' },
  { id: 'intake', label: '요구사항 정리', agentId: 'intake-planner' },
  { id: 'architect', label: '설계·계획', agentId: 'architect-plan' },
  { id: 'orchestrator', label: '실행 준비(오케스트레이터)', agentId: 'orchestrator' },
  { id: 'validator', label: '계획 검증', agentId: 'plan-validator' },
  { id: 'approval', label: '승인 대기', description: 'ApprovalRequest 게이트' },
  { id: 'run', label: '실행(Run)', description: 'RunStep 디스패치' },
  { id: 'contract', label: '계약/API 설계', agentId: 'contract-agent' },
  { id: 'database', label: '데이터베이스 검토', agentId: 'database-agent' },
  { id: 'frontend', label: '프론트엔드 개발', agentId: 'frontend' },
  { id: 'backend', label: '백엔드 개발', agentId: 'backend' },
  { id: 'qa', label: 'QA·리뷰', agentId: 'qa-reviewer' },
  { id: 'devops', label: '문서·보고', agentId: 'devops-reporter' },
  { id: 'prci', label: 'PR·CI 확인', description: 'PullRequest + CIRun' },
  { id: 'report', label: '완료 보고', description: 'result-report.md' },
  { id: 'diagnostics', label: '진단·수정', description: '실패 → 원인 분석' },
  { id: 'improvement', label: '개선 후보 수집', description: '반복 패턴' },
  { id: 'skill', label: '스킬 후보', description: '관리자 검토 후 스킬 준비' },
];

const GLOBAL_DIAGRAM: AgentProcessDiagram = {
  id: 'global',
  title: 'End-to-end development process',
  scope: 'global',
  nodes: GLOBAL_NODES,
  edges: [
    ...chain(GLOBAL_NODES.slice(0, GLOBAL_NODES.findIndex(n => n.id === 'contract') + 1)),
    // contract → frontend/backend/qa fan-out
    { from: 'contract', to: 'database' },
    { from: 'contract', to: 'frontend' },
    { from: 'contract', to: 'backend' },
    { from: 'database', to: 'backend' },
    { from: 'frontend', to: 'qa' },
    { from: 'backend', to: 'qa' },
    { from: 'qa', to: 'devops' },
    { from: 'devops', to: 'prci' },
    { from: 'prci', to: 'report' },
    { from: 'qa', to: 'diagnostics', label: 'on failure' },
    { from: 'diagnostics', to: 'improvement' },
    { from: 'improvement', to: 'skill' },
  ],
};

/* ============================================================================
 * Per-agent processes
 * ========================================================================== */

function agentDiagram(
  id: string, title: string, agentId: string, steps: string[], handoffTo?: string,
): AgentProcessDiagram {
  const nodes: AgentProcessNode[] = steps.map((label, i) => ({ id: `${id}-${i}`, label }));
  // Anchor the agent itself onto the first node so its registry status shows.
  if (nodes[0]) nodes[0].agentId = agentId;
  const edges = chain(nodes);
  if (handoffTo) {
    const tail: AgentProcessNode = { id: `${id}-out`, label: handoffTo };
    nodes.push(tail);
    edges.push({ from: nodes[nodes.length - 2].id, to: tail.id, label: 'handoff' });
  }
  return { id, title, scope: 'agent', agentId, nodes, edges };
}

const AGENT_DIAGRAMS: AgentProcessDiagram[] = [
  agentDiagram('intake-planner', 'Intake / Planner', 'intake-planner',
    ['Request intake', 'Requirement summary', 'Scope', 'Acceptance criteria', 'Task draft'], '→ Architect / Plan'),
  agentDiagram('architect-plan', 'Architect / Plan', 'architect-plan',
    ['Requirements', 'Design', 'API/UI/DB impact', 'Workflow template'], '→ Plan Validator'),
  agentDiagram('plan-validator', 'Plan Validator', 'plan-validator',
    ['Plan', 'Path policy check', 'Dependency check', 'Validation command check', 'approval_required / approved']),
  agentDiagram('orchestrator', 'Orchestrator', 'orchestrator',
    ['Approved plan', 'RunStep ordering', 'Dispatch readiness check', 'Start agent', 'Collect handoff', 'Retry / block / continue']),
  agentDiagram('contract-agent', 'Contract Agent', 'contract-agent',
    ['API requirement', 'Contract draft', 'DTO / schema', 'Error codes', 'Contract handoff'], '→ Frontend / Backend / QA'),
  agentDiagram('database-agent', 'Database Agent', 'database-agent',
    ['DB impact', 'Migration plan', 'Rollback plan', 'DB handoff'], '→ Backend / QA'),
  agentDiagram('frontend', 'Frontend Agent', 'frontend',
    ['Contract handoff', 'UI implementation', 'Frontend validation', 'Frontend handoff'], '→ QA'),
  agentDiagram('backend', 'Backend Agent', 'backend',
    ['Contract / DB handoff', 'API implementation', 'Backend validation', 'Backend handoff'], '→ QA'),
  agentDiagram('qa-reviewer', 'QA / Reviewer', 'qa-reviewer',
    ['Handoffs', 'Test commands', 'Review', 'Approve / change request'], '→ DevOps (or Diagnostics on failure)'),
  agentDiagram('devops-reporter', 'DevOps / Reporter', 'devops-reporter',
    ['QA passed', 'Report', 'PR body', 'CI watch', 'Result report']),
  agentDiagram('diagnostics', 'Diagnostics', 'diagnostics',
    ['Failure event', 'Root cause', 'Suggested fix'], '→ ImprovementSignal'),
  agentDiagram('skill-candidate', 'SkillCandidate', 'skill-candidate',
    ['ImprovementSignal', 'Skill candidate', 'Admin review', 'Ready for registry']),
];

export const PROCESS_DIAGRAMS: AgentProcessDiagram[] = [GLOBAL_DIAGRAM, ...AGENT_DIAGRAMS];

export function getGlobalDiagram(): AgentProcessDiagram {
  return GLOBAL_DIAGRAM;
}

export function getAgentDiagrams(): AgentProcessDiagram[] {
  return AGENT_DIAGRAMS;
}
