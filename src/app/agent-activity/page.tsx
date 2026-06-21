'use client';

import { useCallback, useEffect, useState } from 'react';
import { Users, RefreshCw, FileText, GitCommit, X, Clock } from 'lucide-react';
import { dorothyClient } from '@/lib/dorothyClient';
import { TaskWorkflowView } from '@/components/KanbanBoard/components/TaskWorkflowView';
import DomainTabs, { AGENT_DOMAIN } from '@/components/DomainTabs'; // 재설계 ②-b — 에이전트 도메인 탭

interface DocEntry { path: string; relPath: string; mtime: string; sizeBytes: number; }
interface Commit { sha: string; subject: string; date: string; repo: string; }
interface AgentRow {
  agentId: string; roleId: string; name: string; engine: string | null;
  projectId?: string | null; subProjectId: string | null; status: string; lastActivity: string | null;
  currentTask: string | null; statusLine: string | null; outputTail: string;
  recentCommits: Commit[]; reports: DocEntry[]; docs: DocEntry[];
}
interface ActivityPayload {
  updatedAt: string;
  cycles: { header: string; firstLine: string }[];
  agents: AgentRow[];
  error?: string;
}

const STATUS_CLS: Record<string, string> = {
  running: 'bg-green-500/15 text-green-700',
  waiting: 'bg-amber-500/15 text-amber-700',
  completed: 'bg-blue-500/15 text-blue-700',
  idle: 'bg-secondary text-muted-foreground',
  error: 'bg-red-500/15 text-red-700',
  unknown: 'bg-secondary text-muted-foreground',
};
const STATUS_KO: Record<string, string> = {
  running: '실행 중', waiting: '대기 중', completed: '완료', idle: '유휴', error: '오류', unknown: '미상',
};
const COLUMN_KO: Record<string, string> = { backlog: '대기(backlog)', planned: '예정', ongoing: '진행 중', done: '완료' };
interface KTask { id: string; title: string; column: string; assignedAgentId?: string | null; priority?: string; labels?: string[]; stageHistory?: { at: string; agentId: string | null; column: string }[]; }

