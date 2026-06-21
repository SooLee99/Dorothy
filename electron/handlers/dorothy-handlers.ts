import { ipcMain, shell } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { isBusyLockFresh } from '../core/busy-lock';

// Dorothy 멀티회사/오토컴퍼니/하네스/승인 데이터의 IPC 핸들러.
// src/app/api/dorothy/* 의 Next API 라우트와 동일 로직을 포팅한 것.
// 패키지(static export) 빌드에서는 API 라우트가 제거되므로 렌더러는 이 IPC 를 사용한다.
// agents.json 은 절대 건드리지 않는다. companies.json 만 읽고 쓴다.

const COMPANIES_FILE = path.join(DATA_DIR, 'companies.json');
const TRIPLAN_FALLBACK = '/Users/soo/workspace/source-code/triplan';

// ---------- 공용 헬퍼 ----------
function safeReadFile(file?: string | null): string | null {
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function safeReadJson<T = unknown>(file?: string | null): T | null {
  const raw = safeReadFile(file);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function parseKeyValue(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    if (k) out[k] = t.slice(eq + 1).trim();
  }
  return out;
}

function head(raw: string | null, n: number): string | null {
  if (raw == null) return null;
  return raw.split(/\r?\n/).slice(0, n).join('\n');
}

function tail(raw: string | null, n: number): string | null {
  if (raw == null) return null;
  const lines = raw.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function findNewestLog(installPath?: string): { file: string; tail: string } | null {
  if (!installPath) return null;
  const logsDir = path.join(installPath, 'logs');
  try {
    if (!fs.existsSync(logsDir)) return null;
    const candidates = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const full = path.join(logsDir, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (candidates.length === 0) return null;
    const newest = candidates[0];
    return { file: newest.full, tail: tail(safeReadFile(newest.full), 50) ?? '' };
  } catch {
    return null;
  }
}

function frontmatterField(raw: string | null, field: string): string | null {
  if (!raw) return null;
  const fmMatch = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const block = fmMatch ? fmMatch[1] : raw;
  const m = block.match(new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm'));
  if (!m) return null;
  let val = m[1].trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  return val;
}

// companies.json 에서 선택 프로젝트의 harness/approvals 경로를 구한다(없으면 triplan 폴백).
function resolveProjectPaths(): { harnessRoot: string; approvalsDir: string } {
  const d = safeReadJson<Record<string, unknown>>(COMPANIES_FILE);
  const projects = Array.isArray(d?.projects) ? (d!.projects as Array<Record<string, unknown>>) : [];
  const selected = d?.selectedCompanyId as string | undefined;
  const proj =
    projects.find((p) => p.companyId === selected && p.harnessRoot) ?? projects.find((p) => p.harnessRoot) ?? null;
  return {
    harnessRoot: (proj?.harnessRoot as string) ?? path.join(TRIPLAN_FALLBACK, '.claude'),
    approvalsDir: (proj?.approvalsDir as string) ?? path.join(TRIPLAN_FALLBACK, 'approvals'),
  };
}

// ---------- companies 읽기/쓰기 ----------
interface CompaniesFile {
  version?: number;
  selectedCompanyId?: string;
  companies?: Array<{ id: string; name: string; description?: string; createdAt?: string; defaultEngineProfileId?: string }>;
  projects?: unknown[];
  agentMappings?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

function getCompanies() {
  const d = safeReadJson<CompaniesFile>(COMPANIES_FILE);
  if (!d) return { error: 'companies.json 을 읽을 수 없습니다.' };
  const rawMappings = Array.isArray(d.agentMappings) ? d.agentMappings : [];
  const agentMappings = rawMappings
    .filter((m) => m && m.agentId)
    .map((m) => ({
      agentId: m.agentId as string,
      companyId: (m.companyId as string) ?? null,
      roleId: (m.roleId as string) ?? null,
      name: (m.name as string) ?? null,
      // 정합성 C1-b — UI 가 프로젝트별 그룹을 만들 수 있도록 projectId/subProjectId 보존
      //   (이전엔 여기서 버려져 /agents 등이 프로젝트 그룹을 못 만들었음).
      projectId: (m.projectId as string) ?? null,
      subProjectId: (m.subProjectId as string) ?? null,
    }));
  return {
    selectedCompanyId: d.selectedCompanyId ?? null,
    companies: d.companies ?? [],
    projects: d.projects ?? [],
    agentMappings,
  };
}

interface MutateBody {
  action?: string;
  companyId?: string;
  company?: { id?: string; name?: string; description?: string; defaultEngineProfileId?: string };
  agentId?: string;
  roleId?: string;
  name?: string;
  projectId?: string;
  subProjectId?: string;
}

function mutateCompanies(body: MutateBody) {
  const d = safeReadJson<CompaniesFile>(COMPANIES_FILE);
  if (!d) return { error: 'companies.json 을 읽을 수 없습니다.' };
  d.companies = d.companies ?? [];

  if (body.action === 'select') {
    const id = body.companyId;
    if (!id || !d.companies.some((c) => c.id === id)) return { error: '존재하지 않는 회사입니다.' };
    d.selectedCompanyId = id;
    writeJsonAtomic(COMPANIES_FILE, d);
    return { ok: true, selectedCompanyId: id };
  }

  if (body.action === 'add') {
    const c = body.company ?? {};
    const id = (c.id ?? '').trim();
    const name = (c.name ?? '').trim();
    if (!id || !name) return { error: 'id 와 name 은 필수입니다.' };
    if (d.companies.some((x) => x.id === id)) return { error: `이미 존재하는 회사 id: ${id}` };
    d.companies.push({
      id,
      name,
      description: (c.description ?? '').trim() || undefined,
      createdAt: new Date().toISOString().slice(0, 10),
      defaultEngineProfileId: c.defaultEngineProfileId ?? 'auto',
    });
    if (!d.selectedCompanyId) d.selectedCompanyId = id;
    writeJsonAtomic(COMPANIES_FILE, d);
    return { ok: true, company: id };
  }

  if (body.action === 'update') {
    const target = d.companies.find((x) => x.id === body.companyId);
    if (!target) return { error: '존재하지 않는 회사입니다.' };
    const patch = body.company ?? {};
    if (typeof patch.name === 'string') {
      const name = patch.name.trim();
      if (!name) return { error: '이름은 비울 수 없습니다.' };
      target.name = name;
    }
    if (typeof patch.description === 'string') target.description = patch.description.trim() || undefined;
    if (typeof patch.defaultEngineProfileId === 'string' && patch.defaultEngineProfileId.trim()) {
      target.defaultEngineProfileId = patch.defaultEngineProfileId.trim();
    }
    writeJsonAtomic(COMPANIES_FILE, d);
    return { ok: true, company: target };
  }

  if (body.action === 'mapAgent') {
    const agentId = (body.agentId ?? '').trim();
    const companyId = (body.companyId ?? '').trim();
    if (!agentId || !companyId) return { error: 'agentId 와 companyId 는 필수입니다.' };
    if (!d.companies.some((c) => c.id === companyId)) return { error: '존재하지 않는 회사입니다.' };
    const mappings = Array.isArray(d.agentMappings) ? d.agentMappings : [];
    const existing = mappings.find((m) => m.agentId === agentId);
    if (existing) {
      existing.companyId = companyId;
      if (body.roleId) existing.roleId = body.roleId;
      if (body.name) existing.name = body.name;
    } else {
      mappings.push({
        agentId,
        name: body.name ?? null,
        companyId,
        projectId: body.projectId ?? null,
        subProjectId: body.subProjectId ?? null,
        roleId: body.roleId ?? null,
        autoMapped: true,
        _mappedAt: new Date().toISOString().slice(0, 10),
      });
    }
    d.agentMappings = mappings;
    writeJsonAtomic(COMPANIES_FILE, d);
    return { ok: true, agentId, companyId };
  }

  return { error: '알 수 없는 action 입니다.' };
}

// ---------- auto-company / approvals / harness ----------
function getAutoCompany() {
  const companies = safeReadJson<Record<string, unknown>>(COMPANIES_FILE);
  const meta = (companies?.autoCompany ?? null) as Record<string, string> | null;
  const state = parseKeyValue(safeReadFile(meta?.stateFile));
  const runtime = safeReadJson(meta?.dorothyStateFile);
  const consensusHead = head(safeReadFile(meta?.consensusFile), 40);
  const log = findNewestLog(meta?.installPath);

  // .auto-loop-state 의 STATUS 는 "마지막으로 알려진" 값이라 일시정지 상태를 반영 못 한다.
  // 실제 일시정지 여부(.auto-loop-paused)와 프로세스 생존(.auto-loop.pid)을 추가로 확인한다.
  const installPath = meta?.installPath;
  let paused = false;
  let pidAlive = false;
  if (installPath) {
    paused = fs.existsSync(path.join(installPath, '.auto-loop-paused'));
    const pidRaw = safeReadFile(path.join(installPath, '.auto-loop.pid'));
    const pid = pidRaw ? parseInt(pidRaw.trim(), 10) : NaN;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // 시그널 0 = 존재 확인만
        pidAlive = true;
      } catch {
        pidAlive = false;
      }
    }
  }
  // Dorothy 에이전트가 작업 중이라 데몬이 양보하는 상황인지(상호 배제 표시용)
  const dorothyBusy = isBusyLockFresh();
  return { meta, state, runtime, consensusHead, log, paused, pidAlive, dorothyBusy };
}

function getApprovals() {
  const { approvalsDir } = resolveProjectPaths();
  return {
    dir: approvalsDir,
    queue: safeReadFile(path.join(approvalsDir, 'approval-queue.md')),
    approved: safeReadFile(path.join(approvalsDir, 'approved-decisions.md')),
    rejected: safeReadFile(path.join(approvalsDir, 'rejected-decisions.md')),
    policy: safeReadFile(path.join(approvalsDir, 'approval-policy.md')),
  };
}

// 스킬 카탈로그(통합): triplan 활성 카탈로그 + Auto-Company 추가 활용 가능 카탈로그.
// 각 항목: source('triplan' | 'auto-company'), linked(triplan/.claude/skills 에 들어와 있나),
//         linkedKind('real' | 'symlink' | null), referencedBy(에이전트 .md 가 이 스킬명을 언급?).
const AUTO_COMPANY_SKILLS_DIR = '/Users/soo/ai-company-stack/Auto-Company/.claude/skills';
interface SkillEntry {
  file: string;            // SKILL.md 절대경로(원본 — auto-company 이거나 triplan)
  name: string | null;     // frontmatter name
  description: string | null;
  source: 'triplan' | 'auto-company';
  slug: string;            // 디렉토리 이름(파일이름)
  linked: boolean;         // triplan/.claude/skills/<slug> 에 존재?
  linkedKind: 'real' | 'symlink' | null;
  triplanPath: string | null; // 링크된 경우 triplan 쪽 경로
  referencedBy: string[];  // 그 스킬을 언급하는 에이전트 roleId 목록(휴리스틱)
}

function scanSkillsDir(dir: string, source: 'triplan' | 'auto-company'): SkillEntry[] {
  const out: SkillEntry[] = [];
  try {
    if (!fs.existsSync(dir)) return out;
    for (const dirent of fs.readdirSync(dir)) {
      // 디렉토리 또는 단일 .md(예: frontend-design.md) 둘 다 허용
      const direntPath = path.join(dir, dirent);
      let file = path.join(direntPath, 'SKILL.md');
      let slug = dirent;
      if (!fs.existsSync(file)) {
        if (dirent.endsWith('.md')) { file = direntPath; slug = dirent.replace(/\.md$/, ''); }
        else continue;
      }
      const raw = safeReadFile(file);
      out.push({
        file, slug, source,
        name: frontmatterField(raw, 'name'),
        description: frontmatterField(raw, 'description'),
        linked: false, linkedKind: null, triplanPath: null, referencedBy: [],
      });
    }
  } catch { /* */ }
  return out;
}

function getHarness() {
  const { harnessRoot } = resolveProjectPaths();
  const agents: Array<{ file: string; name: string | null; description: string | null }> = [];

  const agentsDir = path.join(harnessRoot, 'agents');
  try {
    if (fs.existsSync(agentsDir)) {
      for (const f of fs.readdirSync(agentsDir)) {
        if (f.endsWith('.md')) {
          const file = path.join(agentsDir, f);
          const raw = safeReadFile(file);
          agents.push({ file, name: frontmatterField(raw, 'name'), description: frontmatterField(raw, 'description') });
        }
      }
    }
  } catch { /* ignore */ }

  const triplanSkillsDir = path.join(harnessRoot, 'skills');
  const triplanSkills = scanSkillsDir(triplanSkillsDir, 'triplan');
  const acSkills = scanSkillsDir(AUTO_COMPANY_SKILLS_DIR, 'auto-company');

  // triplan 안의 디렉토리/파일이 심볼릭이면 linked=symlink 로 표시(Auto-Company 항목에 매칭).
  const triplanSlugs = new Set(triplanSkills.map((s) => s.slug));
  for (const ac of acSkills) {
    if (triplanSlugs.has(ac.slug)) {
      const triplanPath = path.join(triplanSkillsDir, ac.slug);
      try {
        const lst = fs.lstatSync(triplanPath);
        ac.linked = true;
        ac.linkedKind = lst.isSymbolicLink() ? 'symlink' : 'real';
        ac.triplanPath = triplanPath;
      } catch { /* */ }
    }
  }
  // triplan 항목도 자기 자신은 linked=true(이미 활성).
  for (const t of triplanSkills) {
    t.linked = true;
    const fullPath = path.join(triplanSkillsDir, t.slug);
    try {
      const lst = fs.lstatSync(fullPath);
      t.linkedKind = lst.isSymbolicLink() ? 'symlink' : 'real';
      t.triplanPath = fullPath;
    } catch { t.linkedKind = 'real'; t.triplanPath = fullPath; }
  }

  // referencedBy: 에이전트 .md 안에서 스킬 슬러그가 언급되는지 휴리스틱 검색.
  try {
    for (const a of agents) {
      const raw = safeReadFile(a.file) ?? '';
      const roleId = frontmatterField(raw, 'name') ?? path.basename(a.file, '.md');
      for (const s of [...triplanSkills, ...acSkills]) {
        if (s.name && raw.includes(`/${s.name}`)) s.referencedBy.push(roleId);
        else if (raw.includes(`/${s.slug}/`) || raw.includes(`skills/${s.slug}`)) {
          if (!s.referencedBy.includes(roleId)) s.referencedBy.push(roleId);
        }
      }
    }
  } catch { /* */ }

  // 중복 제거: 동일 slug 가 triplan 에 있으면 triplan 우선, auto-company 항목은 linked 정보만 유지.
  const tripBySlug = new Map(triplanSkills.map((s) => [s.slug, s] as const));
  const merged: SkillEntry[] = [...triplanSkills];
  for (const ac of acSkills) {
    if (!tripBySlug.has(ac.slug)) merged.push(ac);
  }
  merged.sort((a, b) => (a.linked === b.linked ? a.slug.localeCompare(b.slug) : a.linked ? -1 : 1));

  const teamGraph = (safeReadJson<Record<string, unknown>>(COMPANIES_FILE)?.teamGraph ?? null) as unknown;
  return { agents, skills: merged, teamGraph };
}

// 스킬 활성화: Auto-Company → triplan/.claude/skills/<slug> 심볼릭 링크 생성(또는 제거).
// 안전: triplan 안의 "실제 디렉토리"(symlink 아님)는 절대 건드리지 않음(원본 보호).
function skillLink(input: { action?: 'link' | 'unlink'; slug?: string }): { ok?: boolean; error?: string; message?: string } {
  const action = input?.action;
  const slug = input?.slug;
  if (!slug || (action !== 'link' && action !== 'unlink')) return { error: 'action/slug required' };
  const { harnessRoot } = resolveProjectPaths();
  const triplanDir = path.join(harnessRoot, 'skills', slug);
  const acDir = path.join(AUTO_COMPANY_SKILLS_DIR, slug);
  if (action === 'link') {
    if (!fs.existsSync(acDir)) return { error: `Auto-Company 스킬 없음: ${slug}` };
    if (fs.existsSync(triplanDir)) return { error: '이미 triplan에 같은 이름이 존재' };
    try {
      fs.symlinkSync(acDir, triplanDir, 'dir');
      return { ok: true, message: `심볼릭 링크 생성: ${triplanDir} → ${acDir}` };
    } catch (e) { return { error: String(e) }; }
  } else {
    // unlink: triplan 쪽이 symlink 일 때만 안전하게 제거(실제 디렉토리는 보호).
    try {
      const lst = fs.lstatSync(triplanDir);
      if (!lst.isSymbolicLink()) return { error: '심볼릭 링크가 아닌 실제 디렉토리(원본 보호) — 제거 안 함' };
      fs.unlinkSync(triplanDir);
      return { ok: true, message: `심볼릭 제거: ${triplanDir}` };
    } catch (e) { return { error: String(e) }; }
  }
}

// ---------- Auto-Company 제어 (화이트리스트 액션만) ----------
// 렌더러는 action 키만 보낸다. 임의 명령 실행은 불가(보안). 경로는 companies.json 에서 읽는다.
interface AutoCompanyMeta {
  loopScript?: string;
  stopScript?: string;
  installPath?: string;
  consensusFile?: string;
  dashboardUrl?: string;
}

function autoCompanyMeta(): AutoCompanyMeta {
  const d = safeReadJson<Record<string, unknown>>(COMPANIES_FILE);
  return (d?.autoCompany ?? {}) as AutoCompanyMeta;
}

// bash 스크립트를 분리(detached) 실행하고 즉시 반환. 출력은 무시(상태는 파일로 반영).
function runScriptDetached(script: string | undefined, args: string[], extraEnv?: Record<string, string>, cwd?: string): { ok?: boolean; error?: string } {
  if (!script || !fs.existsSync(script)) return { error: `스크립트를 찾을 수 없습니다: ${script ?? '(미지정)'}` };
  try {
    const child = spawn('bash', [script, ...args], {
      cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...(extraEnv ?? {}) },
    });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function autoCompanyControl(action: string): Promise<{ ok?: boolean; error?: string; message?: string }> {
  const meta = autoCompanyMeta();
  const cwd = meta.installPath;

  switch (action) {
    // 시작/재시작/대기후재개: 모두 stop-loop.sh --resume-daemon (launchd 로드 + 시작, pause 플래그 제거)
    case 'start':
    case 'restart':
    case 'resume': {
      const r = runScriptDetached(meta.stopScript, ['--resume-daemon'], undefined, cwd);
      return r.error ? r : { ok: true, message: '자동 루프 시작/재개 요청됨 (잠시 후 상태 갱신)' };
    }
    // 중지: stop-loop.sh --pause-daemon (현재 사이클 중지 + launchd 언로드, 데이터 보존)
    case 'stop': {
      const r = runScriptDetached(meta.stopScript, ['--pause-daemon'], undefined, cwd);
      return r.error ? r : { ok: true, message: '자동 루프 중지(일시정지) 요청됨' };
    }
    // 1 사이클 강제 실행 (엔진 선택)
    case 'runOnce':
    case 'runOnceClaude':
    case 'runOnceCodex':
    case 'runOnceAuto': {
      const engine = action === 'runOnceClaude' ? 'claude' : action === 'runOnceCodex' ? 'codex' : action === 'runOnceAuto' ? 'auto' : undefined;
      const r = runScriptDetached(meta.loopScript, ['--once'], engine ? { ENGINE: engine } : undefined, cwd);
      return r.error ? r : { ok: true, message: `1 사이클 실행 시작됨${engine ? ` (ENGINE=${engine})` : ''}` };
    }
    // 열기
    case 'openConsensus': {
      if (!meta.consensusFile) return { error: 'consensus 경로 없음' };
      const err = await shell.openPath(meta.consensusFile);
      return err ? { error: err } : { ok: true, message: 'consensus.md 열기' };
    }
    case 'openLogs': {
      if (!meta.installPath) return { error: 'logs 경로 없음' };
      const err = await shell.openPath(path.join(meta.installPath, 'logs'));
      return err ? { error: err } : { ok: true, message: 'logs 폴더 열기' };
    }
    case 'openDashboard': {
      await shell.openExternal(meta.dashboardUrl ?? 'http://127.0.0.1:8787');
      return { ok: true, message: '대시보드 열기' };
    }
    default:
      return { error: `알 수 없는 action: ${action}` };
  }
}

// ---------- 🅒 역할 팀 24h 루프 상태 (src/app/api/dorothy/team-loop 의 IPC 포팅) ----------
const TEAMLOOP_PIPELINE: { role: string; label: string }[] = [
  { role: 'approval-manager', label: '승인 관리자' },
  { role: 'pm', label: 'PM' },
  { role: 'backend', label: '백엔드' },
  { role: 'frontend', label: '프론트엔드' },
  { role: 'qa', label: 'QA' },
  { role: 'security', label: '보안' },
  { role: 'ops', label: '운영' },
  { role: 'cost', label: '비용' },
  { role: 'docs', label: '문서' },
];
const TEAMLOOP_CODEX_ROLES = new Set(['frontend', 'cost', 'data-engineer', 'data', 'mobile']);

interface TeamLoopAgentState {
  status?: string;
  cycle?: number | string;
  lastRun?: string | null;
  nextRun?: string | null;
  cooldownUntil?: string | null;
  consecutiveErrors?: number | string;
  lastError?: string | null;
}

function getTeamLoop(): unknown {
  try {
    const runtimeDir = path.join(DATA_DIR, 'runtime');
    const loopState = safeReadJson<{ status?: string; pass?: string; currentRole?: string; updatedAt?: string }>(
      path.join(runtimeDir, 'triplan-team-loop-state.json'),
    );
    const agentStates = safeReadJson<Record<string, TeamLoopAgentState>>(path.join(runtimeDir, 'auto-loop-state.json')) || {};

    const pauseFlag = fs.existsSync(path.join(runtimeDir, 'triplan-pm-tick.paused'));
    let pidAlive = false;
    let pid: number | null = null;
    try {
      const raw = fs.readFileSync(path.join(runtimeDir, 'triplan-team-loop.pid'), 'utf-8').trim();
      pid = parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0) { process.kill(pid, 0); pidAlive = true; }
    } catch { pidAlive = false; }

    const companies = safeReadJson<{ agentMappings?: { agentId: string; roleId: string; name?: string; engine?: string }[] }>(COMPANIES_FILE);
    const byRole = new Map<string, { agentId: string; name?: string }>();
    for (const m of companies?.agentMappings ?? []) byRole.set(m.roleId, { agentId: m.agentId, name: m.name });

    // 🅒 모델: 실제 상태는 대시보드 에이전트(agents.json)에서 읽는다(라이브 status).
    const agentsRaw = safeReadJson<unknown>(path.join(DATA_DIR, 'agents.json'));
    const liveById = new Map<string, { status?: string; provider?: string }>();
    const arr = Array.isArray(agentsRaw)
      ? agentsRaw
      : agentsRaw && typeof agentsRaw === 'object'
        ? Object.values((agentsRaw as { agents?: unknown }).agents ?? agentsRaw)
        : [];
    for (const a of arr as { id?: string; status?: string; provider?: string }[]) {
      if (a && a.id) liveById.set(a.id, { status: a.status, provider: a.provider });
    }

    const now = Date.now();
    const agents = TEAMLOOP_PIPELINE.map(({ role, label }) => {
      const map = byRole.get(role);
      const live = map ? liveById.get(map.agentId) : undefined;
      const st = map ? agentStates[map.agentId] : undefined; // 쿨다운 best-effort
      const cooldownUntil = st?.cooldownUntil || st?.nextRun || null;
      let resumeInSeconds: number | null = null;
      if (cooldownUntil) {
        const t = Date.parse(cooldownUntil);
        if (!Number.isNaN(t)) resumeInSeconds = Math.max(0, Math.round((t - now) / 1000));
      }
      const engine: 'claude' | 'codex' = TEAMLOOP_CODEX_ROLES.has(role) ? 'codex' : 'claude';
      // 상태 우선순위: 대시보드 라이브 status > 옛 루프 상태 > pending
      const status = live?.status ?? st?.status ?? 'pending';
      return {
        role, label, name: map?.name ?? label, engine,
        status, cycle: st?.cycle ?? null, lastRun: st?.lastRun ?? null,
        cooldownUntil, resumeInSeconds,
        consecutiveErrors: st?.consecutiveErrors ?? 0, lastError: st?.lastError ?? null,
        isCurrent: (live?.status === 'running') || loopState?.currentRole === role,
      };
    });

    const engineCooldown: Record<'claude' | 'codex', { until: string | null; resumeInSeconds: number | null }> = {
      claude: { until: null, resumeInSeconds: null }, codex: { until: null, resumeInSeconds: null },
    };
    for (const a of agents) {
      if (a.cooldownUntil) {
        const t = Date.parse(a.cooldownUntil);
        if (!Number.isNaN(t) && t > now) {
          const cur = engineCooldown[a.engine].until ? Date.parse(engineCooldown[a.engine].until!) : 0;
          if (t > cur) engineCooldown[a.engine] = { until: a.cooldownUntil, resumeInSeconds: Math.round((t - now) / 1000) };
        }
      }
    }
    // 엔진 한도 신호(runtime/claude-limit.json) — pm-tick 가 PM output 에서 파싱해 기록한 리셋 시각.
    // 권위 있는 엔진 단위 신호라 위 per-agent 추정보다 우선 적용.
    const claudeLimit = safeReadJson<{ resetAt?: string }>(path.join(DATA_DIR, 'runtime', 'claude-limit.json'));
    if (claudeLimit?.resetAt) {
      const t = Date.parse(claudeLimit.resetAt);
      if (!Number.isNaN(t) && t > now) {
        engineCooldown.claude = { until: claudeLimit.resetAt, resumeInSeconds: Math.round((t - now) / 1000) };
      }
    }
    const agentsWithAvail = agents.map((a) => {
      const ec = engineCooldown[a.engine];
      const available = !ec.until;
      return { ...a, available, availableAt: available ? null : ec.until, availableInSeconds: available ? null : ec.resumeInSeconds };
    });

    const anyCooldown = agentsWithAvail.some((a) => a.resumeInSeconds != null && a.resumeInSeconds > 0);
    const anyRunning = agentsWithAvail.some((a) => a.status === 'running' || a.status === 'waiting');
    const soonestResume = agentsWithAvail
      .filter((a) => a.resumeInSeconds != null && a.resumeInSeconds > 0)
      .sort((a, b) => a.resumeInSeconds! - b.resumeInSeconds!)[0]?.cooldownUntil ?? null;
    // 🅒 모델: launchd pmtick 가 살아있으면(틱 등록) 스케줄 활성. 실행 여부는 에이전트 라이브 상태로.
    let overall: 'running' | 'paused' | 'cooldown' | 'idle';
    if (pauseFlag) overall = 'paused';
    else if (anyCooldown) overall = 'cooldown';
    else if (anyRunning) overall = 'running';
    else overall = 'idle';

    // 사용량 잔여(usage-scan.py 가 기록): claude=예산추정, codex=실측 사용률.
    const usage = safeReadJson(path.join(DATA_DIR, 'runtime', 'usage-consumption.json'));

    return {
      overall, running: anyRunning, paused: pauseFlag, pidAlive, pid,
      loop: loopState, currentRole: loopState?.currentRole ?? null, pass: loopState?.pass ?? null,
      soonestResume, intervalSeconds: 3600,
      engines: {
        claude: { available: !engineCooldown.claude.until, until: engineCooldown.claude.until, resumeInSeconds: engineCooldown.claude.resumeInSeconds },
        codex: { available: !engineCooldown.codex.until, until: engineCooldown.codex.until, resumeInSeconds: engineCooldown.codex.resumeInSeconds },
      },
      usage,
      agents: agentsWithAvail,
    };
  } catch (err) {
    return { error: String(err) };
  }
}

// ---------- 에이전트별 작업 현황 (새 화면용) ----------
const TRIPLAN_ROOT = '/Users/soo/workspace/source-code/triplan';
const ROLE_DOC_PATHS: Record<string, string[]> = {
  pm: ['.claude/memories/consensus.md', '.claude/memories/handoff.md'],
  backend: ['triplan-travel-service/docs', 'soo-auth-service/docs', 'triplan-travel-service/BACKLOG.md'],
  frontend: ['triplan-frontend/docs', 'triplan-frontend/BACKLOG.md'],
  qa: ['triplan-travel-service/docs/qa', 'triplan-frontend/docs/qa', 'docs/qa'],
  security: ['docs/security', 'approvals'],
  ops: ['docs/ops'],
  cost: ['docs/cost'],
  docs: ['docs/adr', 'triplan-frontend/docs/changelog.md', 'docs/changelog.md'],
  'approval-manager': ['approvals'],
};
const ROLE_REPOS: Record<string, string[]> = {
  backend: ['triplan-travel-service', 'soo-auth-service'],
  frontend: ['triplan-frontend'],
  qa: ['triplan-travel-service', 'triplan-frontend'],
  security: ['triplan-travel-service', 'triplan-frontend', 'soo-auth-service'],
  ops: ['triplan-travel-service', 'soo-auth-service'],
  pm: ['triplan-travel-service', 'triplan-frontend', 'soo-auth-service'],
  docs: ['triplan-travel-service', 'triplan-frontend'],
  cost: ['triplan-frontend', 'triplan-travel-service'],
  'approval-manager': [],
};

interface DocEntry { path: string; relPath: string; mtime: string; sizeBytes: number; }

// 역할별 작업 보고서(.claude/reports/<role>/<YYYY-MM-DD>/<HHMMSS>_<slug>.md) 수집.
// agent-reporting 스킬 형식. 사이클 종료 시 각 에이전트가 의무 작성.
function listReports(role: string): DocEntry[] {
  const baseRel = `.claude/reports/${role}`;
  const baseAbs = path.join(TRIPLAN_ROOT, baseRel);
  const out: DocEntry[] = [];
  try {
    if (!fs.existsSync(baseAbs)) return out;
    // 날짜 디렉토리 → 시각_slug 파일 재귀 수집(2단계까지).
    for (const day of fs.readdirSync(baseAbs)) {
      const dayPath = path.join(baseAbs, day);
      try {
        const st = fs.statSync(dayPath);
        if (st.isFile() && day.endsWith('.md')) {
          out.push({ path: dayPath, relPath: path.join(baseRel, day), mtime: st.mtime.toISOString(), sizeBytes: st.size });
          continue;
        }
        if (!st.isDirectory()) continue;
        for (const name of fs.readdirSync(dayPath)) {
          if (!name.endsWith('.md')) continue;
          const full = path.join(dayPath, name);
          try {
            const s = fs.statSync(full);
            if (s.isFile()) out.push({ path: full, relPath: path.join(baseRel, day, name), mtime: s.mtime.toISOString(), sizeBytes: s.size });
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out.slice(0, 10);
}

function listDocs(role: string): DocEntry[] {
  const out: DocEntry[] = [];
  for (const rel of ROLE_DOC_PATHS[role] ?? []) {
    const abs = path.join(TRIPLAN_ROOT, rel);
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) {
        out.push({ path: abs, relPath: rel, mtime: st.mtime.toISOString(), sizeBytes: st.size });
      } else if (st.isDirectory()) {
        for (const name of fs.readdirSync(abs)) {
          const full = path.join(abs, name);
          try {
            const s = fs.statSync(full);
            if (s.isFile() && (name.endsWith('.md') || name.endsWith('.txt'))) {
              out.push({ path: full, relPath: path.join(rel, name), mtime: s.mtime.toISOString(), sizeBytes: s.size });
            }
          } catch { /* ignore */ }
        }
      }
    } catch { /* path not present is ok */ }
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out.slice(0, 12);
}

function recentCommitsForRepo(repo: string, hours = 24): Array<{ sha: string; subject: string; date: string; repo: string }> {
  const repoPath = path.join(TRIPLAN_ROOT, repo);
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    const since = `${hours} hours ago`;
    const out = execSync(`git -C "${repoPath}" log --since="${since}" --pretty=format:"%h%x09%cI%x09%s" -n 30`, { encoding: 'utf-8', timeout: 4000 });
    return out.split('\n').filter(Boolean).map((line) => {
      const [sha, date, ...rest] = line.split('\t');
      return { sha, subject: rest.join('\t'), date, repo };
    });
  } catch { return []; }
}

function getAgentActivity(): unknown {
  try {
    const companies = safeReadJson<{ agentMappings?: { agentId: string; roleId: string; name?: string; engine?: string; subProjectId?: string | null }[] }>(COMPANIES_FILE);
    const mappings = companies?.agentMappings ?? [];

    const agentsRaw = safeReadJson<unknown>(path.join(DATA_DIR, 'agents.json'));
    const arr = Array.isArray(agentsRaw) ? agentsRaw : agentsRaw && typeof agentsRaw === 'object' ? Object.values((agentsRaw as { agents?: unknown }).agents ?? agentsRaw) : [];
    const liveById = new Map<string, { status?: string; lastActivity?: string; currentTask?: string; statusLine?: string; lastCleanOutput?: string; output?: string[]; provider?: string; model?: string }>();
    for (const a of arr as { id?: string; status?: string; lastActivity?: string; currentTask?: string; statusLine?: string; lastCleanOutput?: string; output?: string[]; provider?: string; model?: string }[]) {
      if (a && a.id) liveById.set(a.id, a);
    }

    // 사이클 산출물(handoff) 짧게 — 최상단 5개 사이클 헤더+첫줄.
    const handoffRaw = safeReadFile(path.join(TRIPLAN_ROOT, '.claude/memories/handoff.md')) ?? '';
    const cycles: { header: string; firstLine: string }[] = [];
    const lines = handoffRaw.split('\n');
    for (let i = 0; i < lines.length && cycles.length < 5; i++) {
      if (lines[i].startsWith('## 마지막 사이클') || lines[i].startsWith('## 이전 사이클')) {
        cycles.push({ header: lines[i].replace(/^##\s*/, ''), firstLine: (lines[i + 1] || '').replace(/^-\s*/, '').slice(0, 200) });
      }
    }

    const agents = mappings.map((m) => {
      const live = liveById.get(m.agentId) ?? {};
      const docs = listDocs(m.roleId);
      const reports = listReports(m.roleId);
      const repos = ROLE_REPOS[m.roleId] ?? [];
      const commits: Array<{ sha: string; subject: string; date: string; repo: string }> = [];
      for (const r of repos) commits.push(...recentCommitsForRepo(r, 24));
      commits.sort((a, b) => b.date.localeCompare(a.date));
      const tail = (live.output ?? []).slice(-8).join('\n').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(-1500);
      return {
        agentId: m.agentId,
        roleId: m.roleId,
        name: m.name ?? m.roleId,
        engine: m.engine ?? null,
        subProjectId: m.subProjectId ?? null,
        status: live.status ?? 'unknown',
        lastActivity: live.lastActivity ?? null,
        currentTask: live.currentTask ?? null,
        statusLine: live.statusLine ?? null,
        outputTail: tail,
        recentCommits: commits.slice(0, 6),
        reports,
        docs,
      };
    });

    return { updatedAt: new Date().toISOString(), cycles, agents };
  } catch (err) {
    return { error: String(err) };
  }
}

// 화이트리스트 prefix 안의 텍스트 파일만 읽기 허용(임의 파일 읽기 방지).
const DOC_READ_PREFIXES = [TRIPLAN_ROOT, path.join(process.env.HOME ?? '', '.dorothy'), path.join(process.env.HOME ?? '', '.claude/memories')];
function readDoc(input: { path?: string }): { content?: string; error?: string; bytes?: number } {
  const p = input?.path;
  if (!p || typeof p !== 'string') return { error: 'path required' };
  const normalized = path.resolve(p);
  const ok = DOC_READ_PREFIXES.some((pre) => normalized.startsWith(path.resolve(pre) + path.sep) || normalized === path.resolve(pre));
  if (!ok) return { error: '허용되지 않은 경로' };
  try {
    const st = fs.statSync(normalized);
    if (!st.isFile()) return { error: '파일이 아님' };
    if (st.size > 256 * 1024) {
      const buf = fs.readFileSync(normalized, 'utf-8');
      return { content: buf.slice(0, 256 * 1024) + '\n\n... (256KB 초과, 잘림)', bytes: st.size };
    }
    return { content: fs.readFileSync(normalized, 'utf-8'), bytes: st.size };
  } catch (err) {
    return { error: String(err) };
  }
}

export function registerDorothyHandlers(): void {
  ipcMain.handle('dorothy:companies:get', async () => getCompanies());
  ipcMain.handle('dorothy:companies:mutate', async (_e, body: MutateBody) => mutateCompanies(body ?? {}));
  ipcMain.handle('dorothy:autoCompany:get', async () => getAutoCompany());
  ipcMain.handle('dorothy:approvals:get', async () => getApprovals());
  ipcMain.handle('dorothy:harness:get', async () => getHarness());
  ipcMain.handle('dorothy:autoCompany:control', async (_e, body: { action?: string }) =>
    autoCompanyControl(body?.action ?? ''),
  );
  ipcMain.handle('dorothy:teamLoop:get', async () => getTeamLoop());
  ipcMain.handle('dorothy:agentActivity:get', async () => getAgentActivity());
  ipcMain.handle('dorothy:doc:read', async (_e, body: { path?: string }) => readDoc(body ?? {}));
  ipcMain.handle('dorothy:skill:link', async (_e, body: { action?: 'link' | 'unlink'; slug?: string }) => skillLink(body ?? {}));
}
