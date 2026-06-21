import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolveProjectRoot } from '@/lib/projectPaths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 화이트리스트 prefix 안의 텍스트 파일만 읽기 허용.
// C4-d — 경로는 companies.json 에서(literal 은 폴백만).
const TRIPLAN_ROOT = resolveProjectRoot('triplan') ?? '/Users/soo/workspace/source-code/triplan';
const home = os.homedir();
const DOC_READ_PREFIXES = [TRIPLAN_ROOT, path.join(home, '.dorothy'), path.join(home, '.claude/memories')];

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { path?: string };
    const p = body?.path;
    if (!p || typeof p !== 'string') return NextResponse.json({ error: 'path required' }, { status: 400 });
    const normalized = path.resolve(p);
    const ok = DOC_READ_PREFIXES.some((pre) => normalized.startsWith(path.resolve(pre) + path.sep) || normalized === path.resolve(pre));
    if (!ok) return NextResponse.json({ error: '허용되지 않은 경로' }, { status: 403 });
    const st = fs.statSync(normalized);
    if (!st.isFile()) return NextResponse.json({ error: '파일이 아님' }, { status: 400 });
    if (st.size > 256 * 1024) {
      const content = fs.readFileSync(normalized, 'utf-8').slice(0, 256 * 1024) + '\n\n... (256KB 초과, 잘림)';
      return NextResponse.json({ content, bytes: st.size });
    }
    return NextResponse.json({ content: fs.readFileSync(normalized, 'utf-8'), bytes: st.size });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
