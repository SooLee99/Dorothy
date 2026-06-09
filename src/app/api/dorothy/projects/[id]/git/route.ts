/**
 * PR-2-S2 — Next 프록시: GET /api/dorothy/projects/{id}/git → electron /api/projects/{id}/git.
 * 단일 프로젝트 git 실측(read-only).
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
  const target = `http://127.0.0.1:${API_PORT}/api/projects/${encodeURIComponent(id)}/git`;
  try {
    const res = await fetch(target, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
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
