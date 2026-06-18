/**
 * PR-0a — B1 세션 신호(read-only). "진짜 도는지"를 *관측된 사실*로 노출.
 *
 *   GET /api/sessions                     — baseline 11 세션의 ptyAlive·lastOutputAt·byteCount·outputActivity
 *   GET /api/sessions/:id/output          — 마스킹된 tail-only 출력(§1.2 출구: idx cursor 미구현)
 *
 * 불변(§7 가드):
 *   - self-report 로 running/available 칠하지 않음 — ptyAlive(ptyProcesses.has)·lastOutputAt(실측 계측)만.
 *   - taskId 는 §1.3 미충족(kanban 존재 검증 경로 없음) → observed:false(mapping-uncertain) ★영구.
 *   - outputActivity 는 recent|silent 만(advancing/progress 금지). byteCount 는 전진이 아님.
 *   - 응답에 'running:true' 류 필드를 ★두지 않는다.
 */
import { agents } from '../../core/agent-manager';
import { ptyProcesses } from '../../core/pty-manager';
import { SNAPSHOT_BASELINE_IDS, isSnapshotBaselineAgent, terminalLines } from '../../core/terminal-output-mask';
import { envelope, observed, unknown, serverNow, maskSecrets } from '../../core/observability';
import { getMetricsByAgent, computeActivity } from '../../core/observability/session-metrics';
import { RouteApp, RouteContext } from './types';

function ptyAlive(ptyId: string | undefined): boolean {
  return typeof ptyId === 'string' && ptyId.length > 0 ? ptyProcesses.has(ptyId) : false;
}

function buildSession(agentId: string, serverNowMs: number) {
  const agent = agents.get(agentId);
  const ptyId = agent?.ptyId;
  const hasPty = typeof ptyId === 'string' && ptyId.length > 0;
  const alive = ptyAlive(ptyId);
  const m = getMetricsByAgent(agentId);

  // derived — 순수 computeActivity(②: 제어 테스트 가능). 계측 없으면 unknown.
  const { activity: outputActivity, secondsSince: secondsSinceLastOutput } = computeActivity(m?.lastOutputAtMs, serverNowMs);

  return {
    sessionId: hasPty ? ptyId : `no-pty:${agentId}`,
    agentId,
    // project: projectPath 는 agents.json 실측 → observed:true. 없으면 source-missing.
    project: agent?.projectPath ? observed({ value: agent.projectPath }) : unknown('source-missing'),
    // taskId: §1.3 미충족 → 영구 observed:false. (currentTask 는 자유문자열이라 taskId 아님)
    taskId: unknown('mapping-uncertain'),
    provider: agent?.provider ? observed({ value: agent.provider }) : unknown('source-missing'),
    // pty: 생존은 ptyProcesses.has 실측. pid 는 계측에 있으면.
    pty: hasPty
      ? observed({ alive, pid: m?.ptyPid ?? null })
      : unknown('source-missing'),
    lastOutputAt: m?.lastOutputAt ? observed({ ts: m.lastOutputAt }) : unknown('probe-pending'),
    output: m
      ? observed({ byteCount: m.byteCount, lineCount: m.lineCount })
      : unknown('probe-pending'),
    exit: m?.exitCode != null ? observed({ code: m.exitCode, at: m.exitedAt }) : unknown('probe-pending'),
    derived: { secondsSinceLastOutput, outputActivity },
    // ★running 류 필드 없음(가드).
  };
}

export function registerSessionsRoutes(app_: RouteApp, _ctx: RouteContext): void {
  // GET /api/sessions — baseline 11 세션 신호.
  app_.get('/api/sessions', (req, sendJson) => {
    const now = serverNow();
    const sessions = SNAPSHOT_BASELINE_IDS.map((id) => buildSession(id, now.epochMs));
    sendJson(envelope({ sessions }, { sources: ['agent-manager'] }));
  });

  // GET /api/sessions/:id/output — read-only, masked, tail-only.
  // (MUST register the more specific /output before /:id catch-alls if added later.)
  app_.get(/^\/api\/sessions\/([^/]+)\/output$/, (req, sendJson) => {
    const id = req.params.id;
    if (!isSnapshotBaselineAgent(id)) {
      sendJson(envelope(null, { sources: ['agent-manager'], partial: true }), 404);
      return;
    }
    const agent = agents.get(id);
    const cap = Math.min(5000, Math.max(1, parseInt(req.url.searchParams.get('lines') || '200', 10)));
    const m = getMetricsByAgent(id);

    // 기존 terminalLines(ANSI strip + maskLine) → 강화 maskSecrets 한 번 더(과마스킹).
    const lines = terminalLines(agent?.output, cap).map((text, i) => ({
      idx: i,                 // ★응답 내 상대 순번일 뿐, 단조 cursor 아님(아래 cursor 참고)
      text: maskSecrets(text),
    }));

    sendJson(
      envelope(
        {
          sessionId: agent?.ptyId ?? `no-pty:${id}`,
          agentId: id,
          lines,
          lineCountReturned: lines.length,
          tailOnly: true,
          readOnly: true,
          lastOutputAt: m?.lastOutputAt ? observed({ ts: m.lastOutputAt }) : unknown('probe-pending'),
          output: m ? observed({ byteCount: m.byteCount, lineCount: m.lineCount }) : unknown('probe-pending'),
          // §1.2 출구: 증분 cursor 는 buffer 가 단조 idx 를 안 줘서 미구현(tail-only).
          cursor: unknown('not-implemented'),
        },
        { sources: ['agent-manager'] },
      ),
    );
  });
}
