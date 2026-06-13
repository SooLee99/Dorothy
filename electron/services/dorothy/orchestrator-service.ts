/**
 * Dorothy MVP Phase 3 — Orchestrator service.
 *
 * Owns:
 *   - kicking a Run off from an approved Plan
 *   - picking the next RunStep using the Plan's `dependsOn` graph
 *   - mirroring step completion / failure into Run.state transitions
 *   - building the Run-context prompt the worker receives
 *
 * Does NOT own:
 *   - spawning PTYs (the existing `/api/agents/:id/start` endpoint does that)
 *   - editing triplan/.claude/agents/*.md
 *   - committing or pushing to git
 *
 * The service is callable both from IPC handlers (when a UI button picks the
 * next step) and from internal hooks (when an AgentSession ends).
 */

import {
  getRun,
  listRuns,
  updateRunState,
  createRunStep,
  listRunStepsByRun,
  updateRunStepState,
  attachSessionToStep,
} from './run-service';
import { listPlansByRun } from './plan-service';
import { findActiveSessionForAgent } from './agent-session-service';
import { createHandoff, createArtifact } from './artifact-service';
import { execSync } from 'child_process';
import {
  buildRunContextPrompt,
  resolveLiveAgentForStep,
  DEFAULT_FORBIDDEN_PATHS,
  DEFAULT_FAILURE_RULE,
  handoffPathFor,
  type LiveAgentSlim,
  type RunContextPromptParams,
} from './agent-routing';
import { createImprovementSignal, fingerprintFor } from './improvement-signal-service';
import { policyFor, maxFixAttemptsFor, parallelAllowedFor } from './run-mode-policy';
import { listAgentSessions } from './agent-session-service';
import { safeCreateHookEvent } from './hook-event-service';
import type { Plan, Run, RunStep, RunState, TaskDraft } from '../../types/dorothy';

const MAX_RETRIES_DEFAULT = 2;

/**
 * The ordered list of agent roles the orchestrator inserts between the worker
 * phase and the close-out — qa-reviewer then devops-reporter. The planner can
 * still emit these as explicit tasks; in that case we don't auto-insert.
 */
const VERIFY_AGENT = 'qa-reviewer';
const REPORT_AGENT = 'devops-reporter';

export interface OrchestratorDeps {
  /** Live agent snapshot — typically `Array.from(agents.values())` from
   *  agent-manager.ts. Pass this in so the service stays unit-testable. */
  getLiveAgents(): LiveAgentSlim[];

  /** Start a Dorothy agent with a prompt. Defaults to a no-op so the service
   *  can be exercised by tests without a PTY. Production wiring should pass
   *  an adapter that calls `/api/agents/:id/start` or the IPC equivalent. */
  startAgent?(params: { agentId: string; prompt: string; runId: string; runStepId: string }): Promise<void>;
}

let depsRef: OrchestratorDeps | null = null;

export function configureOrchestrator(deps: OrchestratorDeps): void {
  depsRef = deps;
}

/* ============================================================================
 * Status helpers
 * ========================================================================== */

/** Returns true when the Run is in a state that the orchestrator should keep
 *  advancing — anything else means "leave it alone". */
export function isAdvanceableRun(run: Run): boolean {
  return run.state === 'approved'
      || run.state === 'running'
      || run.state === 'needs_fix'
      || run.state === 'verifying'
      || run.state === 'reporting';
}

function planForRun(runId: string): Plan | null {
  const plans = listPlansByRun(runId);
  // Most Runs have exactly one approved plan; pick the freshest approved one.
  const approved = plans.filter(p => p.state === 'approved');
  if (approved.length > 0) {
    return approved.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }
  return plans[0] ?? null;
}

/**
 * Phase 6-C — preference order for the next-task picker.
 *
 * Contract / Database tasks are foundational: Frontend and Backend
 * implementation cannot land safely until the API surface and DB plan are
 * confirmed. We bias the picker to prefer them when their dependsOn[] is
 * met. The bias is *soft* — explicit `dependsOn` on tasks still wins, and
 * we never reorder past a still-running step.
 */
