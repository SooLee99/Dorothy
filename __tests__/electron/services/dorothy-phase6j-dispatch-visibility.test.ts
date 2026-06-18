/**
 * Dorothy MVP Phase 6-J — dispatch readiness (dry-run visibility).
 *
 * Coverage: every DispatchBlockerReason branch + ready=true, plus the
 * guarantee that NO startAgent / PTY / Claude call happens (the service has no
 * such dependency — it is pure read-only diagnosis).
 */

import { describe, it, expect } from 'vitest';
import {
  computeDispatchReadiness,
  countDispatchReadiness,
} from '../../../electron/services/dorothy/agent-dispatch-readiness-service';
import type { AgentDefinition } from '../../../electron/services/dorothy/agent-definition-registry';
import type { Run, RunStep, ApprovalRequest, RateLimitEvent, Handoff, Plan } from '../../../electron/types/dorothy';

const RUN: Run = {
  id: 'run1', title: 't', source: 'user', priority: 'medium',
  state: 'running', createdAt: '2026-06-01T00:00:00Z', mode: 'team',
};

function def(id: string, over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id, displayName: id, source: 'claude_project_file',
    existsOnDisk: true, hasLiveSession: false, activeSessionCount: 0,
    canSpawn: true, isRegistered: true, isLiveLoaded: true, isSpawnable: true,
    ...over,
  };
}

function pendingStep(agentId: string, order = 0): RunStep {
  return { id: `st-${agentId}`, runId: 'run1', order, agentId, state: 'pending', retryCount: 0 };
}

function base(over: Parameters<typeof computeDispatchReadiness>[0] = {}) {
  return {
    agentIds: ['backend'],
    sessions: [], runs: [RUN], runSteps: [], approvals: [], rateLimitEvents: [],
    handoffs: [], plans: [] as Plan[], autoSpawnEnabled: true, autoResumeMode: 'live' as const,
    definitions: [def('backend')],
    ...over,
  };
}

describe('Phase 6-J — dispatch readiness', () => {
  it('no pending runstep → no_pending_runstep', () => {
    const [r] = computeDispatchReadiness(base({ runSteps: [] }));
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('no_pending_runstep');
  });

  it('agent not registered → agent_not_registered', () => {
    const [r] = computeDispatchReadiness(base({
      runSteps: [pendingStep('backend')],
      definitions: [def('backend', { isRegistered: false, isLiveLoaded: false, isSpawnable: false })],
    }));
    expect(r.reason).toBe('agent_not_registered');
  });

  it('registered but not live loaded → agent_not_live_loaded', () => {
    const [r] = computeDispatchReadiness(base({
      runSteps: [pendingStep('backend')],
      definitions: [def('backend', { isLiveLoaded: false, isSpawnable: false, spawnBlockReason: 'not_live_loaded' })],
    }));
    expect(r.reason).toBe('agent_not_live_loaded');
  });

  it('disabled → agent_not_spawnable', () => {
    const [r] = computeDispatchReadiness(base({
      runSteps: [pendingStep('backend')],
      definitions: [def('backend', { enabled: false, isSpawnable: false, spawnBlockReason: 'disabled' })],
    }));
    expect(r.reason).toBe('agent_not_spawnable');
  });

  it('approval required → approval_required', () => {
    const approval: ApprovalRequest = { id: 'a1', runId: 'run1', riskLevel: 'high', state: 'pending', createdAt: '2026-06-01T00:00:00Z' } as ApprovalRequest;
    const [r] = computeDispatchReadiness(base({ runSteps: [pendingStep('backend')], approvals: [approval] }));
    expect(r.reason).toBe('approval_required');
  });

  it('dependency missing → dependency_not_completed', () => {
    const steps: RunStep[] = [
      { id: 'st0', runId: 'run1', order: 0, agentId: 'frontend', state: 'pending', retryCount: 0 },
      pendingStep('backend', 1),
    ];
    const [r] = computeDispatchReadiness(base({ agentIds: ['backend'], runSteps: steps }));
    expect(r.reason).toBe('dependency_not_completed');
  });

  it('rate limited → rate_limited', () => {
    const rl: RateLimitEvent = { id: 'rl1', engine: 'claude', detectedAt: '2026-06-01T00:00:00Z', source: 'usage_scan', affectedRunIds: ['run1'] } as RateLimitEvent;
    const [r] = computeDispatchReadiness(base({ runSteps: [pendingStep('backend')], rateLimitEvents: [rl] }));
    expect(r.reason).toBe('rate_limited');
  });

  it('auto spawn disabled → auto_spawn_disabled', () => {
    const [r] = computeDispatchReadiness(base({ runSteps: [pendingStep('backend')], autoSpawnEnabled: false }));
    expect(r.reason).toBe('auto_spawn_disabled');
  });

  it('ready agent → ready true', () => {
    // single pending step, no blockers, spawnable agent, autospawn on.
    const [r] = computeDispatchReadiness(base({ runSteps: [pendingStep('backend')] }));
    expect(r.ready).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('handoff missing → handoff_missing', () => {
    const steps: RunStep[] = [
      { id: 'st0', runId: 'run1', order: 0, agentId: 'frontend', state: 'completed', retryCount: 0 },
      pendingStep('backend', 1),
    ];
    // prior completed but no handoff routed into the backend step
    const [r] = computeDispatchReadiness(base({ agentIds: ['backend'], runSteps: steps, handoffs: [] as Handoff[] }));
    expect(r.reason).toBe('handoff_missing');
  });

  it('countDispatchReadiness rolls up ready / blocked / byReason', () => {
    const items = computeDispatchReadiness(base({
      agentIds: ['backend', 'qa'],
      runSteps: [pendingStep('backend')],
      definitions: [def('backend'), def('qa')],
    }));
    const counts = countDispatchReadiness(items);
    expect(counts.total).toBe(2);
    // backend ready, qa has no pending step
    expect(counts.ready).toBe(1);
    expect(counts.byReason.no_pending_runstep).toBe(1);
  });
});
