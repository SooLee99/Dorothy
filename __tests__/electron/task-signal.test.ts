import { describe, it, expect } from 'vitest';
import {
  toTaskSummary, toTaskDetail,
  deriveApprovalRequired, deriveHeldAmbiguous, projectName,
} from '../../electron/core/observability/task-signal';

describe('PR-2-S1 — task-signal', () => {
  describe('deriveApprovalRequired (labels 도출, approval-queue.md 부재)', () => {
    it('게이트 라벨 있고 non-gate 없음 → true', () => {
      expect(deriveApprovalRequired(['approval-required'])).toBe(true);
      expect(deriveApprovalRequired(['user-gate', 'api'])).toBe(true);
    });
    it('non-gate 라벨이 있으면 게이트 라벨이 있어도 false', () => {
      expect(deriveApprovalRequired(['gated', 'non-gated'])).toBe(false);
      expect(deriveApprovalRequired(['non-gate'])).toBe(false);
    });
    it('게이트 라벨 없음 → false', () => {
      expect(deriveApprovalRequired(['api', 'frontend'])).toBe(false);
      expect(deriveApprovalRequired([])).toBe(false);
    });
  });

  it('deriveHeldAmbiguous — blocked/held류 라벨', () => {
    expect(deriveHeldAmbiguous(['backend-blocked'])).toBe(true);
    expect(deriveHeldAmbiguous(['on-hold'])).toBe(true);
    expect(deriveHeldAmbiguous(['api'])).toBe(false);
  });

  it('projectName — projectPath basename', () => {
    expect(projectName('/Users/soo/workspace/source-code/triplan/triplan-frontend')).toBe('triplan-frontend');
    expect(projectName('triplan')).toBe('triplan');
    expect(projectName(undefined)).toBeNull();
  });

  describe('toTaskSummary', () => {
    it('observed 필드 + projectId는 observed:false(mapping-uncertain)', () => {
      const s = toTaskSummary({
        id: 'abc', title: 'T', column: 'ongoing', assignedAgentId: 'backend',
        projectPath: '/x/triplan-frontend', labels: ['approval-required'], priority: 'high',
      });
      expect(s.status).toBe('ongoing');
      expect(s.owner).toEqual({ observed: true, value: 'backend' });
      expect(s.project).toEqual({ observed: true, value: 'triplan-frontend' });
      expect(s.projectId).toEqual({ observed: false, reason: 'mapping-uncertain' });
      expect(s.approvalRequired).toBe(true);
    });
    it('owner/project 부재 → observed:false', () => {
      const s = toTaskSummary({ id: 'x' });
      expect(s.owner.observed).toBe(false);
      expect(s.project.observed).toBe(false);
      expect(s.status).toBe('unknown');
    });
  });

  describe('toTaskDetail — ★G1: evidence.verified 항상 false(근거 미연결), 추측 0', () => {
    it('design.spec=description observed, contract/schema=source-missing', () => {
      const d = toTaskDetail({ id: 'x', description: 'GET /users/:id', completionSummary: '코드+테스트' });
      expect(d.design.spec).toEqual({ observed: true, value: 'GET /users/:id' });
      expect(d.design.contract.observed).toBe(false);
      expect(d.design.schema.observed).toBe(false);
      expect(d.design.doneCriteria).toEqual({ observed: true, value: '코드+테스트' });
    });
    it('evidence.verified=false + basis observed:false (주장 done 초록 0)', () => {
      const d = toTaskDetail({ id: 'x', column: 'done', labels: [] });
      expect(d.evidence.verified).toBe(false);
      expect(d.evidence.basis.observed).toBe(false);
    });
    it('artifacts/session 전부 observed:false (링크 없음)', () => {
      const d = toTaskDetail({ id: 'x' });
      expect(d.artifacts.files.observed).toBe(false);
      expect(d.artifacts.pr.observed).toBe(false);
      expect(d.session.observed).toBe(false);
      expect(d.session).toEqual({ observed: false, reason: 'mapping-uncertain' });
    });
  });
});
