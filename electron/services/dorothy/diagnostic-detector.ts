/**
 * Dorothy MVP Phase 6-A — HookEvent → Diagnostic detector.
 *
 * Rule-based mapping (no AI). Each detector function takes a single freshly-
 * created `HookEvent` and decides whether it warrants a Diagnostic candidate.
 * The caller (rate-limit-service, run-service, etc.) invokes the safe wrapper
 * `safeDetectDiagnosticFromHookEvent(event)` after `safeCreateHookEvent`
 * returns so we never create a Diagnostic for an event that failed to land.
 *
 * Triage budget — we only convert *noisy* HookEvents that the operator needs
 * to act on:
 *
 *   - ci_failed                                  → high severity, ci_failure
 *   - resume_failed                              → high severity, resume_failure
 *   - run_step_failed                            → high severity, orchestrator (qa role → qa_failure)
 *   - agent_session_failed                       → medium, agent_session
 *   - github_review_event w/ changes_requested   → medium, github_review
 *   - approval_required                          → medium, approval_block
 *   - rate_limit_detected                        → low, rate_limit
 *
 * Everything else returns null. We deliberately ignore `system_note` /
 * `info` / `debug` rows; the Diagnostic table is meant to be actionable.
 *
 * Safety:
 *   - detector failures must not propagate to the originating flow
 *   - metadata is excerpted (≤500 chars after masking, via the existing
 *     `makeExcerpt` util reused from hook-event-service)
 *   - no raw GitHub body / comment body / output transcript ever flows in
 */

import { safeCreateOrUpdateDiagnostic } from './diagnostic-service';
import { makeExcerpt } from './hook-event-service';
import { fingerprintFor } from './improvement-signal-service';
import type {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticSource,
  HookEvent,
  HookEventType,
  CreateDiagnosticInput,
} from '../../types/dorothy';

/**
 * Event types this detector cares about. Anything else returns null.
 * Exported so tests can pin the contract.
 */
export const DIAGNOSTIC_TRIGGER_TYPES: ReadonlyArray<HookEventType> = [
  'ci_failed',
  'resume_failed',
  'run_step_failed',
  'agent_session_failed',
  'github_review_event',
  'approval_required',
  'rate_limit_detected',
];

function isDiagnosticTriggerType(t: HookEventType): boolean {
  return DIAGNOSTIC_TRIGGER_TYPES.includes(t);
}

/* ============================================================================
 * Per-type detector helpers
 *
 * Each helper returns a CreateDiagnosticInput (or null when the specific
 * event variant should NOT produce a Diagnostic — e.g. an
 * `github_review_event` for APPROVED is not actionable).
 * ========================================================================== */

function fp(parts: {
  source: DiagnosticSource;
  runId?: string | null;
  agentId?: string | null;
  bucket: string;
}): string {
  // Reuse the ImprovementSignal fingerprint shape so cross-references with
  // ImprovementSignals roll up consistently. The signal source must be one
  // of the ImprovementSignal sources; the second-level bucket gives finer
  // grouping (e.g. workflow name for CI, agent role for RunStep).
  return fingerprintFor({
    source: 'manual_note',
    runId: parts.runId ?? null,
    relatedAgentId: parts.agentId ?? parts.source,
    normalizedTitle: `${parts.source}:${parts.bucket}`,
  });
}

function detectCiFailed(event: HookEvent): CreateDiagnosticInput | null {
  const meta = event.metadata ?? {};
  const workflow = String(meta.workflow ?? 'unknown');
  const conclusion = String(meta.conclusion ?? meta.state ?? 'failed');
  return {
    runId: event.runId ?? null,
    source: 'ci_failure',
    severity: 'high',
    title: clamp(`CI failed: ${workflow}`, 140),
    summary: makeExcerpt(
      `${event.title}${event.summary ? `\n${event.summary}` : ''}\nworkflow=${workflow} conclusion=${conclusion}`,
    ) ?? `CI failed: ${workflow}`,
    suggestedFix: 'Inspect the failing workflow log and re-dispatch via /pr after the underlying defect is patched.',
    evidenceHookEventIds: [event.id],
    fingerprint: fp({ source: 'ci_failure', runId: event.runId, bucket: workflow }),
  };
}

