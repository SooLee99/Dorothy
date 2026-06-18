/**
 * Phase 6-V — undefined-safe agent field helpers.
 *
 * Slug / file-based / live-session agents can have a missing or empty
 * `projectPath` (and other string fields). The dashboard must never assume
 * these are strings — calling `.split('/')` on `undefined` crashed `/agents`.
 * These pure helpers centralize the safe access so every screen behaves
 * consistently. No React / no path aliases → unit-testable in a node env.
 */

export const UNKNOWN_PROJECT_KEY = 'unknown';
export const UNKNOWN_PROJECT_LABEL = '프로젝트 미지정';

/** Stable non-empty grouping/filter key for a (possibly missing) projectPath. */
export function projectKey(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : UNKNOWN_PROJECT_KEY;
}

/** Human-readable project name from a (possibly missing) projectPath. */
export function projectLabel(value: unknown): string {
  const key = projectKey(value);
  if (key === UNKNOWN_PROJECT_KEY) return UNKNOWN_PROJECT_LABEL;
  return key.split('/').filter(Boolean).pop() || 'Unknown';
}

/** Lowercase a value only when it is a string; otherwise empty string. */
export function safeLower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}
