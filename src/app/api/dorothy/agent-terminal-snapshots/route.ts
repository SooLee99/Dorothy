import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

/**
 * Phase 6-AE — read-only proxy so a browser (non-Electron) dev tab can read live,
 * masked agent terminal snapshots. The live PTY output buffers live ONLY in the
 * electron main process (in-memory), so unlike the disk-backed /agents route this
 * must proxy the electron API on 127.0.0.1:31415. The bearer token is read from
 * ~/.dorothy/api-token server-side and NEVER logged or returned to the client.
 *
 * Always read-only: no input, no start/stop/kill. On any failure it returns an
 * empty snapshot set with `unavailable: true` so the UI degrades gracefully.
 */

const API_PORT = 31415;

function readToken(): string | null {
  try {
    const file = path.join(os.homedir(), '.dorothy', 'api-token');
    if (!fs.existsSync(file)) return null;
    const t = fs.readFileSync(file, 'utf-8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const token = readToken();
  if (!token) {
    return NextResponse.json({ snapshots: [], unavailable: true, reason: 'electron API token unavailable' });
  }
  const url = new URL(req.url);
  const agentId = url.searchParams.get('agentId');
  const lines = url.searchParams.get('lines') || '200';
  const target = agentId
    ? `http://127.0.0.1:${API_PORT}/api/agents/${encodeURIComponent(agentId)}/terminal-snapshot?lines=${encodeURIComponent(lines)}`
    : `http://127.0.0.1:${API_PORT}/api/agents/terminal-snapshots?lines=${encodeURIComponent(lines)}`;
  try {
    const res = await fetch(target, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ snapshots: [], unavailable: true, reason: `electron API ${res.status}` });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    // Do NOT surface the token or raw error detail.
    return NextResponse.json({ snapshots: [], unavailable: true, reason: 'electron API unreachable' });
  }
}