function fmtAge(iso: string | null): string {
  if (!iso) return '-';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '-';
  const s = Math.floor((Date.now() - t.getTime()) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

export default function AgentActivityPage() {
  const [data, setData] = useState<ActivityPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [docOpen, setDocOpen] = useState<{ path: string; relPath: string; content?: string; error?: string; loading?: boolean } | null>(null);
  // Phase 6-AN+ — 에이전트별 담당 칸반 작업(assignedAgentId 매칭).
  const [kanbanByAgent, setKanbanByAgent] = useState<Record<string, KTask[]>>({});
  // Phase 6-AO — 에이전트 상세보기 팝업.
  const [detailId, setDetailId] = useState<string | null>(null);
  // Phase 6-AT+ — 작업 클릭 시 워크플로우 진행 상세 팝업.
  const [taskDetail, setTaskDetail] = useState<KTask | null>(null);

  const load = useCallback(async () => {
    try {
      const j = (await dorothyClient.agentActivity.get()) as ActivityPayload;
      if (j.error) setErr(j.error); else { setData(j); setErr(null); }
    } catch (e) { setErr(String(e)); }
    finally { setLoading(false); }
  }, []);

  const loadKanban = useCallback(async () => {
    try {
      const r = await fetch('/api/dorothy/kanban', { cache: 'no-store' });
      const jj = await r.json();
      const tasks: KTask[] = Array.isArray(jj) ? jj : (jj.tasks ?? []);
      const by: Record<string, KTask[]> = {};
      for (const t of tasks) {
        if (t.column === 'done') continue; // 완료 제외 — 해야 할 일 위주
        const owner = t.assignedAgentId;
        if (!owner) continue;
        (by[owner] = by[owner] || []).push(t);
      }
      setKanbanByAgent(by);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    load(); loadKanban();
    const t = setInterval(() => { load(); loadKanban(); }, 15000); // 15초마다 자동 새로고침
    return () => clearInterval(t);
  }, [load, loadKanban]);

  const openDoc = useCallback(async (d: DocEntry) => {
    setDocOpen({ path: d.path, relPath: d.relPath, loading: true });
    const res = await dorothyClient.doc.read(d.path);
    setDocOpen({ path: d.path, relPath: d.relPath, ...res });
  }, []);

  if (loading && !data) return <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>;
  if (err && !data) return <div className="p-6 text-sm text-red-500">{err}</div>;
  if (!data) return null;

  return (
    <div className="space-y-4 lg:space-y-6 pt-4 lg:pt-6">
      <DomainTabs tabs={AGENT_DOMAIN} title="에이전트" bare />
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Users className="w-6 h-6" /> 에이전트별 작업 현황
          </h1>
          <p className="text-muted-foreground text-xs lg:text-sm mt-1">
            누가 무엇을 하고, 어떤 산출물(커밋·문서)을 냈는지. 15초마다 자동 새로고침.
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-2 px-3 py-2 text-sm bg-secondary hover:bg-secondary/80 transition-colors rounded-md">
          <RefreshCw className="w-4 h-4" /> 새로고침
        </button>
      </div>

      {/* 최근 사이클 요약 */}
      {data.cycles.length > 0 && (
        <section className="border border-border rounded-none bg-card p-4">
          <h2 className="text-sm font-bold mb-2 flex items-center gap-2"><Clock className="w-4 h-4" /> 최근 사이클 ({data.cycles.length}개)</h2>
          <ul className="text-xs space-y-1">
            {data.cycles.map((c, i) => (
              <li key={i} className="border-l-2 border-primary/30 pl-2">
                <div className="font-medium text-foreground">{c.header}</div>
                <div className="text-muted-foreground line-clamp-2">{c.firstLine}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 에이전트 카드 (상태별 섹션) — Phase 6-AP */}
      {(() => {
        const norm = (st: string) => st === "running" ? "running" : st === "waiting" ? "waiting" : (st === "error" || st === "blocked") ? "error" : "idle";
        const SECTIONS = [
          { key: "running", label: "실행 중", cls: "text-green-600 border-green-500/40 bg-green-500/5" },
          { key: "waiting", label: "대기 중", cls: "text-amber-600 border-amber-500/40 bg-amber-500/5" },
          { key: "idle", label: "유휴", cls: "text-muted-foreground border-border bg-secondary/30" },
          { key: "error", label: "막힘", cls: "text-red-600 border-red-500/40 bg-red-500/5" },
        ];
        return SECTIONS.map((sec) => {
          const items = data.agents.filter((a) => norm(a.status) === sec.key);
          if (items.length === 0) return null;
          return (
            <section key={sec.key} className="space-y-2">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded-full border text-xs ${sec.cls}`}>{sec.label}</span>
                <span className="text-muted-foreground text-xs">{items.length}명</span>
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {items.map((a) => {
                  const sc = STATUS_CLS[a.status] ?? STATUS_CLS.unknown;
                  const myTasks = kanbanByAgent[a.agentId] ?? kanbanByAgent[a.roleId] ?? [];
                  const ongoing = myTasks.filter((k) => k.column === "ongoing").length;
                  const waiting = myTasks.filter((k) => k.column !== "ongoing").length;
                  const appr = myTasks.filter((k) => (k.labels || []).includes("approval-required")).length;
                  return (
                    <div key={`${a.projectId ?? ''}-${a.agentId}`} className="border border-border rounded-lg bg-card p-3 flex flex-col gap-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold text-sm text-foreground truncate">{a.name}</div>
                          <div className="text-[11px] text-muted-foreground truncate">{a.roleId}</div>
                        </div>
                        <button onClick={() => setDetailId(a.agentId)} className="text-[10px] text-primary hover:underline shrink-0">상세보기</button>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${sc}`}>{STATUS_KO[a.status] ?? a.status}</span>
                        {a.engine && (
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${a.engine === "codex" ? "bg-green-600/20 text-green-700" : "bg-orange-500/20 text-orange-700"}`} title={a.engine === "codex" ? "OpenAI Codex (GPT)" : "Anthropic Claude"}>
                            {a.engine === "codex" ? "GPT (Codex)" : "Claude"}
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground ml-auto">{fmtAge(a.lastActivity)}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        <span className="text-foreground/70">현재 작업: </span>
                        <span>{a.currentTask ?? a.statusLine ?? "진행 중인 작업 없음"}</span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                        <span className={`px-1.5 py-0.5 rounded font-medium ${myTasks.length > 0 ? "bg-cyan-500/15 text-cyan-600" : "bg-secondary text-muted-foreground"}`} title="담당 칸반 작업(완료 제외)">🗂 담당 {myTasks.length}</span>
                        <span className="px-1.5 py-0.5 rounded bg-green-500/10 text-green-600">진행 {ongoing}</span>
                        <span className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">대기 {waiting}</span>
                        {appr > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600">승인필요 {appr}</span>}
                      </div>
                      {myTasks.length > 0 && (
                        <ul className="text-[10px] space-y-0.5 border-t border-border/40 pt-1.5">
                          {myTasks.slice(0, 3).map((k) => (
                            <li key={k.id}>
                              <button onClick={() => setTaskDetail(k)} className="flex items-center gap-1 w-full text-left hover:bg-secondary/40 rounded px-0.5" title="워크플로우 진행 상세 보기">
                                <span className={`px-1 rounded text-[9px] shrink-0 ${k.column === "ongoing" ? "bg-green-500/15 text-green-600" : "bg-secondary text-muted-foreground"}`}>{COLUMN_KO[k.column] ?? k.column}</span>
                                <span className="text-foreground truncate hover:underline">{k.title}</span>
                              </button>
                            </li>
                          ))}
                          {myTasks.length > 3 && <li className="text-muted-foreground">…외 {myTasks.length - 3}건</li>}
                        </ul>
                      )}
                      {a.outputTail && (
                        <details className="text-[10px]">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">최근 출력</summary>
                          <pre className="mt-1 bg-background border border-border rounded p-1.5 max-h-28 overflow-auto whitespace-pre-wrap">{a.outputTail.slice(-600)}</pre>
                        </details>
                      )}
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground border-t border-border/40 pt-1.5 mt-auto">
                        <span className="inline-flex items-center gap-1"><GitCommit className="w-3 h-3" />{a.recentCommits.length}</span>
                        <span className="inline-flex items-center gap-1"><FileText className="w-3 h-3" />{a.docs.length}</span>
                        <span className="inline-flex items-center gap-1">📋 {a.reports.length}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        });
      })()}

      {/* Phase 6-AO — 에이전트 상세보기 팝업 */}
      {detailId && (() => {
        const a = data.agents.find(x => x.agentId === detailId);
        if (!a) return null;
        const myTasks = kanbanByAgent[a.agentId] ?? kanbanByAgent[a.roleId] ?? [];
        const ongoing = myTasks.filter(k => k.column === 'ongoing');
        const waiting = myTasks.filter(k => k.column !== 'ongoing');
        return (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setDetailId(null)}>
            <div className="bg-card border border-border rounded-lg max-w-2xl w-full max-h-[85vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-foreground">{a.name}</h3>
                  <span className="text-[11px] text-muted-foreground">{a.roleId}</span>
                  {a.engine && <span className={`px-1.5 py-0.5 rounded text-[10px] ${a.engine === 'codex' ? 'bg-green-600/20 text-green-700' : 'bg-orange-500/20 text-orange-700'}`}>{a.engine === 'codex' ? 'GPT (Codex)' : 'Claude'}</span>}
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_CLS[a.status] ?? STATUS_CLS.unknown}`}>{STATUS_KO[a.status] ?? a.status}</span>
                </div>
                <button onClick={() => setDetailId(null)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
              </div>
              <div className="space-y-3 text-xs">
                <div><span className="text-muted-foreground">현재 작업:</span> <span className="text-foreground">{a.currentTask ?? a.statusLine ?? '현재 작업 없음'}</span></div>
                <div><span className="text-muted-foreground">최근 활동:</span> {fmtAge(a.lastActivity)}</div>
                {/* 담당 칸반 작업 */}
                <div className="border border-cyan-500/30 rounded p-3 bg-cyan-500/5">
                  <div className="font-bold mb-1">🗂 담당 칸반 작업 — {myTasks.length}건 (완료 제외)</div>
                  {myTasks.length === 0 ? <div className="text-[11px] text-muted-foreground">담당 작업 없음</div> : (
                    <>
                      {ongoing.length > 0 && <div className="text-[11px] text-green-600 mt-1">진행 중 ({ongoing.length})</div>}
                      {ongoing.map(k => <div key={k.id} className="text-[11px] text-foreground truncate">• {k.title}{(k.labels||[]).includes('approval-required') && <span className="text-amber-500 ml-1">승인필요</span>}</div>)}
                      {waiting.length > 0 && <div className="text-[11px] text-muted-foreground mt-1">대기 ({waiting.length})</div>}
                      {waiting.slice(0, 15).map(k => <div key={k.id} className="text-[11px] text-foreground/80 truncate">• {k.title}{(k.labels||[]).includes('approval-required') && <span className="text-amber-500 ml-1">승인필요</span>}</div>)}
                      {waiting.length > 15 && <div className="text-[11px] text-muted-foreground">…외 {waiting.length - 15}건</div>}
                    </>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><span className="text-muted-foreground">보고서:</span> {a.reports.length}건</div>
                  <div><span className="text-muted-foreground">최근 24h 커밋:</span> {a.recentCommits.length}건</div>
                </div>
                {a.outputTail && (
                  <div>
                    <div className="font-bold mb-1">최근 출력</div>
                    <pre className="text-[10px] bg-background border border-border rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap">{a.outputTail}</pre>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 문서 뷰어 모달 */}
      {docOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setDocOpen(null)}>
          <div className="bg-card border border-border rounded-none max-w-4xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-border">
              <div className="text-sm font-bold flex items-center gap-2">
                <FileText className="w-4 h-4" /> {docOpen.relPath}
              </div>
              <button onClick={() => setDocOpen(null)} className="p-1 hover:bg-secondary rounded"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {docOpen.loading ? (
                <div className="text-sm text-muted-foreground">불러오는 중…</div>
              ) : docOpen.error ? (
                <div className="text-sm text-red-500">{docOpen.error}</div>
              ) : (
                <pre className="text-xs whitespace-pre-wrap break-words font-mono">{docOpen.content}</pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Phase 6-AT+ — 작업 워크플로우 진행 상세 팝업 */}
      {taskDetail && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setTaskDetail(null)}>
          <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border sticky top-0 bg-card">
              <div className="min-w-0">
                <div className="text-sm font-bold text-foreground truncate">{taskDetail.title}</div>
                <div className="text-[10px] text-muted-foreground">{COLUMN_KO[taskDetail.column] ?? taskDetail.column} · 담당 {taskDetail.assignedAgentId ?? '미배정'}</div>
              </div>
              <button onClick={() => setTaskDetail(null)} className="p-1 hover:bg-secondary rounded shrink-0"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4">
              <TaskWorkflowView task={{ title: taskDetail.title, column: taskDetail.column, assignedAgentId: taskDetail.assignedAgentId, labels: taskDetail.labels, priority: taskDetail.priority, stageHistory: taskDetail.stageHistory }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
