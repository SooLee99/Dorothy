/**
 * 서비스 제어(프로젝트별 BE/FE start/stop) — 대시보드·슬랙 공용.
 *
 * service-status.ts(관측)와 짝을 이루는 ★제어 모듈. project-capsules.json 의 경로/포트를
 * 근거로 각 서비스를 detached 로 기동하고, 기동 PID 를 레지스트리에 적어 나중에 정지한다.
 *
 * ★안전 경계:
 *   - capsule 에 정의된 프로젝트·경로만 대상(임의 경로/명령 실행 금지).
 *   - 기동 명령은 경로에서 ★탐지(run-local.sh > gradlew bootRun > package.json dev)
 *     하거나 ~/.dorothy/service-commands.json 으로 명시 override. 셸 문자열 보간 없음(spawn 배열).
 *   - 정지는 ★우리가 기록한 PID(프로세스 그룹) 우선. 미기록 시 해당 ★localhost 포트 LISTEN
 *     프로세스만 종료(dev 머신 가정). 그 외 프로세스는 건드리지 않는다.
 *   - secret 미로깅. env 파일(~/.dorothy/project-env/<id>.env)은 자식 환경에만 주입.
 *   - 자동 재시작/감시 없음 — 사용자가 명시적으로 start/stop 할 때만 동작.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { readProjectCapsules, type Capsule } from './service-status';

export type ServiceRole = 'fe' | 'be';

const RUNTIME_DIR = path.join(os.homedir(), '.dorothy', 'runtime');
const PROCS_FILE = path.join(RUNTIME_DIR, 'service-procs.json');
const LOG_DIR = path.join(os.homedir(), '.dorothy', 'logs', 'services');
const ENV_DIR = path.join(os.homedir(), '.dorothy', 'project-env');
const OVERRIDE_FILE = path.join(os.homedir(), '.dorothy', 'service-commands.json');

interface ProcRecord {
  projectId: string;
  role: ServiceRole;
  pid: number;
  port?: number;
  command: string;     // 표시용(로그). 실행은 배열로.
  logFile: string;
  startedAt: string;
}

interface ResolvedCommand {
  cmd: string;
  args: string[];
  cwd: string;
  port?: number;
  display: string;
}

export interface ControlResult {
  ok: boolean;
  projectId: string;
  role: ServiceRole;
  message: string;
  pid?: number;
  port?: number;
  logFile?: string;
}

function expandHome(p?: string): string | undefined {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function readProcs(): ProcRecord[] {
  try { const r = JSON.parse(fs.readFileSync(PROCS_FILE, 'utf8')); return Array.isArray(r) ? r : []; }
  catch { return []; }
}
function writeProcs(rows: ProcRecord[]): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PROCS_FILE, JSON.stringify(rows, null, 2));
}
function upsertProc(rec: ProcRecord): void {
  const rows = readProcs().filter((r) => !(r.projectId === rec.projectId && r.role === rec.role));
  rows.push(rec);
  writeProcs(rows);
}
function removeProc(projectId: string, role: ServiceRole): void {
  writeProcs(readProcs().filter((r) => !(r.projectId === projectId && r.role === role)));
}
export function getProcRecord(projectId: string, role: ServiceRole): ProcRecord | undefined {
  return readProcs().find((r) => r.projectId === projectId && r.role === role);
}

/** pid 가 살아있나(시그널 0). */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** ~/.dorothy/project-env/<id>.env → {KEY:VALUE}. 주석/빈줄 무시. (secret — 로깅 금지) */
function loadEnvFile(projectId: string): Record<string, string> {
  const f = path.join(ENV_DIR, `${projectId}.env`);
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch { /* 파일 없으면 빈 객체 */ }
  return out;
}

/** ~/.dorothy/service-commands.json 의 [projectId][role] override(있으면 탐지보다 우선). */
function readOverride(projectId: string, role: ServiceRole): { cmd: string; args: string[]; cwd?: string; port?: number } | null {
  try {
    const all = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
    const o = all?.[projectId]?.[role];
    if (o && typeof o.cmd === 'string' && Array.isArray(o.args)) return o;
  } catch { /* 없음 */ }
  return null;
}

