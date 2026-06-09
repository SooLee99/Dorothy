/**
 * PR-2-S1 — kanban task → 신호 변환(순수 로직).
 *
 * ★Ground-truth(§2): done 초록은 실제 근거(PR CI green / 테스트 exit 0)일 때만 → evidence.verified.
 *   설계/산출물/session 은 데이터 링크가 없으면(recon) observed:false(추측 0).
 *   - 설계 contract/schema: 산출물(report)↔task 연결 키 없음 → source-missing
 *   - 산출물 files/commits/pr: task↔branch/PR 링크 없음 + side-effects 원장 미운영 → source-missing
 *   - session: task↔session 명시 매핑 없음 → mapping-uncertain
 *   - projectId: 필드는 있으나 projectPath 와 정합 불확실(recon) → mapping-uncertain (project 는 projectPath 로 도출=observed)
 *
 * 순수 모듈(observed 만 의존).
 */
import { observed, unknown, type Observed } from './observed';

/** approval 게이트로 해석되는 라벨(approval-queue.md 부재 → labels 도출). */
const GATE_LABELS = new Set([
  'approval-required', 'needs-approval', 'user-gate', 'gated', 'gate',
  'quality-gate', 'ddl-gated', 'product-gate',
]);
/** 게이트 해제(부정) 라벨 — 있으면 approvalRequired 를 끈다. */
const NONGATE_LABELS = new Set(['non-gated', 'ungated', 'non-gate']);
/** 모호/보류 라벨. */
const HELD_LABELS = new Set(['blocked', 'held', 'backend-blocked', 'frontend-blocked', 'ambiguous', 'on-hold']);

export interface KanbanTaskLike {
  id: string;
  title?: string;
  description?: string;
  column?: string;
  status?: string;
  assignedAgentId?: string;
  projectPath?: string;
  projectId?: string;
  labels?: string[];
  priority?: string;
  progress?: number;
  completionSummary?: string;
  stageHistory?: unknown[];
}

export function deriveApprovalRequired(labels: string[]): boolean {
  const has = (s: Set<string>) => labels.some((l) => s.has(l));
  return has(GATE_LABELS) && !has(NONGATE_LABELS);
}

export function deriveHeldAmbiguous(labels: string[]): boolean {
  return labels.some((l) => HELD_LABELS.has(l));
}

export function projectName(projectPath?: string): string | null {
  if (!projectPath || typeof projectPath !== 'string') return null;
  const parts = projectPath.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

export function toTaskSummary(t: KanbanTaskLike) {
  const labels = Array.isArray(t.labels) ? t.labels : [];
  const pn = projectName(t.projectPath);
  return {
    id: t.id,
    title: t.title ?? '',
    status: t.column ?? t.status ?? 'unknown',
    owner: t.assignedAgentId ? observed({ value: t.assignedAgentId }) : unknown('source-missing'),
    project: pn ? observed({ value: pn }) : unknown('source-missing'),
    projectId: unknown('mapping-uncertain'),         // recon: projectId 불안정
    labels,
    priority: t.priority ?? null,
    approvalRequired: deriveApprovalRequired(labels), // best-effort(labels)
    heldAmbiguous: deriveHeldAmbiguous(labels),
  };
}

export function toTaskDetail(t: KanbanTaskLike) {
  const summary = toTaskSummary(t);
  return {
    ...summary,
    design: {
      spec: t.description ? observed({ value: t.description }) : unknown('source-missing'),
      contract: unknown('source-missing'),  // 산출물↔task 연결 키 없음
      schema: unknown('source-missing'),
      doneCriteria: t.completionSummary ? observed({ value: t.completionSummary }) : unknown('source-missing'),
    },
    // ★G1: PR CI green / 테스트 exit 0 이 task 에 연결될 때만 verified=true. 현재 미연결 → false 고정.
    evidence: { observed: true as const, verified: false, basis: unknown('source-missing') },
    artifacts: {
      observed: true as const,
      files: unknown('source-missing'),    // side-effects 원장 미운영
      commits: unknown('source-missing'),
      tests: unknown('source-missing'),
      pr: unknown('source-missing'),        // GitHub 미연동
      service: unknown('source-missing'),
    },
    session: unknown('mapping-uncertain'),  // task↔session 명시 매핑 없음
  };
}

export type TaskSummary = ReturnType<typeof toTaskSummary>;
export type TaskDetail = ReturnType<typeof toTaskDetail>;
