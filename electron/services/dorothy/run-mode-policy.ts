/**
 * Dorothy MVP Phase 5D — Run Mode policy registry.
 *
 * Each mode has a small immutable record describing its execution rules. The
 * orchestrator consults this registry to decide whether to retry, run FE/BE
 * in parallel, etc. Splitting the rules out into a registry keeps the
 * orchestrator dispatch loop readable and lets the Settings UI surface the
 * same numbers operators see in code.
 */

import type { RunMode } from '../../types/dorothy';

export interface RunModePolicy {
  mode: RunMode;
  /** Human-readable purpose shown in Run Detail and Settings. */
  purpose: string;
  /** Bullet list of rules — rendered verbatim in Settings. */
  rules: string[];
  /** Whether the orchestrator may launch FE+BE concurrently. */
  parallelDispatchAllowed: boolean;
  /** Cap on the orchestrator's automatic verify/fix retries. 0 disables auto retry. */
  maxFixAttempts: number;
  /** True when the mode insists on a non-empty validation command list. */
  requireValidationCommands: boolean;
  /** True when QA/Reviewer step weight is elevated (priority + retry budget). */
  qaHeavy: boolean;
  /** Always keep the ApprovalRequest gate even when the planner thinks risk is low. */
  approvalGateAlwaysOn: boolean;
}

export const RUN_MODE_POLICIES: Record<RunMode, RunModePolicy> = {
  manual: {
    mode: 'manual',
    purpose: 'Human-driven, no auto-retry, approval-heavy.',
    rules: [
      'No automatic retry on step failure',
      'No live auto-resume after rate limits',
      'Stronger approval gate (every risky topic surfaces to user)',
      'QA runs once — re-runs require human request',
    ],
    parallelDispatchAllowed: false,
    maxFixAttempts: 0,
    requireValidationCommands: false,
    qaHeavy: false,
    approvalGateAlwaysOn: true,
  },
  team: {
    mode: 'team',
    purpose: 'Default — Planner → Architect → Orchestrator → FE/BE → QA → Reporter.',
    rules: [
      'FE and BE may run in parallel when worktrees differ',
      'Limited QA retry on flaky failures',
      'Handoff required between roles',
      'Default mode when no keyword matches',
    ],
    parallelDispatchAllowed: true,
    maxFixAttempts: 2,
    requireValidationCommands: false,
    qaHeavy: false,
    approvalGateAlwaysOn: false,
  },
  persistent: {
    mode: 'persistent',
    purpose: 'Limited verify/fix loop until QA / CI passes.',
    rules: [
      'maxFixAttempts default 3',
      'CI failed / QA failed → needs_fix → Orchestrator re-dispatch',
      'Risk keywords still require ApprovalRequest',
      'Repeated failures spawn ImprovementSignal',
    ],
    parallelDispatchAllowed: true,
    maxFixAttempts: 3,
    requireValidationCommands: false,
    qaHeavy: false,
    approvalGateAlwaysOn: false,
  },
  ultraqa: {
    mode: 'ultraqa',
    purpose: 'Verification-heavy. QA / Reviewer + tests over code volume.',
    rules: [
      'Plan Validator rejects plans without validation commands',
      'QA + Reviewer prioritized over implementation parallelism',
      'CI failures spawn ImprovementSignal at higher severity',
      'Acceptance Criteria must be testable',
    ],
    parallelDispatchAllowed: false,
    maxFixAttempts: 2,
    requireValidationCommands: true,
    qaHeavy: true,
    approvalGateAlwaysOn: false,
  },
  pipeline: {
    mode: 'pipeline',
    purpose: 'Strict sequential. Plan → Approval → FE → BE → QA → Reporter.',
    rules: [
      'No FE/BE parallel dispatch',
      'Each Handoff must complete before the next step',
      'Suited for risky operations or compliance-sensitive Runs',
      'maxFixAttempts capped at 1 to keep the timeline tight',
    ],
    parallelDispatchAllowed: false,
    maxFixAttempts: 1,
    requireValidationCommands: false,
    qaHeavy: false,
    approvalGateAlwaysOn: false,
  },
};

export function policyFor(mode: RunMode | null | undefined): RunModePolicy {
  if (!mode) return RUN_MODE_POLICIES.team;
  return RUN_MODE_POLICIES[mode] ?? RUN_MODE_POLICIES.team;
}

/**
 * Per-mode helper for the orchestrator. Returns the retry budget *plus* the
 * existing default (currently 2) — modes that want more retries can raise
 * this without touching the orchestrator code.
 */
export function maxFixAttemptsFor(mode: RunMode | null | undefined): number {
  return policyFor(mode).maxFixAttempts;
}

export function parallelAllowedFor(mode: RunMode | null | undefined): boolean {
  return policyFor(mode).parallelDispatchAllowed;
}
