/**
 * Dorothy MVP Phase 6-W — App Factory service.
 *
 * Manages public-data MVP app ideas as independent companies/projects:
 *   - AppCandidate  : an app idea (target users, problem, MVP features, API
 *                     sources, risks, monetization, projectSlug/path, status).
 *   - AppFactoryPlan: a PREVIEW (architecture + MVP scope + Kanban preview
 *                     tasks owned by process agents) for a candidate.
 *
 * Safety contract (this phase is planning-only):
 *   - `generateAppFactoryPlanPreview()` builds an in-memory preview and writes
 *     NOTHING — no files, no repos, no real Kanban tasks, no DB row.
 *   - `createAppFactoryPlan()` persists a plan row (the preview the operator
 *     chose to keep). It still never creates Kanban tasks or app code.
 *   - Converting a plan to real Kanban tasks is a separate, explicitly-confirmed
 *     step and is intentionally NOT implemented here.
 *
 * All reads/writes no-op gracefully when dorothy.db is unavailable.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import type {
  AppApiSource,
  AppCandidate,
  AppCandidateStatus,
  AppDailyUseLevel,
  AppSubstituteLevel,
  AppImplementationDifficulty,
  CreateAppCandidateInput,
  ListAppCandidatesOptions,
  AppFactoryPlan,
  AppFactoryPlanStatus,
  AppFactoryKanbanPreviewTask,
} from '../../types/dorothy';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_TITLE = 160;
const MAX_LONG = 1000;
const MAX_ITEM = 240;

/* ============================================================================
 * Helpers
 * ========================================================================== */

function clamp(value: string | null | undefined, max: number): string {
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function normList(values: unknown, capCount = 30, capLen = MAX_ITEM): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((v): v is string => typeof v === 'string')
    .slice(0, capCount)
    .map(v => clamp(v, capLen))
    .filter(v => v.length > 0);
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function parseApiSources(raw: string | null): AppApiSource[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((s): s is AppApiSource => !!s && typeof s === 'object' && typeof (s as AppApiSource).name === 'string')
      .map(s => ({
        name: clamp(String(s.name), MAX_TITLE),
        provider: clamp(String(s.provider ?? ''), MAX_TITLE),
        url: s.url ? clamp(String(s.url), MAX_LONG) : undefined,
        requiresApiKey: typeof s.requiresApiKey === 'boolean' ? s.requiresApiKey : undefined,
        notes: s.notes ? clamp(String(s.notes), MAX_LONG) : undefined,
      }));
  } catch {
    return [];
  }
}

function normApiSources(values: AppApiSource[] | undefined): AppApiSource[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 20).map(s => ({
    name: clamp(String(s.name ?? ''), MAX_TITLE),
    provider: clamp(String(s.provider ?? ''), MAX_TITLE),
    url: s.url ? clamp(String(s.url), MAX_LONG) : undefined,
    requiresApiKey: typeof s.requiresApiKey === 'boolean' ? s.requiresApiKey : undefined,
    notes: s.notes ? clamp(String(s.notes), MAX_LONG) : undefined,
  })).filter(s => s.name.length > 0);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'app';
}

/* ============================================================================
 * Row mapping
 * ========================================================================== */

