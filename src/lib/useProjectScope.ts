'use client';

/**
 * 재설계 ②-a — 전역 프로젝트 스코프(중앙 matcher).
 *
 * 화면마다 프로젝트 식별자가 제각각(projectPath / projectId / repo)이라, "이 아이템이
 * 선택 프로젝트(store.selectedProject)에 속하나?"를 ★한 곳에서 판단한다. 칸반의 canonical
 * 조인(matchesCapsule: basename(projectPath) ∈ project.repos)을 재사용하되, 'backend'·
 * 'frontend' 처럼 여러 프로젝트가 공유하는 basename 오매칭을 줄이려 ★projectId 경로 세그먼트
 * 매칭을 1순위로 둔다.
 *
 * 안전 원칙(거짓 필터 금지):
 *  - selectedProject 없음 → 항상 true(필터 off).
 *  - 선택 메타(repos) 못 찾음 → true(degrade).
 *  - 아이템에 식별자가 ★전혀 없음 → true(degrade·보여줌).
 *  - 식별자가 ★있는데 안 맞음 → false(거름).
 */
import { useEffect, useState, useCallback } from 'react';
import { useStore } from '@/store';

export interface ProjectMeta {
  projectId: string;
  name?: string;
  repos?: string[];
}

export interface ProjectMatchFields {
  projectPath?: string | null;
  projectId?: string | null;
  repo?: string | null;
}

/**
 * 정합성 C1-c — projectId 정규화 매칭. 칸반 태스크 등이 같은 프로젝트를 9가지 변형으로
 * 태깅(slug·서브프로젝트명·경로·경로인코딩 '-Users-…'·맨폴더명)하므로, 단일 value 가
 * 선택 projectId(`selected`)에 속하는지 결정적으로 판정한다. ★공유 basename('backend'·
 * 'frontend')은 repos 멤버십으로만 잡혀 다중 프로젝트에 걸릴 수 있음(알려진 한계 — 보수적).
 * 자유 텍스트 이름(예 '안심귀가')·비프로젝트('Dorothy')는 매칭 안 됨(원천 정규화 필요).
 */
function projValueMatches(value: string, selected: string, repos: string[] | null | undefined): boolean {
  if (!value || !selected) return false;
  if (value === selected) return true;
  // 서브프로젝트명(예 triplan-travel-service)·맨폴더명(frontend-src)이 선택 프로젝트 repos 에 속함
  if (Array.isArray(repos) && repos.includes(value)) return true;
  // 경로(/구분): selected 가 한 세그먼트
  const slashSegs = value.replace(/\\/g, '/').split('/').filter(Boolean);
  if (slashSegs.includes(selected)) return true;
  // 경로 인코딩('-Users-…-apps-bueongi-frontend-src'): selected 가 '-'경계 토큰
  if (`-${value}-`.includes(`-${selected}-`) || value.endsWith(`-${selected}`)) return true;
  return false;
}

export function useProjectScope() {
  const selectedProject = useStore((s) => s.selectedProject);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/dorothy/projects', { cache: 'no-store' });
        const j = await res.json();
        const list = j?.data?.projects;
        if (!cancelled && Array.isArray(list)) setProjects(list);
      } catch {
        /* 실패 → projects 빈 채로 → matches 가 degrade(true) */
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const selectedMeta = selectedProject ? projects.find((p) => p.projectId === selectedProject) ?? null : null;
  const repos = selectedMeta?.repos ?? null;

  const matches = useCallback(
    (fields: ProjectMatchFields): boolean => {
      if (!selectedProject) return true; // 필터 off
      if (!selectedMeta) return true; // 메타 못 찾음 → degrade

      const path = typeof fields.projectPath === 'string' ? fields.projectPath : '';
      const id = typeof fields.projectId === 'string' ? fields.projectId : '';
      const repo = typeof fields.repo === 'string' ? fields.repo : '';
      if (!path && !id && !repo) return true; // 식별자 없음 → degrade

      // C1-c — 세 필드 어느 하나라도 정규화 매칭되면 그 프로젝트에 속함.
      if (id && projValueMatches(id, selectedProject, repos)) return true;
      if (path && projValueMatches(path, selectedProject, repos)) return true;
      if (repo && projValueMatches(repo, selectedProject, repos)) return true;

      return false; // 식별자 있는데 안 맞음 → 거름
    },
    [selectedProject, selectedMeta, repos],
  );

  // C2-c — "이 아이템은 어느 프로젝트인가?" 정규화 해석(projectId 반환·없으면 null).
  //   /agents 등 프로젝트별 그룹의 1차 키. matches 와 동일한 projValueMatches 규칙.
  const resolveProjectId = useCallback(
    (fields: ProjectMatchFields): string | null => {
      const vals = [fields.projectId, fields.projectPath, fields.repo].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
      if (vals.length === 0) return null;
      for (const p of projects) {
        if (vals.some((v) => projValueMatches(v, p.projectId, p.repos))) return p.projectId;
      }
      return null;
    },
    [projects],
  );

  return { selectedProject, selectedMeta, repos, projects, matches, resolveProjectId };
}
