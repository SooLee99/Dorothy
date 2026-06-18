import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

/**
 * Phase 6-AE — read-only PM-tick / orchestrator recent status for the dashboard.
 * Tails ~/.dorothy/logs/pm-tick.log and parses the most recent STARTED / SKIP /
 * RESET / ERROR markers. No secrets are emitted (lines are filtered + masked).
 */

const MARK_RE = /(STARTED|SKIP|RESET|ERROR|orchestrator)/i;
// Light masking — never echo a token from a log line.
function mask(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|api[_-]?key|apikey|token|secret|password|access_token)["']?\s*[:=]\s*["']?)[^\s"',]+/gi, '$1[REDACTED]')
    .replace(/\b(sk-|ghp_|gho_|xox[baprs]-)[A-Za-z0-9._\-]+/g, '$1[REDACTED]');
}

function classify(line: string): 'STARTED' | 'SKIP' | 'RESET' | 'ERROR' | 'unknown' {
  if (/ERROR|rc=22|무응답/i.test(line)) return 'ERROR';
  if (/STARTED/i.test(line)) return 'STARTED';
  if (/RESET/i.test(line)) return 'RESET';
  if (/SKIP/i.test(line)) return 'SKIP';
  return 'unknown';
}

export async function GET() {
  const file = path.join(os.homedir(), '.dorothy', 'logs', 'pm-tick.log');
  try {
    if (!fs.existsSync(file)) {
      return NextResponse.json({ available: false, recent: [], latest: null });
    }
    const text = fs.readFileSync(file, 'utf-8');
    const all = text.split('\n').filter(Boolean);
    const recent = all
      .filter(l => MARK_RE.test(l))
      .slice(-6)
      .map(l => {
        const masked = mask(l);
        return { kind: classify(masked), line: masked.length > 220 ? masked.slice(0, 220) + '…' : masked };
      });
    const latest = recent.length > 0 ? recent[recent.length - 1] : null;
    return NextResponse.json({ available: true, recent, latest });
  } catch {
    return NextResponse.json({ available: false, recent: [], latest: null });
  }
}
