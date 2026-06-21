/**
 * 하드코딩 제거 ② — 프로젝트 경로 단일 소스(companies.json).
 *
 * 박혀 있던 절대경로(TRIPLAN_ROOT·BUEONGI_ROOT·APPS_ROOT·TRIPLAN_CLAUDE 등)를 코드에서
 * 빼고 ~/.dorothy/companies.json 의 projects[].rootPath / subProjects[].path 에서 읽는다.
 * 서버(Node) 전용 — API 라우트/electron 핸들러에서 import. 읽기 실패 시 null(호출부가 폴백).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const COMPANIES = path.join(os.homedir(), '.dorothy', 'companies.json');

interface SubProject { id?: string; path?: string }
interface Project { id?: string; rootPath?: string; subProjects?: SubProject[] }

function readProjects(): Project[] {
  try {
    const d = JSON.parse(fs.readFileSync(COMPANIES, 'utf-8')) as { projects?: Project[] };
    return Array.isArray(d?.projects) ? d.projects : [];
  } catch {
    return [];
  }
}

/** projectId → rootPath (companies.json). 없으면 null. */
export function resolveProjectRoot(projectId: string): string | null {
  const p = readProjects().find((x) => x.id === projectId);
  return p?.rootPath ?? null;
}

/** subProjectId → path (companies.json). 없으면 null. */
export function resolveSubProjectPath(subProjectId: string): string | null {
  for (const p of readProjects()) {
    for (const s of p.subProjects ?? []) {
      if (s.id === subProjectId && s.path) return s.path;
    }
  }
  return null;
}

/** 모든 프로젝트 {projectId, root} (rootPath 있는 것만). 프로젝트 순회용. */
export function allProjectRoots(): { projectId: string; root: string }[] {
  return readProjects()
    .filter((p): p is Project & { id: string; rootPath: string } => !!p.id && !!p.rootPath)
    .map((p) => ({ projectId: p.id, root: p.rootPath }));
}
