'use client';

/**
 * 사용자 처리 사항(Action Items) 전용 대시보드.
 *   "에이전트가 못 고치고 ★사람만 처리할 것"(외부 API 키·시크릿·승인·입력)을 한 화면에 모은다.
 *   출처: /api/dorothy/action-items (escalations.jsonl 의 user-action kind). 슬랙 보고와 같은 원본.
 *   프로젝트별 그룹·미해결 우선·해결표시 토글. read 중심(에이전트 자동 처리 X — 정의상 사람 몫).
 */
import { useEffect, useState, useCallback } from 'react';
import { KeyRound, ShieldCheck, MessageSquareWarning, Plug, Check, RotateCcw, Inbox } from 'lucide-react';
import { formatRelative } from '@/components/RunCommon/badges';
import { useProjectScope } from '@/lib/useProjectScope'; // 재설계 ②-a — 전역 프로젝트 스위처

interface ActionItem {
  id: string;
  kind: string;
  detail: string;
  project: string | null;
  role: string | null;
  agent: string | null;
  firstAt: string | null;
  lastAt: string | null;
  count: number;
  resolved: boolean;
  resolvedAt: string | null;
}

const KIND_META: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
  EXTERNAL_API_BLOCKER: { label: '외부 API 막힘', icon: <Plug className="w-3.5 h-3.5" />, cls: 'bg-rose-500/10 text-rose-500 border-rose-500/30' },
  NEEDS_SECRET: { label: '시크릿/키 필요', icon: <KeyRound className="w-3.5 h-3.5" />, cls: 'bg-amber-500/10 text-amber-600 border-amber-500/30' },
  NEEDS_APPROVAL: { label: '승인 필요', icon: <ShieldCheck className="w-3.5 h-3.5" />, cls: 'bg-violet-500/10 text-violet-500 border-violet-500/30' },
  NEEDS_INPUT: { label: '입력/결정 필요', icon: <MessageSquareWarning className="w-3.5 h-3.5" />, cls: 'bg-sky-500/10 text-sky-500 border-sky-500/30' },
};

function kindMeta(kind: string) {
  return KIND_META[kind] ?? { label: kind, icon: <MessageSquareWarning className="w-3.5 h-3.5" />, cls: 'bg-muted text-muted-foreground border-border' };
}

export function ActionItemsView() {
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/dorothy/action-items', { cache: 'no-store' });
      const j = await res.json();
      const list = j?.data?.items;
      if (Array.isArray(list)) { setItems(list); setError(null); }
      else setError(j?.meta?.error || '신호 없음');
    } catch {
      setError('가져오지 못했습니다');
    }
  }, []);

  useEffect(() => {
    load();
    const run = () => { if (!document.hidden) load(); };
    const t = setInterval(run, 10000);
    document.addEventListener('visibilitychange', run);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', run); };
  }, [load]);

  const toggleResolved = useCallback(async (item: ActionItem) => {
    setPending((p) => new Set(p).add(item.id));
    try {
      await fetch('/api/dorothy/action-items/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, resolved: !item.resolved }),
      });
    } catch { /* 무시 */ }
    finally {
      setPending((p) => { const n = new Set(p); n.delete(item.id); return n; });
      load();
    }
  }, [load]);

  // 재설계 ②-a — 전역 프로젝트 스위처 필터(식별자: item.project = 보통 projectId).
  const { matches: matchesProject } = useProjectScope();
  const inScope = (items ?? []).filter((i) => matchesProject({ projectId: i.project, projectPath: i.project }));
  const visible = inScope.filter((i) => showResolved || !i.resolved);
  const openCount = inScope.filter((i) => !i.resolved).length;

  // 프로젝트별 그룹
  const groups = new Map<string, ActionItem[]>();
  for (const it of visible) {
    const k = it.project || '(미지정)';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(it);
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Inbox className="w-5 h-5" /> 사용자 조치 필요
          {openCount > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-500">{openCount}</span>}
        </h1>
        <label className="text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          해결된 것도 보기
        </label>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        에이전트가 막혀 ★사람만 처리할 수 있는 것(외부 API 키·시크릿·승인·설정). 슬랙 #alerts 와 같은 원본입니다. 10초마다 갱신.
      </p>

      {items === null && !error && <div className="text-sm text-muted-foreground">로딩…</div>}
      {error && <div className="text-sm text-rose-400">신호 오류: {error}</div>}
      {items && visible.length === 0 && (
        <div className="text-sm text-muted-foreground border border-dashed border-border rounded-lg p-8 text-center">
          {openCount === 0 ? '처리할 사항이 없습니다 🎉' : '미해결 항목 없음 (해결된 것 보기로 확인)'}
        </div>
      )}

      <div className="space-y-5">
        {[...groups.entries()].map(([project, list]) => (
          <div key={project}>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{project}</div>
            <div className="space-y-2">
              {list.map((it) => {
                const m = kindMeta(it.kind);
                const busy = pending.has(it.id);
                return (
                  <div key={it.id} className={`rounded-lg border p-3 flex items-start gap-3 ${it.resolved ? 'border-border bg-muted/30 opacity-70' : 'border-border bg-card'}`}>
                    <span className={`shrink-0 mt-0.5 inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border ${m.cls}`}>
                      {m.icon}{m.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm ${it.resolved ? 'line-through text-muted-foreground' : 'text-foreground'} whitespace-pre-wrap break-words`}>{it.detail}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        {it.role && <span>역할 {it.role}</span>}
                        {it.lastAt && <span>마지막 {formatRelative(it.lastAt)}</span>}
                        {it.count > 1 && <span>· {it.count}회 보고</span>}
                        {it.resolved && it.resolvedAt && <span className="text-emerald-600">해결됨 {formatRelative(it.resolvedAt)}</span>}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => toggleResolved(it)}
                      className={`shrink-0 text-[11px] px-2 py-1 rounded border transition-colors disabled:opacity-50 ${
                        it.resolved
                          ? 'border-border text-muted-foreground hover:bg-secondary'
                          : 'border-emerald-500/50 text-emerald-600 hover:bg-emerald-500/10'
                      }`}
                    >
                      {it.resolved ? <span className="flex items-center gap-1"><RotateCcw className="w-3 h-3" />되돌리기</span>
                                   : <span className="flex items-center gap-1"><Check className="w-3 h-3" />처리함</span>}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
