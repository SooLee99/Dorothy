'use client';

/**
 * App Factory Dashboard (/app-factory) — Phase 6-W.
 *
 * Read + planning-only surface for public-data MVP app candidates. Each
 * candidate is an independent company/project (projectSlug + suggestedProjectPath
 * + its own future Kanban). "Generate Plan Preview" builds an in-memory plan
 * (architecture + MVP scope + Kanban preview tasks) — it NEVER creates files,
 * repos, or real Kanban tasks. The "Create Kanban" action is intentionally
 * disabled (requires a future explicit confirm step).
 */

import { useMemo, useState } from 'react';
import {
  Factory,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  AlertTriangle,
  Database,
  Wand2,
  Loader2,
  ListChecks,
  Lock,
} from 'lucide-react';
import { useDorothyAppCandidates } from '@/hooks/useDorothyRuns';
import ProjectCapsules from './ProjectCapsules';
import { dorothyRunsClient } from '@/lib/dorothyRunsClient';
import type { AppCandidate, AppCandidateStatus, AppFactoryPlan } from '@/types/dorothy';

const STATUS_KO: Record<AppCandidateStatus, string> = {
  candidate: '후보',
  selected: '선정됨',
  planning: '계획 중',
  kanban_previewed: '칸반 프리뷰됨',
  ready_to_build: '구현 준비',
  building: '구현 중',
  shipped: '출시됨',
  paused: '보류',
};

const STATUS_CHIP: Record<AppCandidateStatus, string> = {
  candidate: 'bg-muted text-muted-foreground border-border',
  selected: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  planning: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  kanban_previewed: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  ready_to_build: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  building: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  shipped: 'bg-green-500/15 text-green-400 border-green-500/30',
  paused: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
};

const DIFFICULTY_KO: Record<string, string> = { easy: '쉬움', medium: '보통', hard: '어려움' };
const DAILY_KO: Record<string, string> = {
  very_high: '매우 높음', high: '높음', medium_high: '중상', medium: '보통', low: '낮음',
};
const SUBSTITUTE_KO: Record<string, string> = {
  weak: '약함', medium: '보통', strong: '강함', very_strong: '매우 강함',
};

const ALL_STATUSES: AppCandidateStatus[] = [
  'candidate', 'selected', 'planning', 'kanban_previewed', 'ready_to_build', 'building', 'shipped', 'paused',
];

function Chips({ label, items, cls }: { label: string; items?: string[]; cls?: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">{label}</span>
      {items.map((t, i) => (
        <span key={i} className={`text-[10px] px-1.5 py-0.5 border rounded ${cls ?? 'bg-secondary border-border text-foreground'}`}>{t}</span>
      ))}
    </div>
  );
}

