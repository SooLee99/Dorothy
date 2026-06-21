import { NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 3600; // ISR: revalidate every hour

interface RawSkill {
  source: string;
  skillId: string;
  name: string;
  installs: number;
}

function formatInstalls(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

let cache: { data: unknown; ts: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * 실패 시 폴백 — ★하드코딩 샘플(과거 SKILLS_DATABASE) 대신 실제 로컬 데이터.
 * Hermes 가 설치한 진짜 스킬(105+)을 `~/.hermes/.skills_prompt_snapshot.json`
 * 에서 읽어 마켓플레이스 Skill 형태로 매핑한다. skills.sh 가 죽거나 HTML 이
 * 바뀌어도 "가짜"가 아닌 실제 설치 스킬을 보여준다.
 */
function localHermesSkills(): { skills: unknown[]; source: string; fetchedAt: string } | null {
  try {
    const file = path.join(os.homedir(), '.hermes', '.skills_prompt_snapshot.json');
    const snap = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      skills?: Array<{
        skill_name?: string;
        frontmatter_name?: string;
        category?: string;
        description?: string;
      }>;
    };
    const list = Array.isArray(snap.skills) ? snap.skills : [];
    if (list.length === 0) return null;
    const skills = list.map((s, i) => ({
      rank: i + 1,
      name: s.frontmatter_name || s.skill_name || `skill-${i + 1}`,
      repo: s.category ? `hermes/${s.category}` : 'hermes',
      installs: '', // 설치 인벤토리라 마켓 설치수 없음
      category: s.category,
      description: s.description,
      installed: true, // Hermes 에 이미 설치됨(실데이터 표식)
    }));
    return { skills, source: 'hermes-installed', fetchedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

export async function GET() {
  // In-memory cache
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data);
  }

  try {
    const res = await fetch('https://skills.sh/', {
      next: { revalidate: 3600 },
      headers: { 'User-Agent': 'Dorothy/1.0' },
    });

    if (!res.ok) {
      const local = localHermesSkills();
      if (local) return NextResponse.json(local);
      return NextResponse.json({ error: 'Failed to fetch skills.sh' }, { status: 502 });
    }

    const html = await res.text();

    // Extract the initialSkills JSON array from the SSR payload
    const match = html.match(/initialSkills.*?(\[\{.*?\}\])/);
    if (!match) {
      const local = localHermesSkills();
      if (local) return NextResponse.json(local);
      return NextResponse.json({ error: 'Could not parse skills data' }, { status: 502 });
    }

    const raw = match[1].replace(/\\"/g, '"');
    const allSkills: RawSkill[] = JSON.parse(raw);

    // Take top 300, map to our Skill shape
    const skills = allSkills.slice(0, 300).map((s, i) => ({
      rank: i + 1,
      name: s.name,
      repo: s.source,
      installs: formatInstalls(s.installs),
      installsNum: s.installs,
    }));

    const result = { skills, source: 'skills.sh', fetchedAt: new Date().toISOString() };
    cache = { data: result, ts: Date.now() };

    return NextResponse.json(result);
  } catch (err) {
    // 네트워크/파싱 예외 — 하드코딩 대신 실제 로컬 Hermes 스킬로 폴백
    const local = localHermesSkills();
    if (local) return NextResponse.json(local);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
