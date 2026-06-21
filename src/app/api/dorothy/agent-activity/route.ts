import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { resolveProjectRoot } from '@/lib/projectPaths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 에이전트별 작업 현황 + 산출물(문서·커밋) 집계. IPC handler 와 동일 로직(dev 패리티).

// 하드코딩 제거 ② — 경로를 companies.json 에서 읽음(literal 은 read 실패 시 폴백만).
const TRIPLAN_ROOT = resolveProjectRoot('triplan') ?? '/Users/soo/workspace/source-code/triplan';
const BUEONGI_ROOT = resolveProjectRoot('bueongi') ?? '/Users/soo/workspace/source-code/apps/bueongi';
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

// Phase 6-AX — 현재 11개 기준선 에이전트(슬러그). 구 companies.json 매핑(pm/docs/ops/cost…)은
// 폐기 모델이라 더 이상 쓰지 않고, agents.json·라이브 스냅샷과 동일한 슬러그로 구성한다.
const BASELINE_AGENTS: { roleId: string; name: string; repos: string[]; reportDirs: string[] }[] = [
  { roleId: 'intake-planner', name: '요구 정리 (Intake)', repos: [], reportDirs: ['intake-planner'] },
  { roleId: 'architect-plan', name: '아키텍트 (설계)', repos: ['triplan-travel-service', 'triplan-frontend'], reportDirs: ['architect-plan'] },
  { roleId: 'plan-validator', name: '계획 검증', repos: [], reportDirs: ['plan-validator'] },
  { roleId: 'contract-agent', name: 'API 계약', repos: ['triplan-travel-service', 'triplan-frontend'], reportDirs: ['contract-agent'] },
  { roleId: 'database-agent', name: '데이터 모델', repos: ['triplan-travel-service'], reportDirs: ['database-agent'] },
  { roleId: 'backend', name: '백엔드 개발자', repos: ['triplan-travel-service', 'soo-auth-service'], reportDirs: ['backend'] },
  { roleId: 'frontend', name: '프론트엔드 개발자', repos: ['triplan-frontend'], reportDirs: ['frontend'] },
  { roleId: 'qa-reviewer', name: 'QA 리뷰어', repos: ['triplan-travel-service', 'triplan-frontend'], reportDirs: ['qa-reviewer', 'qa'] },
  { roleId: 'security-reviewer', name: '보안 리뷰어', repos: ['triplan-travel-service', 'triplan-frontend', 'soo-auth-service'], reportDirs: ['security-reviewer', 'security'] },
  { roleId: 'devops-reporter', name: '데브옵스 / 리포터', repos: ['triplan-travel-service', 'soo-auth-service'], reportDirs: ['devops-reporter', 'devops', 'ops'] },
  { roleId: 'orchestrator', name: '오케스트레이터 (조율)', repos: ['triplan-travel-service', 'triplan-frontend', 'soo-auth-service'], reportDirs: ['orchestrator'] },
];

// 정합성 C2-b — bueongi 전용 에이전트(이전엔 triplan BASELINE 하드코딩이라 화면에서 누락).
//   roleId 는 agents.json 의 라이브 id(bueongi-backend/bueongi-dev)와 일치시켜 상태 오버레이가 붙게.
//   ★canonical agentMappings 가 qa/qa-reviewer 등 의미중복이라 단순 순회가 불가 → 프로젝트별
//   canonical 정의를 명시(이게 단일 소스). cron 8개는 hermes 별 시스템이라 미포함(별도 통합).
const BUEONGI_AGENTS: { roleId: string; name: string; repos: string[]; reportDirs: string[] }[] = [
  { roleId: 'bueongi-backend', name: '백엔드 개발자 (부엉이)', repos: ['backend'], reportDirs: ['bueongi-backend', 'backend'] },
  { roleId: 'bueongi-dev', name: '프론트엔드 개발자 (부엉이)', repos: ['frontend-src'], reportDirs: ['bueongi-dev', 'frontend'] },
];

