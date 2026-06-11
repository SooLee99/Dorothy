/**
 * Dorothy MVP Phase 6-W — App Factory service.
 *
 * Planning-only guarantees:
 *   - generateAppFactoryPlanPreview() persists nothing (no plan row).
 *   - Kanban preview tasks are plain data; no real Kanban task is created.
 *   - DB-unavailable paths no-op gracefully.
 *
 * Run under electron's node (better-sqlite3 ABI): ELECTRON_RUN_AS_NODE=1 electron vitest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { initDorothyDb, closeDorothyDb } from '../../../electron/services/dorothy/db';
import {
  createAppCandidate,
  listAppCandidates,
  getAppCandidate,
  getAppCandidateBySlug,
  updateAppCandidateStatus,
  generateAppFactoryPlanPreview,
  createAppFactoryPlan,
  listAppFactoryPlans,
  getAppFactoryPlan,
  seedDefaultAppCandidates,
  countAppFactory,
  PUBLIC_TOILET_FINDER_SEED,
} from '../../../electron/services/dorothy/app-factory-service';
import type { CreateAppCandidateInput } from '../../../electron/types/dorothy';

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase6w-${process.pid}`);
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let dbPath = '';

beforeEach(() => {
  closeDorothyDb();
  dbPath = path.join(TEST_DIR, `db-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const r = initDorothyDb({ filePath: dbPath });
  if (!r.ok) throw new Error(`initDorothyDb failed: ${r.reason}`);
});

afterEach(() => {
  closeDorothyDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

const SAMPLE: CreateAppCandidateInput = {
  title: '지역별 쓰레기 배출 가이드',
  rank: 3,
  targetUsers: ['1인 가구', '이사자'],
  problem: '지역마다 분리배출/요일이 달라 헷갈린다.',
  coreMvpFeatures: ['지역 선택', '품목 검색', '배출 요일 안내'],
  apiSources: [{ name: '생활폐기물 배출 표준데이터', provider: '지자체', requiresApiKey: false }],
  implementationDifficulty: 'easy',
  monetization: ['지역 광고'],
  risks: ['지자체별 데이터 편차'],
  projectSlug: 'waste-guide',
};

describe('Phase 6-W — AppCandidate CRUD', () => {
  it('create → get → list round-trips with arrays preserved', () => {
    const created = createAppCandidate(SAMPLE);
    expect(created).not.toBeNull();
    expect(created!.title).toBe(SAMPLE.title);
    expect(created!.projectSlug).toBe('waste-guide');
    expect(created!.status).toBe('candidate');
    expect(created!.targetUsers).toEqual(['1인 가구', '이사자']);
    expect(created!.apiSources[0].name).toBe('생활폐기물 배출 표준데이터');
    // default suggestedProjectPath derived from slug
    expect(created!.suggestedProjectPath).toContain('waste-guide');

    const got = getAppCandidate(created!.id);
    expect(got?.id).toBe(created!.id);

    const list = listAppCandidates();
    expect(list.map(c => c.id)).toContain(created!.id);
  });

  it('status transition candidate → planning', () => {
    const c = createAppCandidate(SAMPLE)!;
    expect(c.status).toBe('candidate');
    const updated = updateAppCandidateStatus({ id: c.id, status: 'planning' });
    expect(updated?.status).toBe('planning');
    expect(getAppCandidate(c.id)?.status).toBe('planning');
  });

  it('list filters by status', () => {
    const a = createAppCandidate(SAMPLE)!;
    createAppCandidate({ ...SAMPLE, title: 'Another', projectSlug: 'another' });
    updateAppCandidateStatus({ id: a.id, status: 'selected' });
    const selected = listAppCandidates({ status: 'selected' });
    expect(selected.map(c => c.id)).toEqual([a.id]);
  });
});

describe('Phase 6-W — public-toilet-finder seed', () => {
  it('seeds the sample candidate idempotently', () => {
    const first = seedDefaultAppCandidates();
    expect(first.seeded).toBe(true);
    expect(first.candidate?.projectSlug).toBe('public-toilet-finder');
    expect(first.candidate?.title).toBe('공중화장실 편의시설 찾기');
    expect(first.candidate?.coreMvpFeatures).toContain('24시간 필터');

    // second call does not duplicate
    const second = seedDefaultAppCandidates();
    expect(second.seeded).toBe(false);
    expect(second.candidate?.id).toBe(first.candidate?.id);

    const all = listAppCandidates();
    const toilets = all.filter(c => c.projectSlug === 'public-toilet-finder');
    expect(toilets.length).toBe(1);
    expect(getAppCandidateBySlug('public-toilet-finder')?.id).toBe(first.candidate?.id);
    // seed data integrity
    expect(PUBLIC_TOILET_FINDER_SEED.projectSlug).toBe('public-toilet-finder');
  });
});

describe('Phase 6-W — AppFactoryPlan preview (planning-only)', () => {
  it('generateAppFactoryPlanPreview returns a plan but persists NOTHING', () => {
    const c = createAppCandidate(SAMPLE)!;
    const preview = generateAppFactoryPlanPreview(c.id);
    expect(preview).not.toBeNull();
    expect(preview!.appCandidateId).toBe(c.id);
    expect(preview!.status).toBe('draft');
    expect(preview!.kanbanPreviewTasks.length).toBeGreaterThanOrEqual(9);
    expect(preview!.suggestedArchitecture).toContain('Next.js');
    expect(preview!.riskPolicy.some(r => /API key|secret/i.test(r))).toBe(true);

    // NOT persisted — listing plans is still empty
    expect(listAppFactoryPlans({ appCandidateId: c.id })).toEqual([]);
    expect(countAppFactory().plans).toBe(0);
  });

  it('kanban preview tasks are owned by process-baseline agents (no real Kanban task)', () => {
    const c = createAppCandidate(SAMPLE)!;
    const preview = generateAppFactoryPlanPreview(c.id)!;
    const owners = preview.kanbanPreviewTasks.map(t => t.ownerAgentId);
    expect(owners).toContain('intake-planner');
    expect(owners).toContain('backend');
    expect(owners).toContain('frontend');
    expect(owners).toContain('security-reviewer');
    expect(owners).toContain('qa-reviewer');
    expect(owners).toContain('devops-reporter');
    // every preview task carries acceptance criteria + a stable order
    for (const t of preview.kanbanPreviewTasks) {
      expect(t.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(typeof t.order).toBe('number');
    }
    // process-baseline only (no legacy UUID owners)
    expect(owners.some(o => /^[0-9a-f]{8}-/i.test(o))).toBe(false);
  });

  it('createAppFactoryPlan persists a plan row + advances candidate to kanban_previewed', () => {
    const c = createAppCandidate(SAMPLE)!;
    const plan = createAppFactoryPlan({ appCandidateId: c.id });
    expect(plan).not.toBeNull();
    expect(plan!.kanbanPreviewTasks.length).toBeGreaterThanOrEqual(9);

    const fetched = getAppFactoryPlan(plan!.id);
    expect(fetched?.id).toBe(plan!.id);
    expect(listAppFactoryPlans({ appCandidateId: c.id }).length).toBe(1);
    expect(countAppFactory().plans).toBe(1);

    // candidate advanced (best-effort)
    expect(getAppCandidate(c.id)?.status).toBe('kanban_previewed');
  });

  it('preview for a missing candidate returns null', () => {
    expect(generateAppFactoryPlanPreview('does-not-exist')).toBeNull();
  });
});

describe('Phase 6-W — DB unavailable graceful', () => {
  it('all reads/writes no-op when the DB is closed', () => {
    closeDorothyDb();
    expect(createAppCandidate(SAMPLE)).toBeNull();
    expect(listAppCandidates()).toEqual([]);
    expect(getAppCandidate('x')).toBeNull();
    expect(updateAppCandidateStatus({ id: 'x', status: 'planning' })).toBeNull();
    expect(generateAppFactoryPlanPreview('x')).toBeNull();
    expect(createAppFactoryPlan({ appCandidateId: 'x' })).toBeNull();
    expect(listAppFactoryPlans()).toEqual([]);
    expect(seedDefaultAppCandidates()).toEqual({ seeded: false, candidate: null });
    expect(countAppFactory().total).toBe(0);
    // re-init so afterEach close is harmless
    initDorothyDb({ filePath: dbPath });
  });
});
