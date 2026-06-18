/**
 * PR-0c — provider 가용성 그림자 모드(비교·기록 순수 로직).
 *
 * ★dispatch 절대 불변: 이 모듈은 dispatch 결정을 바꾸지 않는다(decisionUsed=predicted).
 *   recon 실측 — orchestrator-service.advanceRun/isAdvanceableRun 은 run.state 만 보고 provider 판정이 없다.
 *   따라서 dispatch 코드에 hook 을 끼우지 않고 ★독립 관측자(주기 스냅샷, probe-shadow-tick)가 /api/providers(0b)를
 *   읽어 predicted vs observed vs actual 을 비교·기록한다 → dispatch 코드 0줄 변경(최강 격리).
 *
 * §6 측정 한계: probe(real-call) 결과가 있을 때만 actualOutcome 으로 인정(meaningful).
 *   probe 없음(에이전트 미가동)은 ★게이트 분모 제외(counterfactual 추정 금지).
 *
 * 순수 모듈(I/O 없음 — 기록/조회는 ~/.dorothy/scripts/probe-shadow-tick.js).
 */

export interface ShadowDecision {
  ts: string;
  provider: string;
  /** 현재 dispatch 가 쓰는 예측(provider-limit-state). null=소스 없음. */
  predictedLimited: boolean | null;
  /** 0b state: available|limited|recovering|unknown. */
  observedState: string;
  /** 0b probe(real-call) 결과. null=probe-pending(결과 없음 → actualOutcome 없음). */
  probeResult: 'ok' | 'limited' | null;
  /** 전환 시 바뀔 결정인가(predicted 결정 ≠ observed 결정) = 0c 가치 지표. */
  wouldDiffer: boolean;
  /** ★실제 dispatch 는 predicted 그대로(기록만). */
  decisionUsed: 'predicted';
}

interface ProviderEntry {
  ts: string;
  provider: string;
  predicted?: { observed?: boolean; limited?: boolean };
  probe?: { observed?: boolean; result?: string };
  state?: string;
}

/** /api/providers 의 한 provider 항목 → ShadowDecision. dispatch 불변(decisionUsed=predicted). */
export function buildShadowDecision(e: ProviderEntry): ShadowDecision {
  const predictedLimited = e.predicted?.observed ? !!e.predicted.limited : null;
  const probeResult: 'ok' | 'limited' | null = e.probe?.observed
    ? (e.probe.result === 'limited' ? 'limited' : e.probe.result === 'ok' ? 'ok' : null)
    : null;
  // predicted 결정: limited 면 block, 아니면 allow(소스 없으면 allow=보수적 fallback 아님, 기록용).
  const predictedAllow = predictedLimited !== true;
  // observed 결정: state==available 만 allow(불변식). 그 외 block.
  const observedAllow = e.state === 'available';
  return {
    ts: e.ts,
    provider: e.provider,
    predictedLimited,
    observedState: e.state ?? 'unknown',
    probeResult,
    wouldDiffer: predictedAllow !== observedAllow,
    decisionUsed: 'predicted',
  };
}

export interface ShadowAggregate {
  total: number;
  /** actualOutcome(probe 결과) 채워진 비교 수 — §6: 게이트 분모. */
  meaningful: number;
  /** observed 결정이 actual(probe)과 부합한 비율(meaningful 기준). null=meaningful 0. */
  matchRate: number | null;
  /** ★observed=available 인데 actual=limited(429) — 목표 0. */
  falseOkCount: number;
  /** 전환 시 바뀔 결정 수/비율(가치 지표). */
  wouldDifferCount: number;
  wouldDifferRate: number;
}

export function aggregateShadow(decisions: ShadowDecision[]): ShadowAggregate {
  const total = decisions.length;
  const meaningfulDs = decisions.filter((d) => d.probeResult != null);
  const meaningful = meaningfulDs.length;
  let match = 0, falseOk = 0;
  for (const d of meaningfulDs) {
    const observedAllow = d.observedState === 'available';
    const actualOk = d.probeResult === 'ok';
    if (observedAllow === actualOk) match++;
    if (observedAllow && d.probeResult === 'limited') falseOk++; // false-ok 후보
  }
  const wouldDifferCount = decisions.filter((d) => d.wouldDiffer).length;
  return {
    total,
    meaningful,
    matchRate: meaningful > 0 ? match / meaningful : null,
    falseOkCount: falseOk,
    wouldDifferCount,
    wouldDifferRate: total > 0 ? wouldDifferCount / total : 0,
  };
}

/** 카나리 게이트 충족 판정(이번 PR 은 '시작'만 — 통과는 시간). */
export function shadowGatePassed(agg: ShadowAggregate, opts: { minMeaningful?: number; minMatchRate?: number } = {}): {
  passed: boolean;
  reasons: string[];
} {
  const minMeaningful = opts.minMeaningful ?? 500;
  const minMatchRate = opts.minMatchRate ?? 0.99;
  const reasons: string[] = [];
  if (agg.meaningful < minMeaningful) reasons.push(`meaningful ${agg.meaningful} < ${minMeaningful}(데이터 부족)`);
  if (agg.matchRate == null || agg.matchRate < minMatchRate) reasons.push(`matchRate ${agg.matchRate ?? 'n/a'} < ${minMatchRate}`);
  if (agg.falseOkCount > 0) reasons.push(`falseOk ${agg.falseOkCount} > 0`);
  return { passed: reasons.length === 0, reasons };
}
