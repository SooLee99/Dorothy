'use client';

/**
 * Phase 6-AU — 스킬 자기개선 제안 패널 (B: 저위험 자동 + 고위험 승인).
 * 탐지(read-only) → 저위험 자동 적용 / 고위험 승인 게이트. 모든 쓰기는 ~/.claude/skills 안.
 */

import { useCallback, useEffect, useState } from 'react';
import { Sparkles, RefreshCw, Check, X, ShieldAlert } from 'lucide-react';

interface Proposal {
  id: string; type: string; riskLevel: 'low' | 'high'; relTarget: string;
  title: string; rationale: string; source: string; status: string; note?: string; appliedAt?: string;
}
interface State {
  proposals: Proposal[]; enabled: boolean; autoApplyLowRisk: boolean; skillsRoot: string;
}

const STATUS_KO: Record<string, string> = {
  pending: '승인 대기', 'auto-applied': '자동 적용됨', approved: '승인 적용됨', rejected: '거절됨', failed: '실패',
};

export default function SkillProposalsPanel() {
  const [s, setS] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const r = await fetch('/api/dorothy/skill-proposals', { cache: 'no-store' }); setS(await r.json()); } catch { /* ignore */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/dorothy/skill-proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (body.action === 'detect') setMsg(j.ok ? `탐지 ${j.detected}건 · 자동적용 ${j.autoApplied}건 · 승인대기 ${j.pending}건` : (j.error || '실패'));
      else if (!j.ok && j.note) setMsg(j.note);
      await load();
    } finally { setBusy(false); }
  }, [load]);

  if (!s) return null;
  const pending = s.proposals.filter(p => p.status === 'pending');
  const recent = s.proposals.filter(p => p.status === 'auto-applied' || p.status === 'approved').slice(-6).reverse();

  return (
    <div className="mb-3 rounded-md border border-violet-500/30 bg-violet-500/5 p-3">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="w-4 h-4 text-violet-400" />
        <span className="text-sm font-semibold text-foreground">스킬 자기개선 제안</span>
        <span className="text-[10px] text-muted-foreground">저위험 자동 · 고위험 승인 · 쓰기 범위 {s.skillsRoot}</span>
        <button onClick={() => post({ action: 'detect' })} disabled={busy || !s.enabled} className="ml-auto text-[11px] text-violet-400 hover:text-violet-300 inline-flex items-center gap-1 disabled:opacity-40"><RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} /> 지금 탐지</button>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground mb-2">
        <label className="flex items-center gap-1 cursor-pointer" title="자기개선 전체 on/off">
          <input type="checkbox" checked={s.enabled} disabled={busy} onChange={e => post({ action: 'setEnabled', value: e.target.checked })} /> 자기개선 사용
        </label>
        <label className="flex items-center gap-1 cursor-pointer" title="저위험(references/learned 신규 .md) 자동 적용">
          <input type="checkbox" checked={s.autoApplyLowRisk} disabled={busy} onChange={e => post({ action: 'setAuto', value: e.target.checked })} /> 저위험 자동 적용
        </label>
      </div>

      {pending.length === 0 && recent.length === 0 && (
        <p className="text-[11px] text-muted-foreground">제안 없음. "지금 탐지"로 칸반 스킬후보·개선신호에서 제안을 모읍니다.</p>
      )}

      {pending.length > 0 && (
        <div className="mb-2">
          <p className="text-[11px] font-semibold text-amber-500 mb-1 inline-flex items-center gap-1"><ShieldAlert className="w-3.5 h-3.5" /> 승인 대기 (고위험) — {pending.length}</p>
          <ul className="space-y-1">
            {pending.map(p => (
              <li key={p.id} className="text-[11px] border border-border rounded p-1.5 bg-card">
                <div className="flex items-center gap-1.5">
                  <span className="px-1 rounded text-[9px] bg-rose-500/15 text-rose-400">{p.riskLevel === 'high' ? '고위험' : '저위험'}</span>
                  <span className="text-foreground truncate">{p.title}</span>
                </div>
                <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{p.relTarget}{p.note ? ` · ${p.note}` : ''}</div>
                <div className="flex gap-1.5 mt-1">
                  <button onClick={() => post({ action: 'apply', id: p.id, confirm: true })} disabled={busy} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-foreground text-background rounded disabled:opacity-40"><Check className="w-3 h-3" /> 승인·적용</button>
                  <button onClick={() => post({ action: 'reject', id: p.id })} disabled={busy} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] border border-border rounded text-muted-foreground hover:text-foreground disabled:opacity-40"><X className="w-3 h-3" /> 거절</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {recent.length > 0 && (
        <div>
          <p className="text-[11px] text-muted-foreground mb-1">최근 적용 ({recent.length})</p>
          <ul className="space-y-0.5">
            {recent.map(p => (
              <li key={p.id} className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                <Check className="w-3 h-3 text-green-500 shrink-0" />
                <span className="text-foreground/80 truncate">{p.title}</span>
                <span className="text-[9px] px-1 rounded bg-secondary">{STATUS_KO[p.status] ?? p.status}</span>
                <span className="font-mono">{p.relTarget}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {msg && <p className="text-[11px] text-violet-400 mt-1">{msg}</p>}
    </div>
  );
}
