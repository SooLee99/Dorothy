/**
 * Phase 6-AH — provider policy + integration secret-safety.
 */

import { describe, it, expect } from 'vitest';
import {
  applyPolicyToAgent,
  auditProviders,
  desiredProvider,
  CLAUDE_DEV_AGENTS,
  CODEX_PROCESS_AGENTS,
} from '../../src/lib/providerPolicy';

const BASELINE_11 = [...CLAUDE_DEV_AGENTS, ...CODEX_PROCESS_AGENTS];

describe('providerPolicy', () => {
  it('keeps backend/frontend on claude', () => {
    expect(desiredProvider('backend')).toBe('claude');
    expect(desiredProvider('frontend')).toBe('claude');
  });

  it('puts the 8 core process agents + security-reviewer on codex', () => {
    for (const id of ['intake-planner', 'architect-plan', 'orchestrator', 'plan-validator',
      'contract-agent', 'database-agent', 'qa-reviewer', 'devops-reporter', 'security-reviewer']) {
      expect(desiredProvider(id)).toBe('codex');
    }
  });

  it('blanks a Claude-family model on codex agents (no opus to codex)', () => {
    const out = applyPolicyToAgent({ id: 'orchestrator', provider: 'claude', model: 'opus' });
    expect(out.provider).toBe('codex');
    expect(out.model).toBe('');
  });

  it('keeps claude dev agents and their model untouched', () => {
    const out = applyPolicyToAgent({ id: 'backend', provider: 'claude', model: 'opus' });
    expect(out.provider).toBe('claude');
    expect(out.model).toBe('opus');
  });

  it('does not touch non-baseline agents', () => {
    const legacy = { id: '484bb96c-0cbd-4783-96f0-a6575f5d72f6', provider: 'codex', model: 'opus' };
    const out = applyPolicyToAgent(legacy);
    expect(out).toEqual(legacy); // unchanged
  });

  it('full apply → audit: 11 count, 2 claude, 9 codex, 0 mismatch, 0 legacy', () => {
    const agents = BASELINE_11.map(id => ({ id, provider: 'claude', model: '' }));
    const applied = agents.map(applyPolicyToAgent);
    const audit = auditProviders(applied);
    expect(audit.count).toBe(11);
    expect(audit.claude.sort()).toEqual(['backend', 'frontend']);
    expect(audit.codex.length).toBe(9);
    expect(audit.codexClaudeModelMismatch).toHaveLength(0);
    expect(audit.legacyUuid).toHaveLength(0);
  });

  it('is idempotent', () => {
    const once = applyPolicyToAgent({ id: 'qa-reviewer', provider: 'claude', model: 'sonnet' });
    const twice = applyPolicyToAgent(once);
    expect(twice).toEqual(once);
    expect(twice.provider).toBe('codex');
    expect(twice.model).toBe('');
  });
});
