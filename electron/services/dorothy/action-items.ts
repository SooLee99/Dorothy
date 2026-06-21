/**
 * 사용자 처리 사항(Action Items) — "에이전트가 못 고치고 ★사람만 처리할 것"의 단일 목록.
 *
 * 출처: ~/.dorothy/runtime/escalations.jsonl 중 ★user-action KIND 만 추린다(escalate.sh 가 기록).
 *   EXTERNAL_API_BLOCKER / NEEDS_SECRET / NEEDS_APPROVAL / NEEDS_INPUT
 *   (UNVERIFIED_DONE·STALE_APPROVAL·SOAK_VIOLATION 등 시스템/에이전트측 신호는 ★제외 — 여긴 사람 몫만)
 *
 * 슬랙 보고(escalate.sh→slack-alert-tick)와 ★같은 원본을 읽어 대시보드 전용 화면에 모은다(같은 진실).
 * read-only 집계 + 해결표시(resolve)만. 에이전트 자동 처리 없음(정의상 사람 몫).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ESC_FILE = path.join(os.homedir(), '.dorothy', 'runtime', 'escalations.jsonl');
const RESOLVED_FILE = path.join(os.homedir(), '.dorothy', 'runtime', 'action-items-resolved.json');

/** 사람만 처리 가능한 escalation 종류(=Action Item). 그 외 kind 는 이 화면에 안 뜬다. */
export const USER_ACTION_KINDS = ['EXTERNAL_API_BLOCKER', 'NEEDS_SECRET', 'NEEDS_APPROVAL', 'NEEDS_INPUT'] as const;
const KIND_SET = new Set<string>(USER_ACTION_KINDS);

export interface ActionItem {
  id: string;            // approvalId(안정 ID) 또는 kind+detail 파생
  kind: string;
  detail: string;
  project: string | null;
  role: string | null;
  agent: string | null;
  source: string | null;
  firstAt: string | null; // 처음 보고된 시각
  lastAt: string | null;  // 마지막 보고 시각
  count: number;          // 같은 항목 반복 보고 횟수
  resolved: boolean;
  resolvedAt: string | null;
}

interface ResolvedEntry { id: string; at: string }

function readResolved(): Map<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(RESOLVED_FILE, 'utf8'));
    const arr: ResolvedEntry[] = Array.isArray(raw) ? raw : [];
    return new Map(arr.map((r) => [r.id, r.at]));
  } catch {
    return new Map();
  }
}

function writeResolved(map: Map<string, string>): void {
  fs.mkdirSync(path.dirname(RESOLVED_FILE), { recursive: true });
  const arr: ResolvedEntry[] = [...map.entries()].map(([id, at]) => ({ id, at }));
  fs.writeFileSync(RESOLVED_FILE, JSON.stringify(arr, null, 2));
}

/** escalations.jsonl 한 줄 → 안정 id. approvalId 우선, 없으면 kind+detail. */
function itemId(rec: { approvalId?: unknown; kind?: unknown; detail?: unknown }): string {
  if (typeof rec.approvalId === 'string' && rec.approvalId) return rec.approvalId;
  return `${String(rec.kind ?? '?')}|${String(rec.detail ?? '')}`.slice(0, 200);
}

/**
 * 사용자 처리 사항 목록. user-action kind 만 필터 → id 로 dedup(반복 보고는 count/last 갱신).
 * resolved 표시된 항목은 resolved=true 로 포함(기본은 호출부에서 미해결만 보여줄 수 있음).
 */
export function getActionItems(): ActionItem[] {
  const resolved = readResolved();
  const byId = new Map<string, ActionItem>();

  let lines: string[] = [];
  try { lines = fs.readFileSync(ESC_FILE, 'utf8').split('\n'); } catch { return []; }

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(t); } catch { continue; }
    const kind = String(rec.kind ?? '');
    if (!KIND_SET.has(kind)) continue; // ★사람 몫 종류만

    const id = itemId(rec);
    const at = typeof rec.at === 'string' ? rec.at : null;
    const existing = byId.get(id);
    if (existing) {
      existing.count += 1;
      if (at && (!existing.lastAt || at > existing.lastAt)) existing.lastAt = at;
      if (at && (!existing.firstAt || at < existing.firstAt)) existing.firstAt = at;
    } else {
      byId.set(id, {
        id, kind,
        detail: String(rec.detail ?? ''),
        project: (rec.project as string) ?? null,
        role: (rec.role as string) ?? null,
        agent: (rec.agent as string) ?? null,
        source: (rec.source as string) ?? null,
        firstAt: at, lastAt: at, count: 1,
        resolved: resolved.has(id),
        resolvedAt: resolved.get(id) ?? null,
      });
    }
  }

  // 최신 보고 순(미해결 먼저, 그다음 최신)
  return [...byId.values()].sort((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
    return (b.lastAt ?? '').localeCompare(a.lastAt ?? '');
  });
}

/** 사람이 처리 완료 표시(또는 해제). nowIso 는 호출부가 전달(메인 프로세스 시각). */
export function setActionItemResolved(id: string, resolved: boolean, nowIso: string): { ok: boolean; id: string; resolved: boolean } {
  const map = readResolved();
  if (resolved) map.set(id, nowIso);
  else map.delete(id);
  writeResolved(map);
  return { ok: true, id, resolved };
}