const OWNER_PRIORITY: Record<string, number> = {
  'contract-agent':   0,
  'database-agent':   1,
  'architect-plan':   2,
  'intake-planner':   2,
  'backend':          3,
  'frontend':         3,
  'qa-reviewer':      4,
  'devops-reporter':  5,
};

function taskPriority(t: TaskDraft): number {
  return OWNER_PRIORITY[t.ownerAgentId] ?? 3;
}

/** Topological-ish next-task picker. We return the first task whose
 *  dependsOn[] are all completed and which doesn't yet have a step in a
 *  non-completed state. Within that filter, contract/database tasks come
 *  first so fe/be never start without an API contract or DB plan. */
function pickNextTask(plan: Plan, steps: RunStep[]): TaskDraft | null {
  const completedTaskIds = new Set<string>();
  const inFlightTaskIds = new Set<string>();
  for (const s of steps) {
    // RunStep.promptRef holds taskId when we made it; otherwise skip.
    const tid = s.promptRef ?? '';
    if (!tid) continue;
    if (s.state === 'completed') completedTaskIds.add(tid);
    if (s.state === 'pending' || s.state === 'running') inFlightTaskIds.add(tid);
  }

  const candidates = (plan.tasks ?? []).filter(t => {
    if (completedTaskIds.has(t.taskId)) return false;
    if (inFlightTaskIds.has(t.taskId)) return false;
    return (t.dependsOn ?? []).every(d => completedTaskIds.has(d));
  });
  if (candidates.length === 0) return null;
  // Stable sort by priority — preserve Plan-defined order within the same bucket.
  const sorted = candidates
    .map((t, i) => ({ t, i, p: taskPriority(t) }))
    .sort((a, b) => a.p === b.p ? a.i - b.i : a.p - b.p);
  return sorted[0].t;
}

function allWorkerTasksDone(plan: Plan, steps: RunStep[]): boolean {
  const completedTaskIds = new Set<string>();
  for (const s of steps) {
    if (s.state === 'completed' && s.promptRef) completedTaskIds.add(s.promptRef);
  }
  return (plan.tasks ?? []).every(t => completedTaskIds.has(t.taskId));
}

function lastCompletedStep(steps: RunStep[]): RunStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].state === 'completed') return steps[i];
  }
  return null;
}

/* ============================================================================
 * advanceRun — the heart of the orchestrator
 *
 * `advanceRun` is idempotent: calling it twice with the same Run state in
 * dorothy.db produces the same outcome. Hooks call it on every Stop event.
 * ========================================================================== */

export interface AdvanceRunOutcome {
  action:
    | 'noop'                          // run not advanceable / no plan / nothing to do
    | 'started_worker_step'           // dispatched a worker
    | 'started_qa_step'
    | 'started_report_step'
    | 'completed_run'
    | 'needs_fix'
    | 'blocked'
    | 'failed';
  runId: string;
  step?: RunStep;
  agentId?: string;
  reason?: string;
}

