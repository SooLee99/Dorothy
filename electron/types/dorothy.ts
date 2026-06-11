/**
 * Dorothy MVP — Run-centric data model types.
 *
 * Source: docs/rebuild-target-mvp/mvp-data-models.md
 *
 * The MVP intentionally collapses several Phase-5/6 models into JSON-bearing
 * fields here (Plan.tasks, Plan.contracts, Run.affectedRunIds via the rate
 * limit event) so we don't have to normalize prematurely. Identifiers and
 * enum values are kept identical to the long-form rebuild target so a future
 * split is additive, not renaming.
 */

/* ============================================================================
 * Enums
 * ========================================================================== */

/** MVP Run lifecycle — 12 states. See docs/rebuild-target-mvp/mvp-run-state-machine.md */
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

/** Engine identifier as recognised by the API server / providers. */
export type RateLimitEngine = 'claude' | 'codex' | 'gemini' | 'opencode' | 'pi';

export type RateLimitSource =
  | 'pm_output'
  | 'usage_scan'
  | 'codex_rate_limits'
  | 'manual';

export type ArtifactType =
  | 'patch'
  | 'test'
  | 'doc'
  | 'report'
  | 'review'
  | 'other';

export type PlanState =
  | 'draft'
  | 'validating'
  | 'approved'
  | 'pending'
  | 'rejected';

export type ApprovalState =
  | 'pending'
  | 'auto_approved'
  | 'conditional'
  | 'user_approved'
  | 'rejected'
  | 'expired';

/* ============================================================================
 * Core records
 * ========================================================================== */

/**
 * Phase 5D — execution mode that the orchestrator + UI should respect for a
 * given Run. Borrowed conceptually from oh-my-claudecode but implemented
 * natively against Dorothy's existing Run / RunStep / Handoff machinery.
 */
export type RunMode =
  | 'manual'      // human drives, no auto-retry, approval-heavy
  | 'team'        // default — Planner→FE/BE→QA→Reporter parallel where safe
  | 'persistent'  // limited verify/fix loop, maxFixAttempts capped
  | 'ultraqa'     // QA + Reviewer heavy, validation must exist
  | 'pipeline';   // strict sequential, no FE/BE parallel

export type RunModeSource =
  | 'manual'      // user picked it
  | 'keyword'     // router matched a keyword in title/body/task
  | 'policy'      // policy/default fallback
  | 'default';    // no signal — default mode

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
  // Phase 5D — optional fields; backward compatible with rows that predate
  // the column add (db.ts ALTER TABLE). UI must tolerate undefined.
  mode?: RunMode | null;
  modeSource?: RunModeSource | null;
  modeReason?: string | null;
}

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
  provider: string;          // 'claude' | 'codex' | 'gemini' | ... — kept open
  worktreePath?: string | null;
  startedAt: string;
  exitedAt?: string | null;
  endStatus?: AgentSessionEndStatus | null;
  waitingForUserInput?: boolean;
  pid?: number | null;
  rawLogRef?: string | null;
}

/**
 * Plan with embedded tasks/contracts JSON.
 * Phase-5 splits these into dedicated tables (`tasks`, `contracts`); the
 * JSON columns here are intentionally shaped to be migratable 1:1.
 */
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

export interface TaskDraft {
  taskId: string;
  title: string;
  description: string;
  ownerAgentId: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  estimatedRiskLevel?: Priority;
  /**
   * Optional explicit forbidden-path globs the planner can attach to a task.
   * When present, the orchestrator uses *these* as the source of truth and
   * still concatenates DEFAULT_FORBIDDEN_PATHS as a baseline.
   * Older Plans without this field continue to work via the per-owner
   * fallback in agent-routing.ts (`extraForbiddenForOwner`).
   */
  forbiddenPaths?: string[];
  /**
   * Optional explicit validation commands the worker must run. Same opt-in
   * rule: when present, the orchestrator prefers these; otherwise the
   * per-owner defaults in orchestrator-service.ts fill in.
   */
  validationCommands?: string[];
}

