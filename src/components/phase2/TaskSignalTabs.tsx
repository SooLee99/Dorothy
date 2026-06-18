'use client';

/**
 * PR-2-U3 — 작업 상세 [설계]/[산출물] 탭. /api/dorothy/tasks/{id} 신호 배선.
 *
 * ★§0.6: design contract/schema·artifacts 는 대부분 observed:false 가 정상 → "확인 불가" / "연결된 데이터 없음" 빈 상태.
 * ★G1: done 배지는 evidence.verified===true(=CI green/테스트 exit 0)일 때만 초록(EvidenceChip). kanban done 만으론 절대 초록 0.
 * 정적 신호라 폴링 없음(탭 진입 시 1회 fetch).
 */
import { useEffect, useState } from 'react';
import { EvidenceChip } from './EvidenceChip';

interface Obs { observed?: boolean; value?: string; reason?: string }
interface TaskDetail {
  design?: { spec?: Obs; contract?: Obs; schema?: Obs; doneCriteria?: Obs };
  evidence?: { observed?: boolean; verified?: boolean; basis?: { observed?: boolean; value?: string; reason?: string } };
  artifacts?: { observed?: boolean; files?: Obs; tests?: Obs; commits?: Obs; pr?: Obs; service?: Obs };
}

function FieldRow({ label, obs }: { label: string; obs?: Obs }) {
  return (
    <div className="py-1.5 border-b border-border/40 last:border-0">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      {obs?.observed ? (
        <div className="text-xs text-foreground whitespace-pre-wrap break-words mt-0.5">{obs.value}</div>
      ) : (
        <div className="text-xs text-muted-foreground/70 mt-0.5">확인 불가{obs?.reason ? ` (${obs.reason})` : ''}</div>
      )}
    </div>
  );
}

function EmptyState({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-6 text-center text-sm text-muted-foreground">
      {text}
      {hint && <p className="text-xs text-muted-foreground/70 mt-1">{hint}</p>}
    </div>
  );
}

function DesignView({ design }: { design?: TaskDetail['design'] }) {
  const any = !!design && [design.spec, design.contract, design.schema, design.doneCriteria].some((f) => f?.observed);
  if (!any) return <EmptyState text="이 작업엔 연결된 설계 데이터가 아직 없습니다" hint="spec/contract/schema 가 연결되면 표시됩니다." />;
  return (
    <div className="rounded-lg border border-border p-3">
      <FieldRow label="spec(요구사항)" obs={design?.spec} />
      <FieldRow label="contract(API 계약)" obs={design?.contract} />
      <FieldRow label="schema(DB)" obs={design?.schema} />
      <FieldRow label="완료조건" obs={design?.doneCriteria} />
    </div>
  );
}

function ArtifactsView({ artifacts, evidence }: { artifacts?: TaskDetail['artifacts']; evidence?: TaskDetail['evidence'] }) {
  const fields = [
    { label: '변경 파일', obs: artifacts?.files },
    { label: '커밋', obs: artifacts?.commits },
    { label: '테스트', obs: artifacts?.tests },
    { label: 'PR', obs: artifacts?.pr },
    { label: '대상 서비스', obs: artifacts?.service },
  ];
  const anyArtifact = fields.some((f) => f.obs?.observed);
  const verified = evidence?.verified === true;
  return (
    <div className="space-y-3">
      {/* ★done 배지(G1): verified===true 일 때만 초록. */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">완료 검증</span>
        <EvidenceChip evidence={evidence} />
        {!verified && <span className="text-[11px] text-muted-foreground/70">— kanban done 만으론 초록 아님(근거 미연결)</span>}
      </div>
      {anyArtifact ? (
        <div className="rounded-lg border border-border p-3">
          {fields.map((f) => <FieldRow key={f.label} label={f.label} obs={f.obs} />)}
        </div>
      ) : (
        <EmptyState text="연결된 산출물 데이터가 아직 없습니다" hint="task↔git/PR/side-effects 매핑이 있으면 변경 파일·커밋·테스트가 표시됩니다." />
      )}
    </div>
  );
}

export function TaskSignalTabs({ taskId, tab }: { taskId: string; tab: 'design' | 'artifacts' }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/dorothy/tasks/${encodeURIComponent(taskId)}`, { cache: 'no-store' });
        const j = await r.json();
        if (cancelled) return;
        if (j?.data) { setDetail(j.data); setError(null); }
        else setError(j?.meta?.error || '작업 신호 없음');
      } catch {
        if (!cancelled) setError('작업 신호를 가져오지 못했습니다');
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  if (error) return <div className="text-xs text-rose-400">{error}</div>;
  if (!detail) return <div className="text-xs text-muted-foreground">로딩…</div>;
  return tab === 'design'
    ? <DesignView design={detail.design} />
    : <ArtifactsView artifacts={detail.artifacts} evidence={detail.evidence} />;
}
