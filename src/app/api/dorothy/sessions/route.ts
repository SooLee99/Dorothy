/**
 * PR-0a — Next 프록시: GET /api/dorothy/sessions → electron API /api/sessions.
 * PTY 메모리(agents Map, 계측)는 electron main 만 접근하므로 :31415 로 프록시한다.
 */
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

function unavailable(reason: string) {
  return NextResponse.json({
    meta: { serverNow: new Date().toISOString(), sources: [], partial: true, error: reason },
    data: { sessions: [], unavailable: true },
  });
}

export async function GET(req: Request) {
  const token = readToken();
  if (!token) return unavailable('electron API token unavailable');

  const url = new URL(req.url);
  const target = `http://127.0.0.1:${API_PORT}/api/sessions?${url.searchParams.toString()}`;
  try {
    const res = await fetch(target, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return unavailable(`electron API ${res.status}`);
    return NextResponse.json(await res.json());
  } catch {
    return unavailable('electron API unreachable');
  }
}
