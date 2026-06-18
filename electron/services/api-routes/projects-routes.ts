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
import { RouteApp, RouteContext } from './types';

const CAPS_FILE = path.join(os.homedir(), '.dorothy', 'project-capsules.json');
const PROBE_TIMEOUT_MS = 2000;

interface Capsule {
  id?: string; projectId?: string; projectName?: string;
  frontendPort?: number; backendPort?: number; envNamespace?: string;
  rootPath?: string; frontendPath?: string; backendPath?: string;
  status?: string;
}

function readCapsules(): Capsule[] {
  try {
    const raw = JSON.parse(fs.readFileSync(CAPS_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.capsules ?? []);
  } catch {
    return [];
  }
}

function sh(args: string[], cwd?: string): string {
  try { return cp.execFileSync('git', args, { encoding: 'utf8', timeout: 5000, cwd }).trim(); }
  catch { return ''; }
}

/** ★127.0.0.1 고정 read-only 프로브. 응답 수신(상태 무관)=up:true, 연결 실패/timeout=up:false. */
async function probe(port: number | undefined, pathStr: string) {
  if (!port || typeof port !== 'number') return unknown('source-missing');
  const checkedAt = new Date().toISOString();
  const t0 = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathStr}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'manual',
    });
    return observed({ up: true, port, status: res.status, latencyMs: Date.now() - t0, checkedAt });
  } catch (e) {
    const reason = (e as Error)?.name === 'TimeoutError' ? 'probe-timeout' : 'probe-unreachable';
    return observed({ up: false, port, reason, checkedAt });
  }
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

/** capsule 이 포함하는 repo basename 목록(U1 task↔project 조인 키). secret 아님(디렉터리명만). */
function reposOf(c: Capsule): string[] {
  const base = (p?: string) => (p ? p.split('/').filter(Boolean).pop() : undefined);
  return [base(c.rootPath), base(c.frontendPath), base(c.backendPath)]
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
}