export interface ContractDraft {
  contractId: string;
  kind: 'api' | 'schema' | 'event';
  spec: unknown;
  changeType: 'add' | 'modify' | 'deprecate' | 'remove';
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
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'local';

/** Phase 5C-B — life-cycle of a resume schedule. Stored on RateLimitEvent. */
export type RateLimitResumeStatus =
  | 'pending'     // event recorded, no resumeAt yet
  | 'scheduled'   // resumeAt set, in the future
  | 'resuming'    // worker dispatch in flight
  | 'resumed'     // worker successfully restarted
  | 'failed'      // dispatch raised; lastResumeError holds the message
  | 'cancelled';  // user cancelled the schedule

/** Phase 5C-B — extended source taxonomy. The original 4 are kept; we add
 *  the new ones at the end so older rows keep loading. */
export type RateLimitSourceExtended =
  | RateLimitSource
  | 'pm_tick'
  | 'hook'
  | 'agent_output';

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
  // Phase 5C-B additions — every one is optional so existing rows still load.
  provider?: RateLimitProvider | null;
  resumeAt?: string | null;
  resumeStatus?: RateLimitResumeStatus | null;
  affectedSessionIds?: string[];
  affectedRunStepIds?: string[];
  retryCount?: number;
  lastResumeError?: string | null;
  /** Excerpt only — full body is never stored (PII / log volume). */
  messageExcerpt?: string | null;
  /** Set by usage-limit-parser when reset time confidence is low. */
  parseConfidence?: 'high' | 'medium' | 'low' | null;
}

export interface IntakeRequest {
  id: string;
  source: RunSource;
  sourceRefId?: string | null;
  rawContent: string;
  parsedSummary?: string | null;
  classifiedPriority?: Priority | null;
  classifiedDomain?: string | null;
  routedRunId?: string | null;
  createdAt: string;
}

/* ============================================================================
 * Phase 5A — PullRequest + CIRun
 *
 * Tracked here, NOT folded into RunState. The MVP 12-state machine keeps the
 * same surface; PR/CI lifecycle lives in its own dimension and only triggers
 * Run transitions when the `dorothyPrCiAutoTransition` feature flag is on.
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
  /** Canonical external identifier — `owner/repo#number`. Used for upsert. */
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
  /** GitHub workflow_run / check_run id rendered as string. Upsert key. */
  externalRef: string;
  url?: string | null;
  state: CIRunState;
  /** GitHub's `conclusion` raw value (success, failure, neutral, timed_out…). */
  conclusion?: string | null;
  startedAt: string;
  completedAt?: string | null;
  logsUrl?: string | null;
  summary?: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ----- Create / upsert inputs ----- */

export interface UpsertPullRequestInput {
  /** Required for upsert; format `owner/repo#number`. */
  externalRef: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  branch: string;
  baseBranch: string;
  state: PullRequestState;
  title: string;
  runId?: string | null;
  provider?: PullRequestProvider;
  bodyArtifactId?: string | null;
  authorAgentId?: string | null;
  reviewers?: PullRequestReviewer[];
  ciRunIds?: string[];
  mergedAt?: string | null;
  closedAt?: string | null;
}

export interface UpdatePullRequestStateInput {
  id: string;
  state: PullRequestState;
  mergedAt?: string | null;
  closedAt?: string | null;
  reviewers?: PullRequestReviewer[];
}

export interface UpsertCIRunInput {
  /** Required for upsert. */
  externalRef: string;
  provider?: CIProvider;
  workflow: string;
  state: CIRunState;
  startedAt?: string;
  runId?: string | null;
  pullRequestId?: string | null;
  url?: string | null;
  conclusion?: string | null;
  completedAt?: string | null;
  logsUrl?: string | null;
  summary?: string | null;
}

export interface UpdateCIRunStateInput {
  id: string;
  state: CIRunState;
  conclusion?: string | null;
  completedAt?: string | null;
  summary?: string | null;
  logsUrl?: string | null;
}

/* ============================================================================
 * Phase 5C-B — ImprovementSignal
 *
 * Records "Dorothy noticed this pattern" candidates. Strictly no agent code
 * or skill files are mutated — UI / human action only.
 * ========================================================================== */

export type ImprovementSignalSource =
  | 'qa_failure'
  | 'ci_failure'
  | 'rate_limit'
  | 'approval_required'
  | 'review_changes_requested'
  | 'retry_exceeded'
  | 'manual_note';

export type ImprovementSignalSeverity = 'low' | 'medium' | 'high';

export type ImprovementSignalStatus =
  | 'open'
  | 'triaged'
  | 'accepted'
  | 'dismissed'
  | 'converted_to_task';

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
  /** Stable hash so duplicate observations roll up. */
  fingerprint?: string | null;
  occurrenceCount?: number;
  status: ImprovementSignalStatus;
  createdAt: string;
  updatedAt: string;
  /** Phase 5E — when the operator converts the signal to a KanbanTask, the
   * resulting task id is recorded here so re-conversion is a no-op. */
  convertedTaskId?: string | null;
}

