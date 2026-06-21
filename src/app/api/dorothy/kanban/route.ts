import { NextResponse } from 'next/server';
import { loadTasks } from '@/lib/kanban-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ★단일 소스(근본): hermes `~/.hermes/kanban.db`(SQLite) 에서 읽어 web(비-Electron) 클라이언트에 표시.
//   Mutations(move/create/delete)는 Electron/MCP 경로 — 여기는 read-only. 매핑은 @/lib/kanban-store.
export async function GET() {
  try {
    return NextResponse.json(loadTasks());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