export async function advanceRun(runId: string, opts: { maxRetries?: number } = {}): Promise<AdvanceRunOutcome> {
  const run = getRun(runId);
  if (!run) return { action: 'noop', runId, reason: 'run-not-found' };
  if (!isAdvanceableRun(run)) return { action: 'noop', runId, reason: `state=${run.state}` };

  // Phase 5D — pick the retry budget from the RunMode policy. Explicit
  // opts.maxRetries (used by tests) wins; otherwise we read the policy.
  // `manual` returns 0 (no auto-retry), `pipeline` returns 1, `persistent`
  // returns 3, `team`/`ultraqa` return 2 — same as the legacy default for
  // backward compatibility when mode is unset.
  const policyBudget = maxFixAttemptsFor(run.mode);
  const maxRetries = opts.maxRetries ?? (run.mode ? policyBudget : MAX_RETRIES_DEFAULT);

  // Phase 5E — enforce parallelDispatchAllowed. When the mode disallows
  // parallel work (manual / pipeline / ultraqa), refuse to dispatch a new
  // RunStep while another step is still running OR an AgentSession is still
  // active for this Run. We bail out *before* picking the next task so the
  // dispatch loop below never starts a second worker.
  if (run.mode && !parallelAllowedFor(run.mode)) {
    const existingSteps = listRunStepsByRun(runId);
    const stillRunning = existingSteps.some(s => s.state === 'running');
    let activeSessions = 0;
    try {
      activeSessions = listAgentSessions({ runId, active: true, limit: 25 }).length;
    } catch { /* ignore — keep behaviour identical to no-active-sessions */ }
    if (stillRunning || activeSessions > 0) {
      const reason = `parallel dispatch skipped by RunMode policy (mode=${run.mode})`;
      // Phase 5F — record as system_note so the operator can see "the
      // orchestrator backed off here" in the timeline.
      safeCreateHookEvent({
        type: 'system_note',
        severity: 'info',
        source: 'orchestrator',
        runId,
        title: `Parallel dispatch skipped (mode=${run.mode})`,
        summary: reason,
        metadata: { mode: run.mode, stillRunning, activeSessions },
      });
      return { action: 'noop', runId, reason };
    }
  }

  const plan = planForRun(runId);
  if (!plan) return { action: 'noop', runId, reason: 'no-plan' };

  const steps = listRunStepsByRun(runId);

  // 1) If the most recent step *failed* and we still have retry budget,
  //    re-dispatch the same task. The "same task" comes from plan.tasks[] for
  //    worker phases, or is synthesized for the qa/report phases (whose
  //    promptRef sentinels are `__qa__` / `__report__`).
  const lastStep = steps[steps.length - 1];
  if (lastStep && lastStep.state === 'failed') {
    if (lastStep.retryCount < maxRetries) {
      let retryTask: TaskDraft | null = null;
      let retryAction: AdvanceRunOutcome['action'] = 'started_worker_step';
      if (lastStep.promptRef === '__qa__') {
        retryTask = synthesizeTaskFor(VERIFY_AGENT, plan, 'Re-run validation after worker fix');
        retryAction = 'started_qa_step';
      } else if (lastStep.promptRef === '__report__') {
        retryTask = synthesizeTaskFor(REPORT_AGENT, plan, 'Re-run reporter');
        retryAction = 'started_report_step';
      } else {
        retryTask = (plan.tasks ?? []).find(t => t.taskId === lastStep.promptRef) ?? null;
      }

      if (retryTask) {
        const next = createRunStep({
          runId,
          order: lastStep.order + 1,
          agentId: lastStep.agentId,
          promptRef: lastStep.promptRef ?? retryTask.taskId,
        });
        if (next) {
          updateRunStepState(next.id, 'running', { incrementRetry: true });
          // Carry the cumulative retry count forward by repeated increments
          // so the budget check (lastStep.retryCount < maxRetries) sees the
          // total across retries, not just this attempt.
          for (let i = 0; i < lastStep.retryCount; i++) {
            updateRunStepState(next.id, 'running', { incrementRetry: true });
          }
        }
        const startedAgent = await dispatch({
          run, plan, runStep: next!, task: retryTask,
          extraForbidden: retryAction === 'started_qa_step' ? [] : extraForbiddenForOwner(retryTask.ownerAgentId),
          handoffSlug: lastStep.promptRef === '__qa__' ? 'qa-review'
                     : lastStep.promptRef === '__report__' ? 'result-report'
                     : retryTask.taskId,
        });
        return {
          action: retryAction,
          runId,
          step: next!,
          agentId: startedAgent ?? undefined,
          reason: `retry ${lastStep.retryCount + 1}/${maxRetries}`,
        };
      }
    }
    // Out of retries → needs_fix (user can override later)
    updateRunState(runId, 'needs_fix', {
      errorReason: lastStep.errorReason ?? `step ${lastStep.id} failed after ${lastStep.retryCount} retries`,
    });
    // Phase 5C-B — record an ImprovementSignal so the operator can spot
    // chronically flaky steps. Best-effort: failures here are non-critical.
    try {
      const isQa = lastStep.agentId === VERIFY_AGENT;
      createImprovementSignal({
        runId,
        source: isQa ? 'qa_failure' : 'retry_exceeded',
        severity: 'medium',
        title: isQa
          ? `QA step exhausted retries on run ${runId.slice(0, 8)}`
          : `Worker step exhausted retries (${lastStep.agentId}) on run ${runId.slice(0, 8)}`,
        summary: (lastStep.errorReason ?? 'no error reason recorded').slice(0, 400),
        relatedAgentId: lastStep.agentId,
        fingerprint: fingerprintFor({
          source: isQa ? 'qa_failure' : 'retry_exceeded',
          runId,
          relatedAgentId: lastStep.agentId,
          normalizedTitle: 'retry-exceeded',
        }),
      });
    } catch { /* ignore */ }
    return { action: 'needs_fix', runId, reason: 'retry-budget-exhausted' };
  }

  // 2) Pick the next worker task per dependsOn graph.
  const nextTask = pickNextTask(plan, steps);
  if (nextTask) {
    const stepOrder = steps.length;
    const created = createRunStep({
      runId,
      order: stepOrder,
      agentId: nextTask.ownerAgentId,
      promptRef: nextTask.taskId,
    });
    if (!created) return { action: 'noop', runId, reason: 'createRunStep-failed' };

    // First advance moves Run from approved → running.
    if (run.state === 'approved') {
      updateRunState(runId, 'running');
    }
    updateRunStepState(created.id, 'running');
    const startedAgent = await dispatchWorker({ run, plan, task: nextTask, runStep: created });
    return {
      action: 'started_worker_step',
      runId,
      step: created,
      agentId: startedAgent ?? undefined,
    };
  }

  // 3) All planner-defined tasks completed → run QA (unless already done).
  if (allWorkerTasksDone(plan, steps)) {
    const hasQa = steps.some(s => s.agentId === VERIFY_AGENT && s.state !== 'failed');
    if (!hasQa) {
      // Transition Run.state="verifying" before dispatching qa-reviewer.
      if (run.state !== 'verifying') updateRunState(runId, 'verifying');
      const qaStep = createRunStep({
        runId,
        order: steps.length,
        agentId: VERIFY_AGENT,
        promptRef: '__qa__',
      });
      if (!qaStep) return { action: 'noop', runId, reason: 'createRunStep(qa)-failed' };
      updateRunStepState(qaStep.id, 'running');
      const startedAgent = await dispatchVerifier({ run, plan, step: qaStep });
      return { action: 'started_qa_step', runId, step: qaStep, agentId: startedAgent ?? undefined };
    }

    const hasReport = steps.some(s => s.agentId === REPORT_AGENT && s.state !== 'failed');
    const qaCompleted = steps.some(s => s.agentId === VERIFY_AGENT && s.state === 'completed');
    if (qaCompleted && !hasReport) {
      if (run.state !== 'reporting') updateRunState(runId, 'reporting');
      const reportStep = createRunStep({
        runId,
        order: steps.length,
        agentId: REPORT_AGENT,
        promptRef: '__report__',
      });
      if (!reportStep) return { action: 'noop', runId, reason: 'createRunStep(report)-failed' };
      updateRunStepState(reportStep.id, 'running');
      const startedAgent = await dispatchReporter({ run, plan, step: reportStep });
      return { action: 'started_report_step', runId, step: reportStep, agentId: startedAgent ?? undefined };
    }

    const reportCompleted = steps.some(s => s.agentId === REPORT_AGENT && s.state === 'completed');
    if (reportCompleted) {
      if (run.state !== 'completed') updateRunState(runId, 'completed');
      return { action: 'completed_run', runId };
    }
  }

  return { action: 'noop', runId, reason: 'nothing-to-advance' };
}

