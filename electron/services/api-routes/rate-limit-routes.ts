/**
 * Dorothy MVP Phase 4.5 — Rate limit HTTP endpoint.
 *
 *   POST /api/rate-limit/event
 *     {
 *       "engine": "claude",
 *       "resetAt": "2026-06-03T15:30:00+09:00",
 *       "message": "usage limit reached",
 *       "source": "pm-tick"             // optional; defaults to "manual"
 *     }
 *
 * Behaviour:
 *   - Creates a `rate_limit_events` row.
 *   - Marks every still-running Run as `blocked` with reason `rate_limit:<engine>`.
 *   - Returns the event id + the list of blocked Run ids so the caller (a
 *     shell script) can log them.
 *
 * Auth: endpoint is exempt from the bearer token check in `api-server.ts`
 * because the legacy PM-tick shell scripts call it without a header. The
 * dorothy.db file lives in $HOME/.dorothy/ and is local-only, so this is
 * consistent with the other `/api/hooks/*` endpoints.
 */

import { RouteApp, RouteContext } from './types';
import { recordRateLimitEventAndBlockRuns } from '../dorothy/rate-limit-bridge';
import { resumeRateLimitEvent } from '../dorothy/rate-limit-bridge';
import { getDorothyDb } from '../dorothy/db';
import { parseUsageLimitMessage } from '../dorothy/usage-limit-parser';
import { resumeNow as schedulerResumeNow } from '../dorothy/auto-resume-scheduler';
import type {
  RateLimitEngine,
  RateLimitSourceExtended,
  RateLimitProvider,
} from '../../types/dorothy';

const VALID_ENGINES: RateLimitEngine[] = ['claude', 'codex', 'gemini', 'opencode', 'pi'];
const VALID_PROVIDERS: RateLimitProvider[] = ['claude', 'codex', 'gemini', 'opencode', 'local'];
const VALID_SOURCES_EXTENDED: RateLimitSourceExtended[] = [
  'pm_output', 'usage_scan', 'codex_rate_limits', 'manual',
  'pm_tick', 'hook', 'agent_output',
];

function normalizeSource(raw: unknown): RateLimitSourceExtended {
  if (typeof raw !== 'string') return 'manual';
  const s = raw.toLowerCase().replace(/-/g, '_');
  if ((VALID_SOURCES_EXTENDED as string[]).includes(s)) return s as RateLimitSourceExtended;
  // Friendly aliases — keep the Phase-4.5 ones working.
  if (s === 'pm') return 'pm_tick';
  if (s === 'usage') return 'usage_scan';
  if (s === 'output') return 'agent_output';
  return 'manual';
}

function normalizeProvider(raw: unknown, engine: RateLimitEngine): RateLimitProvider {
  if (typeof raw === 'string') {
    const p = raw.toLowerCase();
    if ((VALID_PROVIDERS as string[]).includes(p)) return p as RateLimitProvider;
  }
  // Fall back to the engine — most callers won't supply a separate provider.
  if (engine === 'pi') return 'local';
  return engine as RateLimitProvider;
}