/** lock 파일로 패키지 매니저 추정. */
function detectPkgManager(dir: string): string {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function pkgHasScript(dir: string, name: string): boolean {
  try { return !!JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.scripts?.[name]; }
  catch { return false; }
}

/**
 * npm/pnpm/yarn/bun run 명령의 args 구성.
 * ★pnpm: `--config.verify-deps-before-run=false` 로 run 전 자동 deps-check(=pnpm install)를 끈다.
 *   pnpm v11 은 run 전에 install 을 돌리는데, 빌드스크립트 미승인(ERR_PNPM_IGNORED_BUILDS)이면
 *   그 install 이 실패해 dev 서버가 아예 안 뜬다(triplan FE 증상). 체크를 끄면 node_modules 가
 *   있는 한 그대로 dev 가 실행된다.
 * ★FE: capsule 포트를 dev 서버에 강제 주입(`-- --port <port>`)한다. vite/next 둘 다 --port 를
 *   받으므로, 스크립트에 포트가 없어도(triplan `vite`) capsule 포트로 바인딩돼 모니터와 일치한다.
 *   (이미 --port 가 있으면 vite/next 는 뒤 값을 쓰므로 같은 값이면 무해.)
 */
function buildRunArgs(pm: string, script: string, role: ServiceRole, port?: number): { args: string[]; display: string } {
  const head = pm === 'pnpm' ? ['--config.verify-deps-before-run=false', 'run', script] : ['run', script];
  // ★npm 만 스크립트 인자 전달에 `--` 가 필요. pnpm/yarn/bun 은 스크립트명 뒤 인자를 바로 넘긴다
  //   (pnpm 에 `--` 를 주면 vite 에 literal 로 전달돼 무시됨 → 포트 강제 실패).
  const portArgs = role === 'fe' && port
    ? (pm === 'npm' ? ['--', '--port', String(port)] : ['--port', String(port)])
    : [];
  const args = [...head, ...portArgs];
  return { args, display: `${pm} ${args.join(' ')}` };
}

/** 경로/역할에서 기동 명령 결정. capsule 외 경로·미지원 스택은 에러. */
function resolveCommand(c: Capsule, role: ServiceRole): ResolvedCommand | { error: string } {
  const projectId = c.projectId || c.id || '?';
  const dir = expandHome(role === 'fe' ? c.frontendPath : c.backendPath);
  const port = role === 'fe' ? c.frontendPort : c.backendPort;
  if (!dir) return { error: `${role} 경로가 capsule 에 없습니다` };
  if (!fs.existsSync(dir)) return { error: `${role} 경로 없음: ${dir}` };

  const ov = readOverride(projectId, role);
  if (ov) return { cmd: ov.cmd, args: ov.args, cwd: expandHome(ov.cwd) || dir, port: ov.port ?? port, display: `${ov.cmd} ${ov.args.join(' ')}` };

  // 백엔드: run-local.sh > gradlew bootRun > package.json(dev|start)
  if (role === 'be') {
    if (fs.existsSync(path.join(dir, 'run-local.sh'))) return { cmd: 'bash', args: ['run-local.sh'], cwd: dir, port, display: 'bash run-local.sh' };
    if (fs.existsSync(path.join(dir, 'gradlew'))) return { cmd: './gradlew', args: ['bootRun'], cwd: dir, port, display: './gradlew bootRun' };
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const pm = detectPkgManager(dir);
      const script = pkgHasScript(dir, 'dev') ? 'dev' : pkgHasScript(dir, 'start') ? 'start' : null;
      if (script) { const { args, display } = buildRunArgs(pm, script, 'be', port); return { cmd: pm, args, cwd: dir, port, display }; }
    }
    return { error: `${dir} 에서 백엔드 기동 방법을 찾지 못함(run-local.sh/gradlew/package.json 없음)` };
  }

  // 프론트: package.json dev (포트는 capsule 값으로 강제)
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    const pm = detectPkgManager(dir);
    const script = pkgHasScript(dir, 'dev') ? 'dev' : pkgHasScript(dir, 'start') ? 'start' : null;
    if (script) { const { args, display } = buildRunArgs(pm, script, 'fe', port); return { cmd: pm, args, cwd: dir, port, display }; }
  }
  return { error: `${dir} 에서 프론트 기동 방법을 찾지 못함(package.json dev 없음)` };
}

function findCapsule(projectId: string): Capsule | undefined {
  return readProjectCapsules().find((c) => (c.projectId || c.id) === projectId);
}

