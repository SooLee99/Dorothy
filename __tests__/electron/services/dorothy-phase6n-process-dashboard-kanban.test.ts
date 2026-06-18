/**
 * Dorothy MVP Phase 6-N — process-based display + Korean labels + diagrams.
 *
 * Pure renderer modules (no React, no DB, no spawn). Verifies the display
 * registry, Korean label maps, and process diagram data.
 */

import { describe, it, expect } from 'vitest';

describe('Phase 6-N — process display registry', () => {
  it('maps core agentIds to Korean process names', async () => {
    const m = await import('../../../src/lib/agentProcessDisplay');
    expect(m.processDisplayName('backend')).toBe('백엔드 개발 에이전트');
    expect(m.processDisplayName('frontend')).toBe('프론트엔드 개발 에이전트');
    expect(m.processDisplayName('qa-reviewer')).toBe('QA·리뷰 에이전트');
    expect(m.processDisplayName('devops-reporter')).toBe('문서·보고/DevOps 에이전트');
    expect(m.processDisplayName('contract-agent')).toBe('계약/API 설계 에이전트');
    expect(m.processDisplayName('database-agent')).toBe('데이터베이스 에이전트');
    expect(m.processDisplayName('pm')).toBe('기획 관리자 / PM');
  });

  it('matches legacy aliases (qa, docs, project-manager, korean names)', async () => {
    const m = await import('../../../src/lib/agentProcessDisplay');
    expect(m.processDisplayName('qa')).toBe('QA·리뷰 에이전트');
    expect(m.processDisplayName('docs')).toBe('문서·보고/DevOps 에이전트');
    expect(m.processDisplayName('project-manager')).toBe('기획 관리자 / PM');
    expect(m.processDisplayName('QA')).toBe('QA·리뷰 에이전트');
  });

  it('unknown agent falls back to id / provided fallback', async () => {
    const m = await import('../../../src/lib/agentProcessDisplay');
    expect(m.processDisplayName('totally-unknown')).toBe('totally-unknown');
    expect(m.processDisplayName('totally-unknown', '폴백명')).toBe('폴백명');
    expect(m.lookupProcessDisplay('totally-unknown')).toBeNull();
  });

  it('process display carries input/output/next agents', async () => {
    const m = await import('../../../src/lib/agentProcessDisplay');
    const be = m.lookupProcessDisplay('backend')!;
    expect(be.inputKo.length).toBeGreaterThan(0);
    expect(be.outputKo.length).toBeGreaterThan(0);
    expect(be.nextAgents).toContain('qa-reviewer');
    expect(be.phaseKo).toBe('백엔드 개발');
  });
});

describe('Phase 6-N — Korean labels', () => {
  it('RunState / blocker / idle reason maps render Korean', async () => {
    const m = await import('../../../src/lib/koreanLabels');
    expect(m.RUN_STATE_KO.approval_required).toBe('승인 대기');
    expect(m.DISPATCH_BLOCKER_KO.provider_model_mismatch).toBe('프로바이더/모델 불일치');
    expect(m.DISPATCH_BLOCKER_KO.no_pending_runstep).toBe('할당 작업 없음');
    expect(m.DISPATCH_BLOCKER_KO.claude_binary_missing).toBe('Claude 실행 경로 문제');
    expect(m.IDLE_REASON_KO.waiting_for_approval).toBe('승인 대기');
  });

  it('koLabel falls back to the raw value for unknown keys', async () => {
    const m = await import('../../../src/lib/koreanLabels');
    expect(m.koLabel({ a: 'A' } as Record<string, string>, 'b')).toBe('b');
    expect(m.koLabel({ a: 'A' } as Record<string, string>, 'a')).toBe('A');
  });

  it('has 16 process phases', async () => {
    const m = await import('../../../src/lib/koreanLabels');
    expect(m.PROCESS_PHASES_KO).toHaveLength(16);
    expect(m.PROCESS_PHASES_KO[0]).toBe('요청 접수');
    expect(m.PROCESS_PHASES_KO[15]).toBe('완료');
  });
});

describe('Phase 6-N — process diagrams (Korean)', () => {
  it('global diagram uses Korean labels for non-agent nodes', async () => {
    const m = await import('../../../src/components/AgentWorkflowDiagrams/processDefinitions');
    const g = m.getGlobalDiagram();
    const byId = new Map(g.nodes.map(n => [n.id, n] as const));
    expect(byId.get('request')!.label).toBe('요청 접수');
    expect(byId.get('approval')!.label).toBe('승인 대기');
    expect(byId.get('qa')!.label).toBe('QA·리뷰');
    expect(byId.get('qa')!.agentId).toBe('qa-reviewer');
  });

  it('each core agent has an agent diagram with an agentId', async () => {
    const m = await import('../../../src/components/AgentWorkflowDiagrams/processDefinitions');
    const ids = m.getAgentDiagrams().map(d => d.agentId);
    for (const a of ['intake-planner', 'architect-plan', 'plan-validator', 'orchestrator', 'contract-agent', 'database-agent', 'frontend', 'backend', 'qa-reviewer', 'devops-reporter']) {
      expect(ids).toContain(a);
    }
  });
});
