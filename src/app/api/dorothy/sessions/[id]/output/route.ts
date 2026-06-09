/**
 * PR-0a — Next 프록시: GET /api/dorothy/sessions/{id}/output → electron /api/sessions/{id}/output.
 * read-only, 마스킹된 tail-only 출력. PTY 메모리 접근은 electron main 만.
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

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = readToken();
  if (!token) {
    return NextResponse.json(
      { meta: { serverNow: new Date().toISOString(), partial: true, error: 'electron API token unavailable' }, data: null },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const target = `http://127.0.0.1:${API_PORT}/api/sessions/${encodeURIComponent(id)}/output?${url.searchParams.toString()}`;
  try {
    const res = await fetch(target, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    const body = await res.json().catch(() => null);
    return NextResponse.json(body ?? { meta: { partial: true, error: `electron API ${res.status}` }, data: null }, { status: res.status });
  } catch {
    return NextResponse.json(
      { meta: { serverNow: new Date().toISOString(), partial: true, error: 'electron API unreachable' }, data: null },
      { status: 503 },
    );
  }
}
