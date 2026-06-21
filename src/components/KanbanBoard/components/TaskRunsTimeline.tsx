'use client';

/**
 * 재설계 ③ — 칸반 카드 상세 '타임라인' 탭.
 *
 * `hermes kanban show --json`(/api/dorothy/kanban-detail) 의 runs(시도 이력)·events·comments 를
 * 시간순 타임라인으로 보여준다. ★죽은 /runs(Run 미러 미연결) 데이터를 CLI 로 surfacing.
 * 데이터 없으면(아직 스폰 전 등) '이력 없음' 안전 degrade.
 */
import { useEffect, useState } from 'react';
import { Loader2, GitCommitHorizontal, MessageSquare, Activity } from 'lucide-react';

interface RunRow { id?: string; outcome?: string; state?: string; summary?: string; error?: string; created_at?: number; elapsed_ms?: number }
interface EventRow { kind?: string; payload?: unknown; created_at?: number; run_id?: string | null }
interface CommentRow { body?: string; text?: string; author?: string; created_at?: number }

function rel(ts?: number): string {
  if (!ts || typeof ts !== 'number') return '';
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

export function TaskRunsTimeline({ taskId }: { taskId: string }) {
  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/dorothy/kanban-detail?taskId=${encodeURIComponent(taskId)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setRuns(Array.isArray(j.runs) ? j.runs : []);
        setEvents(Array.isArray(j.events) ? j.events : []);
        setComments(Array.isArray(j.comments) ? j.comments : []);
        setErr(j.error ?? null);
      })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'load failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> 타임라인 불러오는 중…
      </div>
    );
  }

  const empty = runs.length === 0 && events.length === 0 && comments.length === 0;
  if (empty) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground/70">
        실행 이력이 없습니다 (아직 에이전트가 스폰되지 않았거나 기록 없음).
        <div className="text-[11px] mt-1 text-muted-foreground/50">출처: hermes kanban show — 시도(runs)·이벤트·코멘트.</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {err && (
        <div className="text-[11px] text-amber-500/80">일부 데이터를 못 불러왔을 수 있습니다: {err}</div>
      )}

      {runs.length > 0 && (
        <section>
          <div className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
            <GitCommitHorizontal className="w-3.5 h-3.5" /> 시도 이력 (runs · {runs.length})
          </div>
          <ul className="space-y-2">
            {runs.map((r, i) => (
              <li key={r.id ?? i} className="rounded-lg border border-border bg-secondary/20 p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-medium ${(r.outcome ?? r.state) === 'failed' || r.error ? 'text-rose-500' : 'text-foreground'}`}>
                    {r.outcome ?? r.state ?? '시도'}
                  </span>
                  <span className="text-muted-foreground">{rel(r.created_at)}</span>
                </div>
                {r.summary && <div className="text-muted-foreground mt-1 whitespace-pre-wrap">{r.summary}</div>}
                {r.error && <div className="text-rose-400 mt-1 whitespace-pre-wrap">{r.error}</div>}
                {typeof r.elapsed_ms === 'number' && <div className="text-muted-foreground/60 mt-1">{Math.round(r.elapsed_ms / 1000)}s</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {events.length > 0 && (
        <section>
          <div className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" /> 이벤트 ({events.length})
          </div>
          <ul className="space-y-1">
            {events.map((e, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-[12px] border-l-2 border-border pl-2 py-0.5">
                <span className="text-foreground">{e.kind ?? '이벤트'}</span>
                <span className="text-muted-foreground">{rel(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {comments.length > 0 && (
        <section>
          <div className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
            <MessageSquare className="w-3.5 h-3.5" /> 코멘트 ({comments.length})
          </div>
          <ul className="space-y-2">
            {comments.map((c, i) => (
              <li key={i} className="rounded-lg border border-border bg-secondary/20 p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-muted-foreground">{c.author ?? '워커'}</span>
                  <span className="text-muted-foreground">{rel(c.created_at)}</span>
                </div>
                <div className="text-foreground whitespace-pre-wrap">{c.body ?? c.text ?? ''}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
