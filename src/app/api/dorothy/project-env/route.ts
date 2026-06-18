import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Phase 6-BB — 프로젝트별 환경변수 / API 키 관리.
 *
 * SAFETY:
 *  - 저장은 ~/.dorothy/project-env/<projectId>.json (mode 0600).
 *  - secret 값은 GET/응답에 절대 반환하지 않음(설정 여부 hasValue + 마스킹만). non-secret 만 값 반환.
 *  - 'apply' 시 프로젝트 rootPath(APPS_ROOT 하위)에 .env 작성(.gitignore 에 .env 포함됨).
 *  - 토큰/키 값은 로그/응답에 미노출.
 */

const HOME = os.homedir();
const ENV_DIR = path.join(HOME, '.dorothy', 'project-env');
const CAPS_FILE = path.join(HOME, '.dorothy', 'project-capsules.json');
const APPS_ROOT = '/Users/soo/workspace/source-code/apps';
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

interface EnvVar { key: string; value?: string; secret?: boolean; note?: string }

function safeProjectId(pid: string): string | null {
  return /^[a-z0-9][a-z0-9-]*$/.test(pid) ? pid : null;
}
function envFile(pid: string) { return path.join(ENV_DIR, `${pid}.json`); }
function readEnv(pid: string): EnvVar[] {
  try { const v = JSON.parse(fs.readFileSync(envFile(pid), 'utf-8')); return Array.isArray(v.vars) ? v.vars : []; } catch { return []; }
}
function writeEnv(pid: string, vars: EnvVar[]) {
  fs.mkdirSync(ENV_DIR, { recursive: true });
  fs.writeFileSync(envFile(pid), JSON.stringify({ vars }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(envFile(pid), 0o600); } catch { /* ignore */ }
}
/** secret 값을 제거한 안전 표현 */
function masked(vars: EnvVar[]) {
  return vars.map(v => ({
    key: v.key, secret: !!v.secret, note: v.note ?? '',
    value: v.secret ? '' : (v.value ?? ''),
    hasValue: !!v.value,
  }));
}

export async function GET(req: Request) {
  const pid = safeProjectId(new URL(req.url).searchParams.get('projectId') ?? '');
  if (!pid) return NextResponse.json({ ok: false, error: 'projectId 필요' }, { status: 400 });
  return NextResponse.json({ ok: true, projectId: pid, vars: masked(readEnv(pid)) });
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = body.action as string;
  const pid = safeProjectId(typeof body.projectId === 'string' ? body.projectId : '');
  if (!pid) return NextResponse.json({ ok: false, error: 'projectId 형식 오류' }, { status: 400 });

  if (action === 'set') {
    const incoming = Array.isArray(body.vars) ? body.vars as EnvVar[] : [];
    const prev = readEnv(pid);
    const prevByKey = new Map(prev.map(v => [v.key, v]));
    const next: EnvVar[] = [];
    for (const v of incoming) {
      const key = String(v.key || '').trim();
      if (!KEY_RE.test(key)) return NextResponse.json({ ok: false, error: `키 형식 오류(${key}) — 영대문자/숫자/밑줄, 첫 글자는 영문` }, { status: 400 });
      const secret = !!v.secret;
      const note = typeof v.note === 'string' ? v.note.slice(0, 300) : '';
      // 값이 빈 문자열이면 기존 값 유지(특히 secret 재입력 방지)
      const incomingVal = typeof v.value === 'string' ? v.value : '';
      const value = incomingVal !== '' ? incomingVal : (prevByKey.get(key)?.value ?? '');
      next.push({ key, value, secret, note });
    }
    writeEnv(pid, next);
    return NextResponse.json({ ok: true, vars: masked(next) });
  }

  if (action === 'delete') {
    const key = String(body.key || '').trim();
    const next = readEnv(pid).filter(v => v.key !== key);
    writeEnv(pid, next);
    return NextResponse.json({ ok: true, vars: masked(next) });
  }

  if (action === 'apply') {
    // 프로젝트 rootPath 조회(APPS_ROOT 하위만 허용)
    let root = '';
    try {
      const caps = JSON.parse(fs.readFileSync(CAPS_FILE, 'utf-8'));
      const list = Array.isArray(caps) ? caps : (caps.capsules ?? []);
      const cap = (list as { projectId?: string; rootPath?: string }[]).find(c => c.projectId === pid);
      root = String(cap?.rootPath || '');
    } catch { /* ignore */ }
    if (!root) return NextResponse.json({ ok: false, error: '프로젝트 캡슐/경로를 찾을 수 없음' }, { status: 404 });
    const norm = path.resolve(root);
    if (norm !== APPS_ROOT && !norm.startsWith(APPS_ROOT + path.sep)) return NextResponse.json({ ok: false, error: 'rootPath가 허용 루트 밖' }, { status: 400 });
    if (!fs.existsSync(norm)) return NextResponse.json({ ok: false, error: '프로젝트 디렉터리 없음(먼저 scaffold)' }, { status: 409 });
    const vars = readEnv(pid).filter(v => v.value);
    const lines = vars.map(v => `${v.key}=${v.value}`).join('\n') + '\n';
    try {
      fs.writeFileSync(path.join(norm, '.env'), lines, { mode: 0o600 });
      // frontend/backend 하위에도 동일 .env 제공(선택적)
      for (const sub of ['frontend', 'backend']) {
        const sd = path.join(norm, sub);
        if (fs.existsSync(sd)) fs.writeFileSync(path.join(sd, '.env'), lines, { mode: 0o600 });
      }
    } catch (e) {
      return NextResponse.json({ ok: false, error: `.env 작성 실패: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true, applied: vars.length, note: '.env 생성됨(.gitignore로 git 제외)' });
  }

  return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
}
