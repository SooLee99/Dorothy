'use client';

import { useEffect, useState } from 'react';

/**
 * 자동 가동 "볼 눈" — 통제 상태 패널(used%·worker·④ enforce·breaker). ★read-only(표시만).
 * 청사진 548 빈틈 해소: used% 가시화 + ★raw/eff 둘 다(진동에 안 속고 통제 기준=eff 봄).
 */
interface SystemStatus {
  ok: boolean;
  generatedAt: string;
  usage: {
    fiveHour: { raw: number | null; eff: number | null; base: number | null };
    sevenDay: { raw: number | null; eff: number | null; base: number | null };
    note: string;
  };
  workers: { tracked: number | null; untracked: number | null; dead: number | null; at: string | null };
  enforce: { gate: string; scope: string | null };
  breaker: { paused: boolean; pauseReason: string | null; lastAction: string | null; lastAt: string | null; breaches: string[] };
}

const box: React.CSSProperties = { border: '1px solid #2a2a3a', borderRadius: 8, padding: 12, background: '#16161f', minWidth: 150 };
const label: React.CSSProperties = { fontSize: 11, color: '#8a8a9a', marginBottom: 4 };
const big: React.CSSProperties = { fontSize: 20, fontWeight: 700 };

function pct(n: number | null) { return n == null ? '—' : `${n}%`; }
function effColor(eff: number | null) {
  if (eff == null) return '#9aa';
  if (eff >= 85) return '#ff5c5c';   // near-cap 경고
  if (eff >= 60) return '#ffb24c';
  return '#4cd47a';
}

export default function SystemStatusPanel() {
  const [s, setS] = useState<SystemStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/dorothy/system-status', { cache: 'no-store' });
        const j = await r.json();
        if (alive) { setS(j); setErr(null); }
      } catch (e) { if (alive) setErr(String(e)); }
    };
    load();
    const t = setInterval(load, 15000); // 15s 폴링(읽기만)
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (err) return <div style={{ ...box, color: '#ff5c5c' }}>system-status 로드 실패: {err}</div>;
  if (!s) return <div style={{ ...box, color: '#8a8a9a' }}>통제 상태 로딩…</div>;

  const u = s.usage, w = s.workers, b = s.breaker;
  const untrackedBad = (w.untracked ?? 0) > 0;

  return (
    <section style={{ margin: '12px 0', padding: 14, border: '1px solid #2a2a3a', borderRadius: 10, background: '#0f0f17' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: '#e6e6f0' }}>🛰 통제 상태 (자동 가동 볼 눈)</h2>
        <span style={{ fontSize: 10, color: '#6a6a7a' }}>read-only · 15s 갱신 · {new Date(s.generatedAt).toLocaleTimeString()}</span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {/* 5h / 7d — raw vs eff */}
        {([['5시간', u.fiveHour], ['7일', u.sevenDay]] as const).map(([name, d]) => (
          <div key={name} style={box}>
            <div style={label}>{name} 한도</div>
            <div style={{ ...big, color: effColor(d.eff) }}>{pct(d.eff)} <span style={{ fontSize: 11, color: '#8a8a9a' }}>eff</span></div>
            <div style={{ fontSize: 11, color: '#8a8a9a' }}>raw {pct(d.raw)} · base {pct(d.base)}</div>
            {d.eff != null && d.eff >= 85 && <div style={{ fontSize: 10, color: '#ff5c5c', marginTop: 2 }}>⚠ near-cap</div>}
          </div>
        ))}

        {/* worker 추적 */}
        <div style={box}>
          <div style={label}>worker 추적</div>
          <div style={{ ...big, color: untrackedBad ? '#ff5c5c' : '#4cd47a' }}>
            {w.untracked ?? '—'} <span style={{ fontSize: 11, color: '#8a8a9a' }}>untracked</span>
          </div>
          <div style={{ fontSize: 11, color: '#8a8a9a' }}>tracked {w.tracked ?? '—'} · dead {w.dead ?? '—'}</div>
          {w.at && <div style={{ fontSize: 10, color: '#6a6a7a', marginTop: 2 }}>{new Date(w.at).toLocaleTimeString()}</div>}
        </div>

        {/* ④ enforce */}
        <div style={box}>
          <div style={label}>④ enforce (CI 게이트)</div>
          <div style={{ ...big, color: s.enforce.gate === 'enforce' ? '#4cd47a' : s.enforce.gate === 'shadow' ? '#ffb24c' : '#8a8a9a' }}>
            {s.enforce.gate}
          </div>
          <div style={{ fontSize: 11, color: '#8a8a9a' }}>scope {s.enforce.scope ?? '—'}</div>
        </div>

        {/* breaker */}
        <div style={box}>
          <div style={label}>circuit breaker</div>
          <div style={{ ...big, color: b.paused ? '#ff5c5c' : '#4cd47a' }}>{b.paused ? '⏸ paused' : '▶ ok'}</div>
          <div style={{ fontSize: 11, color: '#8a8a9a' }}>{b.lastAction ?? '—'}{b.breaches?.length ? ` · ${b.breaches.join(', ')}` : ''}</div>
          {b.paused && b.pauseReason && <div style={{ fontSize: 10, color: '#ffb24c', marginTop: 2 }}>{b.pauseReason}</div>}
        </div>
      </div>

      <div style={{ fontSize: 10, color: '#6a6a7a', marginTop: 8 }}>{u.note}</div>
    </section>
  );
}
