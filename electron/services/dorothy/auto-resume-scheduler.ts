/**
 * Dorothy MVP Phase 5C-B — Auto Resume Scheduler.
 *
 * Polls `rate_limit_events` for rows where `resume_status ∈ {scheduled, pending}`
 * and `resume_at <= now`, and tries to:
 *
 *   1. Mark Runs / RunSteps / AgentSessions as ready
 *   2. (When the user has opted in) call the Orchestrator's startAgent
 *      adapter so the worker actually resumes.
 *
 * Safety rails:
 *   - Feature flag `appSettings.dorothyAutoResumeRateLimitedSessions` —
 *     default is `'dry-run'`. Only the literal string `true` (or `'true'`)
 *     allows an actual dispatch. dry-run records would-have-dispatched
 *     candidates without calling startAgent.
 *   - In-memory locks prevent concurrent ticks from double-dispatching the
 *     same eventId / sessionId.
 *   - Persistent guard: rows already `resuming` / `resumed` are skipped on
 *     every tick (including after an app restart).
 *   - Manual `resumeNow(eventId)` works even when the flag is off — it's
 *     the user explicitly asking.
 *
 * The scheduler itself is unit-testable: callers configure it via
 * `configureAutoResume({ getLiveAgents, startAgent, isAutoResumeEnabled })`
 * and invoke `runTick()` directly. The real Electron wiring lives in main.ts.
 */

import {
  listResumeReadyEvents,
  updateRateLimitResume,
  getRateLimitEvent,
  listRateLimitEvents,
} from './rate-limit-service';
import { getRun, updateRunState, getRunStep, updateRunStepState, listRunStepsByRun } from './run-service';
import { getAgentSession, findActiveSessionForAgent } from './agent-session-service';
import { listHandoffsByRun, listArtifactsByRun } from './artifact-service';
import { listPlansByRun } from './plan-service';
import {
  buildRunContextPrompt,
  DEFAULT_FORBIDDEN_PATHS,
  DEFAULT_FAILURE_RULE,
  handoffPathFor,
} from './agent-routing';
import { createImprovementSignal, fingerprintFor } from './improvement-signal-service';
import type {
  RateLimitEvent,
  Run,
  RunStep,
  AgentSession,
  TaskDraft,
} from '../../types/dorothy';

/* ============================================================================
 * Public configuration / mode
 * ========================================================================== */

export type AutoResumeMode = 'off' | 'dry-run' | 'live';

export function normalizeAutoResumeMode(raw: unknown): AutoResumeMode {
  if (raw === true || raw === 'true' || raw === 'on' || raw === 'live') return 'live';
  if (raw === false || raw === 'false' || raw === 'off') return 'off';
  // Everything else (undefined, 'dry-run', any string) → safe default.
  return 'dry-run';
}

export interface AutoResumeDeps {
  /** Returns the current setting; called every tick so the flag is hot-reloadable. */
  getMode(): AutoResumeMode;
  /** Orchestrator-style adapter. Called only in live mode or for manual resumeNow. */
  startAgent?(params: { agentId: string; prompt: string; runId: string; runStepId: string }): Promise<void>;
  /** Light agent snapshot so the scheduler can pick the right worker by role. */
  getLiveAgents?(): Array<{ id: string; status: string; name?: string }>;
}

let depsRef: AutoResumeDeps | null = null;
let tickHandle: NodeJS.Timeout | null = null;

/* ============================================================================
 * In-memory locks
 *
 * The scheduler shouldn't dispatch the same event twice if a tick races with
 * a manual resumeNow call. We track in-flight event ids in a Set; the
 * persisted `resume_status = 'resuming'` provides the same guard across app
 * restarts.
 * ========================================================================== */

const inFlightEvents = new Set<string>();
const inFlightSessions = new Set<string>();

function lockEvent(eventId: string): boolean {
  if (inFlightEvents.has(eventId)) return false;
  inFlightEvents.add(eventId);
  return true;
}
function unlockEvent(eventId: string): void { inFlightEvents.delete(eventId); }