function detectResumeFailed(event: HookEvent): CreateDiagnosticInput | null {
  const meta = event.metadata ?? {};
  const retry = Number(meta.retryCount ?? 0);
  const provider = String(meta.provider ?? meta.engine ?? 'claude');
  const lastErr = meta.lastResumeError ?? null;
  const severity: DiagnosticSeverity = retry >= 3 ? 'high' : 'medium';
  return {
    runId: event.runId ?? null,
    source: 'resume_failure',
    severity,
    title: `Auto resume failed (${provider})`,
    summary: makeExcerpt(
      `${event.title}${event.summary ? `\n${event.summary}` : ''}\nprovider=${provider} retryCount=${retry}${lastErr ? `\nlastError=${lastErr}` : ''}`,
    ) ?? `Auto resume failed (${provider})`,
    suggestedFix:
      retry >= 3
        ? 'Investigate the provider connectivity or rate-limit reset time. Consider flipping dorothyAutoResumeRateLimitedSessions to dry-run while debugging.'
        : 'Re-check the resume window. A manual Resume Now on /sessions usually unsticks transient failures.',
    evidenceHookEventIds: [event.id],
    fingerprint: fp({ source: 'resume_failure', runId: event.runId, agentId: provider, bucket: provider }),
  };
}

function detectRunStepFailed(event: HookEvent): CreateDiagnosticInput | null {
  const meta = event.metadata ?? {};
  const agentId = event.agentId ?? String(meta.agentId ?? '');
  // Map qa-reviewer / qa* steps to qa_failure for downstream filtering.
  const isQa = agentId === 'qa-reviewer' || agentId.startsWith('qa');
  const source: DiagnosticSource = isQa ? 'qa_failure' : 'orchestrator';
  const order = meta.order;
  const errorReason = meta.errorReason ?? null;
  return {
    runId: event.runId ?? null,
    runStepId: event.runStepId ?? null,
    agentSessionId: event.agentSessionId ?? null,
    agentId: agentId || null,
    source,
    severity: 'high',
    title: clamp(`RunStep #${order ?? '?'} ${agentId || 'agent'} failed`, 140),
    summary: makeExcerpt(
      `${event.title}${errorReason ? `\nerror=${String(errorReason)}` : ''}`,
    ) ?? event.title,
    suggestedFix: isQa
      ? 'Open the qa-reviewer handoff and address the failing acceptance criterion. Re-dispatch via /runs after the worker pushes a fix.'
      : 'Open the failing RunStep on /runs and re-dispatch after the underlying error is patched. Risky modes (manual / pipeline) have a tighter retry budget.',
    evidenceHookEventIds: [event.id],
    fingerprint: fp({
      source,
      runId: event.runId,
      agentId,
      bucket: `step:${agentId}`,
    }),
  };
}

function detectAgentSessionFailed(event: HookEvent): CreateDiagnosticInput | null {
  const meta = event.metadata ?? {};
  const provider = String(meta.provider ?? '');
  const endStatus = String(meta.endStatus ?? 'failed');
  return {
    runId: event.runId ?? null,
    runStepId: event.runStepId ?? null,
    agentSessionId: event.agentSessionId ?? null,
    agentId: event.agentId ?? null,
    source: 'agent_session',
    severity: 'medium',
    title: clamp(`Agent session ${endStatus} — ${event.agentId ?? 'agent'}`, 140),
    summary: makeExcerpt(
      `${event.title}${event.summary ? `\n${event.summary}` : ''}\nprovider=${provider} endStatus=${endStatus}`,
    ) ?? event.title,
    suggestedFix:
      'Inspect the PTY log for the session. Restart the worker manually via /sessions if the failure looks recoverable.',
    evidenceHookEventIds: [event.id],
    fingerprint: fp({
      source: 'agent_session',
      runId: event.runId,
      agentId: event.agentId ?? provider,
      bucket: `session-${endStatus}`,
    }),
  };
}

function detectGithubReviewEvent(event: HookEvent): CreateDiagnosticInput | null {
  const meta = event.metadata ?? {};
  const reviewerState = String(meta.reviewerState ?? '');
  // We *only* care about changes_requested. APPROVED / COMMENTED is informational.
  if (reviewerState !== 'changes_requested') return null;
  const externalRef = String(meta.externalRef ?? '');
  const reviewer = String(meta.reviewer ?? 'unknown');
  return {
    runId: event.runId ?? null,
    source: 'github_review',
    severity: 'medium',
    title: clamp(`Changes requested on ${externalRef || 'PR'} by @${reviewer}`, 140),
    summary: makeExcerpt(
      `${event.title}\nreviewer=${reviewer} externalRef=${externalRef}`,
    ) ?? event.title,
    suggestedFix:
      'Address the reviewer feedback on the PR, push the fix to the same branch, and re-request review.',
    evidenceHookEventIds: [event.id],
    fingerprint: fp({
      source: 'github_review',
      runId: event.runId,
      agentId: reviewer,
      bucket: externalRef || 'pr',
    }),
  };
}

