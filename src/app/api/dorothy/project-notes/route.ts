import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

/**
 * Phase 6-AH — 프로젝트별 설명/메모 저장. 비밀값이 아닌 사용자 메모만 보관한다.
 * 저장 위치: ~/.dorothy/project-notes.json  ({ [projectId]: { note, updatedAt } })
 * projectId 는 프로젝트 식별자(예: 'triplan', 'dorothy', 또는 프로젝트 경로).
 */

const FILE = path.join(os.homedir(), '.dorothy', 'project-notes.json');
const MAX_LEN = 4000;

function readNotes(): Record<string, { note: string; updatedAt: string }> {
  try {
    if (!fs.existsSync(FILE)) return {};
    const v = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export async function GET() {
  return NextResponse.json({ notes: readNotes() });
}

export async function POST(req: Request) {
  let body: { projectId?: string; note?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (!projectId) return NextResponse.json({ ok: false, error: 'projectId required' }, { status: 400 });
  const note = typeof body.note === 'string' ? body.note.slice(0, MAX_LEN) : '';

  const notes = readNotes();
  if (note.trim().length === 0) {
    delete notes[projectId];
  } else {
    notes[projectId] = { note, updatedAt: new Date().toISOString() };
  }
  try {
    fs.writeFileSync(FILE, JSON.stringify(notes, null, 2));
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
  return NextResponse.json({ ok: true, notes });
}
