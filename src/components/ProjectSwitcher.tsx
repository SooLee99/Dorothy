'use client';

/**
 * 재설계 ①단계 — 전역 프로젝트 스위처.
 *
 * store 의 `selectedProject`(이전엔 화면에 배선 안 된 죽은 상태)를 되살려, 사이드바
 * 상단에서 프로젝트를 고르면 프로젝트별 화면(칸반 등)이 그 선택을 읽어 자동 필터한다.
 * 데이터 출처는 ProjectsStrip 과 동일한 `/api/dorothy/projects`(실데이터).
 *
 * 안전: 프로젝트가 없거나 로딩/에러면 ★렌더 0(깨짐 없음). 라우트/화면 변경 없음.
 */
import { useEffect, useState } from 'react';
import { FolderKanban } from 'lucide-react';
import { useStore } from '@/store';

interface ProjItem {
  projectId: string;
  name?: string;
}

export default function ProjectSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const selectedProject = useStore((s) => s.selectedProject);
  const setSelectedProject = useStore((s) => s.setSelectedProject);
  const [projects, setProjects] = useState<ProjItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/dorothy/projects', { cache: 'no-store' });
        const j = await res.json();
        const list = j?.data?.projects;
        if (!cancelled && Array.isArray(list)) {
          setProjects(
            list
              .filter((p: { projectId?: unknown }) => typeof p?.projectId === 'string')
              .map((p: { projectId: string; name?: string }) => ({ projectId: p.projectId, name: p.name })),
          );
        }
      } catch {
        /* 네트워크 실패 → 스위처 숨김(아래 length===0 가드) */
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // 접힌 사이드바: 현재 스코프만 아이콘으로 표시(클릭 시 전체로 리셋).
  if (collapsed) {
    return (
      <div className="px-2 py-2 flex justify-center">
        <button
          type="button"
          onClick={() => setSelectedProject(null)}
          title={selectedProject ? `프로젝트: ${selectedProject} (클릭 시 전체)` : '전체 프로젝트'}
          className="p-1"
        >
          <FolderKanban className={`w-5 h-5 ${selectedProject ? 'text-primary' : 'text-muted-foreground'}`} />
        </button>
      </div>
    );
  }

  if (projects.length === 0) return null; // 프로젝트 없음/로딩/에러 → 깨짐 0

  const chip = (id: string | null, label: string) => {
    const active = id === null ? !selectedProject : selectedProject === id;
    return (
      <button
        type="button"
        key={id ?? '__all__'}
        onClick={() => setSelectedProject(id)}
        className={`px-2 py-1 text-[11px] rounded border transition-colors ${
          active
            ? 'bg-primary/15 border-primary/40 text-primary font-medium'
            : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary/50'
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="px-3 pt-3 pb-1 border-b border-border/60">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5 flex items-center gap-1">
        <FolderKanban className="w-3 h-3" /> 프로젝트
      </div>
      <div className="flex flex-wrap gap-1">
        {chip(null, '전체')}
        {projects.map((p) => chip(p.projectId, p.name || p.projectId))}
      </div>
    </div>
  );
}
