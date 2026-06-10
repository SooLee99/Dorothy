/**
 * PR-Slack(A) — 아웃바운드 알림 평가(순수 로직). 발신/수집은 ~/.dorothy/scripts/slack-alert-tick.js.
 *
 * ★실측 신호 위에서만 알린다(self-report 금지): silent 지속·프로브 확인 한도·사람 호출(escalation)·정지 지속.
 * ★알림 피로 방지: 임계(지속)·dedupe(activeKeys 재발송 금지)·해제 알림(조건 해소 시 '해결됨').
 * ★발신 자체는 dispatch/관측과 무관(tick 격리). 순수 모듈(I/O 없음).
 */

export type Severity = 'info' | 'warn' | 'critical';

export interface AlertSignal {
  /** outputActivity=silent 인 에이전트와 지속 초. */
  silentAgents: { agentId: string; silentSeconds: number }[];
  /** 프로브로 ★확인된(예측 아님) limited provider 이름. */
  providersLimited: string[];
  /** safePause/EXTERNAL_PAUSE 지속 초(없으면 null). */
  pausedSeconds: number | null;
  /** 사람 호출 큐(최근 escalations) — kind+at 로 dedupe. */
  escalations: { kind: string; detail: string; at: string }[];
  /**
   * PR-감지A — "도는 척" 사각: MCP/대시보드(/api/agents in-memory)는 running 인데
   * 디스크(agents.json)는 idle 인 ★두 상태원 불일치가 무진행으로 지속된 에이전트.
   * mismatchSeconds = 디스크 lastActivity 이후 경과 초(무진행 지표). silentHint = 0a silent 관측 보강(선택).
   * ★감지/알림 전용 — 상태(running/idle)·완료판정·dispatch 를 바꾸지 않는다(읽기만).
   */
  mismatchAgents?: { agentId: string; mismatchSeconds: number; silentHint?: boolean }[];
}

export interface Alert { key: string; severity: Severity; text: string; }
export interface AlertState { activeKeys: Record<string, { since: string }>; }

export interface Thresholds { silentSeconds: number; pausedSeconds: number; mismatchSeconds: number; }
export const DEFAULT_THRESHOLDS: Thresholds = { silentSeconds: 600, pausedSeconds: 1800, mismatchSeconds: 600 }; // silent 10분, pause 30분, mismatch 10분(짧은 상태 전파 지연 오탐 방지)

/**
 * 현재 신호로부터 발송/해제 알림과 다음 상태를 계산.
 * fire   = 새로 충족된 조건(prev 에 없던 것) — dedupe(이미 활성이면 재발송 안 함).
 * resolved = prev 에 있었으나 지금 해소된 조건 — '해결됨' 알림(떠 있는 경보 닫기).
 */
