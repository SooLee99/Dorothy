/**
 * Frontend mirror of `electron/types/dorothy.ts`.
 *
 * Kept hand-in-hand with the main-process definitions: every field that the
 * renderer expects to read off an IPC payload appears here. If you add a
 * column to dorothy.db, mirror the type on both sides.
 */

export type RunState =
  | 'created'
  | 'planned'
  | 'approval_required'
  | 'approved'
  | 'running'
  | 'verifying'
  | 'needs_fix'
  | 'reporting'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type RunSource = 'user' | 'kanban' | 'pm_tick' | 'automation' | 'schedule';

export type Priority = 'low' | 'medium' | 'high' | 'critical';

export type RunStepState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type AgentSessionEndStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export type RateLimitEngine = 'claude' | 'codex' | 'gemini' | 'opencode' | 'pi';
export type RateLimitSource = 'pm_output' | 'usage_scan' | 'codex_rate_limits' | 'manual';

export type ArtifactType = 'patch' | 'test' | 'doc' | 'report' | 'review' | 'other';

export type PlanState = 'draft' | 'validating' | 'approved' | 'pending' | 'rejected';

export type ApprovalState =
  | 'pending'
  | 'auto_approved'
  | 'conditional'
  | 'user_approved'
  | 'rejected'
  | 'expired';

export type RunMode = 'manual' | 'team' | 'persistent' | 'ultraqa' | 'pipeline';
export type RunModeSource = 'manual' | 'keyword' | 'policy' | 'default';

export interface Run {
  id: string;
  title: string;
  source: RunSource;
  sourceRefId?: string | null;
  priority: Priority;
  state: RunState;
  blockedReason?: string | null;
  errorReason?: string | null;
  planId?: string | null;
  kanbanTaskId?: string | null;
  createdAt: string;
  startedAt?: string | null;
  closedAt?: string | null;
  comment?: string | null;
  // Phase 5D
  mode?: RunMode | null;
  modeSource?: RunModeSource | null;
  modeReason?: string | null;
}

export const RUN_MODE_BADGE: Record<RunMode, string> = {
  manual:     'bg-muted text-muted-foreground border-border',
  team:       'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  persistent: 'bg-purple-500/10 text-purple-500 border-purple-500/30',
  ultraqa:    'bg-blue-500/10 text-blue-500 border-blue-500/30',
  pipeline:   'bg-cyan-500/10 text-cyan-500 border-cyan-500/30',
};

export const RUN_MODE_DESCRIPTION: Record<RunMode, string> = {
  manual:     'Human-driven, no auto-retry, approval-heavy.',
  team:       'Default — Planner → FE/BE parallel → QA → Reporter.',
  persistent: 'Limited verify/fix loop; maxFixAttempts capped.',
  ultraqa:    'QA + Reviewer heavy; validation required.',
  pipeline:   'Strict sequential; no FE/BE parallel.',
};

export interface RunStep {
  id: string;
  runId: string;
  order: number;
  agentId: string;
  state: RunStepState;
  promptRef?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  retryCount: number;
  errorReason?: string | null;
  agentSessionId?: string | null;
}

export interface AgentSession {
  id: string;
  runId?: string | null;
  runStepId?: string | null;
  agentId: string;
  provider: string;
  worktreePath?: string | null;
  startedAt: string;
  exitedAt?: string | null;
  endStatus?: AgentSessionEndStatus | null;
  waitingForUserInput?: boolean;
  pid?: number | null;
  rawLogRef?: string | null;
}

export interface TaskDraft {
  taskId: string;
  title: string;
  description: string;
  ownerAgentId: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  estimatedRiskLevel?: Priority;
  /** Phase 4.5 — planner-supplied forbidden paths; optional, see main types. */
  forbiddenPaths?: string[];
  /** Phase 4.5 — planner-supplied validation commands; optional. */
  validationCommands?: string[];
}

export interface ContractDraft {
  contractId: string;
  kind: 'api' | 'schema' | 'event';
  spec: unknown;
  changeType: 'add' | 'modify' | 'deprecate' | 'remove';
}

export interface Plan {
  id: string;
  runId: string;
  title: string;
  description: string;
  state: PlanState;
  rejectionReason?: string | null;
  riskLevel?: Priority | null;
  adrRef?: string | null;
  contracts?: ContractDraft[];
  tasks: TaskDraft[];
  createdAt: string;
  updatedAt: string;
}

