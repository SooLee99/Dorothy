/**
 * Dorothy MVP — service barrel.
 *
 * Re-exports the Phase-1 services so callers (IPC handlers, future tests, the
 * upcoming Phase-2 UI) can import from a single path.
 */

export {
  initDorothyDb,
  closeDorothyDb,
  getDorothyDb,
  requireDorothyDb,
  type DorothyDbInitResult,
} from './db';

export * from './run-service';
export * from './agent-session-service';
export * from './plan-service';
export * from './artifact-service';
export * from './approval-request-service';
export * from './rate-limit-service';
export * from './intake-request-service';
export * from './kanban-task-adapter';

// Phase 3 — routing + orchestrator
export * from './agent-routing';
export * from './orchestrator-service';

// Phase 4 — validator + rate-limit bridge
export * from './plan-validator-service';
export * from './rate-limit-bridge';

// Phase 5A — PR / CI tracking
export * from './pr-service';
export * from './ci-run-service';

// Phase 5C-B — usage-limit parser + auto-resume scheduler + improvement signals
export * from './usage-limit-parser';
export * from './auto-resume-scheduler';
export * from './improvement-signal-service';

// Phase 5D — Run Mode router + policy registry
export * from './run-mode-router';
export * from './run-mode-policy';

// Phase 5F — Hook Event Bus (unified runtime timeline).
export * from './hook-event-service';

// Phase 6-A — Diagnostic model + detector.
export * from './diagnostic-service';
export * from './diagnostic-detector';

// Phase 6-B — AgentWorkflowProgress service + templates.
export * from './agent-workflow-templates';
export * from './agent-workflow-progress-service';

// Phase 6-D — SkillCandidate service.
export * from './skill-candidate-service';

// Phase 6-E — Agent Definition Registry + Idle Reason + Communication Timeline.
export * from './agent-definition-registry';
export * from './agent-idle-reason-service';
export * from './agent-communication-service';

// Phase 6-G — Agent Definition manual registration.
export * from './agent-registration-service';

// Phase 6-J — Agent dispatch readiness (dry-run diagnosis).
export * from './agent-dispatch-readiness-service';

// Phase 6-M — Codex runtime hardening (stale session detect + readiness).
export * from './codex-runtime-service';

// Phase 6-Q — batch warm-up + Codex model normalization.
export * from './agent-warmup-service';

// Phase 6-W — App Factory (multi-company / multi-project orchestration).
export * from './app-factory-service';