export interface CreateImprovementSignalInput {
  runId?: string | null;
  source: ImprovementSignalSource;
  severity?: ImprovementSignalSeverity;
  title: string;
  summary: string;
  evidenceArtifactIds?: string[];
  relatedAgentId?: string | null;
  relatedSkillId?: string | null;
  fingerprint?: string | null;
  occurrenceCount?: number;
}

export interface UpdateImprovementSignalStatusInput {
  id: string;
  status: ImprovementSignalStatus;
  /** Optional note appended to summary for traceability. */
  note?: string | null;
}

/* ============================================================================
 * Create / update inputs
 *
 * These are the narrow argument shapes the services accept. Service code is
 * responsible for filling in id/createdAt/updatedAt, so callers never need to
 * mint ULIDs themselves.
 * ========================================================================== */

export interface CreateRunInput {
  title: string;
  source: RunSource;
  sourceRefId?: string | null;
  priority?: Priority;
  state?: RunState;
  kanbanTaskId?: string | null;
  planId?: string | null;
  comment?: string | null;
  // Phase 5D — when omitted, the caller can let the router decide via
  // `decideRunMode()` and pass the result through here.
  mode?: RunMode | null;
  modeSource?: RunModeSource | null;
  modeReason?: string | null;
}

export interface CreateRunStepInput {
  runId: string;
  order: number;
  agentId: string;
  state?: RunStepState;
  promptRef?: string | null;
}

export interface CreateAgentSessionInput {
  runId?: string | null;
  runStepId?: string | null;
  agentId: string;
  provider: string;
  worktreePath?: string | null;
  pid?: number | null;
}

export interface EndAgentSessionInput {
  id: string;
  endStatus: AgentSessionEndStatus;
  rawLogRef?: string | null;
}

export interface CreateArtifactInput {
  runId: string;
  runStepId?: string | null;
  type: ArtifactType;
  producedByAgentId: string;
  path?: string | null;
  contentRef?: string | null;
  meta?: Record<string, unknown>;
}

export interface CreateHandoffInput {
  runId: string;
  fromRunStepId: string;
  toRunStepId: string;
  summary: string;
  attachedArtifactIds?: string[];
}

export interface CreatePlanInput {
  runId: string;
  title: string;
  description: string;
  state?: PlanState;
  riskLevel?: Priority | null;
  adrRef?: string | null;
  tasks?: TaskDraft[];
  contracts?: ContractDraft[];
}

export interface CreateApprovalRequestInput {
  runId: string;
  planId?: string | null;
  riskLevel: Priority;
  topic?: string | null;
  state?: ApprovalState;
  mirroredMdPath?: string | null;
}

export interface CreateRateLimitEventInput {
  engine: RateLimitEngine;
  // Phase 5C-B — accept the extended source taxonomy (`pm_tick`, `hook`,
  // `agent_output`) directly on the input. Older callers that pass only the
  // original 4 still type-check.
  source: RateLimitSourceExtended;
  detectedAt?: string;
  resetAt?: string | null;
  message?: string | null;
  rawRef?: string | null;
  affectedRunIds?: string[];
}

export interface CreateIntakeRequestInput {
  source: RunSource;
  sourceRefId?: string | null;
  rawContent: string;
  parsedSummary?: string | null;
  classifiedPriority?: Priority | null;
  classifiedDomain?: string | null;
  routedRunId?: string | null;
}

/* ============================================================================
 * Phase 5F — Hook Event Bus
 *
 * Unified runtime timeline. Every notable runtime occurrence (Run state move,
 * RunStep lifecycle, AgentSession output / waiting / completion, rate limit,
 * resume, GitHub webhook signal, improvement signal change, kanban handoff)
 * mirrors a row into `hook_events`. The renderer treats this as the
 * authoritative timeline; the synthesized timeline in Run Detail remains as
 * fallback for empty rows.
 *
 * Storage policy:
 *   - `title` is short (≤140 chars), `summary` is bounded (≤500 chars).
 *   - `metadata` is JSON-encoded; sensitive substrings (secret/token/password/
 *     api_key/private_key/bearer/client_secret/access_token) are masked before
 *     persistence.
 *   - Raw outputs / GitHub bodies / signatures are NEVER stored.
 *   - HookEvent creation failures must not propagate; `safeCreateHookEvent`
 *     swallows + warns.
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
  /** Free-form, JSON-serializable metadata. Sensitive substrings get masked. */
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