/* ============================================================================
 * onAgentSessionEnded — hook from hooks-routes.ts
 *
 * When a Stop event arrives, the hooks layer already updated AgentSession;
 * here we mirror the outcome into RunStep.state and ask the orchestrator to
 * advance the Run.
 *
 * We deliberately do this *outside* the hooks-routes try/catch so a bug
 * here cannot bubble into the legacy AgentStatus path.
 * ========================================================================== */

export interface SessionEndSignal {
  agentSessionId: string;
  /** 'completed' or one of the failure flavors. */
  endStatus: 'completed' | 'failed' | 'cancelled' | 'timeout';
  /** Optional: most recent error / status line; reflected into RunStep.errorReason. */
  errorReason?: string | null;
}

export async function onAgentSessionEnded(signal: SessionEndSignal): Promise<AdvanceRunOutcome | null> {
  // Find any RunStep currently bound to this session.
  // We can't look it up via agent_sessions.run_step_id directly without an
  // extra query; pragma here: scan recent active steps and match.
  // Cheap and correct since a session is bound to at most one step.
  // Implementation lives in run-service via attachSessionToStep / run_steps.agent_session_id.

  // First, locate the binding via run_steps.agent_session_id.
  // For now we accept the runStepId being passed when the caller has it.
  // (hooks-routes.ts will pass it after we wire it up; until then no-op.)
  void signal;
  return null;
}