export function evaluateAlerts(
  sig: AlertSignal,
  prev: AlertState,
  nowIso: string,
  th: Thresholds = DEFAULT_THRESHOLDS,
): { fire: Alert[]; resolved: Alert[]; state: AlertState } {
  const want = new Map<string, Alert>();

  for (const a of sig.silentAgents) {
    if (a.silentSeconds >= th.silentSeconds) {
      want.set(`silent:${a.agentId}`, { key: `silent:${a.agentId}`, severity: 'warn', text: `agent ${a.agentId} 출력 정지 ${Math.round(a.silentSeconds / 60)}분(silent)` });
    }
  }
  for (const p of sig.providersLimited) {
    want.set(`limited:${p}`, { key: `limited:${p}`, severity: 'warn', text: `provider ${p} 프로브 확인 한도(limited)` });
  }
  if (sig.pausedSeconds != null && sig.pausedSeconds >= th.pausedSeconds) {
    want.set('pause', { key: 'pause', severity: 'warn', text: `시스템 정지 ${Math.round(sig.pausedSeconds / 60)}분 지속` });
  }
  for (const e of sig.escalations) {
    const key = `esc:${e.kind}:${e.at}`;
    want.set(key, { key, severity: 'critical', text: `사람/승인 필요: ${e.kind} — ${e.detail}` });
  }
  // PR-감지A — "도는 척"(MCP running ↔ 디스크 idle) 불일치가 ★임계 이상 무진행으로 지속될 때만 알림.
  //   짧은 상태 전파 지연(정상 완료 직후)은 mismatchSeconds 임계로 거른다. dedupe/해제는 공통 메커니즘 재사용.
  for (const m of sig.mismatchAgents ?? []) {
    if (m.mismatchSeconds >= th.mismatchSeconds) {
      const mins = Math.round(m.mismatchSeconds / 60);
      const hint = m.silentHint ? '·출력 silent' : '';
      want.set(`mismatch:${m.agentId}`, {
        key: `mismatch:${m.agentId}`,
        severity: 'warn',
        text: `agent ${m.agentId}: MCP running 인데 디스크 idle·무진행 ${mins}분${hint}(빈 완료/조용한 실패 의심)`,
      });
    }
  }

  const prevKeys = new Set(Object.keys(prev?.activeKeys ?? {}));
  const fire: Alert[] = [];
  const resolved: Alert[] = [];

  for (const [k, alert] of want) {
    if (!prevKeys.has(k)) fire.push(alert); // 새 조건만(dedupe)
  }
  for (const k of prevKeys) {
    if (!want.has(k)) resolved.push({ key: k, severity: 'info', text: `해결됨: ${k}` });
  }

  const activeKeys: Record<string, { since: string }> = {};
  for (const [k] of want) activeKeys[k] = prev?.activeKeys?.[k] ?? { since: nowIso };

  return { fire, resolved, state: { activeKeys } };
}

// ── 칸반 진행 보고(이벤트성, 상태 전이만 — 폭주 방지) ──────────────
export interface KanbanTaskLite { id: string; title: string; column: string }

/**
 * 칸반 진행 이벤트(이전 스냅샷 대비 ★상태 전이만). 매 task 가 아니라 변화한 것만 → 폭주 방지.
 * 첫 실행(prev 비어있음)은 ★스냅샷만 잡고 이벤트 0(이전 상태 모름 → 과거를 전부 알리지 않음).
 *   ongoing 진입 = '진행 시작', done 진입 = '완료'. 그 외 전이는 보고 안 함(노이즈 억제).
 */
export function evaluateKanbanProgress(
  prev: Record<string, string> | undefined,
  curr: KanbanTaskLite[],
): { events: Alert[]; state: Record<string, string> } {
  const prevMap = prev ?? {};
  const hadPrev = Object.keys(prevMap).length > 0;
  const events: Alert[] = [];
  const state: Record<string, string> = {};
  for (const t of curr) {
    state[t.id] = t.column;
    if (!hadPrev) continue; // 첫 실행: 스냅샷만
    const was = prevMap[t.id];
    if (was && was !== t.column) {
      const title = (t.title || t.id).slice(0, 80);
      if (t.column === 'done') events.push({ key: `kanban-done:${t.id}`, severity: 'info', text: `✅ 완료: ${title}` });
      else if (t.column === 'ongoing' && was !== 'ongoing') events.push({ key: `kanban-ongoing:${t.id}`, severity: 'info', text: `▶ 진행 시작: ${title}` });
    }
  }
  return { events, state };
}

/** quiet hours(비긴급 야간 보류) — critical 은 항상 통과, info/warn 은 quiet 시간엔 보류. */
export function passesQuietHours(severity: Severity, hour: number, quiet?: { startHour: number; endHour: number }): boolean {
  if (severity === 'critical' || !quiet) return true;
  const { startHour, endHour } = quiet;
  const inQuiet = startHour <= endHour ? (hour >= startHour && hour < endHour) : (hour >= startHour || hour < endHour);
  return !inQuiet;
}
