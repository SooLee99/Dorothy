/**
 * Dorothy MVP Phase 6-B — AgentWorkflow templates.
 *
 * Each known agent role has a canonical sequence of named steps. These
 * templates are intentionally minimal — they describe *what the operator
 * watches for*, not the agent's actual internal reasoning loop. The
 * progress service maps HookEvents / RunSteps / Handoffs / Artifacts to
 * these named steps; the templates themselves never call out to LLMs.
 *
 * "Unknown" agent ids fall back to the `generic` template so the dashboard
 * has something to render even for ad-hoc agents.
 */

import type {
  AgentWorkflowKind,
  AgentWorkflowStepProgress,
} from '../../types/dorothy';

export interface WorkflowStepDefinition {
  stepId: string;
  label: string;
  description: string;
  expectedEvidence: ReadonlyArray<
    'agent_session_started'
    | 'agent_session_completed'
    | 'run_step_started'
    | 'run_step_completed'
    | 'run_step_failed'
    | 'handoff_created'
    | 'artifact_created'
    | 'ci_failed'
    | 'ci_passed'
    | 'qa_failed'
    | 'qa_passed'
    | 'approval_required'
    | 'approval_resolved'
    | 'rate_limit_detected'
    | 'resume_completed'
  >;
}

export interface WorkflowTemplate {
  kind: AgentWorkflowKind;
  label: string;
  description: string;
  steps: ReadonlyArray<WorkflowStepDefinition>;
}

/* ============================================================================
 * Templates — one per documented agent role
 *
 * Step ordering matters for `progressPercent` calculation. Skip a step by
 * marking it `skipped` rather than deleting it.
 * ========================================================================== */

const FRONTEND: WorkflowTemplate = {
  kind: 'frontend',
  label: 'Frontend',
  description: 'UI agent — reads the spec, verifies UI flow + API contract, implements, validates, hands off.',
  steps: [
    { stepId: 'spec_read',             label: 'Spec read',             description: 'Agent reads the Plan / RunStep prompt.', expectedEvidence: ['agent_session_started', 'run_step_started'] },
    { stepId: 'ui_flow_check',         label: 'UI flow check',         description: 'Confirms the screen flow matches the Plan.', expectedEvidence: [] },
    { stepId: 'api_contract_check',    label: 'API contract check',    description: 'Confirms backend contract assumptions before writing.', expectedEvidence: [] },
    { stepId: 'implementation',        label: 'Implementation',        description: 'Code changes land in the assigned worktree.', expectedEvidence: ['artifact_created'] },
    { stepId: 'frontend_validation',   label: 'Frontend validation',   description: 'Runs npm test / tsc / preview build.', expectedEvidence: ['artifact_created'] },
    { stepId: 'handoff',               label: 'Handoff',               description: 'Writes the frontend handoff for QA / Reporter.', expectedEvidence: ['handoff_created', 'agent_session_completed', 'run_step_completed'] },
  ],
};

const BACKEND: WorkflowTemplate = {
  kind: 'backend',
  label: 'Backend',
  description: 'API/server agent — designs, implements, validates, hands off.',
  steps: [
    { stepId: 'spec_read',             label: 'Spec read',             description: 'Agent reads the Plan / RunStep prompt.', expectedEvidence: ['agent_session_started', 'run_step_started'] },
    { stepId: 'api_design_check',      label: 'API design check',      description: 'Confirms request/response shapes against the contract.', expectedEvidence: [] },
    { stepId: 'db_impact_check',       label: 'DB impact check',       description: 'Verifies migration / schema safety before writing.', expectedEvidence: [] },
    { stepId: 'implementation',        label: 'Implementation',        description: 'Code changes land in backend modules.', expectedEvidence: ['artifact_created'] },
    { stepId: 'backend_validation',    label: 'Backend validation',    description: 'Runs gradle test / linter.', expectedEvidence: ['artifact_created'] },
    { stepId: 'handoff',               label: 'Handoff',               description: 'Writes the backend handoff for QA / Reporter.', expectedEvidence: ['handoff_created', 'agent_session_completed', 'run_step_completed'] },
  ],
};

