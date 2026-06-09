import { describe, it, expect } from 'vitest';
import { evaluateAlerts, passesQuietHours, evaluateKanbanProgress, DEFAULT_THRESHOLDS, type AlertSignal, type AlertState } from '../../electron/core/observability/slack-alert';

const empty = (): AlertState => ({ activeKeys: {} });
const sig = (over: Partial<AlertSignal> = {}): AlertSignal => ({ silentAgents: [], providersLimited: [], pausedSeconds: null, escalations: [], ...over });
const now = '2026-06-10T00:00:00.000Z';

describe('Slack(A) — evaluateAlerts (실측 신호 + 임계 + dedupe + 해제)', () => {
  it('silent < 임계 → 알림 없음', () => {
    const r = evaluateAlerts(sig({ silentAgents: [{ agentId: 'backend', silentSeconds: 120 }] }), empty(), now);
    expect(r.fire).toEqual([]);
  });
  it('silent ≥ 임계(10분) → warn 발송', () => {
    const r = evaluateAlerts(sig({ silentAgents: [{ agentId: 'backend', silentSeconds: 700 }] }), empty(), now);
    expect(r.fire.length).toBe(1);
    expect(r.fire[0].severity).toBe('warn');
    expect(r.fire[0].text).toContain('backend');
  });
  it('★dedupe: 이미 active 면 재발송 안 함', () => {
    const prev: AlertState = { activeKeys: { 'silent:backend': { since: now } } };
    const r = evaluateAlerts(sig({ silentAgents: [{ agentId: 'backend', silentSeconds: 800 }] }), prev, now);
    expect(r.fire).toEqual([]); // 재발송 0
    expect(r.state.activeKeys['silent:backend']).toBeDefined(); // 유지
  });
  it('★해제: prev 에 있던 조건이 해소되면 resolved 알림', () => {
    const prev: AlertState = { activeKeys: { 'silent:backend': { since: now } } };
    const r = evaluateAlerts(sig({ silentAgents: [] }), prev, now); // 더 이상 silent 아님
    expect(r.resolved.length).toBe(1);
    expect(r.resolved[0].text).toContain('해결됨');
    expect(r.state.activeKeys['silent:backend']).toBeUndefined();
  });
  it('provider 프로브 확인 한도 → warn', () => {
    const r = evaluateAlerts(sig({ providersLimited: ['claude'] }), empty(), now);
    expect(r.fire.some((a) => a.key === 'limited:claude')).toBe(true);
  });
  it('pause ≥ 임계(30분) → warn', () => {
    expect(evaluateAlerts(sig({ pausedSeconds: 1000 }), empty(), now).fire).toEqual([]); // 미만
    expect(evaluateAlerts(sig({ pausedSeconds: 2000 }), empty(), now).fire.length).toBe(1); // 이상
  });
  it('escalation(사람 호출) → critical', () => {
    const r = evaluateAlerts(sig({ escalations: [{ kind: 'SECTION0_MIGRATION_PARK', detail: 'V9', at: now }] }), empty(), now);
    expect(r.fire[0].severity).toBe('critical');
    expect(r.fire[0].text).toContain('사람/승인 필요');
  });
});

describe('Slack(A) — evaluateKanbanProgress (★상태 전이만, 폭주 방지)', () => {
  const tasks = (m: Record<string, string>) => Object.entries(m).map(([id, column]) => ({ id, title: `T-${id}`, column }));
  it('첫 실행(prev 없음) → 스냅샷만, 이벤트 0(과거 전부 알리지 않음)', () => {
    const r = evaluateKanbanProgress(undefined, tasks({ a: 'ongoing', b: 'done' }));
    expect(r.events).toEqual([]);
    expect(r.state).toEqual({ a: 'ongoing', b: 'done' });
  });
  it('ongoing 진입 → "진행 시작", done 진입 → "완료"', () => {
    const prev = { a: 'planned', b: 'ongoing' };
    const r = evaluateKanbanProgress(prev, tasks({ a: 'ongoing', b: 'done' }));
    const keys = r.events.map((e) => e.key);
    expect(keys).toContain('kanban-ongoing:a');
    expect(keys).toContain('kanban-done:b');
    expect(r.events.find((e) => e.key === 'kanban-done:b')!.text).toContain('완료');
  });
  it('★변화 없으면 이벤트 0(dedupe — 이미 done 은 재알림 안 함)', () => {
    const prev = { a: 'done', b: 'ongoing' };
    const r = evaluateKanbanProgress(prev, tasks({ a: 'done', b: 'ongoing' }));
    expect(r.events).toEqual([]);
  });
  it('backlog→planned 같은 전이는 보고 안 함(노이즈 억제)', () => {
    const r = evaluateKanbanProgress({ a: 'backlog' }, tasks({ a: 'planned' }));
    expect(r.events).toEqual([]);
  });
});

describe('Slack(A) — passesQuietHours', () => {
  const quiet = { startHour: 22, endHour: 8 };
  it('critical 은 quiet 시간에도 통과', () => {
    expect(passesQuietHours('critical', 3, quiet)).toBe(true);
  });
  it('info/warn 은 quiet 시간(야간)엔 보류', () => {
    expect(passesQuietHours('info', 3, quiet)).toBe(false);
    expect(passesQuietHours('warn', 23, quiet)).toBe(false);
  });
  it('info/warn 은 주간엔 통과', () => {
    expect(passesQuietHours('warn', 14, quiet)).toBe(true);
  });
  it('quiet 미설정이면 전부 통과', () => {
    expect(passesQuietHours('info', 3)).toBe(true);
  });
});
