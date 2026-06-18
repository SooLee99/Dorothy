import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { E2EProject, getE2EProject, listE2EProjects } from '@/lib/testResultsProjects';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * E2E Test Results (/api/dorothy/test-results?project=<id>) — ⑤ 대시보드 (가) 범위.
 *
 * ②③의 E2E 산출물을 ★읽기 표시만 한다(데이터 생성 X):
 *   1. GitHub Actions API — E2E 워크플로 run 목록(통과/실패·브랜치·시각·run URL·artifact).
 *   2. 로컬 캡처 — playwright-report/index.html + screenshots/*.png 절대경로.
 *      (캡처 표시는 /api/dorothy/test-results/capture가 HTTP로 서빙 — 브라우저·Electron 양쪽.)
 *
 * ★프로젝트별: project 쿼리(bueongi|triplan, 기본 첫 프로젝트)로 구분.
 *   레지스트리=src/lib/testResultsProjects.ts. 응답에 projects[] 포함(UI 탭용).
 *
 * SECURITY: appFactoryGithub 토큰은 ★서버측에서만 읽어 GitHub 호출 인증에 쓰고,
 *   응답으로 ★절대 반환하지 않는다(integrations/route.ts의 "평문 시크릿 금지" 계약과 동일).
 */

const INTEGRATION_CFG = path.join(os.homedir(), '.dorothy', 'integration-settings.json');

interface RunSummary {
  id: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  branch: string;
  createdAt: string;
  htmlUrl: string;
  runNumber: number;
}

function readToken(): string | null {
  try {
    if (!fs.existsSync(INTEGRATION_CFG)) return null;
    const cfg = JSON.parse(fs.readFileSync(INTEGRATION_CFG, 'utf-8'));
    const t = cfg?.appFactoryGithub?.token;
    return typeof t === 'string' && t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

async function gh(urlPath: string, token: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://api.github.com${urlPath}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dorothy-dashboard',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function scanLocalCaptures(
  project: E2EProject,
): { captures: { name: string; path: string }[]; reportPath: string | null } {
  const shotsDir = path.join(project.frontendPath, 'screenshots');
  const reportFile = path.join(project.frontendPath, 'playwright-report', 'index.html');
  let captures: { name: string; path: string }[] = [];
  try {
    if (fs.existsSync(shotsDir) && fs.statSync(shotsDir).isDirectory()) {
      captures = fs
        .readdirSync(shotsDir)
        .filter(f => /\.(png|jpe?g|webp)$/i.test(f))
        .sort()
        .map(f => ({ name: f, path: path.join(shotsDir, f) }));
    }
  } catch {
    /* ignore */
  }
  const reportPath = fs.existsSync(reportFile) ? reportFile : null;
  return { captures, reportPath };
}

export async function GET(req: NextRequest) {
  const generatedAt = new Date().toISOString();
  const projectId = req.nextUrl.searchParams.get('project');
  const project = getE2EProject(projectId);
  const repo = project.repoOwner && project.repoName ? `${project.repoOwner}/${project.repoName}` : project.id;

  const { captures, reportPath } = scanLocalCaptures(project);

  const token = readToken();
  let runs: RunSummary[] = [];
  let latestArtifacts: { name: string; sizeKb: number; expired: boolean }[] = [];
  // repo 미설정 프로젝트는 GitHub 조회 생략(로컬 캡처만).
  let githubSource: string = !project.repoOwner || !project.repoName
    ? 'n/a'
    : token
      ? 'ok'
      : 'no-token';

  if (token && project.repoOwner && project.repoName) {
    try {
      const data = (await gh(
        `/repos/${project.repoOwner}/${project.repoName}/actions/runs?per_page=15`,
        token,
      )) as { workflow_runs?: Array<Record<string, unknown>> };
      const all = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
      runs = all
        .filter(r => {
          const name = String(r.name ?? '').toLowerCase();
          const wf = String(r.path ?? '').toLowerCase();
          return name.includes(project.workflowHint) || wf.includes(project.workflowHint);
        })
        .slice(0, 10)
        .map(r => ({
          id: Number(r.id),
          name: String(r.name ?? 'workflow'),
          event: String(r.event ?? ''),
          status: String(r.status ?? ''),
          conclusion: (r.conclusion as string | null) ?? null,
          branch: String(r.head_branch ?? ''),
          createdAt: String(r.created_at ?? ''),
          htmlUrl: String(r.html_url ?? ''),
          runNumber: Number(r.run_number ?? 0),
        }));

      if (runs.length > 0) {
        try {
          const art = (await gh(
            `/repos/${project.repoOwner}/${project.repoName}/actions/runs/${runs[0].id}/artifacts`,
            token,
          )) as { artifacts?: Array<Record<string, unknown>> };
          latestArtifacts = (art.artifacts ?? []).map(a => ({
            name: String(a.name ?? ''),
            sizeKb: Math.floor(Number(a.size_in_bytes ?? 0) / 1024),
            expired: a.expired === true,
          }));
        } catch {
          /* artifact 조회 실패는 비치명 */
        }
      }
    } catch (err) {
      githubSource = `error:${err instanceof Error ? err.message : 'unknown'}`;
    }
  }

  return NextResponse.json({
    ok: true,
    repo,
    project: project.id,
    projects: listE2EProjects(),
    generatedAt,
    source: {
      github: githubSource,
      local: captures.length > 0 || reportPath ? 'ok' : 'none',
    },
    runs,
    latestArtifacts,
    localCaptures: captures,
    localReportPath: reportPath,
  });
}