const QA_REVIEWER: WorkflowTemplate = {
  kind: 'qa_reviewer',
  label: 'QA / Reviewer',
  description: 'Verifies acceptance criteria, runs tests, writes review.',
  steps: [
    { stepId: 'handoff_read',                label: 'Handoff read',                description: 'Reads frontend + backend handoffs.', expectedEvidence: ['agent_session_started', 'run_step_started'] },
    { stepId: 'acceptance_criteria_check',   label: 'AC check',                    description: 'Cross-checks each Plan acceptanceCriterion.', expectedEvidence: [] },
    { stepId: 'test_execution',              label: 'Test execution',              description: 'Runs the validation commands.', expectedEvidence: ['artifact_created'] },
    { stepId: 'review',                      label: 'Review',                      description: 'Writes review notes / changes_requested signal.', expectedEvidence: ['artifact_created', 'qa_failed', 'qa_passed'] },
    { stepId: 'qa_report',                   label: 'QA report',                   description: 'Final QA report + handoff to Reporter.', expectedEvidence: ['handoff_created', 'agent_session_completed', 'run_step_completed'] },
  ],
};

const DEVOPS_REPORTER: WorkflowTemplate = {
  kind: 'devops_reporter',
  label: 'DevOps / Reporter',
  description: 'Reads QA result, drafts changelog + PR body, summarises CI.',
  steps: [
    { stepId: 'qa_result_read',     label: 'QA result read',     description: 'Reads the QA handoff.', expectedEvidence: ['agent_session_started', 'run_step_started'] },
    { stepId: 'report_draft',       label: 'Report draft',       description: 'Drafts the result-report.md.', expectedEvidence: ['artifact_created'] },
    { stepId: 'pr_body_prepare',    label: 'PR body prepare',    description: 'Prepares PR title/body content.', expectedEvidence: ['artifact_created'] },
    { stepId: 'ci_summary_check',   label: 'CI summary check',   description: 'Cross-checks the CI run state.', expectedEvidence: ['ci_passed', 'ci_failed'] },
    { stepId: 'final_report',       label: 'Final report',       description: 'Closes out the Run with the final result-report.', expectedEvidence: ['handoff_created', 'agent_session_completed', 'run_step_completed'] },
  ],
};

const ARCHITECT_PLAN: WorkflowTemplate = {
  kind: 'architect_plan',
  label: 'Architect / Plan',
  description: 'Translates a request into a Plan with tasks + validation hooks.',
  steps: [
    { stepId: 'requirements_read',  label: 'Requirements read',  description: 'Reads the intake summary.', expectedEvidence: ['agent_session_started', 'run_step_started'] },
    { stepId: 'design_draft',       label: 'Design draft',       description: 'Drafts the high-level design.', expectedEvidence: ['artifact_created'] },
    { stepId: 'task_breakdown',     label: 'Task breakdown',     description: 'Breaks the design into tasks.', expectedEvidence: ['artifact_created'] },
    { stepId: 'agent_assignment',   label: 'Agent assignment',   description: 'Assigns owners to tasks.', expectedEvidence: [] },
    { stepId: 'validation_plan',    label: 'Validation plan',    description: 'Defines acceptance criteria / validation commands.', expectedEvidence: ['artifact_created', 'agent_session_completed', 'run_step_completed'] },
  ],
};

const INTAKE_PLANNER: WorkflowTemplate = {
  kind: 'intake_planner',
  label: 'Intake / Planner',
  description: 'Normalises a user request into an actionable scope.',
  steps: [
    { stepId: 'request_read',        label: 'Request read',        description: 'Reads the raw intake request.', expectedEvidence: ['agent_session_started', 'run_step_started'] },
    { stepId: 'requirements_summary', label: 'Requirements summary', description: 'Writes a short summary.', expectedEvidence: ['artifact_created'] },
    { stepId: 'scope_definition',    label: 'Scope definition',    description: 'Defines what is in / out of scope.', expectedEvidence: [] },
    { stepId: 'acceptance_criteria', label: 'Acceptance criteria', description: 'Drafts initial AC.', expectedEvidence: [] },
    { stepId: 'task_draft',          label: 'Task draft',          description: 'Hands off to Architect / Plan.', expectedEvidence: ['handoff_created', 'agent_session_completed', 'run_step_completed'] },
  ],
};