export interface Artifact {
  id: string;
  runId: string;
  runStepId?: string | null;
  type: ArtifactType;
  path?: string | null;
  contentRef?: string | null;
  producedByAgentId: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface Handoff {
  id: string;
  runId: string;
  fromRunStepId: string;
  toRunStepId: string;
  summary: string;
  attachedArtifactIds: string[];
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  planId?: string | null;
  riskLevel: Priority;
  topic?: string | null;
  state: ApprovalState;
  decidedBy?: 'auto' | 'user' | 'policy' | null;
  decidedAt?: string | null;
  decisionNote?: string | null;
  mirroredMdPath?: string | null;
  createdAt: string;
}

export type RateLimitProvider =
  | 'claude' | 'codex' | 'gemini' | 'opencode' | 'local';
export type RateLimitResumeStatus =
  | 'pending' | 'scheduled' | 'resuming' | 'resumed' | 'failed' | 'cancelled';
export type RateLimitSourceExtended =
  | RateLimitSource | 'pm_tick' | 'hook' | 'agent_output';

export interface RateLimitEvent {
  id: string;
  engine: RateLimitEngine;
  detectedAt: string;
  resetAt?: string | null;
  resumedAt?: string | null;
  resolvedAt?: string | null;
  source: RateLimitSourceExtended;
  message?: string | null;
  rawRef?: string | null;
  affectedRunIds?: string[];
  provider?: RateLimitProvider | null;
  resumeAt?: string | null;
  resumeStatus?: RateLimitResumeStatus | null;
  affectedSessionIds?: string[];
  affectedRunStepIds?: string[];
  retryCount?: number;
  lastResumeError?: string | null;
  messageExcerpt?: string | null;
  parseConfidence?: 'high' | 'medium' | 'low' | null;
}

export type ImprovementSignalSource =
  | 'qa_failure' | 'ci_failure' | 'rate_limit'
  | 'approval_required' | 'review_changes_requested'
  | 'retry_exceeded' | 'manual_note';
export type ImprovementSignalSeverity = 'low' | 'medium' | 'high';
export type ImprovementSignalStatus =
  | 'open' | 'triaged' | 'accepted' | 'dismissed' | 'converted_to_task';

export interface ImprovementSignal {
  id: string;
  runId?: string | null;
  source: ImprovementSignalSource;
  severity: ImprovementSignalSeverity;
  title: string;
  summary: string;
  evidenceArtifactIds?: string[];
  relatedAgentId?: string | null;
  relatedSkillId?: string | null;
  fingerprint?: string | null;
  occurrenceCount?: number;
  status: ImprovementSignalStatus;
  createdAt: string;
  updatedAt: string;
  convertedTaskId?: string | null;
}

export const IMPROVEMENT_SOURCE_BADGE: Record<ImprovementSignalSource, string> = {
  qa_failure:                'bg-orange-500/10 text-orange-500 border-orange-500/30',
  ci_failure:                'bg-rose-500/10 text-rose-500 border-rose-500/30',
  rate_limit:                'bg-yellow-500/10 text-yellow-500 border-yellow-500/30',
  approval_required:         'bg-amber-500/10 text-amber-500 border-amber-500/30',
  review_changes_requested:  'bg-orange-500/10 text-orange-500 border-orange-500/30',
  retry_exceeded:            'bg-rose-500/10 text-rose-500 border-rose-500/30',
  manual_note:               'bg-muted text-muted-foreground border-border',
};

export const IMPROVEMENT_STATUS_BADGE: Record<ImprovementSignalStatus, string> = {
  open:               'bg-blue-500/10 text-blue-500 border-blue-500/30',
  triaged:            'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  accepted:           'bg-purple-500/10 text-purple-500 border-purple-500/30',
  dismissed:          'bg-muted text-muted-foreground border-border',
  converted_to_task:  'bg-cyan-500/10 text-cyan-500 border-cyan-500/30',
};

/* ============================================================================
 * Phase 5A — PullRequest / CIRun (frontend mirror of electron/types/dorothy.ts).
 * ========================================================================== */

export type PullRequestProvider = 'github';
export type PullRequestState =
  | 'draft'
  | 'open'
  | 'review'
  | 'changes_requested'
  | 'merged'
  | 'closed';
export type ReviewerState =
  | 'pending'
  | 'approved'
  | 'changes_requested'
  | 'commented';

export interface PullRequestReviewer {
  name: string;
  state: ReviewerState;
}

export interface PullRequest {
  id: string;
  runId?: string | null;
  provider: PullRequestProvider;
  externalRef: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  branch: string;
  baseBranch: string;
  state: PullRequestState;
  title: string;
  bodyArtifactId?: string | null;
  authorAgentId?: string | null;
  reviewers?: PullRequestReviewer[];
  ciRunIds: string[];
  mergedAt?: string | null;
  closedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CIProvider = 'github_actions';
export type CIRunState =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface CIRun {
  id: string;
  runId?: string | null;
  pullRequestId?: string | null;
  provider: CIProvider;
  workflow: string;
  externalRef: string;
  url?: string | null;
  state: CIRunState;
  conclusion?: string | null;
  startedAt: string;
  completedAt?: string | null;
  logsUrl?: string | null;
  summary?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Tailwind colour classes for the upcoming /pr screen — kept here so the
 *  Run Detail's CI badge in Phase 5B reads from the same map. */
export const PR_STATE_BADGE: Record<PullRequestState, string> = {
  draft:              'bg-muted text-muted-foreground border-border',
  open:               'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  review:             'bg-blue-500/10 text-blue-500 border-blue-500/30',
  changes_requested:  'bg-orange-500/10 text-orange-500 border-orange-500/30',
  merged:             'bg-purple-500/10 text-purple-500 border-purple-500/30',
  closed:             'bg-muted text-muted-foreground border-border',
};
export const CI_STATE_BADGE: Record<CIRunState, string> = {
  queued:    'bg-muted text-muted-foreground border-border',
  running:   'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  success:   'bg-emerald-700/15 text-emerald-700 border-emerald-700/30',
  failed:    'bg-rose-500/10 text-rose-500 border-rose-500/30',
  cancelled: 'bg-muted text-muted-foreground border-border',
  skipped:   'bg-muted text-muted-foreground border-border',
};

/* ============================================================================
 * Phase 5F — Hook Event Bus (frontend mirror).
 * ========================================================================== */

export type HookEventType =
  | 'run_created'
  | 'run_state_changed'
  | 'run_mode_changed'
  | 'run_step_created'
  | 'run_step_started'
  | 'run_step_completed'
  | 'run_step_failed'
  | 'agent_session_started'
  | 'agent_session_output'
  | 'agent_session_waiting'
  | 'agent_session_completed'
  | 'agent_session_failed'
  | 'handoff_created'
  | 'artifact_created'
  | 'approval_required'
  | 'approval_resolved'
  | 'rate_limit_detected'
  | 'rate_limit_scheduled'
  | 'resume_scheduled'
  | 'resume_started'
  | 'resume_completed'
  | 'resume_failed'
  | 'github_pr_event'
  | 'github_ci_event'
  | 'github_review_event'
  | 'github_comment_gate'
  | 'qa_failed'
  | 'qa_passed'
  | 'ci_failed'
  | 'ci_passed'
  | 'improvement_signal_created'
  | 'improvement_signal_updated'
  | 'kanban_task_created'
  | 'system_note';

export type HookEventSeverity = 'debug' | 'info' | 'warning' | 'error';

export type HookEventSource =
  | 'hook'
  | 'orchestrator'
  | 'plan_validator'
  | 'rate_limit'
  | 'auto_resume'
  | 'github_webhook'
  | 'qa_reviewer'
  | 'devops_reporter'
  | 'improvement'
  | 'kanban'
  | 'system';

export interface HookEvent {
  id: string;
  type: HookEventType;
  severity: HookEventSeverity;
  runId?: string | null;
  runStepId?: string | null;
  agentSessionId?: string | null;
  agentId?: string | null;
  artifactId?: string | null;
  handoffId?: string | null;
  approvalRequestId?: string | null;
  rateLimitEventId?: string | null;
  pullRequestId?: string | null;
  ciRunId?: string | null;
  improvementSignalId?: string | null;
  kanbanTaskId?: string | null;
  source: HookEventSource;
  title: string;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

/** Tailwind colour classes for HookEvent severity badges. */
export const HOOK_EVENT_SEVERITY_BADGE: Record<HookEventSeverity, string> = {
  debug:   'bg-muted text-muted-foreground border-border',
  info:    'bg-blue-500/10 text-blue-500 border-blue-500/30',
  warning: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
  error:   'bg-rose-500/10 text-rose-500 border-rose-500/30',
};

/* ============================================================================
 * Phase 6-A — Diagnostic (frontend mirror).
 * ========================================================================== */

export type DiagnosticSource =
  | 'qa_failure'
  | 'ci_failure'
  | 'rate_limit'
  | 'resume_failure'
  | 'approval_block'
  | 'github_review'
  | 'orchestrator'
  | 'agent_session'
  | 'hook_event'
  | 'manual';

export type DiagnosticSeverity = 'low' | 'medium' | 'high' | 'critical';

export type DiagnosticStatus =
  | 'open'
  | 'investigating'
  | 'fixed'
  | 'ignored'
  | 'converted_to_task'
  | 'converted_to_improvement';

export interface Diagnostic {
  id: string;
  runId?: string | null;
  runStepId?: string | null;
  agentSessionId?: string | null;
  agentId?: string | null;
  source: DiagnosticSource;
  severity: DiagnosticSeverity;
  status: DiagnosticStatus;
  title: string;
  summary: string;
  rootCause?: string | null;
  impact?: string | null;
  suggestedFix?: string | null;
  evidenceHookEventIds: string[];
  evidenceArtifactIds?: string[];
  relatedImprovementSignalId?: string | null;
  relatedKanbanTaskId?: string | null;
  fingerprint?: string | null;
  occurrenceCount?: number;
  createdAt: string;
  updatedAt: string;
}

/** Tailwind colour classes for Diagnostic severity badges. */
export const DIAGNOSTIC_SEVERITY_BADGE: Record<DiagnosticSeverity, string> = {
  low:      'bg-muted text-muted-foreground border-border',
  medium:   'bg-amber-500/10 text-amber-500 border-amber-500/30',
  high:     'bg-orange-500/10 text-orange-500 border-orange-500/30',
  critical: 'bg-rose-500/10 text-rose-500 border-rose-500/30',
};

/** Tailwind colour classes for Diagnostic status badges. */
export const DIAGNOSTIC_STATUS_BADGE: Record<DiagnosticStatus, string> = {
  open:                       'bg-blue-500/10 text-blue-500 border-blue-500/30',
  investigating:              'bg-amber-500/10 text-amber-500 border-amber-500/30',
  fixed:                      'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  ignored:                    'bg-muted text-muted-foreground border-border',
  converted_to_task:          'bg-cyan-500/10 text-cyan-500 border-cyan-500/30',
  converted_to_improvement:   'bg-purple-500/10 text-purple-500 border-purple-500/30',
};

/* ============================================================================
 * Phase 6-B — AgentWorkflowProgress (frontend mirror).
 * ========================================================================== */

export type AgentWorkflowKind =
  | 'intake_planner'
  | 'architect_plan'
  | 'orchestrator'
  | 'frontend'
  | 'backend'
  | 'contract'
  | 'database'
  | 'qa_reviewer'
  | 'devops_reporter'
  | 'approval_validator'
  | 'generic';

export type AgentWorkflowProgressStatus =
  | 'not_started'
  | 'in_progress'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'stalled';

export type AgentWorkflowStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface AgentWorkflowStepProgress {
  stepId: string;
  label: string;
  status: AgentWorkflowStepStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  evidenceHookEventIds?: string[];
  evidenceArtifactIds?: string[];
  evidenceHandoffIds?: string[];
  note?: string | null;
}

export interface AgentWorkflowProgress {
  id: string;
  runId: string;
  runStepId?: string | null;
  agentSessionId?: string | null;
  agentId: string;
  workflowKind: AgentWorkflowKind;
  status: AgentWorkflowProgressStatus;
  currentStepId?: string | null;
  currentStepLabel?: string | null;
  steps: AgentWorkflowStepProgress[];
  progressPercent: number;
  blockedReason?: string | null;
  failedReason?: string | null;
  stalledReason?: string | null;
  lastEventAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const WORKFLOW_STATUS_BADGE: Record<AgentWorkflowProgressStatus, string> = {
  not_started: 'bg-muted text-muted-foreground border-border',
  in_progress: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  blocked:     'bg-yellow-500/10 text-yellow-500 border-yellow-500/30',
  failed:      'bg-rose-500/10 text-rose-500 border-rose-500/30',
  completed:   'bg-emerald-700/15 text-emerald-700 border-emerald-700/30',
  stalled:     'bg-amber-500/10 text-amber-500 border-amber-500/30',
};

export const WORKFLOW_STEP_STATUS_BADGE: Record<AgentWorkflowStepStatus, string> = {
  pending:     'bg-muted text-muted-foreground border-border',
  in_progress: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  completed:   'bg-emerald-700/15 text-emerald-700 border-emerald-700/30',
  failed:      'bg-rose-500/10 text-rose-500 border-rose-500/30',
  skipped:     'bg-muted text-muted-foreground border-border',
};

/* ============================================================================
 * Phase 6-D — SkillCandidate (frontend mirror).
 * ========================================================================== */

export type SkillCandidateSource =
  | 'improvement_signal'
  | 'diagnostic'
  | 'workflow_progress'
  | 'contract_drift'
  | 'db_risk'
  | 'qa_failure'
  | 'ci_failure'
  | 'manual';

export type SkillCandidateStatus =
  | 'open'
  | 'triaged'
  | 'accepted'
  | 'dismissed'
  | 'converted_to_task'
  | 'ready_for_registry';

export type SkillCandidateCategory =
  | 'frontend'
  | 'backend'
  | 'contract'
  | 'database'
  | 'qa'
  | 'devops'
  | 'orchestration'
  | 'security'
  | 'performance'
  | 'documentation'
  | 'general';

export type SkillCandidateSeverity = 'low' | 'medium' | 'high';

export interface SkillCandidate {
  id: string;
  title: string;
  summary: string;
  category: SkillCandidateCategory;
  source: SkillCandidateSource;
  status: SkillCandidateStatus;
  severity: SkillCandidateSeverity;
  runId?: string | null;
  diagnosticId?: string | null;
  improvementSignalId?: string | null;
  workflowProgressId?: string | null;
  relatedAgentId?: string | null;
  relatedSkillId?: string | null;
  proposedSkillName?: string | null;
  proposedSkillDescription?: string | null;
  proposedTrigger?: string | null;
  proposedInputs?: string[];
  proposedOutputs?: string[];
  proposedGuardrails?: string[];
  proposedValidation?: string[];
  evidenceHookEventIds?: string[];
  evidenceArtifactIds?: string[];
  evidenceHandoffIds?: string[];
  fingerprint?: string | null;
  occurrenceCount?: number;
  convertedTaskId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const SKILL_CANDIDATE_STATUS_BADGE: Record<SkillCandidateStatus, string> = {
  open:                'bg-blue-500/10 text-blue-500 border-blue-500/30',
  triaged:             'bg-amber-500/10 text-amber-500 border-amber-500/30',
  accepted:            'bg-purple-500/10 text-purple-500 border-purple-500/30',
  dismissed:           'bg-muted text-muted-foreground border-border',
  converted_to_task:   'bg-cyan-500/10 text-cyan-500 border-cyan-500/30',
  ready_for_registry:  'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
};

export const SKILL_CANDIDATE_SEVERITY_BADGE: Record<SkillCandidateSeverity, string> = {
  low:    'bg-muted text-muted-foreground border-border',
  medium: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
  high:   'bg-rose-500/10 text-rose-500 border-rose-500/30',
};

export const SKILL_CANDIDATE_CATEGORY_BADGE: Record<SkillCandidateCategory, string> = {
  frontend:       'bg-blue-500/10 text-blue-500 border-blue-500/30',
  backend:        'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  contract:       'bg-cyan-500/10 text-cyan-500 border-cyan-500/30',
  database:       'bg-amber-500/10 text-amber-500 border-amber-500/30',
  qa:             'bg-orange-500/10 text-orange-500 border-orange-500/30',
  devops:         'bg-purple-500/10 text-purple-500 border-purple-500/30',
  orchestration:  'bg-purple-500/10 text-purple-500 border-purple-500/30',
  security:       'bg-rose-500/10 text-rose-500 border-rose-500/30',
  performance:    'bg-yellow-500/10 text-yellow-500 border-yellow-500/30',
  documentation:  'bg-muted text-muted-foreground border-border',
  general:        'bg-muted text-muted-foreground border-border',
};

export const WORKFLOW_KIND_LABEL: Record<AgentWorkflowKind, string> = {
  intake_planner:     'Intake / Planner',
  architect_plan:     'Architect / Plan',
  orchestrator:       'Orchestrator',
  frontend:           'Frontend',
  backend:            'Backend',
  contract:           'Contract Agent',
  database:           'Database Agent',
  qa_reviewer:        'QA / Reviewer',
  devops_reporter:    'DevOps / Reporter',
  approval_validator: 'Approval Validator',
  generic:            'Agent',
};

/** Tailwind colour classes for Diagnostic source chips. */
export const DIAGNOSTIC_SOURCE_BADGE: Record<DiagnosticSource, string> = {
  qa_failure:      'bg-orange-500/10 text-orange-500 border-orange-500/30',
  ci_failure:      'bg-rose-500/10 text-rose-500 border-rose-500/30',
  rate_limit:      'bg-yellow-500/10 text-yellow-500 border-yellow-500/30',
  resume_failure:  'bg-rose-500/10 text-rose-500 border-rose-500/30',
  approval_block:  'bg-amber-500/10 text-amber-500 border-amber-500/30',
  github_review:   'bg-blue-500/10 text-blue-500 border-blue-500/30',
  orchestrator:    'bg-purple-500/10 text-purple-500 border-purple-500/30',
  agent_session:   'bg-cyan-500/10 text-cyan-500 border-cyan-500/30',
  hook_event:      'bg-muted text-muted-foreground border-border',
  manual:          'bg-muted text-muted-foreground border-border',
};

/* ========================================================================
 * IPC envelope (matches HandlerResult in electron/handlers/dorothy-runs-handler.ts)
 * ====================================================================== */

export interface DorothyIpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  dbUnavailable?: boolean;
}

/* ========================================================================
 * Display helpers
 * ====================================================================== */

/** UI grouping for Run Board columns. Centralized so the Run Board, the
 * Active Run Summary, and any future filter widget agree on the bucketing. */
export type RunGroup = 'pending' | 'active' | 'blocked' | 'done' | 'stopped';

export const RUN_GROUP_ORDER: RunGroup[] = ['pending', 'active', 'blocked', 'done', 'stopped'];

export const RUN_GROUP_LABEL: Record<RunGroup, string> = {
  pending: 'Pending',
  active: 'Active',
  blocked: 'Blocked',
  done: 'Done',
  stopped: 'Stopped',
};

export function runGroupOf(state: RunState): RunGroup {
  switch (state) {
    case 'created':
    case 'planned':
    case 'approval_required':
    case 'approved':
      return 'pending';
    case 'running':
    case 'verifying':
    case 'needs_fix':
    case 'reporting':
      return 'active';
    case 'blocked':
      return 'blocked';
    case 'completed':
      return 'done';
    case 'failed':
    case 'cancelled':
      return 'stopped';
  }
}

/** Tailwind color class for each state — used by both badges and group headers. */
export const RUN_STATE_BADGE: Record<RunState, string> = {
  created:           'bg-muted text-muted-foreground border-border',
  planned:           'bg-blue-500/10 text-blue-500 border-blue-500/30',
  approval_required: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
  approved:          'bg-cyan-500/10 text-cyan-500 border-cyan-500/30',
  running:           'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  verifying:         'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  needs_fix:         'bg-orange-500/10 text-orange-500 border-orange-500/30',
  reporting:         'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  completed:         'bg-emerald-700/15 text-emerald-700 border-emerald-700/30',
  blocked:           'bg-yellow-500/10 text-yellow-500 border-yellow-500/30',
  failed:            'bg-rose-500/10 text-rose-500 border-rose-500/30',
  cancelled:         'bg-muted text-muted-foreground border-border',
};

export const PRIORITY_BADGE: Record<Priority, string> = {
  low:      'bg-muted text-muted-foreground',
  medium:   'bg-blue-500/10 text-blue-500',
  high:     'bg-amber-500/10 text-amber-500',
  critical: 'bg-rose-500/10 text-rose-500',
};

/* ========================================================================
 * Phase 6-E — Agent Definition Registry / Idle Reason / Communication
 *
 * Renderer mirrors of the main-process service types in
 * electron/services/dorothy/{agent-definition-registry,agent-idle-reason-service,
 * agent-communication-service}.ts.
 * ====================================================================== */

export type AgentDefinitionSource =
  | 'configured'
  | 'claude_project_file'
  | 'claude_user_file'
  | 'live_session'
  | 'generated';

export type SpawnBlockReason =
  | 'not_registered'
  | 'not_live_loaded'
  | 'disabled'
  | 'provider_unavailable'
  | 'missing_definition'
  | 'unknown';

export interface AgentDefinition {
  id: string;
  displayName: string;
  source: AgentDefinitionSource;
  filePath?: string;
  configuredAgentId?: string;
  workflowKind?: AgentWorkflowKind;
  roleSummary?: string;
  existsOnDisk: boolean;
  hasLiveSession: boolean;
  activeSessionCount: number;
  lastSessionAt?: string;
  canSpawn: boolean;
  spawnReason?: string;
  createdAt?: string;
  updatedAt?: string;
  // Phase 6-I
  enabled?: boolean;
  isRegistered: boolean;
  isLiveLoaded: boolean;
  isSpawnable: boolean;
  spawnBlockReason?: SpawnBlockReason;
  // Phase 6-L
  provider?: string;
  model?: string;
  modelCompatibility?: AgentModelCompatibility;
}

export interface AgentModelCompatibility {
  ok: boolean;
  reason: 'ok' | 'model_not_supported' | 'model_missing' | 'provider_unknown';
  message: string;
  suggestedModel?: string;
}

export type AgentRegistryMismatchKind =
  | 'definition_file_not_configured'
  | 'session_without_definition'
  | 'unknown_workflow_kind'
  | 'cannot_spawn';

export interface AgentRegistryMismatch {
  kind: AgentRegistryMismatchKind;
  agentId: string;
  summary: string;
}

export interface AgentRegistrySnapshot {
  definitions: AgentDefinition[];
  warnings: AgentRegistryMismatch[];
  scanRoots: string[];
  configuredCount: number;
  fileCount: number;
  liveSessionAgentCount: number;
}

export type AgentIdleReason =
  | 'active'
  | 'no_assigned_runstep'
  | 'waiting_for_approval'
  | 'blocked_by_rate_limit'
  | 'blocked_by_runmode_policy'
  | 'waiting_for_dependency'
  | 'waiting_for_handoff'
  | 'waiting_for_validation'
  | 'orchestrator_autospawn_disabled'
  | 'auto_resume_dry_run'
  | 'provider_unavailable'
  | 'completed'
  | 'unknown';

export interface AgentIdleStatus {
  agentId: string;
  reason: AgentIdleReason;
  summary: string;
  runId?: string;
  runStepId?: string;
  agentSessionId?: string;
  evidenceHookEventIds?: string[];
  evidenceDiagnosticIds?: string[];
  since?: string;
}

export type DispatchBlockerReason =
  | 'no_pending_runstep'
  | 'agent_not_registered'
  | 'agent_not_live_loaded'
  | 'agent_not_spawnable'
  | 'approval_required'
  | 'runmode_policy'
  | 'dependency_not_completed'
  | 'handoff_missing'
  | 'rate_limited'
  | 'auto_spawn_disabled'
  | 'provider_unavailable'
  | 'claude_binary_missing'
  | 'project_path_missing'
  | 'mcp_config_missing'
  | 'add_dir_missing'
  | 'launch_command_invalid'
  | 'provider_model_mismatch'
  | 'provider_unknown'
  | 'model_missing'
  | 'codex_persistent_model_mismatch'
  | 'stale_session_model_mismatch'
  | 'unknown';

/* Phase 6-M — Codex runtime readiness (renderer mirror). */
export interface CodexRuntimeReadiness {
  binaryFound: boolean;
  binaryPath?: string | null;
  configTomlModel?: string | null;
  persistentModelOpus: boolean;
  defaultCodexModel?: string | null;
  defaultCodexModelOk?: boolean;
  incompatibleConfiguredAgents: Array<{ agentId: string; name?: string; model?: string; message: string }>;
  opusBlocked: boolean;
  autoRewrite: boolean;
}

export interface StaleSessionFlag {
  sessionId: string;
  agentId: string;
  provider: string;
  model?: string;
  reason: 'stale_session_model_mismatch';
  summary: string;
}

/* Phase 6-Q — batch warm-up + Codex normalization (renderer mirror). */
export interface AgentWarmupTarget {
  agentId: string;
  displayName: string;
  canWarmup: boolean;
  reason?: string;
  alreadyRunning?: boolean;
  provider?: string;
  model?: string;
}

export interface AgentWarmupResult {
  ok: boolean;
  requestedAgentIds: string[];
  startedAgentIds: string[];
  skipped: Array<{ agentId: string; reason: string }>;
  failed: Array<{ agentId: string; error: string }>;
}

export interface CodexNormalizationTarget {
  id: string;
  name?: string;
  model: string;
}

export interface CodexNormalizationPreview {
  structure: 'array' | 'object' | 'unknown' | 'missing';
  targets: CodexNormalizationTarget[];
}

export interface CodexNormalizationResult {
  ok: boolean;
  reason?: string;
  changedAgentIds: string[];
  backupPath?: string | null;
}

/* Phase 6-K — Claude launch readiness (renderer mirror). */
export type LaunchBlockReason =
  | 'claude_binary_missing'
  | 'project_path_missing'
  | 'mcp_config_missing'
  | 'add_dir_missing'
  | 'launch_command_invalid';

export interface LaunchPathCheck {
  path?: string;
  ok: boolean;
  suggestion?: string;
}

export interface ClaudeLaunchReadiness {
  agentId?: string;
  claudeBinary: { found: boolean; path?: string; source?: string };
  projectPath: LaunchPathCheck;
  mcpConfig: LaunchPathCheck & { required: boolean };
  addDir: LaunchPathCheck;
  ready: boolean;
  launchBlockReason?: LaunchBlockReason;
  summary: string;
}

export interface ClaudeRuntimeReadiness {
  binary: { found: boolean; path?: string | null; source?: string | null; checkedCount: number };
  pathIncludesClaude: boolean;
  mcpConfigPath?: string | null;
  addDir: string;
  agents: ClaudeLaunchReadiness[];
}

export interface AgentDispatchReadiness {
  agentId: string;
  ready: boolean;
  reason?: DispatchBlockerReason;
  summary: string;
  runId?: string;
  runStepId?: string;
}

export interface DispatchReadinessCounts {
  ready: number;
  blocked: number;
  total: number;
  byReason: Partial<Record<DispatchBlockerReason, number>>;
}

export const DISPATCH_BLOCKER_LABEL: Record<DispatchBlockerReason, string> = {
  no_pending_runstep:       'No pending step',
  agent_not_registered:     'Not registered',
  agent_not_live_loaded:    'Reload required',
  agent_not_spawnable:      'Not spawnable',
  approval_required:        'Approval required',
  runmode_policy:           'Run-mode policy',
  dependency_not_completed: 'Dependency',
  handoff_missing:          'Handoff missing',
  rate_limited:             'Rate-limited',
  auto_spawn_disabled:      'Auto-spawn off',
  provider_unavailable:     'Provider down',
  claude_binary_missing:    'Claude not found',
  project_path_missing:     'Project path missing',
  mcp_config_missing:       'MCP config missing',
  add_dir_missing:          'Add-dir missing',
  launch_command_invalid:   'Launch invalid',
  provider_model_mismatch:  'Provider/model mismatch',
  provider_unknown:         'Unknown provider',
  model_missing:            'Model missing',
  codex_persistent_model_mismatch: 'Codex saved model incompatible',
  stale_session_model_mismatch:    'Stale session command blocked',
  unknown:                  'Unknown',
};

export type AgentCommunicationType =
  | 'handoff'
  | 'artifact'
  | 'hook_event'
  | 'diagnostic'
  | 'approval'
  | 'workflow_update'
  | 'rate_limit'
  | 'resume'
  | 'comment';

export interface AgentCommunicationEvent {
  id: string;
  type: AgentCommunicationType;
  runId?: string;
  runStepId?: string;
  fromAgentId?: string;
  toAgentId?: string;
  agentSessionId?: string;
  title: string;
  summary?: string;
  artifactId?: string;
  handoffId?: string;
  hookEventId?: string;
  diagnosticId?: string;
  approvalRequestId?: string;
  createdAt: string;
}

/** Badge classes for idle reasons (used by /agents, /sessions, Command Center). */
export const IDLE_REASON_BADGE: Record<AgentIdleReason, string> = {
  active:                          'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  no_assigned_runstep:             'bg-muted text-muted-foreground border-border',
  waiting_for_approval:            'bg-amber-500/10 text-amber-500 border-amber-500/30',
  blocked_by_rate_limit:           'bg-rose-500/10 text-rose-500 border-rose-500/30',
  blocked_by_runmode_policy:       'bg-orange-500/10 text-orange-500 border-orange-500/30',
  waiting_for_dependency:          'bg-blue-500/10 text-blue-500 border-blue-500/30',
  waiting_for_handoff:             'bg-cyan-500/10 text-cyan-500 border-cyan-500/30',
  waiting_for_validation:          'bg-purple-500/10 text-purple-500 border-purple-500/30',
  orchestrator_autospawn_disabled: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30',
  auto_resume_dry_run:             'bg-yellow-500/10 text-yellow-500 border-yellow-500/30',
  provider_unavailable:            'bg-rose-500/10 text-rose-500 border-rose-500/30',
  completed:                       'bg-emerald-700/15 text-emerald-700 border-emerald-700/30',
  unknown:                         'bg-muted text-muted-foreground border-border',
};

export const IDLE_REASON_LABEL: Record<AgentIdleReason, string> = {
  active:                          'Active',
  no_assigned_runstep:             'No assigned step',
  waiting_for_approval:            'Waiting approval',
  blocked_by_rate_limit:           'Rate-limited',
  blocked_by_runmode_policy:       'Run-mode policy',
  waiting_for_dependency:          'Waiting dependency',
  waiting_for_handoff:             'Waiting handoff',
  waiting_for_validation:          'Waiting validation',
  orchestrator_autospawn_disabled: 'Auto-spawn off',
  auto_resume_dry_run:             'Auto-resume dry-run',
  provider_unavailable:            'Provider down',
  completed:                       'Completed',
  unknown:                         'Queued',
};

export const AGENT_DEFINITION_SOURCE_LABEL: Record<AgentDefinitionSource, string> = {
  configured:          'Configured (agents.json)',
  claude_project_file: 'Project .claude/agents',
  claude_user_file:    'User .claude/agents',
  live_session:        'Live session',
  generated:           'Generated',
};

export const COMMUNICATION_TYPE_LABEL: Record<AgentCommunicationType, string> = {
  handoff:         'Handoff',
  artifact:        'Artifact',
  hook_event:      'Event',
  diagnostic:      'Diagnostic',
  approval:        'Approval',
  workflow_update: 'Workflow',
  rate_limit:      'Rate limit',
  resume:          'Resume',
  comment:         'Comment',
};

/* Phase 6-G — manual agent-definition registration (renderer mirror). */
export type RegistrationProvider = 'claude' | 'codex' | 'gemini' | 'opencode' | 'local';

export interface RegisterAgentDefinitionOptions {
  provider?: RegistrationProvider;
  model?: string;
  enabled?: boolean;
  dryRun?: boolean;
  /** Phase 6-H — reload the live agent manager after a successful register. Default true. */
  reloadAfterRegister?: boolean;
}

export interface AgentRegistrationPreview {
  agentDefinitionId: string;
  displayName: string;
  source: AgentDefinitionSource;
  filePath?: string;
  workflowKind?: AgentWorkflowKind;
  roleSummary?: string;
  proposedAgentRecord: Record<string, unknown>;
  warnings: string[];
  canRegister: boolean;
  reason?: string;
}

export interface ReloadLiveAgentsResult {
  ok: boolean;
  beforeCount: number;
  afterCount: number;
  addedAgentIds: string[];
  removedAgentIds: string[];
  updatedAgentIds?: string[];
  preservedActiveSessionIds?: string[];
  warnings?: string[];
  error?: string;
  alreadyInProgress?: boolean;
}

export interface RegisterAgentDefinitionResult {
  ok: boolean;
  reason?: string;
  agentId?: string;
  dryRun?: boolean;
  alreadyRegistered?: boolean;
  backupPath?: string | null;
  proposedAgentRecord?: Record<string, unknown>;
  hookEventId?: string | null;
  reloadResult?: ReloadLiveAgentsResult;
  postRegistrationDefinition?: AgentDefinition;
  warnings?: string[];
}

export const COMMUNICATION_TYPE_BADGE: Record<AgentCommunicationType, string> = {
  handoff:         'bg-cyan-500/10 text-cyan-500 border-cyan-500/30',
  artifact:        'bg-blue-500/10 text-blue-500 border-blue-500/30',
  hook_event:      'bg-muted text-muted-foreground border-border',
  diagnostic:      'bg-orange-500/10 text-orange-500 border-orange-500/30',
  approval:        'bg-amber-500/10 text-amber-500 border-amber-500/30',
  workflow_update: 'bg-purple-500/10 text-purple-500 border-purple-500/30',
  rate_limit:      'bg-rose-500/10 text-rose-500 border-rose-500/30',
  resume:          'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  comment:         'bg-muted text-muted-foreground border-border',
};

/* ============================================================================
 * Phase 6-W — App Factory (multi-company / multi-project orchestration)
 *
 * Planning-only models (mirror of electron/types/dorothy.ts). Generating a
 * plan preview never creates files, repos, or real Kanban tasks.
 * ========================================================================== */

export type AppCandidateStatus =
  | 'candidate'
  | 'selected'
  | 'planning'
  | 'kanban_previewed'
  | 'ready_to_build'
  | 'building'
  | 'shipped'
  | 'paused';

export type AppDailyUseLevel = 'very_high' | 'high' | 'medium_high' | 'medium' | 'low';
export type AppSubstituteLevel = 'weak' | 'medium' | 'strong' | 'very_strong';
export type AppImplementationDifficulty = 'easy' | 'medium' | 'hard';

export interface AppApiSource {
  name: string;
  provider: string;
  url?: string;
  requiresApiKey?: boolean;
  notes?: string;
}

export interface AppCandidate {
  id: string;
  rank?: number;
  title: string;
  targetUsers: string[];
  problem: string;
  dailyUseLevel?: AppDailyUseLevel;
  substituteLevel?: AppSubstituteLevel;
  substitutes?: string[];
  coreMvpFeatures: string[];
  apiSources: AppApiSource[];
  provider?: string;
  implementationDifficulty?: AppImplementationDifficulty;
  monetization?: string[];
  risks?: string[];
  projectSlug: string;
  companyName: string;
  suggestedProjectPath: string;
  status: AppCandidateStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAppCandidateInput {
  title: string;
  rank?: number;
  targetUsers?: string[];
  problem?: string;
  dailyUseLevel?: AppDailyUseLevel;
  substituteLevel?: AppSubstituteLevel;
  substitutes?: string[];
  coreMvpFeatures?: string[];
  apiSources?: AppApiSource[];
  provider?: string;
  implementationDifficulty?: AppImplementationDifficulty;
  monetization?: string[];
  risks?: string[];
  projectSlug: string;
  companyName?: string;
  suggestedProjectPath?: string;
  status?: AppCandidateStatus;
}

export interface ListAppCandidatesOptions {
  status?: AppCandidateStatus | AppCandidateStatus[];
  implementationDifficulty?: AppImplementationDifficulty | AppImplementationDifficulty[];
  limit?: number;
  offset?: number;
}

export type AppFactoryPlanStatus = 'draft' | 'approved' | 'converted_to_kanban';

export interface AppFactoryKanbanPreviewTask {
  id: string;
  title: string;
  ownerAgentId: string;
  description: string;
  acceptanceCriteria: string[];
  order: number;
}

export interface AppFactoryPlan {
  id: string;
  appCandidateId: string;
  summary: string;
  suggestedArchitecture: string;
  mvpScope: string[];
  outOfScope: string[];
  dataModelDraft: string[];
  apiContractDraft: string[];
  kanbanPreviewTasks: AppFactoryKanbanPreviewTask[];
  riskPolicy: string[];
  status: AppFactoryPlanStatus;
  createdAt: string;
  updatedAt: string;
}
