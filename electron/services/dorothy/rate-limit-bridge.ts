/**
 * Dorothy MVP Phase 4 — Rate limit ↔ Run bridge.
 *
 * Phase 1 added the `rate_limit_events` table and the legacy
 * `claude-limit.json` / usage-scan.py flows kept doing what they already did.
 * Phase 4 connects them: when an event is recorded we mark affected Runs as
 * `blocked` and stamp `blockedReason='rate_limit:<engine>'`; when the event
 * is resolved we restore them to their previous state.
 *
 * Crucial: this module never *parses* claude-limit.json. The legacy file
 * remains the human-facing mirror; we only intake rate limit signals via the
 * dorothy.db rows. A future Phase will wire usage-scan.py to call our HTTP
 * endpoint; until then a caller (PM-tick prompt, manual /api call) populates
 * the row and asks us to fan out.
 */

import {
  createRateLimitEvent,
  resolveRateLimitEvent,
} from './rate-limit-service';
import type { CreateRateLimitEventInputExtended } from './rate-limit-service';
import {
  listRuns,
  updateRunState,
  getRun,
} from './run-service';
import type {
  CreateRateLimitEventInput,
  RateLimitEvent,
  RateLimitProvider,
  Run,
  RunState,
} from '../../types/dorothy';

const RUNNING_STATES: RunState[] = ['running', 'verifying', 'reporting', 'needs_fix'];

/**
 * Per-event memo of which Runs we blocked and what their pre-block state was.
 * Stored in-process; survives a single Electron run only (which is fine —
 * a relaunch starts from a clean DB snapshot anyway).
 *
 * Each entry's key is the rate_limit_events.id so the resume side can recover
 * the exact set without scanning Runs blindly.
 */
const previousStateByEvent = new Map<string, Map<string, RunState>>();

export interface RecordRateLimitInput extends CreateRateLimitEventInput {
  /** When omitted we block every advanceable Run regardless of engine. When
   *  provided the affected list is recorded so resume targets only those. */
  affectedRunIds?: string[];
  // Phase 5C-B extensions — all optional, all forwarded to the service.
  provider?: RateLimitProvider | null;
  resumeAt?: string | null;
  affectedSessionIds?: string[];
  affectedRunStepIds?: string[];
  messageExcerpt?: string | null;
  parseConfidence?: 'high' | 'medium' | 'low' | null;
}

export interface RecordRateLimitResult {
  event: RateLimitEvent | null;
  blockedRunIds: string[];
}

/**
 * Persist a rate limit event AND mark every running Run as `blocked`.
 * Optionally restrict the fan-out to a caller-provided Run subset.
 */
export function recordRateLimitEventAndBlockRuns(input: RecordRateLimitInput): RecordRateLimitResult {
  const eventInput: CreateRateLimitEventInputExtended = {
    engine: input.engine,
    source: input.source,
    detectedAt: input.detectedAt,
    resetAt: input.resetAt,
    message: input.message,
    rawRef: input.rawRef,
    affectedRunIds: input.affectedRunIds,
    provider: input.provider ?? null,
    resumeAt: input.resumeAt ?? null,
    affectedSessionIds: input.affectedSessionIds,
    affectedRunStepIds: input.affectedRunStepIds,
    messageExcerpt: input.messageExcerpt ?? null,
    parseConfidence: input.parseConfidence ?? null,
  };
  const event = createRateLimitEvent(eventInput);
  if (!event) return { event: null, blockedRunIds: [] };

  // Decide which Runs to block.
  let candidates: Run[];
  if (input.affectedRunIds && input.affectedRunIds.length > 0) {
    candidates = [];
    for (const id of input.affectedRunIds) {
      const r = getRun(id);
      if (r) candidates.push(r);
    }
  } else {
    candidates = listRuns({ state: RUNNING_STATES, limit: 500 });
  }

  const memo = new Map<string, RunState>();
  const blockedIds: string[] = [];
  for (const r of candidates) {
    if (r.state === 'blocked') continue; // already blocked
    if (!RUNNING_STATES.includes(r.state) && r.state !== 'approved') continue;
    memo.set(r.id, r.state);
    updateRunState(r.id, 'blocked', { blockedReason: `rate_limit:${input.engine}` });
    blockedIds.push(r.id);
  }
  previousStateByEvent.set(event.id, memo);

  return { event, blockedRunIds: blockedIds };
}

export interface ResumeRateLimitResult {
  event: RateLimitEvent | null;
  resumedRunIds: string[];
  remainingBlockedRunIds: string[];
}

/**
 * Mark the event as resolved and restore each previously-blocked Run to its
 * pre-block state. If we have no memo (e.g. Electron restarted between block
 * and resume) we fall back to flipping `blocked` Runs whose `blockedReason`
 * matches `rate_limit:<engine>` to `running`.
 */
export function resumeRateLimitEvent(eventId: string, engine?: string): ResumeRateLimitResult {
  const resolved = resolveRateLimitEvent(eventId);
  const resumedRunIds: string[] = [];
  const remainingBlockedRunIds: string[] = [];

  const memo = previousStateByEvent.get(eventId);
  previousStateByEvent.delete(eventId);

  if (memo && memo.size > 0) {
    for (const [runId, prevState] of memo) {
      const current = getRun(runId);
      if (!current) continue;
      if (current.state !== 'blocked') {
        // Someone moved it elsewhere — leave it alone.
        continue;
      }
      updateRunState(runId, prevState);
      resumedRunIds.push(runId);
    }
    return { event: resolved, resumedRunIds, remainingBlockedRunIds };
  }

  // Fallback: scan for blocked Runs whose blockedReason matches the engine.
  const blocked = listRuns({ state: 'blocked' as RunState, limit: 500 });
  const enginePrefix = `rate_limit:${engine ?? resolved?.engine ?? ''}`;
  for (const r of blocked) {
    if (!enginePrefix || (r.blockedReason ?? '').startsWith(enginePrefix)) {
      updateRunState(r.id, 'running');
      resumedRunIds.push(r.id);
    } else {
      remainingBlockedRunIds.push(r.id);
    }
  }
  return { event: resolved, resumedRunIds, remainingBlockedRunIds };
}

/**
 * Helper for the PM-tick scanner: given the latest pre-known reset time,
 * has it passed? Returns true when it's safe to call resumeRateLimitEvent.
 */
export function isCooldownElapsed(event: RateLimitEvent, now = new Date()): boolean {
  if (!event.resetAt) return false;
  const reset = new Date(event.resetAt);
  if (Number.isNaN(reset.getTime())) return false;
  return reset.getTime() <= now.getTime();
}

/**
 * Test/debug helper exposed so unit tests can assert the memo contents
 * without instrumenting the whole module.
 */
export function _peekMemo(eventId: string): Map<string, RunState> | undefined {
  return previousStateByEvent.get(eventId);
}
