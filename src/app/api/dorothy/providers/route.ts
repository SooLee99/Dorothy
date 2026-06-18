/**
 * PR-0b — Next 프록시: GET /api/dorothy/providers → electron /api/providers.
 * predicted(provider-limit-state) vs probe(real-call) 분리 노출. read-only.
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
    data: { providers: [], unavailable: true },
  });
}

export async function GET(req: Request) {
  const token = readToken();
  if (!token) return unavailable('electron API token unavailable');

  const url = new URL(req.url);
  const target = `http://127.0.0.1:${API_PORT}/api/providers?${url.searchParams.toString()}`;
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
