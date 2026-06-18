/**
 * Dorothy MVP Phase 5C-B — Claude usage-limit message parser.
 *
 * Best-effort extraction of the reset/resume time from free-form text that
 * Anthropic's CLI / API emits when a tier limit is hit. We deliberately
 * refuse to guess when the message is ambiguous — the caller must treat
 * `confidence: 'low'` as "store the event but do not auto-resume".
 *
 * Hard rules:
 *   - We never store the original message verbatim; the caller persists
 *     `originalMessageExcerpt` only (truncated to 240 chars).
 *   - Common secret-looking substrings are masked before excerpting.
 *   - Timezone defaults to Asia/Seoul (UTC+9) because that's where the
 *     Dorothy operator runs the dashboard.
 *
 * The parser is pure / side-effect-free so it's unit-test friendly.
 */

const TZ_OFFSET_MINUTES = 9 * 60; // Asia/Seoul, fixed (no DST).

export type UsageLimitConfidence = 'high' | 'medium' | 'low';

export interface ParsedUsageLimit {
  detected: boolean;
  provider: 'claude';
  resumeAt?: string;
  originalMessageExcerpt: string;
  confidence: UsageLimitConfidence;
}

/* ============================================================================
 * Detection heuristics
 *
 * These cover the actual Claude CLI output shapes we've seen:
 *   - "Claude usage limit reached. Your limit will reset at 3:30 PM"
 *   - "usage limit reached, resets at 15:30"
 *   - "Claude usage limit reached. Resets 3:20pm"
 *   - "You can use Claude again after 2026-06-03T15:30:00+09:00"
 *   - "reset time: 2026-06-03 15:30"
 *   - "5-hour limit reached. Resets at 2:40am"
 * ========================================================================== */

const DETECT_PATTERNS = [
  /usage\s+limit\s+(?:reached|hit)/i,
  /5[- ]hour\s+limit/i,
  /you\s+can\s+use\s+claude\s+again/i,
  /reset\s+time/i,
  /limit\s+(?:will\s+)?reset/i,
  // Short forms like "Resets at 3:30pm" or "resets 15:30" — anchored on the
  // word "reset(s)" followed by a clock or "at <time>" so a stray
  // "reset password link" doesn't trigger.
  /reset[s]?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*([ap]m)?/i,
];

function looksLikeUsageLimit(message: string): boolean {
  return DETECT_PATTERNS.some(re => re.test(message));
}

/* ============================================================================
 * Time extraction
 *
 * Order:
 *   1. Full ISO 8601 with offset (highest confidence)
 *   2. "YYYY-MM-DD HH:MM" date+time
 *   3. "resets [at] H[:MM] [am|pm]" with implicit day
 * ========================================================================== */

const ISO_RE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2}))/;
const DATE_TIME_RE = /(\d{4}-\d{2}-\d{2})[\sT](\d{1,2}):(\d{2})/;
const CLOCK_RE = /reset[s]?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i;
const AFTER_RE = /(?:again\s+after|use\s+claude\s+again)\s*[: ]?\s*(.+)/i;

