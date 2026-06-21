/**
 * Next 프록시: POST /api/dorothy/projects/{id}/service → electron POST /api/projects/{id}/service.
 * 프로젝트 서비스 start/stop(★제어). body: { role: 'fe'|'be', action: 'start'|'stop' }.
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

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = readToken();
  if (!token) {
    return NextResponse.json({ ok: false, message: 'electron API token unavailable' }, { status: 503 });
  }
  const payload = await req.json().catch(() => ({}));
  const target = `http://127.0.0.1:${API_PORT}/api/projects/${encodeURIComponent(id)}/service`;
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000), // 정지 시 TERM→KILL 대기(~2.5s) 여유
    });
    const body = await res.json().catch(() => null);
    return NextResponse.json(body ?? { ok: false, message: `electron API ${res.status}` }, { status: res.status });
  } catch {
    return NextResponse.json({ ok: false, message: 'electron API unreachable' }, { status: 503 });
  }
}