/**
 * Variant called when the caller already knows which RunStep ended (preferred
 * code path from a future hooks wire-up). Mirrors end status into RunStep,
 * writes a Handoff, then advances the Run.
 */
export async function completeRunStep(params: {
  runStepId: string;
  endStatus: 'completed' | 'failed' | 'cancelled' | 'timeout';
  errorReason?: string | null;
  /** Optional summary text — usually the worker's report excerpt. */
  handoffSummary?: string | null;
  /** Optional list of artifact ids attached to the handoff. */
  attachedArtifactIds?: string[];
}): Promise<AdvanceRunOutcome | null> {
  const { runStepId, endStatus, errorReason, handoffSummary, attachedArtifactIds } = params;

  const stepState = endStatus === 'completed' ? 'completed' : endStatus === 'cancelled' ? 'cancelled' : 'failed';
  const updated = updateRunStepState(runStepId, stepState, { errorReason });
  if (!updated) return null;

  // 자율 PR 토대 ② — RunStep 완료 시 worker repo의 commit ref(SHA/branch)를 artifacts.meta_json 에
  // 기록한다. dispatchVerifier(④)가 "이 작업의 commit/CI"를 ★쿼리할 수 있게(현재는 completionSummary
  // 자유텍스트에만 있어 매핑 불가). ★push 와 무관 — 로컬 HEAD SHA 기록만. 기존 동작 불변(try/catch).
  if (stepState === 'completed') {
    try {
      const liveAgents = depsRef?.getLiveAgents?.() ?? [];
      const projectPath = liveAgents.find(a => a.id === updated.agentId)?.projectPath;
      if (projectPath) {
        const opts = { cwd: projectPath, encoding: 'utf8' as const, timeout: 4000 };
        const commitSha = execSync('git rev-parse HEAD', opts).trim();
        const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
        createArtifact({
          runId: updated.runId,
          runStepId: updated.id,
          type: 'other',
          producedByAgentId: updated.agentId,
          meta: { kind: 'commit-ref', commitSha, branch, projectPath, capturedAt: new Date().toISOString() },
        });
      }
    } catch { /* ref 기록 실패는 비치명 — 완료 흐름 안 막음 */ }
  }

  // Write a handoff record linking this step to the previous one so the
  // Run Detail timeline / Handoffs tab has structure.
  const steps = listRunStepsByRun(updated.runId);
  const prior = steps.filter(s => s.state === 'completed' && s.id !== updated.id);
  if (prior.length > 0 && stepState === 'completed') {
    const previousStep = prior[prior.length - 1];
    createHandoff({
      runId: updated.runId,
      fromRunStepId: previousStep.id,
      toRunStepId: updated.id,
      summary: handoffSummary ?? `Step ${previousStep.order} → ${updated.order} (${updated.agentId})`,
      attachedArtifactIds,
    });
  }

  // If a worker is marked failed, Run goes to needs_fix only when we're past
  // the retry budget — advanceRun handles that branch.
  return advanceRun(updated.runId);
}

