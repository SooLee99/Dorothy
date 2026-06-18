import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

// Read ~/.dorothy/kanban-tasks.json so web (non-Electron) clients can display kanban.
// Mutations (move/create/delete) still require Electron — this is read-only.
export async function GET() {
  const file = path.join(os.homedir(), '.dorothy', 'kanban-tasks.json');
  try {
    if (!fs.existsSync(file)) return NextResponse.json([]);
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return NextResponse.json(Array.isArray(data) ? data : []);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