function lockSession(sessionId: string): boolean {
  if (inFlightSessions.has(sessionId)) return false;
  inFlightSessions.add(sessionId);
  return true;
}
function unlockSession(sessionId: string): void { inFlightSessions.delete(sessionId); }

/* ============================================================================
 * Public surface
 * ========================================================================== */

export function configureAutoResume(deps: AutoResumeDeps): void {
  depsRef = deps;
}

export function startAutoResumeTicker(intervalMs = 60_000): void {
  if (tickHandle) return;
  tickHandle = setInterval(() => { void runTick().catch(err => console.warn('[auto-resume] tick failed:', err)); }, intervalMs);
}

export function stopAutoResumeTicker(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

export interface TickOutcome {
  mode: AutoResumeMode;
  scheduledCount: number;
  attempted: Array<{ eventId: string; agentId?: string; runId?: string; runStepId?: string; outcome: 'dispatched' | 'dry-run' | 'skipped' | 'failed'; reason?: string }>;
}

/**
 * One tick of the scheduler. Idempotent — safe to call as often as you like.
 * Returns a summary the IPC handler / tests can inspect.
 */
export async function runTick(now: Date = new Date()): Promise<TickOutcome> {
  const deps = depsRef;
  const mode: AutoResumeMode = deps?.getMode ? deps.getMode() : 'dry-run';
  const ready = listResumeReadyEvents(now);
  const attempted: TickOutcome['attempted'] = [];

  for (const evt of ready) {
    if (!lockEvent(evt.id)) {
      attempted.push({ eventId: evt.id, outcome: 'skipped', reason: 'event-locked' });
      continue;
    }
    try {
      // Re-read so we don't race a manual resumeNow that already flipped the
      // row to 'resuming' or 'resumed'.
      const current = getRateLimitEvent(evt.id);
      if (!current || current.resumeStatus === 'resuming' || current.resumeStatus === 'resumed') {
        attempted.push({ eventId: evt.id, outcome: 'skipped', reason: 'already-finished' });
        continue;
      }
      const r = await attemptResume(current, mode);
      attempted.push({ eventId: evt.id, ...r });
    } finally {
      unlockEvent(evt.id);
    }
  }

  // Phase 5C-C — audit: events that have been scheduled/pending in dry-run
  // for >24h since their resumeAt elapsed are surfaced as ImprovementSignals
  // so the operator notices their auto-resume hasn't run. Dedupe by event id.
  try {
    auditOverdueDryRun(now);
  } catch (err) {
    console.warn('[auto-resume] dry-run audit failed (ignored):', err instanceof Error ? err.message : 'unknown');
  }

  return { mode, scheduledCount: ready.length, attempted };
}

const OVERDUE_AUDIT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function auditOverdueDryRun(now: Date): void {
  const events = listRateLimitEvents({
    resumeStatus: ['scheduled', 'pending'],
    limit: 500,
  });
  for (const e of events) {
    if (!e.resumeAt) continue;
    const elapsed = now.getTime() - new Date(e.resumeAt).getTime();
    if (elapsed < OVERDUE_AUDIT_THRESHOLD_MS) continue;
    // Dedupe by event id — the same event keeps bumping occurrenceCount via
    // the fingerprint rather than re-creating rows.
    const fp = fingerprintFor({
      source: 'rate_limit',
      runId: (e.affectedRunIds ?? [])[0] ?? null,
      relatedAgentId: e.provider ?? e.engine ?? null,
      normalizedTitle: `dry-run-overdue:${e.id}`,
    });
    createImprovementSignal({
      runId: (e.affectedRunIds ?? [])[0] ?? null,
      source: 'rate_limit',
      severity: 'medium',
      title: 'Rate-limited session remained in dry-run resume state',
      summary: `Event ${e.id.slice(0, 8)} (${e.provider ?? e.engine}) was eligible for auto-resume at ${e.resumeAt} but auto-resume is in dry-run mode. ${Math.floor(elapsed / 3600_000)}h since resume time. Flip dorothyAutoResumeRateLimitedSessions to "live" or click Resume Now on /sessions.`,
      relatedAgentId: e.provider ?? e.engine ?? null,
      fingerprint: fp,
    });
  }
}

/**
 * Manual user-driven resume. Works even when mode='dry-run' or 'off' — this
 * is the operator explicitly asking.
 */
export async function resumeNow(eventId: string): Promise<TickOutcome['attempted'][number]> {
  if (!lockEvent(eventId)) {
    return { eventId, outcome: 'skipped', reason: 'event-locked' };
  }
  try {
    const evt = getRateLimitEvent(eventId);
    if (!evt) return { eventId, outcome: 'skipped', reason: 'not-found' };
    if (evt.resumeStatus === 'resumed') return { eventId, outcome: 'skipped', reason: 'already-resumed' };
    // Force live mode for this call regardless of the global flag.
    const r = await attemptResume(evt, 'live', /* manual */ true);
    return { eventId, ...r };
  } finally {
    unlockEvent(eventId);
  }
}

/* ============================================================================
 * Resume mechanics
 * ========================================================================== */

interface ResumeAttemptResult {
  outcome: 'dispatched' | 'dry-run' | 'skipped' | 'failed';
  reason?: string;
  agentId?: string;
  runId?: string;
  runStepId?: string;
}

async function attemptResume(evt: RateLimitEvent, mode: AutoResumeMode, manual = false): Promise<ResumeAttemptResult> {
  // Confidence gate: never auto-resume an event we couldn't parse.
  if (!manual && evt.parseConfidence === 'low') {
    return { outcome: 'skipped', reason: 'low-confidence' };
  }

  // Pick the resume target — sessions first, then steps, then runs.
  const target = pickResumeTarget(evt);
  if (!target) {
    return { outcome: 'skipped', reason: 'no-affected-targets' };
  }

  if (!lockSession(target.sessionLockKey)) {
    return { outcome: 'skipped', reason: 'session-locked' };
  }
  try {
    // dry-run / off short-circuit. Mark the event as scheduled-but-untouched.
    if (mode !== 'live') {
      // Stamp a dry-run trace into lastResumeError so the UI can show "dry-run".
      updateRateLimitResume({
        id: evt.id,
        lastResumeError: `dry-run @ ${new Date().toISOString()}: would dispatch ${target.agentRole ?? '?'} for run ${target.run.id}`,
      });
      return {
        outcome: 'dry-run',
        agentId: undefined,
        runId: target.run.id,
        runStepId: target.runStep?.id,
        reason: 'auto-resume disabled (dry-run)',
      };
    }

    // Live mode — call the adapter.
    const deps = depsRef;
    if (!deps?.startAgent) {
      updateRateLimitResume({
        id: evt.id,
        resumeStatus: 'failed',
        lastResumeError: 'no startAgent adapter wired',
        incrementRetry: true,
      });
      return { outcome: 'failed', reason: 'no-adapter' };
    }

    // Match a live agent for the worker role.
    const live = deps.getLiveAgents?.() ?? [];
    const wantedRole = target.agentRole;
    const matching = wantedRole
      ? live.find(a => (a.name ?? '').toLowerCase().includes(wantedRole.toLowerCase()) && a.status === 'idle')
        ?? live.find(a => (a.name ?? '').toLowerCase().includes(wantedRole.toLowerCase()))
      : undefined;
    if (!matching) {
      updateRateLimitResume({
        id: evt.id,
        resumeStatus: 'failed',
        lastResumeError: `no live agent matches role=${wantedRole ?? '?'}`,
        incrementRetry: true,
      });
      return { outcome: 'failed', reason: 'no-matching-agent' };
    }

    // Mark resuming BEFORE the await so a parallel tick sees the lock.
    updateRateLimitResume({ id: evt.id, resumeStatus: 'resuming' });
    try {
      const prompt = buildResumePrompt({ event: evt, target });
      await deps.startAgent({
        agentId: matching.id,
        prompt,
        runId: target.run.id,
        runStepId: target.runStep?.id ?? '',
      });
      updateRateLimitResume({
        id: evt.id,
        resumeStatus: 'resumed',
        resumedAt: new Date().toISOString(),
      });
      return {
        outcome: 'dispatched',
        agentId: matching.id,
        runId: target.run.id,
        runStepId: target.runStep?.id,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      updateRateLimitResume({
        id: evt.id,
        resumeStatus: 'failed',
        lastResumeError: msg,
        incrementRetry: true,
      });
      // Repeated resume failures are an improvement signal worth recording.
      try {
        createImprovementSignal({
          runId: target.run.id,
          source: 'rate_limit',
          severity: 'medium',
          title: `Auto-resume failed for ${target.agentRole ?? 'worker'} on run ${target.run.id.slice(0, 8)}`,
          summary: `Last error: ${msg.slice(0, 240)}`,
          relatedAgentId: target.agentRole ?? null,
          fingerprint: fingerprintFor({
            source: 'rate_limit',
            runId: target.run.id,
            relatedAgentId: target.agentRole ?? null,
            normalizedTitle: 'auto-resume-failed',
          }),
        });
      } catch { /* non-critical */ }
      return { outcome: 'failed', reason: msg };
    }
  } finally {
    unlockSession(target.sessionLockKey);
  }
}

interface ResumeTarget {
  run: Run;
  runStep?: RunStep;
  session?: AgentSession;
  agentRole?: string;
  /** Used by the in-memory session lock. We fall back to runId when no
   *  AgentSession is bound yet. */
  sessionLockKey: string;
}

function pickResumeTarget(evt: RateLimitEvent): ResumeTarget | null {
  // 1) Bound AgentSession ids — most specific.
  if (evt.affectedSessionIds && evt.affectedSessionIds.length) {
    for (const sid of evt.affectedSessionIds) {
      const s = getAgentSession(sid);
      if (!s || !s.runId) continue;
      const r = getRun(s.runId);
      if (!r) continue;
      const step = s.runStepId ? getRunStep(s.runStepId) : undefined;
      return {
        run: r, runStep: step ?? undefined, session: s,
        agentRole: s.agentId,
        sessionLockKey: sid,
      };
    }
  }
  // 2) RunStep ids
  if (evt.affectedRunStepIds && evt.affectedRunStepIds.length) {
    for (const stepId of evt.affectedRunStepIds) {
      const step = getRunStep(stepId);
      if (!step) continue;
      const run = getRun(step.runId);
      if (!run) continue;
      return {
        run, runStep: step,
        agentRole: step.agentId,
        sessionLockKey: `step:${stepId}`,
      };
    }
  }
  // 3) Run ids — pick the most recent non-completed step (pending or blocked).
  if (evt.affectedRunIds && evt.affectedRunIds.length) {
    for (const rid of evt.affectedRunIds) {
      const run = getRun(rid);
      if (!run) continue;
      const steps = listRunStepsByRun(rid);
      const cand = steps.find(s => s.state === 'pending' || s.state === 'running')
                ?? steps[steps.length - 1];
      return {
        run, runStep: cand,
        agentRole: cand?.agentId,
        sessionLockKey: `run:${rid}`,
      };
    }
  }
  return null;
}

/* ============================================================================
 * Resume prompt
 *
 * The contract docs require this exact preface so the worker reads context
 * before touching files.
 * ========================================================================== */

export const RESUME_PROMPT_PREFACE =
  'You are resuming a previously paused Dorothy Run.\n' +
  'Do not repeat completed work.\n' +
  'Read the Run, RunStep, AgentSession, and latest Handoff before modifying files.\n' +
  'Continue only the assigned pending or blocked step.\n' +
  'If unsure, write a change-request instead of guessing.';

interface BuildResumePromptArgs {
  event: RateLimitEvent;
  target: ResumeTarget;
}

export function buildResumePrompt({ event, target }: BuildResumePromptArgs): string {
  const { run, runStep, session } = target;
  const handoffs = listHandoffsByRun(run.id);
  const lastHandoff = handoffs[handoffs.length - 1];
  const artifacts = listArtifactsByRun(run.id);
  const recentArtifacts = artifacts.slice(-8);
  const allSteps = listRunStepsByRun(run.id);
  const completedSteps = allSteps.filter(s => s.state === 'completed').map(s => `#${s.order} ${s.agentId}`);
  const pendingSteps = allSteps.filter(s => s.state === 'pending' || s.state === 'running' || s.state === 'failed')
    .map(s => `#${s.order} ${s.agentId} (${s.state})`);

  // Pull the planner-supplied task (if any) so paths / criteria are exact.
  let task: TaskDraft | undefined;
  const plans = listPlansByRun(run.id);
  const plan = plans.find(p => p.state === 'approved') ?? plans[0];
  if (plan && runStep) {
    task = (plan.tasks ?? []).find(t => t.taskId === runStep.promptRef);
  }

  const ctxBlock = task && plan
    ? buildRunContextPrompt({
        runId: run.id,
        runStepId: runStep!.id,
        planId: plan.id,
        task,
        allowedWritePaths: [`triplan-${task.ownerAgentId}/**`, `triplan/.claude/reports/${task.ownerAgentId}/**`],
        forbiddenPaths: [...DEFAULT_FORBIDDEN_PATHS, ...(task.forbiddenPaths ?? [])],
        validationCommands: task.validationCommands ?? task.acceptanceCriteria ?? [],
        handoffOutputPath: handoffPathFor(task.ownerAgentId, `resume-${task.taskId}`),
        previousHandoff: lastHandoff?.summary ?? null,
        failureHandlingRule: DEFAULT_FAILURE_RULE,
        taskSummary: `${task.title}\n\n${task.description}`.trim(),
        adrRef: plan.adrRef ?? null,
      })
    : '';

  const lines: string[] = [];
  lines.push(RESUME_PROMPT_PREFACE);
  lines.push('');
  lines.push('## Resume context');
  lines.push(`- runId: \`${run.id}\``);
  lines.push(`- runState: \`${run.state}\``);
  if (runStep) {
    lines.push(`- runStepId: \`${runStep.id}\``);
    lines.push(`- runStepState: \`${runStep.state}\``);
  }
  if (session) {
    lines.push(`- agentSessionId: \`${session.id}\``);
  }
  if (event.resumeAt) {
    lines.push(`- resumeAt: \`${event.resumeAt}\``);
  }
  if (event.messageExcerpt) {
    lines.push(`- limitExcerpt: \`${event.messageExcerpt}\``);
  }
  lines.push('');

  if (completedSteps.length) {
    lines.push('## Already completed (do NOT repeat)');
    for (const s of completedSteps) lines.push(`- ${s}`);
    lines.push('');
  }
  if (pendingSteps.length) {
    lines.push('## Pending / blocked (continue from here)');
    for (const s of pendingSteps) lines.push(`- ${s}`);
    lines.push('');
  }
  if (lastHandoff) {
    lines.push('## Latest handoff');
    lines.push('```');
    lines.push((lastHandoff.summary ?? '').slice(0, 2000));
    lines.push('```');
    lines.push('');
  }
  if (recentArtifacts.length) {
    lines.push('## Recent artifacts');
    for (const a of recentArtifacts) {
      lines.push(`- ${a.type}: ${a.path ?? a.contentRef ?? '(no path)'}`);
    }
    lines.push('');
  }

  if (ctxBlock) {
    lines.push('---');
    lines.push(ctxBlock);
  }
  return lines.join('\n');
}

/* ============================================================================
 * Testing helpers
 * ========================================================================== */

export function _clearLocks(): void {
  inFlightEvents.clear();
  inFlightSessions.clear();
}