/* ============================================================================
 * Worker / verifier / reporter dispatch
 * ========================================================================== */

interface DispatchContext {
  run: Run;
  plan: Plan;
  task: TaskDraft;
  runStep: RunStep;
}

async function dispatchWorker(ctx: DispatchContext): Promise<string | null> {
  return dispatch({
    run: ctx.run,
    plan: ctx.plan,
    runStep: ctx.runStep,
    task: ctx.task,
    extraForbidden: extraForbiddenForOwner(ctx.task.ownerAgentId),
    handoffSlug: `${ctx.task.taskId}`,
  });
}

async function dispatchVerifier({ run, plan, step }: { run: Run; plan: Plan; step: RunStep }): Promise<string | null> {
  return dispatch({
    run, plan, runStep: step,
    task: synthesizeTaskFor(VERIFY_AGENT, plan, 'Run all acceptance criteria + reviews + path violation + security scan'),
    extraForbidden: [],
    handoffSlug: 'qa-review',
  });
}

async function dispatchReporter({ run, plan, step }: { run: Run; plan: Plan; step: RunStep }): Promise<string | null> {
  return dispatch({
    run, plan, runStep: step,
    task: synthesizeTaskFor(REPORT_AGENT, plan, 'Write changelog, PR body, result-report; transition run to completed'),
    extraForbidden: ['triplan/.claude/agents/**'],
    handoffSlug: 'result-report',
  });
}

interface DispatchInner {
  run: Run;
  plan: Plan;
  runStep: RunStep;
  task: TaskDraft;
  extraForbidden: string[];
  handoffSlug: string;
}

async function dispatch({ run, plan, runStep, task, extraForbidden, handoffSlug }: DispatchInner): Promise<string | null> {
  const deps = depsRef;
  const liveAgents = deps?.getLiveAgents?.() ?? [];
  const liveId = resolveLiveAgentForStep({ step: runStep, plan, liveAgents });

  const previousHandoff = await readMostRecentHandoff(run.id);

  // Phase 4.5 — TaskDraft.forbiddenPaths / validationCommands are the planner's
  // explicit will. We always concat the global baselines so a planner can't
  // shrink them by accident; if the planner is silent we fall back to the
  // legacy per-owner heuristics.
  const taskForbiddenPaths = task.forbiddenPaths ?? [];
  const fallbackForbidden = taskForbiddenPaths.length > 0 ? [] : extraForbidden;
  const finalForbiddenPaths = dedupe([
    ...DEFAULT_FORBIDDEN_PATHS,
    ...fallbackForbidden,
    ...taskForbiddenPaths,
  ]);

  const taskValidationCommands = task.validationCommands ?? [];
  const finalValidationCommands = taskValidationCommands.length > 0
    ? taskValidationCommands
    : validationCommandsFor(task);

  const promptParams: RunContextPromptParams = {
    runId: run.id,
    runStepId: runStep.id,
    planId: plan.id,
    task,
    allowedWritePaths: allowedWritePathsFor(task.ownerAgentId),
    forbiddenPaths: finalForbiddenPaths,
    validationCommands: finalValidationCommands,
    handoffOutputPath: handoffPathFor(task.ownerAgentId, handoffSlug),
    previousHandoff,
    failureHandlingRule: DEFAULT_FAILURE_RULE,
    taskSummary: `${task.title}\n\n${task.description}`.trim(),
    adrRef: plan.adrRef ?? null,
  };
  const prompt = buildRunContextPrompt(promptParams);

  // Phase 4.5 — feature-flag the auto-spawn. When the adapter is configured
  // *and* live, we dispatch directly; otherwise we leave the step in the
  // existing PTY/kanban auto-spawn path and just bind the session lazily.
  const adapterAvailable = Boolean(liveId && deps?.startAgent);
  if (adapterAvailable) {
    try {
      await deps!.startAgent!({
        agentId: liveId!,
        prompt,
        runId: run.id,
        runStepId: runStep.id,
      });
      // Bind the still-in-flight AgentSession to this step so the Stop hook
      // can mirror end status into the right RunStep.
      const sess = findActiveSessionForAgent(liveId!);
      if (sess) attachSessionToStep(runStep.id, sess.id);
      return liveId!;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn('[orchestrator] dispatch failed; leaving step pending:', reason);
      // Roll back to pending and stamp the reason so the Run Detail screen
      // shows *why* the step never got a live session.
      updateRunStepState(runStep.id, 'pending', {
        errorReason: `dispatch failed: ${reason}`,
      });
      return null;
    }
  }

  // No live agent or no adapter: leave the step in 'running' state — the
  // existing kanban auto-spawn flow / pm-tick will still pick it up the next
  // time it sees a Run with no live session bound. We intentionally keep this
  // soft so the orchestrator can be enabled progressively.
  return null;
}

