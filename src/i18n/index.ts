// Tiny dependency-free i18n helper. Defaults to Korean (ko).
import { ko } from './ko';

export { ko };
export type { KoStrings } from './ko';

// Resolve a dotted key path like "nav.dashboard" against the ko table.
// Falls back to the key itself if not found.
export function t(key: string): string {
  const parts = key.split('.');
  let cur: unknown = ko;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return key;
    }
  }
  return typeof cur === 'string' ? cur : key;
}
