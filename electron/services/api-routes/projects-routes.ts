/**
 * PR-2-S2 — Projects 신호(read-only). project-capsules.json + FE/BE 실프로브 + git 실측.
 *   GET /api/projects             — 프로젝트별 capsule + fe/be 프로브 + git
 *   GET /api/projects/{id}/git     — 단일 프로젝트 git 상세
 *
 * ★G2: fe/be 'up:true' 는 실제 프로브 성공(HTTP 응답 수신)일 때만. timeout/refused → up:false.
 * ★보안: 프로브는 ★127.0.0.1 고정(localhost dev 만, production 0) · read-only GET · 짧은 타임아웃. secret 0(네임스페이스 이름만).
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { envelope, observed, unknown, type Observed } from '../../core/observability';
import { readProjectCapsules as readCapsules, probeService, type Capsule } from '../dorothy/service-status';
import { startService, stopService, getServiceLog, type ServiceRole } from '../dorothy/service-control';
import { RouteApp, RouteContext } from './types';

function sh(args: string[], cwd?: string): string {
  try { return cp.execFileSync('git', args, { encoding: 'utf8', timeout: 5000, cwd }).trim(); }
  catch { return ''; }
}

/**
 * ★127.0.0.1 고정 read-only 프로브(공유 service-status 모듈 사용 → 슬랙과 같은 진실).
 * 응답 수신(상태 무관)=up:true, 연결 실패/timeout=up:false, 포트 미설정=확인 불가.
 */
async function probe(port: number | undefined, pathStr: string) {
  const r = await probeService(port, pathStr);
  if (!r) return unknown('source-missing');
  const checkedAt = new Date().toISOString();
  return r.up
    ? observed({ up: true, port: r.port, status: r.status, latencyMs: r.latencyMs, checkedAt })
    : observed({ up: false, port: r.port, reason: r.reason, checkedAt });
}

/** capsule repo 경로에서 git 실측(read-only). */
function gitInfo(repoPath: string | undefined) {
  if (!repoPath || !fs.existsSync(repoPath)) return unknown('source-missing');
  if (!sh(['-C', repoPath, 'rev-parse', '--git-dir'])) return unknown('source-missing');
  const checkedAt = new Date().toISOString();
  const branch = sh(['-C', repoPath, 'branch', '--show-current']);
  const porcelain = sh(['-C', repoPath, 'status', '--porcelain']);
  const dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
  const log = sh(['-C', repoPath, 'log', '-1', '--format=%h%x1f%cI%x1f%s']);
  const [hash, at, msg] = log ? log.split('\x1f') : [];
  let ahead: number | null = null, behind: number | null = null;
  const lr = sh(['-C', repoPath, 'rev-list', '--count', '--left-right', '@{u}...HEAD']);
  if (/^\d+\s+\d+$/.test(lr)) { const [b, a] = lr.split(/\s+/); behind = +b; ahead = +a; }
  return observed({
    branch: branch || null,
    ahead, behind, dirty,
    lastCommit: hash ? { hash, at, msg } : null,
    repoPath,
    pr: unknown('source-missing'), // GitHub 미연동
    checkedAt,
  });
}

function gitRepoOf(c: Capsule): string | undefined {
  return c.backendPath || c.frontendPath || c.rootPath;
}

