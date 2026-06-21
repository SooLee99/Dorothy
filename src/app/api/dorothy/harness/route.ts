import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolveProjectRoot, allProjectRoots } from '@/lib/projectPaths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 정합성 C3-a — 하네스(에이전트 .md + 스킬 카탈로그 + teamGraph).
 *
 * ★Electron 핸들러(dorothy-handlers.ts getHarness)와 ★동일 스키마로 맞춤(이전엔 빈약한 복제라
 * 브라우저에서 filter/비교 항상 0·bueongi 안 보임). skill 에 slug/source/linked/linkedKind/
 * referencedBy 포함 → 필터·비교 복구. 에이전트는 companies.json 프로젝트 순회 → bueongi 포함.
 * 경로는 resolveProjectRoot(companies.json)에서 — 하드코딩 제거 ②.
 */
const AUTO_COMPANY_SKILLS_DIR = '/Users/soo/ai-company-stack/Auto-Company/.claude/skills';

interface AgentEntry { file: string; name: string | null; description: string | null; projectId: string }
interface SkillEntry {
  file: string; slug: string; name: string | null; description: string | null;
  source: 'triplan' | 'auto-company';
  linked: boolean; linkedKind: 'real' | 'symlink' | null; triplanPath: string | null; referencedBy: string[];
}

function safeRead(file: string): string | null {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
}
function frontmatterField(raw: string | null, field: string): string | null {
  if (!raw) return null;
  const fm = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const block = fm ? fm[1] : raw;
  const m = block.match(new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm'));
  if (!m) return null;
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

function scanSkillsDir(dir: string, source: 'triplan' | 'auto-company'): SkillEntry[] {
  const out: SkillEntry[] = [];
  try {
    if (!fs.existsSync(dir)) return out;
    for (const dirent of fs.readdirSync(dir)) {
      const direntPath = path.join(dir, dirent);
      let file = path.join(direntPath, 'SKILL.md');
      let slug = dirent;
      if (!fs.existsSync(file)) {
        if (dirent.endsWith('.md')) { file = direntPath; slug = dirent.replace(/\.md$/, ''); }
        else continue;
      }
      const raw = safeRead(file);
      out.push({
        file, slug, source,
        name: frontmatterField(raw, 'name'), description: frontmatterField(raw, 'description'),
        linked: false, linkedKind: null, triplanPath: null, referencedBy: [],
      });
    }
  } catch { /* */ }
  return out;
}

export async function GET() {
  try {
    // 에이전트: 모든 프로젝트(companies.json) 의 <root>/.claude/agents/*.md → bueongi 포함.
    const agents: AgentEntry[] = [];
    for (const { projectId, root } of allProjectRoots()) {
      const agentsDir = path.join(root, '.claude', 'agents');
      try {
        if (fs.existsSync(agentsDir)) {
          for (const f of fs.readdirSync(agentsDir)) {
            if (!f.endsWith('.md')) continue;
            const file = path.join(agentsDir, f);
            const raw = safeRead(file);
            agents.push({ file, name: frontmatterField(raw, 'name'), description: frontmatterField(raw, 'description'), projectId });
          }
        }
      } catch { /* */ }
    }

    // 스킬: triplan(.claude/skills) + auto-company. linked/referencedBy 로 필터·비교 복구.
    const triplanRoot = resolveProjectRoot('triplan') ?? '/Users/soo/workspace/source-code/triplan';
    const triplanSkillsDir = path.join(triplanRoot, '.claude', 'skills');
    const triplanSkills = scanSkillsDir(triplanSkillsDir, 'triplan');
    const acSkills = scanSkillsDir(AUTO_COMPANY_SKILLS_DIR, 'auto-company');

    const triplanSlugs = new Set(triplanSkills.map((s) => s.slug));
    for (const ac of acSkills) {
      if (triplanSlugs.has(ac.slug)) {
        const triplanPath = path.join(triplanSkillsDir, ac.slug);
        try {
          const lst = fs.lstatSync(triplanPath);
          ac.linked = true; ac.linkedKind = lst.isSymbolicLink() ? 'symlink' : 'real'; ac.triplanPath = triplanPath;
        } catch { /* */ }
      }
    }
    for (const t of triplanSkills) {
      t.linked = true;
      const fullPath = path.join(triplanSkillsDir, t.slug);
      try { const lst = fs.lstatSync(fullPath); t.linkedKind = lst.isSymbolicLink() ? 'symlink' : 'real'; t.triplanPath = fullPath; }
      catch { t.linkedKind = 'real'; t.triplanPath = fullPath; }
    }

    // referencedBy: 에이전트 .md 가 스킬 슬러그/이름을 언급?
    try {
      for (const a of agents) {
        const raw = safeRead(a.file) ?? '';
        const roleId = frontmatterField(raw, 'name') ?? path.basename(a.file, '.md');
        for (const s of [...triplanSkills, ...acSkills]) {
          if (s.name && raw.includes(`/${s.name}`)) { if (!s.referencedBy.includes(roleId)) s.referencedBy.push(roleId); }
          else if (raw.includes(`/${s.slug}/`) || raw.includes(`skills/${s.slug}`)) { if (!s.referencedBy.includes(roleId)) s.referencedBy.push(roleId); }
        }
      }
    } catch { /* */ }

    const tripBySlug = new Set(triplanSkills.map((s) => s.slug));
    const skills: SkillEntry[] = [...triplanSkills];
    for (const ac of acSkills) if (!tripBySlug.has(ac.slug)) skills.push(ac);
    skills.sort((a, b) => (a.linked === b.linked ? a.slug.localeCompare(b.slug) : a.linked ? -1 : 1));

    let teamGraph: unknown = null;
    try {
      const companiesFile = path.join(os.homedir(), '.dorothy', 'companies.json');
      if (fs.existsSync(companiesFile)) teamGraph = JSON.parse(fs.readFileSync(companiesFile, 'utf-8'))?.teamGraph ?? null;
    } catch { /* */ }

    return NextResponse.json({ agents, skills, teamGraph });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
