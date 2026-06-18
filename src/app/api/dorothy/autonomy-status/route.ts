import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Part H / E-2 — 자율운영 상태 통합 노출(read-only).
 *   Part F/G/H 의 런타임 상태를 한 곳에 모아 대시보드가 표시:
 *   liveness 4-state(EXTERNAL_PAUSE 포함) / pause-reason 요약 / supervision 레벨 / trust / 예산 / provider 한도 /
 *   복구 circuit·scope 차단기 / 최근 에스컬레이션 / 최신 soak.
 */
const H = os.homedir();
const RT = path.join(H, '.dorothy', 'runtime');
const ST = path.join(H, '.dorothy', 'state');
function rj(p: string): unknown { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }
function tail(p: string, n: number): unknown[] {
  try { return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }); } catch { return []; }
}

export async function GET() {
  const liveness = rj(path.join(RT, 'liveness-state.json')) as { state?: string; suppressForceRecovery?: boolean; anomaly?: unknown; counts?: unknown } | null;
  const pause = rj(path.join(ST, 'pause-state.json')) as { units?: Record<string, { pauseReasons: { type: string; provider?: string }[] }> } | null;
  const rollout = rj(path.join(ST, 'rollout-state.json')) as { level?: string; driftMetrics?: unknown; soakGreen?: boolean } | null;
  const trust = rj(path.join(ST, 'trust-scores.json')) as { actions?: Record<string, { state?: string }> } | null;
  const budget = rj(path.join(RT, 'budget-state.json'));
  const providerLimit = rj(path.join(RT, 'provider-limit-state.json'));
  const recoveryCircuit = rj(path.join(ST, 'recovery-circuit.json'));
  const scopeBreakers = rj(path.join(ST, 'scope-breakers.json'));
  const soak = rj(path.join(ST, 'soak-last.json'));
  const bootRecovery = rj(path.join(ST, 'boot-recovery-state.json'));
  const killSwitch = fs.existsSync(path.join(RT, 'kill-switch.flag'));
  const configDegraded = fs.existsSync(path.join(RT, 'config-degraded.flag'));
  const wakeCatchup = rj(path.join(RT, 'wake-catchup.json'));
  const escalations = tail(path.join(RT, 'escalations.jsonl'), 20);

  // pause-reason 타입별 집계.
  const reasonCounts: Record<string, number> = {};
  let pausedUnits = 0;
  if (pause?.units) {
    for (const u of Object.values(pause.units)) {
      pausedUnits++;
      for (const r of u.pauseReasons || []) reasonCounts[r.type] = (reasonCounts[r.type] || 0) + 1;
    }
  }

  return NextResponse.json({
    liveness: liveness ? { state: liveness.state, suppressForceRecovery: liveness.suppressForceRecovery, anomaly: liveness.anomaly, counts: liveness.counts } : null,
    pause: { pausedUnits, reasonCounts },
    supervision: { level: rollout?.level ?? null, soakGreen: rollout?.soakGreen ?? null, drift: rollout?.driftMetrics ?? null },
    trust: trust?.actions ?? null,
    budget,
    providerLimit,
    recoveryCircuit,
    scopeBreakers,
    soak,
    bootRecovery,
    flags: { killSwitch, configDegraded, wakeCatchup: !!(wakeCatchup as { active?: boolean } | null)?.active },
    escalations,
    at: new Date().toISOString(),
  });
}