/* ============================================================================
 * Helpers
 * ========================================================================== */

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function extraForbiddenForOwner(ownerAgentId: string): string[] {
  // The agent-definition .md files spell out per-role forbidden paths; we
  // bake the high-impact ones in here so the prompt is self-contained.
  switch (ownerAgentId) {
    case 'frontend':
      return [
        'triplan-travel-service/**',
        'soo-auth-service/**',
        'triplan-company/**',
        'electron/**',
        'db/migrations/**',
      ];
    case 'backend':
      return [
        'triplan-frontend/**',
        'src/**', // Dorothy frontend
      ];
    case 'qa-reviewer':
      return [
        'src/**', '**/*.tsx', '**/*.kt', '**/*.java', 'db/migrations/**', // QA is read-only
      ];
    case 'devops-reporter':
      return [
        'src/**', '**/*.tsx', '**/*.kt', '**/*.java', // docs/changelog only
      ];
    // Phase 6-C — Contract Agent never touches implementation code.
    case 'contract-agent':
      return [
        'triplan-frontend/**',
        'triplan-travel-service/**',
        'triplan-company/**',
        'soo-auth-service/**',
        'src/**',
        'electron/**',
        '**/*.tsx', '**/*.kt', '**/*.java',
        'db/migrations/**',
        '.env*',
        '**/.env*',
        'secrets/**',
        'production/**',
        'node_modules/**',
        '.git/**',
      ];
    // Phase 6-C — Database Agent never runs implementation code AND never
    // touches production DB paths. Migration / rollback artifacts live in
    // docs and migrations/** only.
    case 'database-agent':
      return [
        'triplan-frontend/**',
        'triplan-travel-service/**',
        'triplan-company/**',
        'soo-auth-service/**',
        'src/**',
        'electron/**',
        '**/*.tsx', '**/*.kt', '**/*.java',
        '.env*',
        '**/.env*',
        'secrets/**',
        'production/**',
        'production-db/**',
        'node_modules/**',
        '.git/**',
      ];
    default:
      return [];
  }
}

