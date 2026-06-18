'use client';

/**
 * PR-2-U1 — Projects 영역. /api/dorothy/projects 배선 → ProjectCard 리스트.
 * 카드 클릭 → onSelect(project)(필터는 KanbanBoard 가 별도 슬롯에서 AND 합성). clearable.
 * ★상태: 로딩 / 에러 / 빈 / observed:false(repo 없음 등) 전부 깨짐 0.
 * ★조인 불가(repos 부재) → "매핑 확인 불가" 안내(거짓 필터 금지).
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { ProjectCard, type ProjectCardData } from './ProjectCard';

export function ProjectsStrip({
  selectedId,
  onSelect,
  pollMs = 5000,
}: {
  selectedId: string | null;
  onSelect: (project: ProjectCardData | null) => void;
  pollMs?: number;
}) {
  const [projects, setProjects] = useState<ProjectCardData[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/dorothy/projects', { cache: 'no-store' });
      const j = await res.json();
      const list = j?.data?.projects;
      if (Array.isArray(list)) { setProjects(list); setError(null); }
      else setError(j?.meta?.error || '프로젝트 신호 없음');
    } catch {
      setError('프로젝트를 가져오지 못했습니다');
    }
  }, []);

  useEffect(() => {
    load();
    // ★폴링은 탭이 보일 때만(document.hidden 시 스킵).
    const run = () => { if (!document.hidden) load(); };
    const t = setInterval(run, pollMs);
    document.addEventListener('visibilitychange', run);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', run); };
  }, [load, pollMs]);

  // ★basename 충돌 가드(§5): 여러 capsule 에 중복된 repo basename(frontend/backend 등)은 매칭 키에서 제외(거짓 포함 < 누락).
  const ambiguous = useMemo(() => {
    const cnt = new Map<string, number>();
    (projects ?? []).forEach((p) => (p.repos ?? []).forEach((r) => cnt.set(r, (cnt.get(r) ?? 0) + 1)));
    return new Set([...cnt.entries()].filter(([, n]) => n > 1).map(([r]) => r));
  }, [projects]);

  const handlePick = useCallback((p: ProjectCardData | null) => {
    if (!p) return onSelect(null);
    const repos = (p.repos ?? []).filter((r) => !ambiguous.has(r)); // 충돌 basename 제외
    onSelect({ ...p, repos });
  }, [onSelect, ambiguous]);

  const selected = projects?.find((p) => p.projectId === selectedId) ?? null;
  const selRepos = selected ? (selected.repos ?? []).filter((r) => !ambiguous.has(r)) : [];
  const joinUnavailable = !!selected && selRepos.length === 0;

  return (
    <div className="px-6 pt-1 pb-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Projects</span>
        {selectedId && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-[11px] text-primary hover:underline"
          >
            필터 해제 · {selectedId}
          </button>
        )}
      </div>

      {projects === null && !error && <div className="text-xs text-muted-foreground">프로젝트 로딩…</div>}
      {error && <div className="text-xs text-rose-400">프로젝트 신호 오류: {error}</div>}
      {projects && projects.length === 0 && <div className="text-xs text-muted-foreground">표시할 프로젝트 없음</div>}

      {projects && projects.length > 0 && (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {projects.map((p) => (
            <div key={p.projectId} className="w-72 shrink-0">
              <ProjectCard project={p} selected={p.projectId === selectedId} onSelect={handlePick} />
            </div>
          ))}
        </div>
      )}

      {joinUnavailable && (
        <div className="text-[11px] text-amber-600 mt-1">
          이 프로젝트의 작업 매핑 확인 불가 — 필터를 적용하지 않습니다.
        </div>
      )}
    </div>
  );
}
