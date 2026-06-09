/**
 * PR-2-U0 — Phase 2 컴포넌트 공통 순수 표시 로직(React 무관 → node 단위테스트 가능).
 *
 * ★Ground-truth 강제:
 *   - evidenceView: verified===true 일 때만 tone='success'(초록). kanban done 이어도 verified 아니면 절대 초록 아님(G1).
 *   - probeView: 서버가 up:true 줄 때만 '응답함'(G2). 예측/주장 만들지 않음.
 *   - 부재(observed:false) → '확인 불가'(G4). 낙관 기본값 0.
 */

export type Tone = 'success' | 'neutral' | 'unknown' | 'danger';

/** badges.tsx 컨벤션과 동일한 칩 색(테두리 포함). */
export const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  neutral: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  unknown: 'bg-muted text-muted-foreground border-border',
  danger: 'bg-rose-500/10 text-rose-500 border-rose-500/30',
};

interface Obs { observed?: boolean; reason?: string }

// ── EvidenceChip (G1) ──────────────────────────────────────────────
export interface EvidenceLike extends Obs {
  verified?: boolean;
  basis?: { observed?: boolean; value?: string; reason?: string };
}
export function evidenceView(e?: EvidenceLike): { tone: Tone; label: string; basis: string | null } {
  if (!e || !e.observed) return { tone: 'unknown', label: '확인 불가', basis: null };
  if (e.verified === true) {
    const basis = e.basis?.observed ? (e.basis.value ?? '근거 있음') : null;
    return { tone: 'success', label: '검증됨', basis };
  }
  return { tone: 'neutral', label: '미검증', basis: null };
}

// ── ProjectCard fe/be (G2) ─────────────────────────────────────────
export interface ProbeLike extends Obs {
  up?: boolean;
  port?: number | null;
  latencyMs?: number;
  status?: number;
}
export function probeView(p?: ProbeLike): { tone: Tone; text: string } {
  if (!p || !p.observed) return { tone: 'unknown', text: '확인 불가' };
  if (p.up) {
    const lat = p.latencyMs != null ? ` · ${p.latencyMs}ms` : '';
    return { tone: 'success', text: `응답함 (:${p.port ?? '?'}${lat})` };
  }
  return { tone: 'danger', text: `미응답${p.reason ? ` (${p.reason})` : ''}` };
}

// ── ProjectCard git (G3) ───────────────────────────────────────────
export interface GitLike extends Obs {
  branch?: string | null;
  ahead?: number | null;
  behind?: number | null;
  dirty?: number;
  lastCommit?: { hash?: string; msg?: string; at?: string } | null;
  checkedAt?: string;
}
export function gitView(g?: GitLike) {
  if (!g || !g.observed) return { observed: false as const, text: '확인 불가' };
  return {
    observed: true as const,
    branch: g.branch ?? '(no branch)',
    ahead: g.ahead ?? null,
    behind: g.behind ?? null,
    dirty: g.dirty ?? 0,
    lastCommit: g.lastCommit ?? null,
    checkedAt: g.checkedAt ?? null,
  };
}

// ── ReadonlyTerminal (Phase 0 /output 소비) ────────────────────────
export interface OutputResp {
  meta?: { serverNow?: string };
  data?: {
    sessionId?: string;
    lines?: { idx: number; text: string }[];
    lastOutputAt?: { observed?: boolean; ts?: string; reason?: string };
    output?: { observed?: boolean; byteCount?: number; lineCount?: number; reason?: string };
    readOnly?: boolean;
    tailOnly?: boolean;
  } | null;
}
/** /output 응답 → 표시 상태. nowMs 는 호출자 시각(상대시간 계산). */
export function terminalView(resp: OutputResp | null, nowMs: number) {
  const data = resp?.data ?? null;
  const lines = Array.isArray(data?.lines) ? data!.lines : [];
  const loObs = data?.lastOutputAt?.observed === true && !!data?.lastOutputAt?.ts;
  let secondsSince: number | null = null;
  let activity: 'recent' | 'silent' | 'unknown' = 'unknown';
  if (loObs) {
    const t = new Date(data!.lastOutputAt!.ts!).getTime();
    if (!Number.isNaN(t)) {
      secondsSince = Math.max(0, Math.round((nowMs - t) / 1000));
      activity = secondsSince < 30 ? 'recent' : 'silent'; // ★recent|silent only(advancing/progress 금지)
    }
  }
  const byteCount = data?.output?.observed === true ? (data!.output!.byteCount ?? null) : null;
  return { lines, secondsSince, activity, byteCount, hasOutputAt: loObs };
}

// ── project↔task 조인 (U1 카드 클릭 필터) ──────────────────────────
/** projectPath 의 마지막 경로 조각(=repo basename). task.project 와 동일 파생. */
export function taskRepoBasename(projectPath?: string | null): string | null {
  if (!projectPath || typeof projectPath !== 'string') return null;
  const parts = projectPath.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}
/**
 * task 가 capsule(=프로젝트)에 속하나? ★task.projectId(observed:false) 가 아니라
 * task.projectPath basename 이 capsule.repos(capsule paths basename, 명시 정의)에 포함될 때만 true.
 * repos 부재(조인 불가) → false(거짓 필터 금지 — 호출부에서 '매핑 확인 불가' 처리).
 */
export function matchesCapsule(projectPath: string | undefined | null, repos: string[] | null | undefined): boolean {
  if (!Array.isArray(repos) || repos.length === 0) return false;
  const bn = taskRepoBasename(projectPath);
  return bn != null && repos.includes(bn);
}
