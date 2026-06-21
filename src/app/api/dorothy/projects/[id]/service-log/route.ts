/**
 * Next 프록시: GET /api/dorothy/projects/{id}/service-log?role=fe|be&lines=N
 *   → electron GET /api/projects/{id}/service-log. 서비스 기동 로그 tail(read-only, 팝업용).
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
  if (!token) return NextResponse.json({ exists: false, lines: [], error: 'electron API token unavailable' }, { status: 503 });
  const qs = new URL(req.url).searchParams.toString();
  const target = `http://127.0.0.1:${API_PORT}/api/projects/${encodeURIComponent(id)}/service-log?${qs}`;
  try {
    const res = await fetch(target, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    });
    const body = await res.json().catch(() => null);
    return NextResponse.json(body ?? { exists: false, lines: [], error: `electron API ${res.status}` }, { status: res.status });
  } catch {
    return NextResponse.json({ exists: false, lines: [], error: 'electron API unreachable' }, { status: 503 });
  }
}
