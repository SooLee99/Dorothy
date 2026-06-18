/**
 * Phase 6-AU — 스킬 자기개선 제안 순수 로직 테스트.
 */
import { describe, it, expect } from 'vitest';
import {
  isLowRiskTarget, isHighRiskTarget, classifyRisk, slugify, proposalsFromKanban,
} from '../../src/lib/skillProposals';

describe('skillProposals 안전 분류', () => {
  it('isLowRiskTarget: <skill>/references/learned/<name>.md 만 저위험', () => {
    expect(isLowRiskTarget('harness/references/learned/lint-rerun.md')).toBe(true);
    expect(isLowRiskTarget('harness/SKILL.md')).toBe(false);
    expect(isLowRiskTarget('harness/references/team.md')).toBe(false);
    expect(isLowRiskTarget('../escape.md')).toBe(false);
    expect(isLowRiskTarget('/etc/passwd')).toBe(false);
  });

  it('isHighRiskTarget: SKILL.md/agents/경로이탈은 고위험', () => {
    expect(isHighRiskTarget('harness/SKILL.md')).toBe(true);
    expect(isHighRiskTarget('foo/agents/bar.md')).toBe(true);
    expect(isHighRiskTarget('../x')).toBe(true);
    expect(isHighRiskTarget('harness/references/learned/x.md')).toBe(false);
  });

  it('classifyRisk: 보안 키워드/위험 경로는 high, learned 신규는 low', () => {
    expect(classifyRisk({ type: 'reference-note', relTarget: 'harness/references/learned/x.md', title: '린트 자동화' })).toBe('low');
    expect(classifyRisk({ type: 'reference-note', relTarget: 'harness/references/learned/x.md', title: 'JWT token 처리' })).toBe('high');
    expect(classifyRisk({ type: 'edit-agent', relTarget: 'foo/agents/a.md', title: 'x' })).toBe('high');
    expect(classifyRisk({ type: 'edit-skill', relTarget: 'harness/SKILL.md', title: 'x' })).toBe('high');
  });

  it('slugify: 라벨 제거+소문자+하이픈', () => {
    expect(slugify('[스킬후보] 린트 재실행 자동화')).toMatch(/린트-재실행-자동화/);
    expect(slugify('')).toBe('note');
  });

  it('proposalsFromKanban: [스킬후보]만, done 제외, slug 중복 제거, 전부 low', () => {
    const tasks = [
      { title: '[스킬후보] 린트 재실행 자동화', description: 'rerun lint', column: 'backlog' },
      { title: '[스킬후보] 린트 재실행 자동화', description: 'dup', column: 'backlog' },
      { title: '[스킬후보] 보안 토큰 점검', description: 'auth token', column: 'backlog' },
      { title: '일반 작업', description: 'x', column: 'backlog' },
      { title: '[스킬후보] 완료된 것', description: 'x', column: 'done' },
    ];
    const ps = proposalsFromKanban(tasks, '2026-06-07T00:00:00Z');
    expect(ps.length).toBe(2); // dup 1개 제거, done 제외, 일반 제외
    expect(ps.every(p => p.relTarget.startsWith('harness/references/learned/'))).toBe(true);
    // 보안 키워드 후보는 high 로 분류(자동적용 안 됨)
    const sec = ps.find(p => p.title.includes('보안'));
    expect(sec?.riskLevel).toBe('high');
    const lint = ps.find(p => p.title.includes('린트'));
    expect(lint?.riskLevel).toBe('low');
  });
});
