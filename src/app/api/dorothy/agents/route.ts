import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Read ~/.dorothy/agents.json so web (non-Electron) clients can display agent list.
// Mutations (create/start/stop) still require Electron — this is read-only.
//
// Phase 6-BK — 라이브 반영: 디스크 agents.json 의 status 는 저장 시 running→idle 로 리셋되어 stale.
// electron(:31415) 의 실시간 스냅샷(status/currentTask/lastActivity)으로 덮어써 화면이 라이브를 반영하게 한다.
export async function GET() {
  const home = os.homedir();
  const file = path.join(home, '.dorothy', 'agents.json');
  let list: Record<string, unknown>[] = [];
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      list = Array.isArray(data) ? data : (data.agents ?? []);
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  // 라이브 스냅샷 오버레이(electron 미응답 시 디스크값 폴백)
  const live = new Map<string, { status?: string; currentTask?: string; lastActivity?: string; outputPreview?: string }>();
  try {
    const token = fs.readFileSync(path.join(home, '.dorothy', 'api-token'), 'utf-8').trim();
    if (token) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch('http://127.0.0.1:31415/api/agents/terminal-snapshots', {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: ctrl.signal,
      }).finally(() => clearTimeout(to));
      if (res.ok) {
        const j = await res.json();
        const snaps = (Array.isArray(j) ? j : (j.snapshots ?? j.agents ?? [])) as { agentId?: string; status?: string; currentTask?: string; lastActivity?: string; outputPreview?: string }[];
        for (const s of snaps) { if (s.agentId) live.set(s.agentId, s); }
      }
    }
  } catch { /* fallback to disk */ }

  const merged = list.map(a => {
    const s = live.get(String(a.id));
    return s ? { ...a, status: s.status ?? a.status, currentTask: s.currentTask ?? a.currentTask, lastActivity: s.lastActivity ?? a.lastActivity } : a;
  });
  return NextResponse.json(merged);
}