const ORCHESTRATOR: WorkflowTemplate = {
  kind: 'orchestrator',
  label: 'Orchestrator',
  description: 'Drives RunSteps, dispatch, and handoff routing.',
  steps: [
    { stepId: 'plan_read',         label: 'Plan read',         description: 'Reads the approved Plan.', expectedEvidence: [] },
    { stepId: 'run_created',       label: 'Run created',       description: 'Run row exists.', expectedEvidence: [] },
    { stepId: 'runstep_created',   label: 'RunStep created',   description: 'First RunStep is queued.', expectedEvidence: ['run_step_started'] },
    { stepId: 'dispatch',          label: 'Dispatch',          description: 'Live agent picked up the step.', expectedEvidence: ['agent_session_started'] },
    { stepId: 'monitor',           label: 'Monitor',           description: 'Watches for completions / failures.', expectedEvidence: [] },
    { stepId: 'handoff_route',     label: 'Handoff route',     description: 'Forwards artifacts to the next role.', expectedEvidence: ['handoff_created', 'run_step_completed'] },
  ],
};

const CONTRACT: WorkflowTemplate = {
  kind: 'contract',
  label: 'Contract Agent',
  description:
    'Owns the FE/BE API contract — endpoints, request/response shape, error codes. Never writes implementation code.',
  steps: [
    { stepId: 'requirements_read',         label: 'Requirements read',         description: 'Reads the request + acceptanceCriteria.', expectedEvidence: ['agent_session_started', 'run_step_started'] },
    { stepId: 'api_surface_identified',    label: 'API surface identified',    description: 'Enumerates the endpoints / methods / routes the change touches.', expectedEvidence: [] },
    { stepId: 'request_response_schema',   label: 'Request / response schema', description: 'Drafts DTOs, request bodies, response shapes.', expectedEvidence: ['artifact_created'] },
    { stepId: 'error_code_policy',         label: 'Error code policy',         description: 'Decides validation / auth / domain error codes.', expectedEvidence: ['artifact_created'] },
    { stepId: 'frontend_backend_contract', label: 'FE / BE contract',          description: 'Locks the shared contract document for fe/be to reference.', expectedEvidence: ['artifact_created'] },
    { stepId: 'contract_artifact',         label: 'Contract artifact',         description: 'Writes api-contract.md, openapi.yaml, dto-schema.json.', expectedEvidence: ['artifact_created', 'handoff_created', 'agent_session_completed', 'run_step_completed'] },
  ],
};

const DATABASE: WorkflowTemplate = {
  kind: 'database',
  label: 'Database Agent',
  description:
    'Analyses DB impact, drafts migration + rollback plans. Never executes migrations. Destructive operations require ApprovalRequest.',
  steps: [
    { stepId: 'db_impact_read',          label: 'DB impact read',           description: 'Reads the request + design.md for DB touch points.', expectedEvidence: ['agent_session_started', 'run_step_started'] },
    { stepId: 'schema_impact_analysis',  label: 'Schema impact analysis',   description: 'Identifies tables / indexes / relations / queries that change.', expectedEvidence: [] },
    { stepId: 'migration_plan',          label: 'Migration plan',           description: 'Drafts the migration SQL + safety notes.', expectedEvidence: ['artifact_created'] },
    { stepId: 'rollback_plan',           label: 'Rollback plan',            description: 'Drafts the reversal SQL + data-preservation strategy.', expectedEvidence: ['artifact_created'] },
    { stepId: 'risk_check',              label: 'Risk check',               description: 'Flags destructive ops, data loss, lock risk for ApprovalRequest.', expectedEvidence: ['approval_required', 'approval_resolved'] },
    { stepId: 'db_artifact',             label: 'DB artifact',              description: 'Writes db-impact-report.md, migration-plan.md, rollback-plan.md.', expectedEvidence: ['artifact_created', 'handoff_created', 'agent_session_completed', 'run_step_completed'] },
  ],
};