function allowedWritePathsFor(ownerAgentId: string): string[] {
  switch (ownerAgentId) {
    case 'frontend':
      return [
        'triplan-frontend/**',
        '__tests__/**',
        'triplan/.claude/reports/frontend/**',
      ];
    case 'backend':
      return [
        'triplan-travel-service/**',
        'triplan-company/**',
        'soo-auth-service/**',
        'db/migrations/**',
        'triplan/.claude/reports/backend/**',
      ];
    case 'qa-reviewer':
      return [
        'triplan/.claude/reports/qa-reviewer/**',
        // QA may not edit code; reports only.
      ];
    case 'devops-reporter':
      return [
        'triplan/docs/changelog/**',
        'triplan/docs/reports/**',
        'triplan/.claude/reports/devops-reporter/**',
      ];
    // Phase 6-C — Contract Agent writes docs / openapi / contracts only.
    case 'contract-agent':
      return [
        'docs/**',
        'triplan/docs/**',
        'contracts/**',
        'openapi/**',
        'triplan/.claude/reports/contract-agent/**',
      ];
    // Phase 6-C — Database Agent drafts migration / rollback files and a
    // db-impact report. Never touches production DB paths.
    case 'database-agent':
      return [
        'docs/**',
        'triplan/docs/**',
        'migrations/**',
        'db/**',
        'triplan/.claude/reports/database-agent/**',
      ];
    default:
      return [`triplan/.claude/reports/${ownerAgentId}/**`];
  }
}

function validationCommandsFor(task: TaskDraft): string[] {
  // Tasks may carry their own; otherwise we provide sensible defaults the
  // worker can quote in its report.
  // For phase 3 we keep this small — the planner is expected to enrich
  // acceptanceCriteria with explicit commands when relevant.
  if (!task.ownerAgentId) return [];
  switch (task.ownerAgentId) {
    case 'frontend':        return ['npm test', 'npx tsc --noEmit'];
    case 'backend':         return ['./gradlew test', './gradlew bootJar'];
    case 'qa-reviewer':     return ['(run tests in changed modules) — see step prompt'];
    case 'devops-reporter': return ['(no-op — verify changelog formatting)'];
    // Phase 6-C — Contract Agent ships a contract document; the validation
    // is "the artifact exists and parses". The orchestrator surfaces this
    // string so the worker quotes it in their report.
    case 'contract-agent':  return ['(verify api-contract.md + openapi.yaml/dto-schema.json are present and parse)'];
    // Phase 6-C — Database Agent ships migration + rollback plans. We
    // *never* tell the worker to actually run a migration command — the
    // string here is a check, not an execution instruction.
    case 'database-agent':  return ['(verify migration-plan.md + rollback-plan.md exist; do NOT execute migrations)'];
    default: return [];
  }
}

function synthesizeTaskFor(agentId: string, plan: Plan, description: string): TaskDraft {
  return {
    taskId: `__${agentId}__`,
    title: `${agentId} for plan ${plan.title}`,
    description,
    ownerAgentId: agentId,
    dependsOn: [],
    acceptanceCriteria: [
      'Read all prior step handoffs',
      'Produce the agent-specific handoff at handoffOutputPath',
    ],
  };
}

/**
 * Reads the most recent worker report file for the Run, if it exists. Phase
 * 3 keeps this best-effort — when running outside the triplan workspace we
 * just return null.
 */
async function readMostRecentHandoff(runId: string): Promise<string | null> {
  void runId;
  // TODO Phase 4: walk triplan/.claude/reports/<role>/<date>/ and find the
  // newest *.md whose body references `runId`. For Phase 3 the prompt is
  // self-contained, so we omit this read to avoid noisy filesystem walks
  // on every dispatch.
  return null;
}

/* ============================================================================
 * Public utility — drive the orchestrator across every advanceable Run.
 *
 * Wired by the IPC handler (`dorothy:runs:advanceAll`) so the UI can poke
 * the orchestrator after a manual decision. Safe to call repeatedly.
 * ========================================================================== */

export async function advanceAllRuns(): Promise<AdvanceRunOutcome[]> {
  const candidates = listRuns({ state: ['approved', 'running', 'verifying', 'needs_fix', 'reporting'] as RunState[], limit: 100 });
  const out: AdvanceRunOutcome[] = [];
  for (const r of candidates) {
    out.push(await advanceRun(r.id));
  }
  return out;
}