/** 단일 호스트 TCP connect 1회. */
function connectOnce(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (v: boolean) => { try { sock.destroy(); } catch { /* noop */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

/** loopback 포트가 LISTEN 중인지 — IPv4/IPv6 둘 다 확인(vite 는 ::1 에만 바인딩하기도 함). */
async function portUp(port: number, timeoutMs = 800): Promise<boolean> {
  const [v4, v6] = await Promise.all([connectOnce('127.0.0.1', port, timeoutMs), connectOnce('::1', port, timeoutMs)]);
  return v4 || v6;
}

/**
 * 서비스 기동(detached). 이미 기록된 PID 가 살아있으면 noop(중복 기동 방지).
 * 포트가 이미 떠 있으면(외부 기동) 기록만 안 하고 "이미 가동" 보고.
 */
export async function startService(projectId: string, role: ServiceRole): Promise<ControlResult> {
  const c = findCapsule(projectId);
  if (!c) return { ok: false, projectId, role, message: `프로젝트 capsule 없음: ${projectId}` };

  const existing = getProcRecord(projectId, role);
  if (existing && pidAlive(existing.pid)) {
    return { ok: true, projectId, role, pid: existing.pid, port: existing.port, logFile: existing.logFile, message: `이미 기동됨(pid ${existing.pid})` };
  }

  const resolved = resolveCommand(c, role);
  if ('error' in resolved) return { ok: false, projectId, role, message: resolved.error };

  if (resolved.port && await portUp(resolved.port)) {
    return { ok: true, projectId, role, port: resolved.port, message: `포트 :${resolved.port} 이미 가동 중(외부 기동·기록 안 함)` };
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `${projectId}-${role}.log`);
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `\n===== start ${new Date().toISOString()} : ${resolved.display} (cwd=${resolved.cwd}) =====\n`);

  const child = spawn(resolved.cmd, resolved.args, {
    cwd: resolved.cwd,
    env: { ...process.env, ...loadEnvFile(projectId) },
    detached: true,                 // 새 프로세스 그룹 → 그룹 단위 종료 가능(gradle→java, npm→vite)
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);

  if (!child.pid) return { ok: false, projectId, role, message: '기동 실패(pid 없음)' };

  upsertProc({ projectId, role, pid: child.pid, port: resolved.port, command: resolved.display, logFile, startedAt: new Date().toISOString() });
  return {
    ok: true, projectId, role, pid: child.pid, port: resolved.port, logFile,
    message: `기동 시작(pid ${child.pid}) — ${resolved.display}. 바인딩까지 수십초 걸릴 수 있음, services 로 확인.`,
  };
}

/** 서비스 로그(기동 출력) tail. 팝업에서 "어떻게 됐는지"(성공/실패 사유) 보여주기용. read-only. */
export function getServiceLog(projectId: string, role: ServiceRole, maxLines = 200): { exists: boolean; logFile: string; lines: string[] } {
  const logFile = path.join(LOG_DIR, `${projectId}-${role}.log`);
  try {
    const all = fs.readFileSync(logFile, 'utf8').split('\n');
    const n = Math.max(1, Math.min(maxLines, 1000));
    return { exists: true, logFile, lines: all.slice(-n) };
  } catch {
    return { exists: false, logFile, lines: [] };
  }
}

/** lsof 로 해당 localhost 포트 LISTEN PID 목록(미기록 서비스 정지용 fallback). */
function listenerPidsOnPort(port: number): number[] {
  try {
    const out = require('child_process').execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 4000 });
    return out.split('\n').map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => Number.isInteger(n));
  } catch { return []; }
}

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* 이미 죽음 */ } }
}

/**
 * 서비스 정지. 기록된 PID 그룹 우선 TERM→(잔존 시)KILL.
 * 미기록인데 포트가 떠 있으면 그 localhost LISTEN PID 만 종료(dev 머신 가정).
 */
export async function stopService(projectId: string, role: ServiceRole): Promise<ControlResult> {
  const c = findCapsule(projectId);
  const port = c ? (role === 'fe' ? c.frontendPort : c.backendPort) : undefined;
  const rec = getProcRecord(projectId, role);

  let killedPid: number | undefined;
  if (rec && pidAlive(rec.pid)) {
    killGroup(rec.pid, 'SIGTERM');
    // 잠깐 기다렸다 잔존 시 KILL
    await new Promise((r) => setTimeout(r, 2500));
    if (pidAlive(rec.pid)) killGroup(rec.pid, 'SIGKILL');
    killedPid = rec.pid;
    removeProc(projectId, role);
    return { ok: true, projectId, role, pid: killedPid, port, message: `정지함(pid ${killedPid})` };
  }

  // 미기록 fallback: 포트 LISTEN 프로세스 종료(localhost dev)
  if (port) {
    const pids = listenerPidsOnPort(port);
    if (pids.length) {
      for (const p of pids) killGroup(p, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 2500));
      for (const p of pids) if (pidAlive(p)) killGroup(p, 'SIGKILL');
      removeProc(projectId, role);
      return { ok: true, projectId, role, port, message: `정지함(:${port} LISTEN pid ${pids.join(',')} — 미기록/외부 기동분)` };
    }
  }
  removeProc(projectId, role);
  return { ok: true, projectId, role, port, message: '이미 정지 상태(실행 중 아님)' };
}