/** Build an ISO timestamp for the next occurrence of HH:MM in Asia/Seoul. */
function nextSeoulOccurrence(hour: number, minute: number, now: Date): { iso: string; isPast: boolean } {
  // Compute "now" in Seoul wall-clock.
  const nowMs = now.getTime();
  const seoulNow = new Date(nowMs + TZ_OFFSET_MINUTES * 60_000);
  const target = new Date(Date.UTC(
    seoulNow.getUTCFullYear(),
    seoulNow.getUTCMonth(),
    seoulNow.getUTCDate(),
    hour,
    minute,
    0,
    0,
  ));
  let isPast = false;
  if (target.getTime() <= seoulNow.getTime()) {
    // Roll forward 24h.
    target.setUTCDate(target.getUTCDate() + 1);
    isPast = true;
  }
  // Convert back to a real UTC instant by subtracting the offset.
  const utcMs = target.getTime() - TZ_OFFSET_MINUTES * 60_000;
  const utc = new Date(utcMs);
  // Render as Asia/Seoul ISO with explicit +09:00 offset for readability.
  const seoul = new Date(utc.getTime() + TZ_OFFSET_MINUTES * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = `${seoul.getUTCFullYear()}-${pad(seoul.getUTCMonth() + 1)}-${pad(seoul.getUTCDate())}T${pad(seoul.getUTCHours())}:${pad(seoul.getUTCMinutes())}:00+09:00`;
  return { iso, isPast };
}

function extractResumeAt(message: string, now: Date): { resumeAt?: string; confidence: UsageLimitConfidence } {
  // 1. Full ISO timestamp.
  const isoMatch = ISO_RE.exec(message);
  if (isoMatch) {
    const candidate = new Date(isoMatch[1]);
    if (!Number.isNaN(candidate.getTime())) {
      // ISO with an offset is unambiguous — high confidence even if the
      // value is in the past (the caller can decide what to do).
      return { resumeAt: candidate.toISOString(), confidence: 'high' };
    }
  }

  // 2. Full date + time without offset → assume Seoul.
  const dtMatch = DATE_TIME_RE.exec(message);
  if (dtMatch) {
    const dateStr = dtMatch[1];
    const h = parseInt(dtMatch[2], 10);
    const m = parseInt(dtMatch[3], 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      const iso = `${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`;
      const candidate = new Date(iso);
      if (!Number.isNaN(candidate.getTime())) {
        // High confidence — explicit date + 24h clock.
        return { resumeAt: candidate.toISOString(), confidence: 'high' };
      }
    }
  }

  // 3. Clock-only "resets at 3:30pm". Medium confidence because we have to
  //    guess the day; we pick the next future occurrence.
  const clockMatch = CLOCK_RE.exec(message);
  if (clockMatch) {
    const hh0 = parseInt(clockMatch[1], 10);
    const mm = parseInt(clockMatch[2] || '0', 10);
    const ampm = (clockMatch[3] || '').toLowerCase();
    let hh = hh0;
    if (ampm === 'pm' && hh !== 12) hh += 12;
    if (ampm === 'am' && hh === 12) hh = 0;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      return { confidence: 'low' };
    }
    const { iso, isPast } = nextSeoulOccurrence(hh, mm, now);
    // No am/pm hint AND hour < 12 → ambiguous (could be a 24h field). Drop to
    // 'medium' or 'low' depending on the hour.
    const confidence: UsageLimitConfidence = ampm
      ? 'medium'
      : isPast
      ? 'low'    // ambiguous + we had to roll forward → manual review
      : 'medium';
    return { resumeAt: iso, confidence };
  }

  // 4. Last-ditch "after X" — punt to low confidence.
  if (AFTER_RE.test(message)) {
    return { confidence: 'low' };
  }
  return { confidence: 'low' };
}

/* ============================================================================
 * Excerpt + masking
 * ========================================================================== */

const MASK_RE = /\b(secret|token|password|api[_-]?key)\b\s*[:=]\s*[^\s"',]+/gi;

function maskSensitive(s: string): string {
  return s.replace(MASK_RE, (_full, kw: string) => `${kw}: ***`);
}

export function excerptMessage(message: string, maxLen = 240): string {
  if (!message) return '';
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return maskSensitive(oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + '…' : oneLine);
}

/* ============================================================================
 * Public entry
 * ========================================================================== */

export interface ParseUsageLimitOptions {
  /** Defaults to `new Date()`. Exposed for tests. */
  now?: Date;
}

export function parseUsageLimitMessage(
  message: string | null | undefined,
  options: ParseUsageLimitOptions = {},
): ParsedUsageLimit {
  const text = message ?? '';
  const detected = looksLikeUsageLimit(text);
  if (!detected) {
    return {
      detected: false,
      provider: 'claude',
      originalMessageExcerpt: excerptMessage(text),
      confidence: 'low',
    };
  }
  const { resumeAt, confidence } = extractResumeAt(text, options.now ?? new Date());
  return {
    detected: true,
    provider: 'claude',
    resumeAt,
    originalMessageExcerpt: excerptMessage(text),
    confidence,
  };
}
