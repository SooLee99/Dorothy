import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { generateKanbanPreview } from '@/lib/projectIsolation';
import { ALL_OPERATION_AGENT_IDS } from '@/lib/agentProcessDisplay';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KANBAN_FILE = path.join(os.homedir(), '.dorothy', 'kanban-tasks.json');
// Phase 6-AY — 스캐폴드 쓰기 허용 루트(이 밖으로는 절대 생성하지 않음).
const APPS_ROOT = '/Users/soo/workspace/source-code/apps';

/**
 * Phase 6-AK — App Factory Project Capsules store (preview/plan only).
 *
 * SAFETY: this route stores ONLY capsule definition records to
 * ~/.dorothy/project-capsules.json. It NEVER creates directories, installs
 * packages, generates code, or materializes Kanban tasks (that is the later
 * confirmed phase 6-AL). No secrets are stored.
 */

const FILE = path.join(os.homedir(), '.dorothy', 'project-capsules.json');

function readCapsules(): Record<string, unknown>[] {
  try {
    if (!fs.existsSync(FILE)) return [];
    const v = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeCapsules(list: Record<string, unknown>[]) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}

const SETTINGS_FILE = path.join(os.homedir(), '.dorothy', 'app-settings.json');
function readSettings(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')); } catch { return {}; }
}

// Phase 6-BA — App Factory 전용 GitHub 계정(현재 gh 와 다른 계정). 토큰은 write-only(노출 금지).
const INTEGRATION_FILE = path.join(os.homedir(), '.dorothy', 'integration-settings.json');
interface AppFactoryGithub { owner?: string; email?: string; token?: string }
function readIntegration(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(INTEGRATION_FILE, 'utf-8')); } catch { return {}; }
}
function readGithubAccount(): AppFactoryGithub {
  const v = readIntegration().appFactoryGithub;
  return (v && typeof v === 'object') ? v as AppFactoryGithub : {};
}

