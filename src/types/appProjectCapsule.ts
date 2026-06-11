/**
 * Phase 6-AK — App Factory Project Capsule (preview/plan only; no scaffolding).
 *
 * A capsule is the isolated definition of one MVP app project: its own
 * projectId / rootPath / kanban / vault / reports / logs / ports / env namespace,
 * so multiple projects never mix with triplan or each other. Real directory
 * creation, package install, and Kanban task materialization happen ONLY in a
 * later confirmed phase (6-AL).
 */

import type { AppApiSource } from './dorothy';

export type CapsuleStatus = 'draft' | 'ready' | 'active' | 'paused' | 'completed' | 'blocked';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'gradle' | 'mixed';

export interface AppProjectCapsule {
  id: string;
  appCandidateId?: string;
  projectId: string;
  projectName: string;
  companyName: string;
  status: CapsuleStatus;
  // Phase 6-AS — 생성 마법사 입력(모두 선택; 기존 캡슐 backward-compatible)
  description?: string;
  appType?: string;
  targetUsers?: string;
  coreProblem?: string;
  apiKeyRequired?: boolean;
  /** Phase 6-AW — Figma AI가 생성한 TypeScript 프론트엔드 소스 GitHub 레포 URL */
  frontendRepoUrl?: string;
  rootPath: string;
  frontendPath?: string;
  backendPath?: string;
  packageManager?: PackageManager;
  techStack?: string[];
  frontendPort?: number;
  backendPort?: number;
  envNamespace: string;
  vaultNamespace: string;
  kanbanProjectId: string;
  reportsPath: string;
  logsPath: string;
  dataSources?: AppApiSource[];
  mvpScope?: string[];
  outOfScope?: string[];
  riskPolicy?: string[];
  // Phase 6-AO — 실행 전 상세 필드
  dataSourceNotes?: string[];
  executionChecklist?: string[];
  createdAt: string;
  updatedAt: string;
}

/** Kanban preview task for a capsule — NOT persisted as a real Kanban task. */
export interface CapsuleKanbanPreviewTask {
  projectId: string;
  kanbanProjectId: string;
  ownerAgentId: string;
  title: string;
  description: string;
  riskLevel: 'low' | 'medium' | 'high';
  requiresApproval: boolean;
  order: number;
}

export interface ResumeBrief {
  projectId: string;
  projectName: string;
  status: CapsuleStatus;
  rootPathExists: boolean;
  gitStatus?: string;
  dirtyFileCount: number;
  hasPackageJson: boolean;
  hasBuildGradle: boolean;
  packageManager?: PackageManager;
  ongoingTaskCount: number;
  backlogTaskCount: number;
  blockedTaskCount: number;
  lastReports: string[];
  recommendedNextAgent: string;
  recommendedAction: string;
  generatedAt: string;
  notes: string[];
}
