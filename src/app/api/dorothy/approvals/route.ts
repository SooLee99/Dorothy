import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { resolveProjectRoot } from '@/lib/projectPaths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Read-only: returns raw markdown for triplan approval queue/decisions.
// C4-d — 경로는 companies.json 에서(literal 은 폴백만).
const APPROVALS_DIR = path.join(resolveProjectRoot('triplan') ?? '/Users/soo/workspace/source-code/triplan', 'approvals');

function safeRead(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    return NextResponse.json({
      dir: APPROVALS_DIR,
      queue: safeRead(path.join(APPROVALS_DIR, 'approval-queue.md')),
      approved: safeRead(path.join(APPROVALS_DIR, 'approved-decisions.md')),
      rejected: safeRead(path.join(APPROVALS_DIR, 'rejected-decisions.md')),
      policy: safeRead(path.join(APPROVALS_DIR, 'approval-policy.md')),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