/* ============================================================================
 * Phase 6-A — Diagnostic
 *
 * A Diagnostic is "Dorothy noticed this problem and is tracking how to
 * resolve it". It's distinct from `ImprovementSignal` (which records
 * recurring or structural improvement candidates):
 *
 *   - Diagnostic     = the *current* problem instance + status timeline
 *   - ImprovementSignal = the *pattern* across many similar Diagnostics
 *
 * Diagnostics are derived from `HookEvent`s by `diagnostic-detector.ts`;
 * the detector is invoked at the few call sites that already emit the
 * matching HookEvent so we don't introduce a circular import. Auto root-cause
 * AI analysis is intentionally out of scope for this Phase.
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

export interface CreateDiagnosticInput {
  runId?: string | null;
  runStepId?: string | null;
  agentSessionId?: string | null;
  agentId?: string | null;
  source: DiagnosticSource;
  severity?: DiagnosticSeverity;
  status?: DiagnosticStatus;
  title: string;
  summary: string;
  rootCause?: string | null;
  impact?: string | null;
  suggestedFix?: string | null;
  evidenceHookEventIds?: string[];
  evidenceArtifactIds?: string[];
  fingerprint?: string | null;
  occurrenceCount?: number;
}

export interface UpdateDiagnosticStatusInput {
  id: string;
  status: DiagnosticStatus;
  /** Optional note appended to summary for traceability. */
  note?: string | null;
}

/* ============================================================================
 * Phase 6-B — AgentWorkflowProgress
 *
 * One row per `(runId, runStepId, agentSessionId, agentId)` quartet. Each
 * agent role has a standard `AgentWorkflowKind` template; the row tracks
 * which named step the agent is currently on, what evidence (HookEvent /
 * Artifact / Handoff id) backs each step, and the rolled-up
 * `progressPercent` + `status` for dashboards.
 *
 * The model is intentionally derived from existing data — HookEvent, RunStep,
 * AgentSession, Artifact, Handoff. We never store raw output / GitHub body /
 * comment body; only evidence IDs and rule-based step transitions land here.
 * ========================================================================== */

export type AgentWorkflowKind =
  | 'intake_planner'
  | 'architect_plan'
  | 'orchestrator'
  | 'frontend'
  | 'backend'
  // Phase 6-C — Contract Agent (API contract owner) + Database Agent (DB
  // impact analyst). Both run *before* fe/be implementation in pipeline
  // mode and surface their own workflow timelines.
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

export interface CreateOrGetWorkflowProgressInput {
  runId: string;
  runStepId?: string | null;
  agentSessionId?: string | null;
  agentId: string;
  /** Optional override; otherwise resolved from agentId via the template registry. */
  workflowKind?: AgentWorkflowKind;
}

/* ============================================================================
 * Phase 6-D — SkillCandidate
 *
 * "Dorothy noticed a pattern that might justify a Skill — but a human should
 * decide". The candidate captures the proposed skill shape (name, trigger,
 * inputs, outputs, guardrails, validation) from rule-based mapping; we never
 * synthesise the skill body via LLM and we never auto-create or auto-modify
 * skill files. accepted / ready_for_registry only marks readiness; actual
 * registry registration is deferred (Phase 6-E+).
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

  /** Phase 6-D — populated when the candidate is converted to a KanbanTask. */
  convertedTaskId?: string | null;

  createdAt: string;
  updatedAt: string;
}

export interface CreateSkillCandidateInput {
  title: string;
  summary: string;
  category?: SkillCandidateCategory;
  source: SkillCandidateSource;
  status?: SkillCandidateStatus;
  severity?: SkillCandidateSeverity;

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
}

export interface UpdateSkillCandidateStatusInput {
  id: string;
  status: SkillCandidateStatus;
  /** Optional note appended to summary. */
  note?: string | null;
}

/** Op-codes the service accepts for updating a single step. */
export interface UpdateWorkflowProgressStepInput {
  progressId: string;
  stepId: string;
  status?: AgentWorkflowStepStatus;
  /** Append-only evidence ids. */
  addHookEventId?: string | null;
  addArtifactId?: string | null;
  addHandoffId?: string | null;
  note?: string | null;
}

export interface CreateHookEventInput {
  type: HookEventType;
  severity?: HookEventSeverity;
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
  /** Override `createdAt`; tests use this to keep ordering deterministic. */
  createdAt?: string;
}

/* ============================================================================
 * Phase 6-W — App Factory (multi-company / multi-project orchestration)
 *
 * Planning-only models. An AppCandidate describes a public-data MVP app idea
 * managed as an independent company/project. An AppFactoryPlan is a *preview*
 * (architecture + MVP scope + Kanban preview tasks) — generating it never
 * creates files, repos, or real Kanban tasks. Conversion to real work is a
 * separate, explicitly-confirmed step (not implemented in this phase).
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
