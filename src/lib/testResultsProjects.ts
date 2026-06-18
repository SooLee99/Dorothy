import os from 'os';
import path from 'path';

/**
 * E2E 테스트 결과를 프로젝트별로 구분하기 위한 레지스트리.
 *
 * /api/dorothy/test-results (목록·캡처 스캔)와
 * /api/dorothy/test-results/capture (이미지/리포트 HTTP 서빙)가 공유한다.
 *
 * ★캡처 서빙은 이 레지스트리의 frontendPath/screenshots·playwright-report 하위만 허용(allowlist).
 *   임의 절대경로 서빙 금지 — 경로 traversal 차단.
 */
export interface E2EProject {
  id: string;
  label: string;
  /** GitHub Actions 조회용. 없으면(null) GitHub 조회 생략(local 캡처만). */
  repoOwner: string | null;
  repoName: string | null;
  /** run.name / workflow path 매칭(대소문자 무시). */
  workflowHint: string;
  /** 로컬 캡처 스캔 루트(screenshots/·playwright-report/ 의 부모). */
  frontendPath: string;
}

export const E2E_PROJECTS: E2EProject[] = [
  {
    id: 'bueongi',
    label: '부엉이 (안심귀가)',
    repoOwner: 'soo-ai-agent',
    repoName: 'bueongi',
    workflowHint: 'e2e',
    frontendPath: path.join(os.homedir(), 'workspace/source-code/apps/bueongi/frontend-src'),
  },
  {
    id: 'triplan',
    label: 'triplan',
    repoOwner: 'soo-ai-agent',
    repoName: 'triplan-frontend',
    workflowHint: 'e2e',
    frontendPath: path.join(os.homedir(), 'workspace/source-code/triplan/triplan-frontend'),
  },
];

/** id로 프로젝트 조회. 없거나 미지정이면 첫 프로젝트(bueongi). */
export function getE2EProject(id?: string | null): E2EProject {
  return E2E_PROJECTS.find(p => p.id === id) ?? E2E_PROJECTS[0];
}

/** UI 탭용 경량 목록. */
export function listE2EProjects(): { id: string; label: string }[] {
  return E2E_PROJECTS.map(p => ({ id: p.id, label: p.label }));
}

/**
 * 캡처 서빙 allowlist. 절대경로가 등록 프로젝트의 screenshots/ 또는
 * playwright-report/ 하위(또는 report index 자체)일 때만 true.
 */
export function isAllowedCapturePath(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  return E2E_PROJECTS.some(p => {
    const shots = path.join(p.frontendPath, 'screenshots');
    const report = path.join(p.frontendPath, 'playwright-report');
    return (
      resolved === shots ||
      resolved.startsWith(shots + path.sep) ||
      resolved === report ||
      resolved.startsWith(report + path.sep)
    );
  });
}