/** 정합성 C4-c — companies.json 의 projects[id].subProjects basename 목록(권위 서브프로젝트). */
function companiesSubRepos(projectId?: string): string[] {
  if (!projectId) return [];
  try {
    const file = path.join(os.homedir(), '.dorothy', 'companies.json');
    const d = JSON.parse(fs.readFileSync(file, 'utf8')) as { projects?: Array<{ id?: string; subProjects?: Array<{ path?: string }> }> };
    const proj = (d.projects ?? []).find((p) => p.id === projectId);
    return (proj?.subProjects ?? [])
      .map((s) => (s.path ? s.path.split('/').filter(Boolean).pop() : undefined))
      .filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

/** capsule 이 포함하는 repo basename 목록(U1 task↔project 조인 키). secret 아님(디렉터리명만).
 *  ★C4-c: capsule 경로 3슬롯(root/fe/be)에 더해 companies.json subProjects 도 병합 —
 *  soo-auth-service 처럼 4번째 서브프로젝트가 누락되던 문제 해소(데이터 기반). */
function reposOf(c: Capsule): string[] {
  const base = (p?: string) => (p ? p.split('/').filter(Boolean).pop() : undefined);
  return [base(c.rootPath), base(c.frontendPath), base(c.backendPath), ...companiesSubRepos(c.projectId ?? c.id)]
    .filter((x): x is string => !!x)
    .filter((x, i, arr) => arr.indexOf(x) === i);
}

export function registerProjectsRoutes(app_: RouteApp, _ctx: RouteContext): void {
  // GET /api/projects — capsule + fe/be 프로브 + git
  app_.get('/api/projects', async (req, sendJson) => {
    const caps = readCapsules();
    const projects = await Promise.all(caps.map(async (c) => {
      const [fe, be] = await Promise.all([
        probe(c.frontendPort, '/'),
        probe(c.backendPort, '/health'),
      ]);
      return {
        projectId: c.projectId || c.id,
        name: c.projectName || c.projectId || c.id,
        capsule: { frontendPort: c.frontendPort ?? null, backendPort: c.backendPort ?? null, envNamespace: c.envNamespace ?? null },
        repos: reposOf(c), // ★U1 조인 키(repo basename)
        fe, be,
        git: gitInfo(gitRepoOf(c)),
      };
    }));
    sendJson(envelope({ projects }, { sources: ['project-capsules.json', 'http-probe', 'git'] }));
  });

  // GET /api/projects/:id/git — 단일 프로젝트 git 상세
  app_.get(/^\/api\/projects\/([^/]+)\/git$/, (req, sendJson) => {
    const id = decodeURIComponent(req.params.id);
    const c = readCapsules().find((x) => (x.projectId || x.id) === id);
    if (!c) { sendJson(envelope(null, { sources: ['project-capsules.json'], partial: true }), 404); return; }
    sendJson(envelope({ projectId: id, git: gitInfo(gitRepoOf(c)) }, { sources: ['git'] }));
  });

  // GET /api/projects/:id/service-log?role=fe|be&lines=N — 서비스 기동 로그 tail(read-only, 팝업용).
  app_.get(/^\/api\/projects\/([^/]+)\/service-log$/, (req, sendJson) => {
    const id = decodeURIComponent(req.params.id);
    const role = req.url.searchParams.get('role');
    if (role !== 'fe' && role !== 'be') { sendJson({ error: "role 은 'fe' 또는 'be'" }, 400); return; }
    const lines = parseInt(req.url.searchParams.get('lines') || '200', 10) || 200;
    sendJson(getServiceLog(id, role as ServiceRole, lines));
  });

  // POST /api/projects/:id/service — 서비스 start/stop(★제어·write). body: { role: 'fe'|'be', action: 'start'|'stop' }
  //   ★capsule 정의 프로젝트/경로만 대상 · localhost dev 가정 · 자동 재시작 없음(명시 호출만).
  app_.post(/^\/api\/projects\/([^/]+)\/service$/, async (req, sendJson) => {
    const id = decodeURIComponent(req.params.id);
    const { role, action } = req.body as { role?: string; action?: string };
    if (role !== 'fe' && role !== 'be') { sendJson({ ok: false, message: "role 은 'fe' 또는 'be'" }, 400); return; }
    if (action !== 'start' && action !== 'stop') { sendJson({ ok: false, message: "action 은 'start' 또는 'stop'" }, 400); return; }
    try {
      const result = action === 'start'
        ? await startService(id, role as ServiceRole)
        : await stopService(id, role as ServiceRole);
      sendJson(result, result.ok ? 200 : 400);
    } catch (e) {
      sendJson({ ok: false, projectId: id, role, message: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}
