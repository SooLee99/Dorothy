import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { isAllowedCapturePath } from '@/lib/testResultsProjects';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * E2E 캡처/리포트 HTTP 서빙 (/api/dorothy/test-results/capture?path=<abs>).
 *
 * ★사진이 안 나오던 원인 해소: 기존엔 <img src="local-file://...">로
 *   Electron 커스텀 프로토콜에만 의존 → 웹 브라우저에선 미표시.
 *   이 라우트는 표준 HTTP로 서빙해 ★브라우저·Electron 양쪽에서 표시된다.
 *
 * SECURITY: isAllowedCapturePath allowlist(등록 프로젝트의 screenshots/·playwright-report/
 *   하위)만 서빙. 임의 절대경로·경로 traversal 차단. 읽기 전용.
 */

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
};

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('path');
  if (!raw) {
    return NextResponse.json({ error: 'path 누락' }, { status: 400 });
  }

  const filePath = path.resolve(raw);

  // allowlist 밖 경로는 거부(traversal·임의 파일 노출 차단)
  if (!isAllowedCapturePath(filePath)) {
    return NextResponse.json({ error: 'forbidden path' }, { status: 403 });
  }

  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const buf = fs.readFileSync(filePath);
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'read failed' },
      { status: 500 },
    );
  }
}
