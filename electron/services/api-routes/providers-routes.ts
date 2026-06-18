/**
 * PR-0b — provider 한도 '신호 노출만'(read-only, dispatcher 미변경).
 *
 *   GET /api/providers — predicted(provider-limit-state.json) vs probe(real-call) 분리 노출.
 *
 * ★불변식(provider-signal): available 은 실측 ok 일 때만. 예측 recoveryAt 도달만으론 금지.
 * ★dispatcher 안 건드림 — 판정을 어디에도 적용하지 않는다(노출만). 적용은 PR-0c(그림자→카나리).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agents } from '../../core/agent-manager';
import { getMetricsByAgent } from '../../core/observability/session-metrics';
import { envelope, observed, unknown, serverNow } from '../../core/observability';
import { computeProviderState } from '../../core/observability/provider-signal';
import { listRateLimitEvents } from '../dorothy/rate-limit-service';
import { RouteApp, RouteContext } from './types';

/** 세션 출력이 이 시간 내면 '실측 ok'(토큰 실소비 = 한도 아님). */
const PROBE_FRESH_MS = 30_000;
const PLS_PATH = path.join(os.homedir(), '.dorothy', 'runtime', 'provider-limit-state.json');

function readPLS(): Record<string, { limited?: boolean; cooldownUntil?: string | null }> | null {
  try { return JSON.parse(fs.readFileSync(PLS_PATH, 'utf8')); } catch { return null; }
}

/** 실측 ok: 그 provider 에이전트 세션 중 최근(<PROBE_FRESH) 출력이 있으면. */
function probeOkFor(provider: string, nowMs: number): { at: string; agentId: string } | null {
  for (const a of agents.values()) {
    const p = a.provider || 'claude';
    if (p !== provider) continue;
    const m = getMetricsByAgent(a.id);
    if (m?.lastOutputAtMs != null && m.lastOutputAt && (nowMs - m.lastOutputAtMs) < PROBE_FRESH_MS) {
      return { at: m.lastOutputAt, agentId: a.id };
    }
  }
  return null;
}

/** 실측 limited: 그 provider(engine) 미해소(active) 한도 이벤트가 있으면. */
function probeLimitedFor(provider: string): { at: string } | null {
  try {
    const ev = listRateLimitEvents({ engine: provider as never, active: true, limit: 5 });
    if (ev.length > 0) return { at: ev[0].detectedAt };
  } catch { /* db 부재 등 — limited 아님으로 처리 */ }
  return null;
}

export function registerProvidersRoutes(app_: RouteApp, _ctx: RouteContext): void {
  app_.get('/api/providers', (req, sendJson) => {
    const now = serverNow();
    const pls = readPLS();

    // 노출할 provider 집합: provider-limit-state 키(provider만) + agents 의 distinct provider.
    const names = new Set<string>(['claude', 'codex']);
    for (const a of agents.values()) if (a.provider) names.add(a.provider);

    const providers = Array.from(names).map((name) => {
      const plsP = pls?.[name];
      const predLimited = !!plsP?.limited;
      const predRecoveryAt = plsP?.cooldownUntil ?? null;

      const okHit = probeOkFor(name, now.epochMs);
      const limHit = okHit ? null : probeLimitedFor(name);
      const probeOk = !!okHit;
      const probeLimited = !!limHit;

      const state = computeProviderState({ probeOk, probeLimited, predLimited, predRecoveryAt });

      const predicted = (pls && plsP)
        ? observed({ limited: predLimited, recoveryAt: predRecoveryAt, source: 'provider-limit-state.json' })
        : unknown('source-missing');

      let probe;
      if (probeOk) {
        probe = observed({ result: 'ok', at: okHit!.at, source: 'real-call', via: 'session-activity' });
      } else if (probeLimited) {
        probe = observed({ result: 'limited', at: limHit!.at, source: 'real-call', via: 'rate-limit-events' });
      } else {
        probe = unknown('probe-pending');
      }

      return { name, state, predicted, probe };
    });

    sendJson(envelope({ providers }, {
      sources: ['provider-limit-state.json', 'rate-limit-events', 'session-activity'],
    }));
  });
}