export function registerRateLimitRoutes(app: RouteApp, _ctx: RouteContext): void {
  // POST /api/rate-limit/event — record a new rate limit event and block runs.
  app.post('/api/rate-limit/event', (req, sendJson) => {
    const body = req.body as {
      engine?: string;
      resetAt?: string | null;
      detectedAt?: string;
      message?: string | null;
      source?: string;
      affectedRunIds?: string[];
      // Phase 5C-B optional fields.
      provider?: string;
      resumeAt?: string | null;
      affectedSessionIds?: string[];
      affectedRunStepIds?: string[];
    };

    if (!body || typeof body !== 'object') {
      sendJson({ error: 'JSON body required' }, 400);
      return;
    }
    const engine = (body.engine ?? '').toLowerCase() as RateLimitEngine;
    if (!engine || !VALID_ENGINES.includes(engine)) {
      sendJson({ error: `engine must be one of: ${VALID_ENGINES.join(', ')}` }, 400);
      return;
    }
    if (!getDorothyDb()) {
      // Graceful degrade — match the IPC handler's behaviour so PM-tick
      // never sees this endpoint as "broken" when the DB is being rebuilt.
      sendJson({ ok: false, dbUnavailable: true, blockedRunIds: [] }, 200);
      return;
    }

    try {
      // Phase 5C-B — parse the message to extract resumeAt + confidence.
      // If the caller already supplied a resumeAt we trust it (high
      // confidence); otherwise we try the heuristic parser.
      const provider = normalizeProvider(body.provider, engine);
      const source = normalizeSource(body.source);
      const parsed = body.resumeAt
        ? { resumeAt: body.resumeAt, confidence: 'high' as const, excerpt: typeof body.message === 'string' ? body.message.slice(0, 240) : '' }
        : (() => {
            const p = parseUsageLimitMessage(typeof body.message === 'string' ? body.message : '');
            return { resumeAt: p.resumeAt, confidence: p.confidence, excerpt: p.originalMessageExcerpt };
          })();

      const result = recordRateLimitEventAndBlockRuns({
        engine,
        source,
        detectedAt: body.detectedAt,
        resetAt: body.resetAt ?? parsed.resumeAt ?? null,
        message: body.message ?? null,
        affectedRunIds: body.affectedRunIds,
        provider,
        resumeAt: parsed.resumeAt ?? null,
        affectedSessionIds: body.affectedSessionIds,
        affectedRunStepIds: body.affectedRunStepIds,
        messageExcerpt: parsed.excerpt,
        parseConfidence: parsed.confidence,
      });
      sendJson({
        ok: true,
        eventId: result.event?.id ?? null,
        blockedRunIds: result.blockedRunIds,
        resumeAt: result.event?.resumeAt ?? null,
        resumeStatus: result.event?.resumeStatus ?? null,
        parseConfidence: result.event?.parseConfidence ?? null,
      });
    } catch (err) {
      console.error('[rate-limit] event recording failed:', err instanceof Error ? err.message : 'unknown');
      sendJson({
        ok: false,
        error: err instanceof Error ? err.message : 'unknown error',
      }, 500);
    }
  });

  // Phase 5C-B — manual user-driven resume (always live, regardless of flag).
  app.post(/^\/api\/rate-limit\/event\/([^/]+)\/resume-now$/, async (req, sendJson) => {
    const id = req.params.id;
    if (!id) { sendJson({ error: 'event id required in path' }, 400); return; }
    if (!getDorothyDb()) { sendJson({ ok: false, dbUnavailable: true }, 200); return; }
    try {
      const out = await schedulerResumeNow(id);
      sendJson({ ok: true, result: out });
    } catch (err) {
      console.error('[rate-limit] resume-now failed:', err instanceof Error ? err.message : 'unknown');
      sendJson({ ok: false, error: err instanceof Error ? err.message : 'unknown' }, 500);
    }
  });

  // POST /api/rate-limit/event/:id/resume — resolve an event and restore Runs.
  // Same auth-exempt rationale.
  app.post(/^\/api\/rate-limit\/event\/([^/]+)\/resume$/, (req, sendJson) => {
    const id = req.params.id;
    if (!id) {
      sendJson({ error: 'event id required in path' }, 400);
      return;
    }
    if (!getDorothyDb()) {
      sendJson({ ok: false, dbUnavailable: true, resumedRunIds: [] }, 200);
      return;
    }
    const body = req.body as { engine?: string };
    try {
      const result = resumeRateLimitEvent(id, body?.engine);
      sendJson({
        ok: true,
        eventId: result.event?.id ?? null,
        resumedRunIds: result.resumedRunIds,
        remainingBlockedRunIds: result.remainingBlockedRunIds,
      });
    } catch (err) {
      console.error('[rate-limit] resume failed:', err);
      sendJson({
        ok: false,
        error: err instanceof Error ? err.message : 'unknown error',
      }, 500);
    }
  });
}