function detectApprovalRequired(event: HookEvent): CreateDiagnosticInput | null {
  const meta = event.metadata ?? {};
  const topic = String(meta.topic ?? '');
  const riskLevel = String(meta.riskLevel ?? 'medium');
  // Approval gates are normal flow for risky topics; they only become a
  // Diagnostic when they BLOCK progress (risk=high|critical).
  const severity: DiagnosticSeverity = riskLevel === 'critical' ? 'high'
                                    : riskLevel === 'high'     ? 'medium'
                                    : 'low';
  // Don't emit a Diagnostic for plain medium-risk approvals — they're a normal
  // gate, not a blocker. Operator can still inspect via /approvals.
  if (severity === 'low') return null;
  return {
    runId: event.runId ?? null,
    source: 'approval_block',
    severity,
    title: clamp(`Approval required — ${topic || 'no-topic'}`, 140),
    summary: makeExcerpt(
      `${event.title}\ntopic=${topic} riskLevel=${riskLevel}`,
    ) ?? event.title,
    suggestedFix:
      'Open /approvals, review the proposed change against approval-policy.md, and either approve, reject, or split the risky task out.',
    evidenceHookEventIds: [event.id],
    fingerprint: fp({
      source: 'approval_block',
      runId: event.runId,
      bucket: topic || 'gate',
    }),
  };
}

function detectRateLimitDetected(event: HookEvent): CreateDiagnosticInput | null {
  const meta = event.metadata ?? {};
  const provider = String(meta.provider ?? meta.engine ?? 'claude');
  const parseConfidence = String(meta.parseConfidence ?? 'medium');
  // Low-confidence parses are the actionable case (operator must inspect);
  // high-confidence usage limits self-resolve at resumeAt and rarely warrant
  // a Diagnostic. We still emit a low-severity row so /diagnostics shows
  // chronology when the operator filters.
  const severity: DiagnosticSeverity = parseConfidence === 'low' ? 'medium' : 'low';
  return {
    runId: event.runId ?? null,
    source: 'rate_limit',
    severity,
    title: `Rate limit detected (${provider})`,
    summary: makeExcerpt(
      `${event.title}\nprovider=${provider} parseConfidence=${parseConfidence}`,
    ) ?? event.title,
    suggestedFix:
      parseConfidence === 'low'
        ? 'Manually verify the resumeAt timestamp and trigger Resume Now on /sessions once the cooldown passes.'
        : 'Wait for the scheduled resume; no action required unless retries pile up.',
    evidenceHookEventIds: [event.id],
    fingerprint: fp({
      source: 'rate_limit',
      runId: event.runId,
      agentId: provider,
      bucket: `${provider}:${parseConfidence}`,
    }),
  };
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/* ============================================================================
 * Public surface
 * ========================================================================== */

/** Dispatcher: pick the right detector for an event type, return its input. */
export function detectDiagnosticInput(event: HookEvent): CreateDiagnosticInput | null {
  if (!isDiagnosticTriggerType(event.type)) return null;
  switch (event.type) {
    case 'ci_failed':              return detectCiFailed(event);
    case 'resume_failed':          return detectResumeFailed(event);
    case 'run_step_failed':        return detectRunStepFailed(event);
    case 'agent_session_failed':   return detectAgentSessionFailed(event);
    case 'github_review_event':    return detectGithubReviewEvent(event);
    case 'approval_required':      return detectApprovalRequired(event);
    case 'rate_limit_detected':    return detectRateLimitDetected(event);
    default:                       return null;
  }
}

/**
 * The hot-path entry point. Callers invoke this after successfully creating a
 * HookEvent. Never throws.
 *
 * Returns the resulting Diagnostic (new or deduped), or null when:
 *   - the event isn't a trigger type
 *   - the detector decided this variant is not actionable
 *   - DB is unavailable
 *   - any underlying write failed
 */
export function safeDetectDiagnosticFromHookEvent(event: HookEvent | null | undefined): Diagnostic | null {
  if (!event) return null;
  try {
    const input = detectDiagnosticInput(event);
    if (!input) return null;
    return safeCreateOrUpdateDiagnostic(input);
  } catch (err) {
    console.warn(
      '[diagnostic-detector] swallowed error:',
      err instanceof Error ? err.message : 'unknown',
    );
    return null;
  }
}
