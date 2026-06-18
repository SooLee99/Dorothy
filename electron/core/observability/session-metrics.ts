/**
 * PR-0a — PTY 세션 계측(메모리, hot-path).
 *
 * onData 에서 byteCount/lineCount/lastOutputAt 를 누적한다. ★디스크 I/O 없음(out-of-band).
 * AgentStatus 를 오염시키지 않도록 별도 Map(ptyId=sessionId 키)에 보관 → saveAgents 가
 * 디스크에 영속하지 않음. record* 는 절대 throw 하지 않는다(onData hot-path 보호).
 *
 * ★B1 한계: byteCount 증가 = '프로세스 생존 + 출력'까지. '유의미 전진'이 아니다
 *   (무한 루프가 에러를 토해도 증가). 따라서 outputActivity 는 recent|silent 만 노출하고
 *   advancing/progress 류 단어를 쓰지 않는다(net-progress 는 이후 Phase).
 *
 * 순수 모듈(electron/IPC import 없음) — server-clock 만 의존.
 */
import { serverNow } from './server-clock';

export interface SessionMetrics {
  sessionId: string;     // = ptyId
  agentId: string;
  ptyPid?: number;
  startedAt: string;     // ISO(단조 시계)
  startedAtMs: number;   // 단조 epoch
  seq: number;           // 생성 순번(같은 ms 동률에도 최신 식별 — getMetricsByAgent 용)
  lastOutputAt?: string; // ISO
  lastOutputAtMs?: number;
  byteCount: number;
  lineCount: number;
  exitCode?: number;
  exitedAt?: string;
}

/** sessionId(ptyId) → metrics. */
const metrics = new Map<string, SessionMetrics>();
/** 생성 순번(단조). 같은 ms 에 여러 세션이 시작돼도 최신을 구분. */
let _seq = 0;

/** Map 상한(무인 며칠 잦은 PTY 생성/종료에도 무한 증가 방지). */
const MAX_METRICS = 200;
/** outputActivity 판정 임계(초). recent < 이 값 ≤ silent. */
export const OUTPUT_IDLE_SECONDS = 30;

/**
 * cap: Map 이 상한을 넘으면 ★종료된(exitCode != null) 엔트리만 오래된(seq 작은) 것부터 제거.
 * 살아있는 세션과 ★방금 종료한 세션(seq 큰)은 보존 → 종료 직후 /sessions 조회 살림.
 */
function capIfNeeded(): void {
  if (metrics.size <= MAX_METRICS) return;
  const exited = [...metrics.values()].filter((m) => m.exitCode != null).sort((a, b) => a.seq - b.seq);
  let toRemove = metrics.size - MAX_METRICS;
  for (const m of exited) {
    if (toRemove <= 0) break;
    metrics.delete(m.sessionId);
    toRemove--;
  }
}

/**
 * outputActivity 순수 판정(②: 제어 테스트 가능). lastOutputAtMs 없으면 unknown.
 * secondsSince < idleSeconds → recent, 이상 → silent. ★recent|silent|unknown 만(advancing 금지).
 */
export function computeActivity(
  lastOutputAtMs: number | undefined | null,
  nowMs: number,
  idleSeconds: number = OUTPUT_IDLE_SECONDS,
): { activity: 'recent' | 'silent' | 'unknown'; secondsSince: number | null } {
  if (lastOutputAtMs == null) return { activity: 'unknown', secondsSince: null };
  const secondsSince = Math.max(0, Math.round((nowMs - lastOutputAtMs) / 1000));
  return { activity: secondsSince < idleSeconds ? 'recent' : 'silent', secondsSince };
}

/** PTY 생성 직후. ptyPid 는 node-pty IPty.pid(없으면 생략). */
export function recordStart(sessionId: string, agentId: string, ptyPid?: number): void {
  try {
    if (typeof sessionId !== 'string' || !sessionId) return;
    const now = serverNow();
    metrics.set(sessionId, {
      sessionId,
      agentId,
      ptyPid: typeof ptyPid === 'number' ? ptyPid : undefined,
      startedAt: now.iso,
      startedAtMs: now.epochMs,
      seq: ++_seq,
      byteCount: 0,
      lineCount: 0,
    });
    capIfNeeded(); // ③ 종료 엔트리 누적 방지(생성 시점에 cap)
  } catch { /* hot-path 보호: 절대 throw 안 함 */ }
}

/** onData chunk 1건. byteCount += utf8 길이, lineCount += 개행 수, lastOutputAt = now. */
export function recordOutput(sessionId: string, chunk: unknown): void {
  try {
    const m = metrics.get(sessionId);
    if (!m || typeof chunk !== 'string') return;
    m.byteCount += Buffer.byteLength(chunk, 'utf8');
    // 개행 수 — chunk 는 틱 단위로 작음(실질 O(1)). split 대신 charCode 스캔(할당 0).
    let nl = 0;
    for (let i = 0; i < chunk.length; i++) if (chunk.charCodeAt(i) === 10) nl++;
    m.lineCount += nl;
    const now = serverNow();
    m.lastOutputAt = now.iso;
    m.lastOutputAtMs = now.epochMs;
  } catch { /* hot-path 보호 */ }
}

/** PTY 종료. exitCode 기록(metrics 는 보존 — 종료 후에도 마지막 상태 조회 가능). */
export function recordExit(sessionId: string, exitCode: number): void {
  try {
    const m = metrics.get(sessionId);
    if (!m) return;
    m.exitCode = exitCode;
    m.exitedAt = serverNow().iso;
  } catch { /* */ }
}

export function getMetrics(sessionId: string): SessionMetrics | undefined {
  return metrics.get(sessionId);
}

/** 한 에이전트의 ★최신(startedAtMs 최대) 세션. 여러 PTY 가 있어도 가장 최근 것. */
export function getMetricsByAgent(agentId: string): SessionMetrics | undefined {
  let best: SessionMetrics | undefined;
  for (const m of metrics.values()) {
    if (m.agentId === agentId && (!best || m.seq > best.seq)) best = m;
  }
  return best;
}

export function deleteMetrics(sessionId: string): void {
  metrics.delete(sessionId);
}

export function allMetrics(): SessionMetrics[] {
  return Array.from(metrics.values());
}

/** 테스트 전용 — 전역 Map 초기화. */
export function __resetMetricsForTest(): void {
  metrics.clear();
  _seq = 0;
}