interface AppCandidateRow {
  id: string;
  rank: number | null;
  title: string;
  target_users_json: string | null;
  problem: string | null;
  daily_use_level: string | null;
  substitute_level: string | null;
  substitutes_json: string | null;
  core_mvp_features_json: string | null;
  api_sources_json: string | null;
  provider: string | null;
  implementation_difficulty: string | null;
  monetization_json: string | null;
  risks_json: string | null;
  project_slug: string;
  company_name: string | null;
  suggested_project_path: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToCandidate(r: AppCandidateRow): AppCandidate {
  return {
    id: r.id,
    rank: r.rank ?? undefined,
    title: r.title,
    targetUsers: parseList(r.target_users_json),
    problem: r.problem ?? '',
    dailyUseLevel: (r.daily_use_level as AppDailyUseLevel) ?? undefined,
    substituteLevel: (r.substitute_level as AppSubstituteLevel) ?? undefined,
    substitutes: parseList(r.substitutes_json),
    coreMvpFeatures: parseList(r.core_mvp_features_json),
    apiSources: parseApiSources(r.api_sources_json),
    provider: r.provider ?? undefined,
    implementationDifficulty: (r.implementation_difficulty as AppImplementationDifficulty) ?? undefined,
    monetization: parseList(r.monetization_json),
    risks: parseList(r.risks_json),
    projectSlug: r.project_slug,
    companyName: r.company_name ?? '',
    suggestedProjectPath: r.suggested_project_path ?? '',
    status: r.status as AppCandidateStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface AppFactoryPlanRow {
  id: string;
  app_candidate_id: string;
  summary: string;
  suggested_architecture: string;
  mvp_scope_json: string | null;
  out_of_scope_json: string | null;
  data_model_draft_json: string | null;
  api_contract_draft_json: string | null;
  kanban_preview_tasks_json: string | null;
  risk_policy_json: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function parsePreviewTasks(raw: string | null): AppFactoryKanbanPreviewTask[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as AppFactoryKanbanPreviewTask[]) : [];
  } catch {
    return [];
  }
}

function rowToPlan(r: AppFactoryPlanRow): AppFactoryPlan {
  return {
    id: r.id,
    appCandidateId: r.app_candidate_id,
    summary: r.summary,
    suggestedArchitecture: r.suggested_architecture,
    mvpScope: parseList(r.mvp_scope_json),
    outOfScope: parseList(r.out_of_scope_json),
    dataModelDraft: parseList(r.data_model_draft_json),
    apiContractDraft: parseList(r.api_contract_draft_json),
    kanbanPreviewTasks: parsePreviewTasks(r.kanban_preview_tasks_json),
    riskPolicy: parseList(r.risk_policy_json),
    status: r.status as AppFactoryPlanStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ============================================================================
 * AppCandidate CRUD
 * ========================================================================== */

export function createAppCandidate(input: CreateAppCandidateInput): AppCandidate | null {
  const db = getDorothyDb();
  if (!db) return null;

  const id = uuidv4();
  const now = new Date().toISOString();
  const projectSlug = slugify(input.projectSlug || input.title);
  const status: AppCandidateStatus = input.status ?? 'candidate';
  const targetUsers = normList(input.targetUsers);
  const coreMvpFeatures = normList(input.coreMvpFeatures);
  const apiSources = normApiSources(input.apiSources);
  const substitutes = normList(input.substitutes);
  const monetization = normList(input.monetization);
  const risks = normList(input.risks);

  db.prepare(`
    INSERT INTO app_candidates (
      id, rank, title, target_users_json, problem,
      daily_use_level, substitute_level, substitutes_json,
      core_mvp_features_json, api_sources_json, provider,
      implementation_difficulty, monetization_json, risks_json,
      project_slug, company_name, suggested_project_path, status,
      created_at, updated_at
    ) VALUES (
      @id, @rank, @title, @target_users_json, @problem,
      @daily_use_level, @substitute_level, @substitutes_json,
      @core_mvp_features_json, @api_sources_json, @provider,
      @implementation_difficulty, @monetization_json, @risks_json,
      @project_slug, @company_name, @suggested_project_path, @status,
      @now, @now
    )
  `).run({
    id,
    rank: input.rank ?? null,
    title: clamp(input.title, MAX_TITLE),
    target_users_json: targetUsers.length ? JSON.stringify(targetUsers) : null,
    problem: clamp(input.problem, MAX_LONG) || null,
    daily_use_level: input.dailyUseLevel ?? null,
    substitute_level: input.substituteLevel ?? null,
    substitutes_json: substitutes.length ? JSON.stringify(substitutes) : null,
    core_mvp_features_json: coreMvpFeatures.length ? JSON.stringify(coreMvpFeatures) : null,
    api_sources_json: apiSources.length ? JSON.stringify(apiSources) : null,
    provider: input.provider ?? null,
    implementation_difficulty: input.implementationDifficulty ?? null,
    monetization_json: monetization.length ? JSON.stringify(monetization) : null,
    risks_json: risks.length ? JSON.stringify(risks) : null,
    project_slug: projectSlug,
    company_name: clamp(input.companyName ?? input.title, MAX_TITLE) || null,
    suggested_project_path:
      clamp(input.suggestedProjectPath ?? `~/workspace/source-code/dorothy-apps/${projectSlug}`, MAX_LONG) || null,
    status,
    now,
  });

  return getAppCandidate(id);
}

export function getAppCandidate(id: string): AppCandidate | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM app_candidates WHERE id = ?').get(id) as AppCandidateRow | undefined;
  return row ? rowToCandidate(row) : null;
}

export function getAppCandidateBySlug(projectSlug: string): AppCandidate | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM app_candidates WHERE project_slug = ? ORDER BY created_at DESC LIMIT 1')
    .get(projectSlug) as AppCandidateRow | undefined;
  return row ? rowToCandidate(row) : null;
}

function clampLimit(n: number | undefined): number {
  const v = n ?? DEFAULT_LIMIT;
  if (v <= 0) return DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

export function listAppCandidates(opts: ListAppCandidatesOptions = {}): AppCandidate[] {
  const db = getDorothyDb();
  if (!db) return [];
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.status) {
    if (Array.isArray(opts.status)) {
      const ph = opts.status.map((_, i) => `@st${i}`);
      opts.status.forEach((s, i) => { params[`st${i}`] = s; });
      where.push(`status IN (${ph.join(',')})`);
    } else { where.push('status = @status'); params.status = opts.status; }
  }
  if (opts.implementationDifficulty) {
    if (Array.isArray(opts.implementationDifficulty)) {
      const ph = opts.implementationDifficulty.map((_, i) => `@diff${i}`);
      opts.implementationDifficulty.forEach((d, i) => { params[`diff${i}`] = d; });
      where.push(`implementation_difficulty IN (${ph.join(',')})`);
    } else { where.push('implementation_difficulty = @diff'); params.diff = opts.implementationDifficulty; }
  }
  const limit = clampLimit(opts.limit);
  const offset = opts.offset ?? 0;
  const sql = `
    SELECT * FROM app_candidates
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY (rank IS NULL), rank ASC, created_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `;
  const rows = db.prepare(sql).all({ ...params, limit, offset }) as AppCandidateRow[];
  return rows.map(rowToCandidate);
}

export interface UpdateAppCandidateStatusInput {
  id: string;
  status: AppCandidateStatus;
}

export function updateAppCandidateStatus(input: UpdateAppCandidateStatusInput): AppCandidate | null {
  const db = getDorothyDb();
  if (!db) return null;
  const current = getAppCandidate(input.id);
  if (!current) return null;
  const now = new Date().toISOString();
  db.prepare('UPDATE app_candidates SET status = @status, updated_at = @now WHERE id = @id')
    .run({ id: input.id, status: input.status, now });
  return getAppCandidate(input.id);
}

/* ============================================================================
 * AppFactoryPlan — preview generation (no side effects) + persistence
 * ========================================================================== */

/** The canonical process-agent pipeline used for Kanban preview tasks. */
const PIPELINE: Array<{ ownerAgentId: string; titleSuffix: string; ac: (c: AppCandidate) => string[] }> = [
  {
    ownerAgentId: 'intake-planner',
    titleSuffix: 'MVP 요구사항 정리',
    ac: c => [
      `대상 사용자(${c.targetUsers.join(', ') || '미지정'})와 문제 정의를 요구사항으로 정리`,
      'MVP 범위 / 비범위를 명확히 구분',
      `핵심 기능 ${c.coreMvpFeatures.length}개를 우선순위화`,
    ],
  },
  {
    ownerAgentId: 'architect-plan',
    titleSuffix: '앱 구조 설계',
    ac: () => [
      'Next.js frontend + lightweight backend/API route 구조 결정',
      '데이터 수집(ingestion) 모듈과 정규화 모델 경계 정의',
      'ADR 후보 식별(공공데이터 갱신 주기, 캐싱 전략)',
    ],
  },
  {
    ownerAgentId: 'contract-agent',
    titleSuffix: 'API 계약 설계',
    ac: () => [
      'search/detail/filter 엔드포인트 요청·응답 계약 정의',
      '에러코드 및 빈 결과/좌표 누락 케이스 명세',
      'FE/BE 공유 DTO 초안 작성(구현 코드는 작성하지 않음)',
    ],
  },
  {
    ownerAgentId: 'database-agent',
    titleSuffix: '데이터 모델 설계',
    ac: c => [
      `${c.title} 핵심 엔티티 및 정규화 위치 모델 설계`,
      '공공데이터 → 내부 모델 매핑/마이그레이션 계획(실행 없음)',
      '좌표/필터 인덱스 전략 초안',
    ],
  },
  {
    ownerAgentId: 'backend',
    titleSuffix: '데이터 ingestion + search API',
    ac: () => [
      '공공데이터 ingestion 모듈 + 정규화 파이프라인 구현',
      '위치/필터 기반 search API 구현 + 테스트',
      'API key/secret은 환경변수로만 취급(저장·로그 금지)',
    ],
  },
  {
    ownerAgentId: 'frontend',
    titleSuffix: '지도/list/filter UI',
    ac: c => [
      `지도/리스트 + 필터 패널(${c.coreMvpFeatures.slice(0, 3).join(', ') || '핵심 필터'}) UI 구현`,
      '빈 상태/로딩/에러 상태 처리',
      '데이터 출처/최신성 안내 표시',
    ],
  },
  {
    ownerAgentId: 'security-reviewer',
    titleSuffix: 'API key / 위치정보 / 공공데이터 출처 검토',
    ac: () => [
      'API key·secret 노출 경로 점검(로그/번들/응답)',
      '위치정보 수집·이용 고지 및 최소수집 원칙 검토',
      '공공데이터 라이선스/출처 표기 적절성 검토',
    ],
  },
  {
    ownerAgentId: 'qa-reviewer',
    titleSuffix: '필터/빈상태/모바일 테스트',
    ac: () => [
      '필터 조합·빈 결과·좌표 누락 케이스 테스트',
      '모바일 반응형/접근성 점검',
      'acceptance criteria 대비 회귀 검증',
    ],
  },
  {
    ownerAgentId: 'devops-reporter',
    titleSuffix: '구현 보고서 작성',
    ac: () => [
      '구현 결과 보고서(result-report.md) 작성',
      '남은 위험/후속 작업 정리',
      '배포 준비 체크리스트(실 배포는 별도 승인)',
    ],
  },
];

function buildKanbanPreviewTasks(candidate: AppCandidate): AppFactoryKanbanPreviewTask[] {
  return PIPELINE.map((step, i) => ({
    id: `preview-${i + 1}-${step.ownerAgentId}`,
    title: `${step.ownerAgentId}: ${step.titleSuffix}`,
    ownerAgentId: step.ownerAgentId,
    description: `[${candidate.title}] ${step.titleSuffix} — 프리뷰 단계(실제 작업/파일 생성 없음).`,
    acceptanceCriteria: step.ac(candidate),
    order: i + 1,
  }));
}

/**
 * Build an in-memory AppFactoryPlan preview for a candidate. NEVER persists,
 * never creates files / repos / Kanban tasks. Returns null when the candidate
 * does not exist (or the DB is unavailable).
 */
export function generateAppFactoryPlanPreview(appCandidateId: string): AppFactoryPlan | null {
  const candidate = getAppCandidate(appCandidateId);
  if (!candidate) return null;

  const now = new Date().toISOString();
  const apiList = candidate.apiSources.map(s => `${s.name} (${s.provider})`).join(', ') || '공개 API 출처 확인 필요';

  const suggestedArchitecture = [
    '- Next.js frontend',
    '- API route 또는 lightweight backend',
    `- ${candidate.title} 데이터 ingestion module`,
    '- normalized data/location model',
    '- map/list UI',
    '- filter panel',
    '- source freshness notice',
  ].join('\n');

  return {
    id: uuidv4(),
    appCandidateId: candidate.id,
    summary:
      `${candidate.title} MVP 자동 구현 계획 프리뷰. 대상: ${candidate.targetUsers.join(', ') || '미지정'}. ` +
      `데이터 출처: ${apiList}. (이 단계는 프리뷰이며 실제 코드/Kanban을 생성하지 않습니다.)`,
    suggestedArchitecture,
    mvpScope: candidate.coreMvpFeatures.length
      ? [...candidate.coreMvpFeatures]
      : ['위치 기반 검색', '핵심 필터', '상세/길찾기 링크', '데이터 출처 안내'],
    outOfScope: [
      '사용자 계정/로그인',
      '실시간 이용 가능 여부 보장',
      '결제/유료 기능',
      '관리자 백오피스',
    ],
    dataModelDraft: [
      `${candidate.projectSlug} 위치/항목 엔티티(좌표, 이름, 카테고리, 운영시간, 편의시설 플래그)`,
      '데이터 출처/수집 시각 메타',
      '필터 인덱스(좌표, 카테고리, 플래그)',
    ],
    apiContractDraft: [
      'POST/GET search: 위치/반경/필터 → 항목 목록',
      'GET detail: id → 단일 항목 상세',
      'GET meta: 데이터 출처/최신성',
    ],
    kanbanPreviewTasks: buildKanbanPreviewTasks(candidate),
    riskPolicy: [
      ...(candidate.risks ?? []),
      'API key/secret은 저장·로그 금지(환경변수만)',
      '공공데이터 출처/라이선스 표기 필수',
      '실제 이용 가능 여부는 보장하지 않음(고지)',
      '실 배포/외부 게시는 별도 사용자 승인 게이트',
    ],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

export interface CreateAppFactoryPlanInput {
  appCandidateId: string;
  /** When omitted, the preview is generated from the candidate. */
  plan?: Omit<AppFactoryPlan, 'id' | 'appCandidateId' | 'createdAt' | 'updatedAt' | 'status'> & {
    status?: AppFactoryPlanStatus;
  };
}

/**
 * Persist an AppFactoryPlan row (the preview the operator chose to keep).
 * Still creates NO Kanban tasks / files / repos.
 */
export function createAppFactoryPlan(input: CreateAppFactoryPlanInput): AppFactoryPlan | null {
  const db = getDorothyDb();
  if (!db) return null;
  const candidate = getAppCandidate(input.appCandidateId);
  if (!candidate) return null;

  const base = input.plan ?? generateAppFactoryPlanPreview(input.appCandidateId);
  if (!base) return null;

  const id = uuidv4();
  const now = new Date().toISOString();
  const status: AppFactoryPlanStatus = (input.plan?.status as AppFactoryPlanStatus) ?? 'draft';
  const previewTasks = Array.isArray(base.kanbanPreviewTasks) ? base.kanbanPreviewTasks.slice(0, 50) : [];

  db.prepare(`
    INSERT INTO app_factory_plans (
      id, app_candidate_id, summary, suggested_architecture,
      mvp_scope_json, out_of_scope_json, data_model_draft_json,
      api_contract_draft_json, kanban_preview_tasks_json, risk_policy_json,
      status, created_at, updated_at
    ) VALUES (
      @id, @candidate_id, @summary, @arch,
      @mvp_scope_json, @out_of_scope_json, @data_model_draft_json,
      @api_contract_draft_json, @kanban_preview_tasks_json, @risk_policy_json,
      @status, @now, @now
    )
  `).run({
    id,
    candidate_id: input.appCandidateId,
    summary: clamp(base.summary, MAX_LONG * 2),
    arch: clamp(base.suggestedArchitecture, MAX_LONG * 2),
    mvp_scope_json: JSON.stringify(normList(base.mvpScope, 50)),
    out_of_scope_json: JSON.stringify(normList(base.outOfScope, 50)),
    data_model_draft_json: JSON.stringify(normList(base.dataModelDraft, 50)),
    api_contract_draft_json: JSON.stringify(normList(base.apiContractDraft, 50)),
    kanban_preview_tasks_json: JSON.stringify(previewTasks),
    risk_policy_json: JSON.stringify(normList(base.riskPolicy, 50)),
    status,
    now,
  });

  // Reflect planning progress on the candidate (best-effort, non-destructive).
  if (candidate.status === 'candidate' || candidate.status === 'selected') {
    try { updateAppCandidateStatus({ id: candidate.id, status: 'kanban_previewed' }); } catch { /* ignore */ }
  }

  return getAppFactoryPlan(id);
}

export function getAppFactoryPlan(id: string): AppFactoryPlan | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM app_factory_plans WHERE id = ?').get(id) as AppFactoryPlanRow | undefined;
  return row ? rowToPlan(row) : null;
}

export interface ListAppFactoryPlansOptions {
  appCandidateId?: string;
  status?: AppFactoryPlanStatus | AppFactoryPlanStatus[];
  limit?: number;
  offset?: number;
}

export function listAppFactoryPlans(opts: ListAppFactoryPlansOptions = {}): AppFactoryPlan[] {
  const db = getDorothyDb();
  if (!db) return [];
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.appCandidateId) { where.push('app_candidate_id = @cid'); params.cid = opts.appCandidateId; }
  if (opts.status) {
    if (Array.isArray(opts.status)) {
      const ph = opts.status.map((_, i) => `@st${i}`);
      opts.status.forEach((s, i) => { params[`st${i}`] = s; });
      where.push(`status IN (${ph.join(',')})`);
    } else { where.push('status = @status'); params.status = opts.status; }
  }
  const limit = clampLimit(opts.limit);
  const offset = opts.offset ?? 0;
  const sql = `
    SELECT * FROM app_factory_plans
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `;
  const rows = db.prepare(sql).all({ ...params, limit, offset }) as AppFactoryPlanRow[];
  return rows.map(rowToPlan);
}

/* ============================================================================
 * Seed — first sample candidate "공중화장실 편의시설 찾기"
 * ========================================================================== */

export const PUBLIC_TOILET_FINDER_SEED: CreateAppCandidateInput = {
  title: '공중화장실 편의시설 찾기',
  rank: 1,
  targetUsers: ['임산부', '부모', '장애인', '외근자'],
  problem: '외출 중 사용할 수 있는 화장실, 기저귀교환대, 장애인화장실, 24시간 화장실을 빠르게 찾기 어렵다.',
  dailyUseLevel: 'high',
  substituteLevel: 'weak',
  substitutes: ['포털 지도 검색', '카카오/네이버 지도'],
  coreMvpFeatures: [
    '위치 기반 주변 화장실 검색',
    '24시간 필터',
    '장애인 화장실 필터',
    '어린이용 / 기저귀교환대 필터',
    '길찾기 링크',
    '데이터 출처 / 최신성 안내',
  ],
  apiSources: [
    {
      name: '전국공중화장실표준데이터',
      provider: '행정안전부/지자체',
      url: 'https://www.data.go.kr/data/15012892/standard.do',
      requiresApiKey: false,
      notes: 'requiresApiKey 실제 여부는 발급 페이지에서 확인 필요',
    },
  ],
  provider: 'claude',
  implementationDifficulty: 'easy',
  monetization: ['지역 광고', '지자체 제휴'],
  risks: ['좌표 정확도', '개방시간 최신성', '실제 이용 가능 여부 보장 금지'],
  projectSlug: 'public-toilet-finder',
  companyName: 'Public Toilet Finder',
  suggestedProjectPath: '~/workspace/source-code/dorothy-apps/public-toilet-finder',
  status: 'candidate',
};

/**
 * Idempotently seed the first sample candidate. Returns the candidate (existing
 * or newly created), or null when the DB is unavailable.
 */
export function seedDefaultAppCandidates(): { seeded: boolean; candidate: AppCandidate | null } {
  const db = getDorothyDb();
  if (!db) return { seeded: false, candidate: null };
  const existing = getAppCandidateBySlug(PUBLIC_TOILET_FINDER_SEED.projectSlug);
  if (existing) return { seeded: false, candidate: existing };
  const candidate = createAppCandidate(PUBLIC_TOILET_FINDER_SEED);
  return { seeded: !!candidate, candidate };
}

export interface AppFactoryCounts {
  candidate: number;
  planning: number;
  previewed: number;
  ready: number;
  building: number;
  shipped: number;
  total: number;
  plans: number;
}

export function countAppFactory(): AppFactoryCounts {
  const empty: AppFactoryCounts = {
    candidate: 0, planning: 0, previewed: 0, ready: 0, building: 0, shipped: 0, total: 0, plans: 0,
  };
  const db = getDorothyDb();
  if (!db) return empty;
  type Row = { status: string; n: number };
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM app_candidates GROUP BY status').all() as Row[];
  for (const r of rows) {
    empty.total += r.n;
    switch (r.status) {
      case 'candidate': empty.candidate = r.n; break;
      case 'planning': empty.planning = r.n; break;
      case 'kanban_previewed': empty.previewed = r.n; break;
      case 'ready_to_build': empty.ready = r.n; break;
      case 'building': empty.building = r.n; break;
      case 'shipped': empty.shipped = r.n; break;
    }
  }
  const planRow = db.prepare('SELECT COUNT(*) AS n FROM app_factory_plans').get() as { n: number } | undefined;
  empty.plans = planRow?.n ?? 0;
  return empty;
}
