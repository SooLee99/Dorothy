import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

/**
 * Phase 6-BI — done≠라이브 게이트 상태(read-only).
 * done-live-gate.js(PM-tick)가 쓰는 runtime/done-live-gate.json 을 그대로 노출.
 */
const STATE = path.join(os.homedir(), '.dorothy', 'runtime', 'done-live-gate.json');

export async function GET() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE, 'utf-8'));
    return NextResponse.json({ ok: true, ...j });
  } catch {
    return NextResponse.json({ ok: false, doneNotLive: 0, repoDirty: {}, updatedAt: null });
  }
}