function PlanPreview({ plan }: { plan: AppFactoryPlan }) {
  return (
    <div className="mt-3 border border-border rounded-md bg-background/50 p-3 space-y-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-purple-400">
        <ListChecks className="w-4 h-4" /> Generate Plan Preview <span className="text-muted-foreground font-normal">(저장/실행 없음 · in-memory)</span>
      </div>
      <p className="text-[11px] text-muted-foreground whitespace-pre-wrap">{plan.summary}</p>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Architecture</div>
        <pre className="text-[10px] text-foreground whitespace-pre-wrap bg-secondary/50 border border-border rounded p-2">{plan.suggestedArchitecture}</pre>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ListBlock title="MVP Scope" items={plan.mvpScope} />
        <ListBlock title="Out of Scope" items={plan.outOfScope} />
        <ListBlock title="Data Model Draft" items={plan.dataModelDraft} />
        <ListBlock title="API Contract Draft" items={plan.apiContractDraft} />
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Kanban Preview ({plan.kanbanPreviewTasks.length})</div>
        <div className="space-y-1.5">
          {plan.kanbanPreviewTasks.map(t => (
            <div key={t.id} className="border border-border rounded bg-secondary/40 p-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] tabular-nums text-muted-foreground">{t.order}</span>
                <span className="text-[11px] font-medium text-foreground">{t.title}</span>
                <span className="text-[9px] px-1.5 py-0.5 border rounded bg-emerald-500/10 text-emerald-500 border-emerald-500/30 ml-auto">{t.ownerAgentId}</span>
              </div>
              {t.acceptanceCriteria.length > 0 && (
                <ul className="mt-1 ml-5 list-disc text-[10px] text-muted-foreground space-y-0.5">
                  {t.acceptanceCriteria.map((ac, i) => <li key={i}>{ac}</li>)}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>

      <ListBlock title="Risk Policy" items={plan.riskPolicy} danger />

      <div className="flex items-center gap-2 pt-1">
        <button
          disabled
          title="실제 Kanban task 생성은 별도 confirm 단계가 필요합니다 (이번 단계 비활성)"
          className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-border rounded bg-muted text-muted-foreground cursor-not-allowed"
        >
          <Lock className="w-3.5 h-3.5" /> Create Kanban (confirm 필요 · 비활성)
        </button>
        <span className="text-[10px] text-muted-foreground">프리뷰는 실제 Kanban/코드/레포를 생성하지 않습니다.</span>
      </div>
    </div>
  );
}

function ListBlock({ title, items, danger }: { title: string; items: string[]; danger?: boolean }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{title}</div>
      <ul className={`ml-4 list-disc text-[10px] space-y-0.5 ${danger ? 'text-rose-400' : 'text-foreground'}`}>
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  );
}

function CandidateCard({ candidate }: { candidate: AppCandidate }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<AppFactoryPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await dorothyRunsClient.appFactory.generatePlanPreview({ appCandidateId: candidate.id });
      if (res.ok && res.data?.plan) { setPlan(res.data.plan); setOpen(true); }
      else setError(res.error || 'preview 생성 실패');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'preview 생성 실패');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border border-border rounded-md bg-card/40 p-3">
      <div className="flex items-start gap-2">
        <button onClick={() => setOpen(v => !v)} className="mt-0.5 text-muted-foreground hover:text-foreground cursor-pointer">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {candidate.rank != null && <span className="text-[10px] tabular-nums text-muted-foreground">#{candidate.rank}</span>}
            <span className="text-sm font-semibold text-foreground">{candidate.title}</span>
            <span className={`text-[10px] px-1.5 py-0.5 border rounded ${STATUS_CHIP[candidate.status]}`}>{STATUS_KO[candidate.status]}</span>
            {candidate.implementationDifficulty && (
              <span className="text-[10px] px-1.5 py-0.5 border rounded bg-secondary border-border text-muted-foreground">난이도: {DIFFICULTY_KO[candidate.implementationDifficulty]}</span>
            )}
            {candidate.dailyUseLevel && (
              <span className="text-[10px] px-1.5 py-0.5 border rounded bg-secondary border-border text-muted-foreground">일상성: {DAILY_KO[candidate.dailyUseLevel]}</span>
            )}
            {candidate.substituteLevel && (
              <span className="text-[10px] px-1.5 py-0.5 border rounded bg-secondary border-border text-muted-foreground">대체제: {SUBSTITUTE_KO[candidate.substituteLevel]}</span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">{candidate.problem}</p>
          <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1"><FolderGit2 className="w-3 h-3" />{candidate.projectSlug}</span>
            <span className="truncate" title={candidate.suggestedProjectPath}>{candidate.suggestedProjectPath}</span>
          </div>
        </div>
        <button
          onClick={generate}
          disabled={loading}
          className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-purple-500/30 rounded bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 cursor-pointer disabled:opacity-60"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
          Generate Plan
        </button>
      </div>

      {open && (
        <div className="mt-3 ml-6 space-y-2">
          <Chips label="대상" items={candidate.targetUsers} cls="bg-cyan-500/10 text-cyan-400 border-cyan-500/30" />
          <Chips label="핵심 기능" items={candidate.coreMvpFeatures} />
          <Chips label="수익화" items={candidate.monetization} cls="bg-emerald-500/10 text-emerald-400 border-emerald-500/30" />
          <Chips label="리스크" items={candidate.risks} cls="bg-rose-500/10 text-rose-400 border-rose-500/30" />
          {candidate.apiSources.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1"><Database className="w-3 h-3" />API Sources</div>
              <div className="space-y-1">
                {candidate.apiSources.map((s, i) => (
                  <div key={i} className="text-[10px] text-foreground border border-border rounded bg-secondary/40 p-1.5">
                    <span className="font-medium">{s.name}</span> · <span className="text-muted-foreground">{s.provider}</span>
                    {s.requiresApiKey != null && <span className="ml-1 text-muted-foreground">· API key: {s.requiresApiKey ? '필요' : '불필요/확인'}</span>}
                    {s.url && <div className="text-muted-foreground truncate">{s.url}</div>}
                    {s.notes && <div className="text-muted-foreground">{s.notes}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {error && <p className="text-[11px] text-rose-400 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>}
          {plan && <PlanPreview plan={plan} />}
        </div>
      )}
    </div>
  );
}

export default function AppFactoryDashboard() {
  const [statusFilter, setStatusFilter] = useState<AppCandidateStatus | 'all'>('all');
  const { candidates, isLoading, error, dbUnavailable } = useDorothyAppCandidates(
    statusFilter === 'all' ? {} : { status: statusFilter },
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const x of candidates) c[x.status] = (c[x.status] ?? 0) + 1;
    return c;
  }, [candidates]);

  return (
    <div className="space-y-4 pt-4 lg:pt-6">
      <div className="flex items-center gap-2">
        <Factory className="w-5 h-5 text-purple-400" />
        <h1 className="text-xl font-bold tracking-tight text-foreground">앱 팩토리</h1>
        <span className="text-[11px] text-muted-foreground">
          공공데이터 MVP 앱 후보 — 1 앱 = 1 회사 = 1 프로젝트 = 1 디렉터리 = 1 Kanban (계획 전용)
        </span>
      </div>

      <div className="rounded-md border border-border bg-secondary/40 p-3">
        <p className="text-sm font-medium text-foreground">새 프로젝트 만들기 · 중단된 프로젝트 이어서 시작</p>
        <p className="text-[11px] text-muted-foreground mt-1">
          후보를 골라 <strong className="text-foreground">프로젝트 준비 카드</strong>를 만들고, <strong className="text-foreground">작업 계획 미리보기</strong>·<strong className="text-foreground">이어서 시작 요약</strong>을 확인하세요.
          이 화면은 <strong className="text-foreground">계획 전용</strong>입니다 — 실제 디렉터리·코드·Kanban 작업은 생성하지 않으며, 자동 빌드는 확인(confirm) 후에만 실행됩니다.
        </p>
      </div>

      {/* status filter */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setStatusFilter('all')}
          className={`text-[11px] px-2 py-0.5 border rounded cursor-pointer ${statusFilter === 'all' ? 'bg-foreground text-background border-foreground' : 'bg-secondary border-border text-muted-foreground'}`}
        >전체 {candidates.length}</button>
        {ALL_STATUSES.map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`text-[11px] px-2 py-0.5 border rounded cursor-pointer ${statusFilter === s ? `${STATUS_CHIP[s]}` : 'bg-secondary border-border text-muted-foreground'}`}
          >{STATUS_KO[s]} {counts[s] ? `· ${counts[s]}` : ''}</button>
        ))}
      </div>

      {dbUnavailable && (
        <p className="text-[11px] text-yellow-500">dorothy.db 사용 불가 — App Factory 데이터를 읽을 수 없습니다.</p>
      )}
      {error && !dbUnavailable && (
        <p className="text-[11px] text-rose-400 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>
      )}

      {isLoading && candidates.length === 0 ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" /> 로딩 중…</div>
      ) : candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">등록된 앱 후보가 없습니다.</p>
      ) : (
        <div className="space-y-2">
          {candidates.map(c => <CandidateCard key={c.id} candidate={c} />)}
        </div>
      )}

      {/* Phase 6-AK — Project Capsules (독립 프로젝트 생성/재개, 계획 전용) */}
      <ProjectCapsules candidates={candidates} />
    </div>
  );
}
