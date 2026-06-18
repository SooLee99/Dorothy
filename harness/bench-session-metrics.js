#!/usr/bin/env node
/**
 * PR-0a closeout ① — recordOutput hot-path 벤치(일회성 측정).
 * onData 에 추가한 계측(byteCount+=utf8len; lineCount+=newlines; lastOutputAt=serverNow())의 per-call 비용을 잰다.
 * dist 모듈 사용(electron tsc emit 후). 측정값만 출력 — '영향 없음' 단정 금지.
 */
const path = require('path');
const SM = require(path.join(__dirname, '..', 'electron', 'dist', 'core', 'observability', 'session-metrics.js'));

function benchMs(fn, iters, reps = 9) {
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn(i);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]; // median
}

SM.__resetMetricsForTest();
SM.recordStart('bench', 'agent', 4242);

const N = 500000;
// 대표 청크: 4KB + 개행 다수(고출력 라인 스트림)
const chunk = 'x'.repeat(4096) + '\n'.repeat(8);

// 워밍업
for (let i = 0; i < 20000; i++) SM.recordOutput('bench', chunk);

const withMetric = benchMs(() => SM.recordOutput('bench', chunk), N);
const noop = benchMs(() => { /* 루프 오버헤드 baseline */ }, N);

const perCallUs = (withMetric / N) * 1000;
const deltaPerCallUs = ((withMetric - noop) / N) * 1000;

console.log(JSON.stringify({
  N,
  chunkBytes: Buffer.byteLength(chunk, 'utf8'),
  withMetric_ms: +withMetric.toFixed(2),
  noopLoop_ms: +noop.toFixed(2),
  recordOutput_perCall_us: +perCallUs.toFixed(4),
  delta_vs_noop_perCall_us: +deltaPerCallUs.toFixed(4),
}, null, 2));
