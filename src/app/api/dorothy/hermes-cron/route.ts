import { NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 정합성 C4-e — hermes cron(실 자동개발 동력)을 자동화 화면에 read-only 노출.
 *
 * ★문제: 실제 도는 자동화는 `~/.hermes/cron/jobs.json`(15잡·triplan/부엉이 QA/Orchestrator/
 * Backend/Frontend 등)인데 어느 Dorothy 화면도 안 읽음(자동화 화면은 빈 automations.json).
 * 이 라우트가 jobs.json 을 읽어 자동화 화면이 실 동력을 보이게 한다. ★read-only(제어 X).
 */
const JOBS = path.join(os.homedir(), '.hermes', 'cron', 'jobs.json');

interface RawJob {
  id?: string; name?: string; schedule_display?: string; schedule?: string;
  enabled?: boolean; state?: string; next_run_at?: string; last_run_at?: string;
  last_status?: string; last_error?: string; deliver?: string; skills?: string[];
  provider?: string; model?: string;
}

export async function GET() {
  try {
    const parsed = JSON.parse(fs.readFileSync(JOBS, 'utf-8')) as RawJob[] | { jobs?: RawJob[] };
    const raw: RawJob[] = Array.isArray(parsed) ? parsed : (parsed.jobs ?? []);
    const jobs = raw.map((j) => ({
      id: j.id ?? '',
      name: j.name ?? j.id ?? '(이름 없음)',
      schedule: j.schedule_display ?? j.schedule ?? null,
      enabled: j.enabled !== false,
      state: j.state ?? null,
      nextRunAt: j.next_run_at ?? null,
      lastRunAt: j.last_run_at ?? null,
      lastStatus: j.last_status ?? null,
      lastError: j.last_error ?? null,
      deliver: j.deliver ?? null,
      provider: j.provider ?? null,
      model: j.model ?? null,
      skills: Array.isArray(j.skills) ? j.skills : [],
    }));
    return NextResponse.json({ source: '~/.hermes/cron/jobs.json', count: jobs.length, jobs });
  } catch (e) {
    return NextResponse.json(
      { source: '~/.hermes/cron/jobs.json', count: 0, jobs: [], error: e instanceof Error ? e.message : 'failed' },
      { status: 200 },
    );
  }
}