// 프로젝트별 canonical 에이전트 세트(하드코딩 단일 BASELINE → 프로젝트 순회). 각 프로젝트의
// root/agents/docPaths 를 명시. triplan 은 기존 상세 매핑 그대로(회귀 0), bueongi 추가.
const PROJECTS: { projectId: string; root: string; agents: typeof BASELINE_AGENTS; docPaths: Record<string, string[]> }[] = [
  { projectId: 'triplan', root: TRIPLAN_ROOT, agents: BASELINE_AGENTS, docPaths: ROLE_DOC_PATHS },
  { projectId: 'bueongi', root: BUEONGI_ROOT, agents: BUEONGI_AGENTS, docPaths: {} },
];

function safeReadJson<T = unknown>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return null; }
}
function safeReadFile(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

interface DocEntry { path: string; relPath: string; mtime: string; sizeBytes: number; }

function listReports(role: string, root: string): DocEntry[] {
  const baseRel = `.claude/reports/${role}`;
  const baseAbs = path.join(root, baseRel);
  const out: DocEntry[] = [];
  try {
    if (!fs.existsSync(baseAbs)) return out;
    for (const day of fs.readdirSync(baseAbs)) {
      const dayPath = path.join(baseAbs, day);
      try {
        const st = fs.statSync(dayPath);
        if (st.isFile() && day.endsWith('.md')) {
          out.push({ path: dayPath, relPath: path.join(baseRel, day), mtime: st.mtime.toISOString(), sizeBytes: st.size }); continue;
        }
        if (!st.isDirectory()) continue;
        for (const name of fs.readdirSync(dayPath)) {
          if (!name.endsWith('.md')) continue;
          const full = path.join(dayPath, name);
          try { const s = fs.statSync(full); if (s.isFile()) out.push({ path: full, relPath: path.join(baseRel, day, name), mtime: s.mtime.toISOString(), sizeBytes: s.size }); } catch { /* */ }
        }
      } catch { /* */ }
    }
  } catch { /* */ }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out.slice(0, 10);
}

function listDocs(role: string, root: string, docPaths: Record<string, string[]>): DocEntry[] {
  const out: DocEntry[] = [];
  for (const rel of docPaths[role] ?? []) {
    const abs = path.join(root, rel);
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) out.push({ path: abs, relPath: rel, mtime: st.mtime.toISOString(), sizeBytes: st.size });
      else if (st.isDirectory()) {
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
    } catch { /* ignore */ }
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out.slice(0, 12);
}

function recentCommits(repo: string, root: string, hours = 24) {
  const repoPath = path.join(root, repo);
  try {
    const out = execSync(`git -C "${repoPath}" log --since="${hours} hours ago" --pretty=format:"%h%x09%cI%x09%s" -n 30`, { encoding: 'utf-8', timeout: 4000 });
    return out.split('\n').filter(Boolean).map((line) => {
      const [sha, date, ...rest] = line.split('\t');
      return { sha, subject: rest.join('\t'), date, repo };
    });
  } catch { return []; }
}

export async function GET() {
  try {
    const home = os.homedir();
    const agentsRaw = safeReadJson<unknown>(path.join(home, '.dorothy', 'agents.json'));
    const arr = Array.isArray(agentsRaw) ? agentsRaw : agentsRaw && typeof agentsRaw === 'object' ? Object.values((agentsRaw as { agents?: unknown }).agents ?? agentsRaw) : [];
    const liveById = new Map<string, { status?: string; lastActivity?: string; currentTask?: string; statusLine?: string; output?: string[]; provider?: string }>();
    for (const a of arr as { id?: string; status?: string; lastActivity?: string; currentTask?: string; statusLine?: string; output?: string[]; provider?: string }[]) {
      if (a && a.id) liveById.set(a.id, a);
    }

    // Phase 6-BF — handoff.md 의 사이클 헤더는 현재 `## [날짜 자동틱 #N] ...` 형식.
    // 옛 `## 마지막/이전 사이클` 만 찾던 파서가 최신 틱을 못 잡아 실행기록이 stale 였음 → 두 형식 모두 인식.
    const handoffRaw = safeReadFile(path.join(TRIPLAN_ROOT, '.claude/memories/handoff.md')) ?? '';
    const cycles: { header: string; firstLine: string }[] = [];
    const lines = handoffRaw.split('\n');
    for (let i = 0; i < lines.length && cycles.length < 6; i++) {
      const ln = lines[i];
      if (ln.startsWith('## [') || ln.startsWith('## 마지막 사이클') || ln.startsWith('## 이전 사이클')) {
        // 헤더 다음의 첫 비어있지 않은 라인을 요약으로
        let summary = '';
        for (let k = i + 1; k < lines.length && k < i + 4; k++) {
          const t = (lines[k] || '').trim();
          if (t) { summary = t.replace(/^[-*]\s*/, '').slice(0, 200); break; }
        }
        cycles.push({ header: ln.replace(/^##\s*/, '').slice(0, 120), firstLine: summary });
      }
    }

    // Phase 6-AX — 라이브 상태 오버레이: 디스크 agents.json 은 저장 시 running→idle 로
    // 리셋되어 stale 하므로, electron(:31415) 의 실시간 터미널 스냅샷(role slug 키)으로 덮어쓴다.
    const liveSnapByRole = new Map<string, { status?: string; currentTask?: string; outputPreview?: string; lastActivity?: string }>();
    try {
      const token = safeReadFile(path.join(home, '.dorothy', 'api-token'))?.trim();
      if (token) {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch('http://127.0.0.1:31415/api/agents/terminal-snapshots', {
          headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: ctrl.signal,
        }).finally(() => clearTimeout(to));
        if (res.ok) {
          const j = await res.json();
          const snaps = (Array.isArray(j) ? j : (j.snapshots ?? j.agents ?? [])) as { agentId?: string; status?: string; currentTask?: string; outputPreview?: string; lastActivity?: string }[];
          for (const sn of snaps) { if (sn.agentId) liveSnapByRole.set(sn.agentId, sn); }
        }
      }
    } catch { /* electron 미응답 시 디스크 값으로 폴백 */ }

    // C2-b — 프로젝트(triplan·bueongi) 순회로 에이전트 집계(이전엔 triplan BASELINE 단일).
    const agents = PROJECTS.flatMap((proj) => proj.agents.map((m) => {
      const live = liveById.get(m.roleId) ?? {};
      const snap = liveSnapByRole.get(m.roleId) ?? {};
      const docs = listDocs(m.roleId, proj.root, proj.docPaths);
      const reports = m.reportDirs.flatMap(d => listReports(d, proj.root));
      const commits: Array<{ sha: string; subject: string; date: string; repo: string }> = [];
      for (const r of m.repos) commits.push(...recentCommits(r, proj.root, 24));
      commits.sort((a, b) => b.date.localeCompare(a.date));
      const diskTail = (live.output ?? []).slice(-8).join('\n').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(-1500);
      const tail = (snap.outputPreview ? snap.outputPreview.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(-1500) : diskTail);
      const provider = live.provider as string | undefined;
      return {
        agentId: m.roleId, roleId: m.roleId, name: m.name, projectId: proj.projectId,
        engine: provider === 'claude' ? 'claude' : provider === 'codex' ? 'codex' : null,
        subProjectId: null,
        status: snap.status ?? live.status ?? 'unknown',
        lastActivity: snap.lastActivity ?? live.lastActivity ?? null,
        currentTask: snap.currentTask ?? live.currentTask ?? null,
        statusLine: live.statusLine ?? null,
        outputTail: tail, recentCommits: commits.slice(0, 6), reports, docs,
      };
    }));

    return NextResponse.json({ updatedAt: new Date().toISOString(), cycles, agents });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
