/**
 * Phase 6-AK — project isolation + capsule + kanban preview (pure).
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeProjectId,
  suggestProjectSlug,
  suggestProjectRootPath,
  suggestEnvNamespace,
  suggestVaultNamespace,
  suggestPorts,
  isSameProject,
  projectIdOrLegacy,
  buildCapsuleFromCandidate,
  generateKanbanPreview,
  PROJECT_ID_RE,
  RESERVED_PORTS,
  PROJECT_AGENT_FLOW,
} from '../../src/lib/projectIsolation';
import { ALL_OPERATION_AGENT_IDS } from '../../src/lib/agentProcessDisplay';

const CANDIDATE: any = {
  id: 'cand-1',
  title: '공중화장실 찾기',
  projectSlug: 'public-toilet-finder',
  companyName: 'toilet-co',
  suggestedProjectPath: '/Users/soo/workspace/source-code/apps/public-toilet-finder',
  apiSources: [{ name: '공공데이터', provider: 'data.go.kr', requiresApiKey: true }],
  coreMvpFeatures: ['지도', '검색'],
  risks: ['API key 노출 주의'],
  status: 'candidate',
  createdAt: 'x', updatedAt: 'x', targetUsers: [], problem: '', substitutes: [], monetization: [], order: 0,
};

describe('projectIsolation helpers', () => {
  it('normalizeProjectId slugifies safely', () => {
    expect(normalizeProjectId('Public Toilet Finder!')).toBe('public-toilet-finder');
    expect(normalizeProjectId('  a__b  ')).toBe('a-b');
    expect(normalizeProjectId('')).toBe('project');
  });

  it('env/vault namespaces never collide with triplan', () => {
    expect(suggestEnvNamespace('public-toilet-finder')).toBe('APP_PUBLIC_TOILET_FINDER');
    expect(suggestVaultNamespace('public-toilet-finder')).toBe('project:public-toilet-finder');
    expect(suggestProjectRootPath('public-toilet-finder')).toContain('/apps/public-toilet-finder');
  });

  it('ports are deterministic + away from triplan 3500/8080', () => {
    const p = suggestPorts('public-toilet-finder');
    expect(p).toEqual(suggestPorts('public-toilet-finder')); // deterministic
    expect(p.frontendPort).toBeGreaterThanOrEqual(3600);
    expect(p.frontendPort).toBeLessThan(3900);
    expect(p.backendPort).toBeGreaterThanOrEqual(8100);
    expect(p.backendPort).toBeLessThan(8400);
    expect(p.frontendPort).not.toBe(3500);
    expect(p.backendPort).not.toBe(8080);
  });

  it('isSameProject + projectIdOrLegacy fallback', () => {
    expect(isSameProject('Public Toilet', 'public-toilet')).toBe(true);
    expect(isSameProject('a', 'b')).toBe(false);
    expect(isSameProject(null, null)).toBe(false);
    expect(projectIdOrLegacy(undefined)).toBe('triplan');
    expect(projectIdOrLegacy('  ')).toBe('triplan');
    expect(projectIdOrLegacy('Foo Bar')).toBe('foo-bar');
  });

  it('buildCapsuleFromCandidate produces isolated namespaces (no side effects)', () => {
    const c = buildCapsuleFromCandidate(CANDIDATE, { id: 'cap-1', now: '2026-06-07T00:00:00Z' });
    expect(c.projectId).toBe('public-toilet-finder');
    expect(c.kanbanProjectId).toBe('public-toilet-finder');
    expect(c.envNamespace).toBe('APP_PUBLIC_TOILET_FINDER');
    expect(c.vaultNamespace).toBe('project:public-toilet-finder');
    expect(c.reportsPath).toContain('/reports/projects/public-toilet-finder');
    expect(c.logsPath).toContain('/logs/projects/public-toilet-finder');
    expect(c.rootPath).not.toContain('/triplan');
    expect(c.status).toBe('ready');
    expect(c.dataSources).toHaveLength(1);
    expect(c.mvpScope).toEqual(['지도', '검색']);
  });

  it('kanban preview tasks carry projectId + baseline ownerAgentId (no persistence)', () => {
    const c = buildCapsuleFromCandidate(CANDIDATE, { id: 'cap-1', now: 'x' });
    const preview = generateKanbanPreview(c);
    expect(preview.length).toBe(10);
    for (const t of preview) {
      expect(t.projectId).toBe('public-toilet-finder');
      expect(t.kanbanProjectId).toBe('public-toilet-finder');
      expect(ALL_OPERATION_AGENT_IDS).toContain(t.ownerAgentId);
    }
    // security-reviewer step requires approval (high risk)
    const sec = preview.find(t => t.ownerAgentId === 'security-reviewer');
    expect(sec?.requiresApproval).toBe(true);
    expect(sec?.riskLevel).toBe('high');
  });
});

describe('Phase 6-AS — 생성 마법사 검증 상수', () => {
  it('PROJECT_ID_RE: 영소문자/숫자/하이픈만 허용', () => {
    expect(PROJECT_ID_RE.test('public-toilet-finder')).toBe(true);
    expect(PROJECT_ID_RE.test('app1')).toBe(true);
    expect(PROJECT_ID_RE.test('Bad_ID!')).toBe(false);
    expect(PROJECT_ID_RE.test('대문자X')).toBe(false);
    expect(PROJECT_ID_RE.test('-leading')).toBe(false);
    expect(PROJECT_ID_RE.test('')).toBe(false);
  });

  it('RESERVED_PORTS 는 triplan 점유 포트를 포함하고, suggestPorts 결과와 겹치지 않는다', () => {
    expect(RESERVED_PORTS).toEqual(expect.arrayContaining([3000, 3500, 8080]));
    const p = suggestPorts('any-project-x');
    expect(RESERVED_PORTS).not.toContain(p.frontendPort);
    expect(RESERVED_PORTS).not.toContain(p.backendPort);
  });

  it('PROJECT_AGENT_FLOW 는 11개 기준선 에이전트를 읽기전용으로 표시', () => {
    expect(PROJECT_AGENT_FLOW.length).toBe(11);
    const ids = PROJECT_AGENT_FLOW.map(a => a.agentId);
    expect(ids).toContain('orchestrator');
    expect(ids).toContain('backend');
    expect(ids).toContain('security-reviewer');
    for (const a of PROJECT_AGENT_FLOW) expect(a.role.length).toBeGreaterThan(0);
  });
});