export async function GET() {
  const gh = readGithubAccount();
  return NextResponse.json({
    capsules: readCapsules(),
    autoRun: readSettings().dorothyAppProjectAutoRun === true,
    // 토큰 값은 절대 반환하지 않음 — 설정 여부만.
    githubAccount: { owner: gh.owner ?? null, email: gh.email ?? null, configured: !!gh.token },
  });
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = body.action as string;
  const list = readCapsules();

  if (action === 'create') {
    const capsule = body.capsule as Record<string, unknown> | undefined;
    if (!capsule || typeof capsule.projectId !== 'string' || !capsule.projectId) {
      return NextResponse.json({ ok: false, error: 'projectId를 입력하세요.' }, { status: 400 });
    }
    if (typeof capsule.projectName !== 'string' || !capsule.projectName.trim()) {
      return NextResponse.json({ ok: false, error: '프로젝트 이름을 입력하세요.' }, { status: 400 });
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(capsule.projectId)) {
      return NextResponse.json({ ok: false, error: 'projectId는 영문 소문자, 숫자, 하이픈만 사용할 수 있습니다.' }, { status: 400 });
    }
    // duplicate projectId prevention
    if (list.some(c => c.projectId === capsule.projectId)) {
      return NextResponse.json({ ok: false, error: `이미 존재하는 projectId입니다: ${capsule.projectId}`, capsules: list }, { status: 409 });
    }
    // SAFETY: secret 류 키는 절대 저장하지 않음(apiKeyRequired boolean 은 별도 보존).
    const SECRET = /token|secret|api[_-]?key|password|bearer|private_key|access_token|client_secret/i;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(capsule)) {
      if (k === 'apiKeyRequired') continue; // 아래에서 boolean 으로만 보존
      if (SECRET.test(k)) continue;
      clean[k] = v;
    }
    if (typeof capsule.apiKeyRequired === 'boolean') clean.apiKeyRequired = capsule.apiKeyRequired;
    list.push(clean);
    writeCapsules(list);
    return NextResponse.json({ ok: true, capsules: list });
  }

  if (action === 'updateStatus') {
    const id = body.id as string;
    const status = body.status as string;
    const valid = ['draft', 'ready', 'active', 'paused', 'completed', 'blocked'];
    if (!id || !valid.includes(status)) {
      return NextResponse.json({ ok: false, error: 'id + valid status required' }, { status: 400 });
    }
    const cap = list.find(c => c.id === id);
    if (!cap) return NextResponse.json({ ok: false, error: 'capsule not found' }, { status: 404 });
    cap.status = status;
    cap.updatedAt = new Date().toISOString();
    writeCapsules(list);
    return NextResponse.json({ ok: true, capsules: list });
  }

  // Phase 6-AN — 비-secret 필드 편집(이름/포트/경로/scope/pm 등). projectId 변경은
  // 다른 캡슐과 충돌하지 않을 때만 허용. secret 류 키는 무시.
  if (action === 'update') {
    const id = body.id as string;
    const patch = (body.patch ?? {}) as Record<string, unknown>;
    const cap = list.find(c => c.id === id);
    if (!cap) return NextResponse.json({ ok: false, error: 'capsule not found' }, { status: 404 });
    const SECRET = /token|secret|api[_-]?key|password|bearer|private_key|access_token/i;
    const EDITABLE = new Set(['projectName', 'companyName', 'status', 'rootPath', 'frontendPath', 'backendPath',
      'packageManager', 'frontendPort', 'backendPort', 'techStack', 'mvpScope', 'outOfScope', 'riskPolicy',
      'dataSourceNotes', 'executionChecklist',
      'description', 'appType', 'targetUsers', 'coreProblem', 'apiKeyRequired', 'frontendRepoUrl',
      'envNamespace', 'vaultNamespace', 'kanbanProjectId', 'projectId']);
    if (typeof patch.projectId === 'string' && patch.projectId !== cap.projectId
        && list.some(c => c.id !== id && c.projectId === patch.projectId)) {
      return NextResponse.json({ ok: false, error: `projectId 중복: ${patch.projectId}` }, { status: 409 });
    }
    for (const [k, v] of Object.entries(patch)) {
      if (SECRET.test(k) || !EDITABLE.has(k)) continue;
      (cap as Record<string, unknown>)[k] = v;
    }
    cap.updatedAt = new Date().toISOString();
    writeCapsules(list);
    return NextResponse.json({ ok: true, capsules: list });
  }

  // Phase 6-AN — 캡슐 정의 삭제(계획 카드만 제거 — 실제 디렉터리/코드/Kanban 미접촉).
  if (action === 'delete') {
    const id = body.id as string;
    const next = list.filter(c => c.id !== id);
    if (next.length === list.length) return NextResponse.json({ ok: false, error: 'capsule not found' }, { status: 404 });
    writeCapsules(next);
    return NextResponse.json({ ok: true, capsules: next });
  }

  // Phase 6-AN — Kanban Materialization (confirm-gate). confirm!==true 면 dry-run.
  if (action === 'materializeKanbanPreview') {
    const capsuleId = body.capsuleId as string;
    const confirm = body.confirm === true;
    const cap = list.find(c => c.id === capsuleId) as Record<string, unknown> | undefined;
    if (!cap) return NextResponse.json({ ok: false, error: 'capsule not found' }, { status: 404 });
    const projectId = String(cap.projectId);
    const kanbanProjectId = String(cap.kanbanProjectId || projectId);
    const preview = generateKanbanPreview({ projectId, kanbanProjectId });
    // ownerAgentId 는 11 기준선만 허용
    const baseline = new Set(ALL_OPERATION_AGENT_IDS as readonly string[]);
    for (const t of preview) {
      if (!baseline.has(t.ownerAgentId)) {
        return NextResponse.json({ ok: false, error: `non-baseline owner: ${t.ownerAgentId}` }, { status: 400 });
      }
    }
    // 결정적 id(중복 방지): mat-<projectId>-<order>
    const planned = preview.map(t => ({ ...t, taskId: `mat-${projectId}-${t.order}` }));

    if (!confirm) {
      // dry-run: Kanban 파일 미변경
      return NextResponse.json({ ok: true, dryRun: true, wouldCreate: planned.length, tasks: planned });
    }

    // confirm=true → 실제 생성(기존 task 삭제 없음, idempotent)
    let existing: Record<string, unknown>[] = [];
    try { const raw = JSON.parse(fs.readFileSync(KANBAN_FILE, 'utf-8')); existing = Array.isArray(raw) ? raw : (raw.tasks ?? []); } catch { existing = []; }
    const have = new Set(existing.map(t => t.id));
    const now = new Date().toISOString();
    let created = 0;
    for (const t of planned) {
      if (have.has(t.taskId)) continue; // idempotent
      existing.push({
        id: t.taskId, title: `[${projectId}] ${t.title}`, description: t.description,
        projectPath: String(cap.rootPath || ''), projectId, kanbanProjectId,
        requiredSkills: [], labels: t.requiresApproval ? ['approval-required'] : [],
        priority: t.riskLevel === 'high' ? 'high' : t.riskLevel === 'medium' ? 'medium' : 'low',
        column: 'backlog', assignedAgentId: t.ownerAgentId, progress: 0,
        createdAt: now, updatedAt: now, order: t.order,
      });
      created++;
    }
    try { fs.writeFileSync(KANBAN_FILE, JSON.stringify(existing, null, 2)); }
    catch (err) { return NextResponse.json({ ok: false, error: String(err) }, { status: 500 }); }
    // capsule status → active
    cap.status = 'active'; cap.updatedAt = now; writeCapsules(list);
    return NextResponse.json({ ok: true, dryRun: false, created, total: planned.length });
  }

  // Phase 6-BA — App Factory GitHub 계정 저장(다른 계정). 토큰은 mode 0600, 응답에 미반환.
  if (action === 'setGithubAccount') {
    const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (owner && !/^[\w-]+$/.test(owner)) return NextResponse.json({ ok: false, error: 'owner는 GitHub 사용자명 형식이어야 합니다' }, { status: 400 });
    const integ = readIntegration();
    const prev = (integ.appFactoryGithub && typeof integ.appFactoryGithub === 'object') ? integ.appFactoryGithub as AppFactoryGithub : {};
    const next: AppFactoryGithub = {
      owner: owner || prev.owner,
      email: email || prev.email,
      token: token || prev.token, // 빈 값이면 기존 토큰 유지(덮어쓰지 않음)
    };
    integ.appFactoryGithub = next;
    fs.writeFileSync(INTEGRATION_FILE, JSON.stringify(integ, null, 2), { mode: 0o600 });
    try { fs.chmodSync(INTEGRATION_FILE, 0o600); } catch { /* ignore */ }
    return NextResponse.json({ ok: true, owner: next.owner ?? null, email: next.email ?? null, configured: !!next.token });
  }
  if (action === 'clearGithubToken') {
    const integ = readIntegration();
    const prev = (integ.appFactoryGithub && typeof integ.appFactoryGithub === 'object') ? integ.appFactoryGithub as AppFactoryGithub : {};
    integ.appFactoryGithub = { owner: prev.owner, email: prev.email };
    fs.writeFileSync(INTEGRATION_FILE, JSON.stringify(integ, null, 2), { mode: 0o600 });
    return NextResponse.json({ ok: true, configured: false });
  }

  // Phase 6-AZ — 프로젝트별 자율 실행 on/off(설정만 변경, 비파괴적).
  if (action === 'setAutoRun') {
    if (typeof body.value !== 'boolean') return NextResponse.json({ ok: false, error: 'value:boolean 필요' }, { status: 400 });
    const s = readSettings();
    s.dorothyAppProjectAutoRun = body.value;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
    return NextResponse.json({ ok: true, autoRun: body.value });
  }

  // Phase 6-AY — 실제 스캐폴드(디렉터리 생성 + git init + Figma 레포 clone). confirm 게이트.
  //  SAFETY: 쓰기는 APPS_ROOT 하위로만, 경로 이탈 거부, injection 방지(execFileSync 인자배열),
  //  push/commit 안 함(init+clone만), confirm!==true 면 dry-run.
  if (action === 'scaffold') {
    const capsuleId = body.capsuleId as string;
    const confirm = body.confirm === true;
    const cap = list.find(c => c.id === capsuleId) as Record<string, unknown> | undefined;
    if (!cap) return NextResponse.json({ ok: false, error: 'capsule not found' }, { status: 404 });
    const root = String(cap.rootPath || '');
    const norm = path.resolve(root);
    if (norm !== APPS_ROOT && !norm.startsWith(APPS_ROOT + path.sep)) {
      return NextResponse.json({ ok: false, error: `rootPath가 허용 루트(${APPS_ROOT}) 밖 — 거부: ${root}` }, { status: 400 });
    }
    const repoUrl = typeof cap.frontendRepoUrl === 'string' ? cap.frontendRepoUrl.trim() : '';
    const repoOk = !repoUrl || /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?\/?$/.test(repoUrl);
    if (repoUrl && !repoOk) return NextResponse.json({ ok: false, error: 'frontendRepoUrl은 https://github.com/owner/repo 형식이어야 합니다' }, { status: 400 });

    const plan = {
      create: [norm, path.join(norm, 'frontend'), path.join(norm, 'backend')],
      files: ['README.md', '.gitignore', 'CLAUDE.md'],
      gitInit: true,
      cloneFrontend: repoUrl || null,
      alreadyExists: fs.existsSync(norm),
    };
    if (!confirm) return NextResponse.json({ ok: true, dryRun: true, plan });

    const steps: string[] = [];
    try {
      for (const d of plan.create) { fs.mkdirSync(d, { recursive: true }); }
      steps.push('디렉터리 생성');
      const pid = String(cap.projectId);
      if (!fs.existsSync(path.join(norm, 'README.md')))
        fs.writeFileSync(path.join(norm, 'README.md'), `# ${cap.projectName}\n\n${cap.description || ''}\n\n- projectId: ${pid}\n- 기술스택: ${(cap.techStack as string[] | undefined)?.join(', ') || ''}\n- 독립 실행: 포트 ${cap.frontendPort}/${cap.backendPort}\n`);
      if (!fs.existsSync(path.join(norm, '.gitignore')))
        fs.writeFileSync(path.join(norm, '.gitignore'), 'node_modules/\n.gradle/\nbuild/\n.env\n.env.local\n*.log\n.DS_Store\n');
      if (!fs.existsSync(path.join(norm, 'CLAUDE.md')))
        fs.writeFileSync(path.join(norm, 'CLAUDE.md'), `# ${cap.projectName} — 프로젝트 가이드\n\n독립 App Factory 프로젝트(projectId=${pid}). triplan과 동일 기술스택, 별도 경로/포트/kanban.\n\n## 워크플로우\n오케스트레이터가 칸반(projectId=${pid}) 작업을 요구정리→설계→구현→QA→운영 순으로 진행합니다.\n`);
      steps.push('기본 파일 생성');

      const gh = readGithubAccount(); // App Factory 전용 계정(다른 계정). 토큰 노출 금지.
      execFileSync('git', ['init'], { cwd: norm, stdio: 'ignore' });
      if (gh.owner) execFileSync('git', ['config', 'user.name', gh.owner], { cwd: norm, stdio: 'ignore' });
      if (gh.email) execFileSync('git', ['config', 'user.email', gh.email], { cwd: norm, stdio: 'ignore' });
      steps.push('git init' + (gh.owner ? ` (커밋 계정: ${gh.owner})` : ''));

      // Phase 6-BD — Claude Code 폴더 트러스트 사전 등록(새 폴더 "신뢰?" 프롬프트가 자율 진행을 막지 않게).
      try {
        const cf = path.join(os.homedir(), '.claude.json');
        const cj = JSON.parse(fs.readFileSync(cf, 'utf-8')) as { projects?: Record<string, { allowedTools?: string[]; hasTrustDialogAccepted?: boolean }> };
        cj.projects = cj.projects || {};
        for (const p of [norm, path.join(norm, 'frontend'), path.join(norm, 'backend')]) {
          cj.projects[p] = { ...(cj.projects[p] || {}), allowedTools: cj.projects[p]?.allowedTools || [], hasTrustDialogAccepted: true };
        }
        fs.writeFileSync(cf, JSON.stringify(cj, null, 2));
        steps.push('폴더 트러스트 사전등록');
      } catch { /* .claude.json 없거나 파싱불가 시 skip */ }

      let cloneResult = 'skip';
      if (repoUrl) {
        const dest = path.join(norm, 'frontend-src');
        if (fs.existsSync(dest)) { cloneResult = '이미 clone됨(skip)'; }
        else {
          // 다른 계정 비공개 레포 대비: 토큰이 있으면 인증 URL로 clone(토큰은 로그/응답에 절대 미포함),
          // clone 후 origin 을 토큰 없는 URL로 재설정해 .git/config 에 토큰이 남지 않게 한다.
          const cloneUrl = gh.token ? repoUrl.replace('https://github.com/', `https://${gh.token}@github.com/`) : repoUrl;
          execFileSync('git', ['clone', '--depth', '1', cloneUrl, dest], { cwd: norm, stdio: 'ignore', timeout: 120000 });
          if (gh.token) { try { execFileSync('git', ['-C', dest, 'remote', 'set-url', 'origin', repoUrl], { stdio: 'ignore' }); } catch { /* ignore */ } }
          cloneResult = 'clone 완료 → frontend-src';
        }
        steps.push(`frontend 레포 ${cloneResult}`);
      }
      cap.status = 'active';
      (cap as Record<string, unknown>).scaffoldedAt = new Date().toISOString();
      cap.updatedAt = new Date().toISOString();
      writeCapsules(list);
      return NextResponse.json({ ok: true, scaffolded: true, root: norm, steps, cloneFrontend: cloneResult });
    } catch (e) {
      return NextResponse.json({ ok: false, error: `스캐폴드 실패: ${e instanceof Error ? e.message : String(e)}`, steps }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
}
