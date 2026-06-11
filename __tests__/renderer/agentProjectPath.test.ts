/**
 * Phase 6-V — undefined-safe agent projectPath helpers.
 *
 * Regression guard for the `/agents` runtime crash:
 *   "Cannot read properties of undefined (reading 'split')"
 * caused by slug/file-based/live-session agents lacking projectPath.
 */

import { describe, it, expect } from 'vitest';
import {
  projectKey,
  projectLabel,
  safeLower,
  UNKNOWN_PROJECT_KEY,
  UNKNOWN_PROJECT_LABEL,
} from '../../src/lib/agentProjectPath';

describe('Phase 6-V — projectKey', () => {
  it('returns a stable key for a valid path', () => {
    expect(projectKey('/Users/soo/workspace/source-code/triplan')).toBe('/Users/soo/workspace/source-code/triplan');
  });
  it('falls back to the unknown key for undefined / null / empty / non-string', () => {
    expect(projectKey(undefined)).toBe(UNKNOWN_PROJECT_KEY);
    expect(projectKey(null)).toBe(UNKNOWN_PROJECT_KEY);
    expect(projectKey('')).toBe(UNKNOWN_PROJECT_KEY);
    expect(projectKey('   ')).toBe(UNKNOWN_PROJECT_KEY);
    expect(projectKey(42 as unknown)).toBe(UNKNOWN_PROJECT_KEY);
  });
});

describe('Phase 6-V — projectLabel', () => {
  it('extracts the basename from a valid path', () => {
    expect(projectLabel('/Users/soo/workspace/source-code/triplan/triplan-frontend')).toBe('triplan-frontend');
    expect(projectLabel('/a/b/triplan-travel-service')).toBe('triplan-travel-service');
  });
  it('handles trailing slashes', () => {
    expect(projectLabel('/a/b/triplan/')).toBe('triplan');
  });
  it('returns the 미지정 label for missing projectPath (no crash on undefined)', () => {
    expect(projectLabel(undefined)).toBe(UNKNOWN_PROJECT_LABEL);
    expect(projectLabel(null)).toBe(UNKNOWN_PROJECT_LABEL);
    expect(projectLabel('')).toBe(UNKNOWN_PROJECT_LABEL);
  });
});

describe('Phase 6-V — safeLower', () => {
  it('lowercases strings', () => {
    expect(safeLower('Backend')).toBe('backend');
  });
  it('returns empty string for non-strings (undefined name/provider safe)', () => {
    expect(safeLower(undefined)).toBe('');
    expect(safeLower(null)).toBe('');
    expect(safeLower(123 as unknown)).toBe('');
  });
});

describe('Phase 6-V — uniqueProjects grouping does not throw on undefined', () => {
  it('groups a mixed agent list (some without projectPath) without crashing', () => {
    const agents = [
      { projectPath: '/a/b/triplan-frontend' },
      { projectPath: undefined },
      { projectPath: '' },
      { projectPath: '/a/b/triplan-travel-service' },
    ];
    const set = new Map<string, string>();
    expect(() => {
      for (const a of agents) set.set(projectKey(a.projectPath), projectLabel(a.projectPath));
    }).not.toThrow();
    expect(set.get(UNKNOWN_PROJECT_KEY)).toBe(UNKNOWN_PROJECT_LABEL);
    expect(set.get('/a/b/triplan-frontend')).toBe('triplan-frontend');
  });
});