const APPROVAL_VALIDATOR: WorkflowTemplate = {
  kind: 'approval_validator',
  label: 'Approval Validator',
  description: 'Plan validator + ApprovalRequest gatekeeper.',
  steps: [
    { stepId: 'plan_read',           label: 'Plan read',           description: 'Reads the Plan.', expectedEvidence: [] },
    { stepId: 'risk_check',          label: 'Risk check',          description: 'Evaluates risk level.', expectedEvidence: [] },
    { stepId: 'path_check',          label: 'Forbidden path check', description: 'Looks for mentions of forbidden paths.', expectedEvidence: [] },
    { stepId: 'validation_check',    label: 'Validation check',    description: 'Confirms validationCommands when policy requires them.', expectedEvidence: [] },
    { stepId: 'approval_decision',   label: 'Approval decision',   description: 'Decides auto_approved / pending / rejected.', expectedEvidence: ['approval_required', 'approval_resolved'] },
  ],
};

const GENERIC: WorkflowTemplate = {
  kind: 'generic',
  label: 'Agent',
  description: 'Fallback for agents that do not have a named workflow yet.',
  steps: [
    { stepId: 'session_started',  label: 'Session started',  description: 'Agent PTY is live.', expectedEvidence: ['agent_session_started'] },
    { stepId: 'work',             label: 'Work',             description: 'Agent is making changes.', expectedEvidence: ['artifact_created', 'handoff_created'] },
    { stepId: 'completed',        label: 'Completed',        description: 'Agent reported done.', expectedEvidence: ['agent_session_completed', 'run_step_completed'] },
  ],
};

const TEMPLATE_REGISTRY: Record<AgentWorkflowKind, WorkflowTemplate> = {
  frontend:           FRONTEND,
  backend:            BACKEND,
  contract:           CONTRACT,
  database:           DATABASE,
  qa_reviewer:        QA_REVIEWER,
  devops_reporter:    DEVOPS_REPORTER,
  architect_plan:     ARCHITECT_PLAN,
  intake_planner:     INTAKE_PLANNER,
  orchestrator:       ORCHESTRATOR,
  approval_validator: APPROVAL_VALIDATOR,
  generic:            GENERIC,
};

/* ============================================================================
 * Public surface
 * ========================================================================== */

export function getWorkflowTemplate(kind: AgentWorkflowKind): WorkflowTemplate {
  return TEMPLATE_REGISTRY[kind] ?? GENERIC;
}

export function listWorkflowTemplates(): WorkflowTemplate[] {
  return Object.values(TEMPLATE_REGISTRY);
}

/**
 * Map an `agentId` to the canonical `AgentWorkflowKind`. Dashes and dots are
 * both supported (we see `qa-reviewer` and `qa_reviewer` interchangeably).
 * Unknown ids fall back to `generic`.
 */
export function resolveWorkflowKindForAgent(agentId: string | null | undefined): AgentWorkflowKind {
  if (!agentId) return 'generic';
  const norm = agentId.toLowerCase().replace(/[-./]/g, '_');
  switch (norm) {
    case 'frontend':           return 'frontend';
    case 'backend':            return 'backend';
    case 'qa':
    case 'qa_reviewer':
    case 'qa_reviewer_agent':
    case 'reviewer':           return 'qa_reviewer';
    case 'devops':
    case 'devops_reporter':
    case 'reporter':           return 'devops_reporter';
    case 'architect':
    case 'architect_plan':     return 'architect_plan';
    case 'intake':
    case 'intake_planner':
    case 'planner':            return 'intake_planner';
    case 'orchestrator':       return 'orchestrator';
    case 'approval':
    case 'approval_validator':
    case 'plan_validator':     return 'approval_validator';
    // Phase 6-C — Contract / Database agent aliases.
    case 'contract':
    case 'contract_agent':
    case 'api_contract':
    case 'api_contract_agent': return 'contract';
    case 'database':
    case 'database_agent':
    case 'db':
    case 'db_agent':
    case 'migration_agent':    return 'database';
    default:                   return 'generic';
  }
}

/**
 * Materialise the per-row steps array from a template. All steps start as
 * `pending` with no evidence.
 */
export function materializeSteps(kind: AgentWorkflowKind): AgentWorkflowStepProgress[] {
  const tpl = getWorkflowTemplate(kind);
  return tpl.steps.map(s => ({
    stepId: s.stepId,
    label: s.label,
    status: 'pending',
    evidenceHookEventIds: [],
    evidenceArtifactIds: [],
    evidenceHandoffIds: [],
  }));
}
