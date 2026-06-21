/**
 * 서비스 상태(프로젝트별 FE/BE up/down + 헬스) 공유 모듈.
 *
 * project-capsules.json 을 읽어 각 프로젝트의 프론트(/)·백엔드(/health) 포트를
 * 127.0.0.1 고정으로 read-only 프로브한다. 대시보드(api-routes/projects-routes.ts)와
 * 슬랙 봇(slack-bot.ts) 양쪽이 ★같은 진실원본/같은 프로브 로직을 쓰도록 여기로 추출.
 *
 * ★보안: 프로브는 127.0.0.1 고정(localhost dev 만) · GET · 짧은 타임아웃 · secret 0(포트/이름만).
 * ★상태 확인만 — 서비스 기동/재시작/복구는 하지 않는다(read-only).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const CAPS_FILE = path.join(os.homedir(), '.dorothy', 'project-capsules.json');
export const PROBE_TIMEOUT_MS = 2000;

export interface Capsule {
  id?: string; projectId?: string; projectName?: string;
  frontendPort?: number; backendPort?: number; envNamespace?: string;
  rootPath?: string; frontendPath?: string; backendPath?: string;
  status?: string;
}

/** 단일 포트 프로브 결과. up=응답 수신(상태코드 무관), reason=실패 사유(미응답 시). */
export interface ServiceProbe {
  up: boolean;
  port: number;
  status?: number;
  latencyMs?: number;
  reason?: 'probe-timeout' | 'probe-unreachable';
}

export function readProjectCapsules(): Capsule[] {
  try {
    const raw = JSON.parse(fs.readFileSync(CAPS_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.capsules ?? []);
  } catch {
    return [];
  }
}

/** 단일 호스트 1회 프로브. */
async function probeOnce(host: string, port: number, pathStr: string): Promise<ServiceProbe> {
  const t0 = Date.now();
  try {
    const res = await fetch(`http://${host}:${port}${pathStr}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'manual',
    });
    return { up: true, port, status: res.status, latencyMs: Date.now() - t0 };
  } catch (e) {
    const reason = (e as Error)?.name === 'TimeoutError' ? 'probe-timeout' : 'probe-unreachable';
    return { up: false, port, reason };
  }
}

/**
 * ★loopback 고정 read-only 프로브. 응답 수신(상태 무관)=up:true, 연결 실패/timeout=up:false.
 * 포트가 없으면 null(=source-missing).
 * ★IPv4(127.0.0.1)·IPv6(::1) 둘 다 확인(병렬) — vite 등은 host 미설정 시 ::1 에만 바인딩하므로
 *   IPv4 만 보면 떠 있는 서비스를 down 으로 오판한다. 둘 다 loopback 이라 보안 경계 동일.
 */
export async function probeService(port: number | undefined, pathStr: string): Promise<ServiceProbe | null> {
  if (!port || typeof port !== 'number') return null;
  const [v4, v6] = await Promise.all([
    probeOnce('127.0.0.1', port, pathStr),
    probeOnce('[::1]', port, pathStr),
  ]);
  return v4.up ? v4 : v6.up ? v6 : v4;
}

export interface ProjectServiceStatus {
  projectId: string;
  name: string;
  status?: string;          // capsule 의 라이프사이클 상태(active/ready/draft 등)
  fe: ServiceProbe | null;  // null = 포트 미설정(확인 불가)
  be: ServiceProbe | null;
}

/**
 * 전 프로젝트의 FE(/)·BE(/health) 상태를 한 번에 프로브한다(병렬). read-only.
 * 대시보드 /api/projects 와 동일한 경로 규약(FE='/', BE='/health')을 사용한다.
 */
export async function getProjectServiceStatus(): Promise<ProjectServiceStatus[]> {
  const caps = readProjectCapsules();
  return Promise.all(caps.map(async (c) => {
    const [fe, be] = await Promise.all([
      probeService(c.frontendPort, '/'),
      probeService(c.backendPort, '/health'),
    ]);
    return {
      projectId: c.projectId || c.id || '?',
      name: c.projectName || c.projectId || c.id || '?',
      status: c.status,
      fe,
      be,
    };
  }));
}
