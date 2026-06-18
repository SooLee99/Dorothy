'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Network, Bot, Sparkles, Loader2, GitBranch, X, Eye, Link as LinkIcon, Unlink, CheckCircle2 } from 'lucide-react';
import { ko } from '@/i18n';
import { dorothyClient } from '@/lib/dorothyClient';

interface AgentEntry {
  file: string;
  name: string | null;
  description: string | null;
}
interface SkillEntry {
  file: string;
  slug: string;
  name: string | null;
  description: string | null;
  source: 'triplan' | 'auto-company';
  linked: boolean;
  linkedKind: 'real' | 'symlink' | null;
  triplanPath: string | null;
  referencedBy: string[];
}
interface TeamGraph { pattern?: string; edges?: string[]; }
interface HarnessData {
  agents: AgentEntry[];
  skills: SkillEntry[];
  teamGraph: TeamGraph | null;
  error?: string;
}

const SOURCE_BADGE = {
  triplan: 'bg-blue-500/15 text-blue-700',
  'auto-company': 'bg-purple-500/15 text-purple-700',
};

export default function HarnessPage() {
  const [data, setData] = useState<HarnessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // slug currently being linked/unlinked
  const [docOpen, setDocOpen] = useState<{ path: string; slug: string; content?: string; error?: string; loading?: boolean } | null>(null);
  const [filter, setFilter] = useState<'all' | 'linked' | 'available' | 'auto-company'>('all');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      const json = (await dorothyClient.harness.get()) as HarnessData;
      setData(json);
    } catch (e) {
      setData({ agents: [], skills: [], teamGraph: null, error: String(e) });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = () => { setRefreshing(true); load(); };

  const openDoc = useCallback(async (s: SkillEntry) => {
    setDocOpen({ path: s.file, slug: s.slug, loading: true });
    const res = await dorothyClient.doc.read(s.file);
    setDocOpen({ path: s.file, slug: s.slug, ...res });
  }, []);

  const toggleLink = useCallback(async (s: SkillEntry) => {
    setBusy(s.slug);
    const result = s.linked
      ? await dorothyClient.skill.unlink(s.slug)
      : await dorothyClient.skill.link(s.slug);
    setBusy(null);
    if (result.error) alert('실패: ' + result.error);
    handleRefresh();
  }, []);

  const skills = data?.skills ?? [];
  const filtered = skills.filter((s) => {
    if (q && !((s.name ?? s.slug).toLowerCase().includes(q.toLowerCase()) || (s.description ?? '').toLowerCase().includes(q.toLowerCase()))) return false;
    if (filter === 'linked') return s.linked;
    if (filter === 'available') return !s.linked;
    if (filter === 'auto-company') return s.source === 'auto-company';
    return true;
  });
  const stats = {
    total: skills.length,
    linked: skills.filter((s) => s.linked).length,
    triplan: skills.filter((s) => s.source === 'triplan').length,
    autoCompany: skills.filter((s) => s.source === 'auto-company').length,
    autoCompanyLinked: skills.filter((s) => s.source === 'auto-company' && s.linked).length,
  };

  return (
    <div className="space-y-4 lg:space-y-6 pt-4 lg:pt-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Network className="w-6 h-6" /> {ko.nav.harness}
          </h1>
          <p className="text-muted-foreground text-xs lg:text-sm mt-1">
            에이전트 · 스킬 카탈로그 · 팀 그래프. <span className="text-blue-700">triplan</span>(활성) + <span className="text-purple-700">auto-company</span>(추가 활용 가능) 스킬 통합.
          </p>
        </div>
        <button onClick={handleRefresh} disabled={refreshing} className="flex items-center gap-2 px-3 py-2 text-sm bg-secondary hover:bg-secondary/80 transition-colors rounded-md">
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} /> {ko.button.refresh}
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" /> 불러오는 중...
        </div>
      ) : data?.error ? (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-500 text-sm">{data.error}</div>
      ) : (
        <>
          {/* 통계 + 팀 그래프 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="bg-card border border-border rounded p-3">
              <div className="text-xs text-muted-foreground">스킬 합계 / 활성</div>
              <div className="text-2xl font-bold">{stats.linked} <span className="text-muted-foreground text-base font-normal">/ {stats.total}</span></div>
              <div className="text-[11px] text-muted-foreground mt-1">
                triplan {stats.triplan} · auto-company {stats.autoCompany}({stats.autoCompanyLinked} 활성)
              </div>
            </div>
            <div className="bg-card border border-border rounded p-3 lg:col-span-2">
              <div className="text-xs font-medium mb-1.5 flex items-center gap-1"><GitBranch className="w-4 h-4" /> 팀 그래프</div>
              {data?.teamGraph?.pattern && <div className="text-[11px] text-muted-foreground">패턴: <span className="font-mono">{data.teamGraph.pattern}</span></div>}
              {data?.teamGraph?.edges?.length ? (
                <ul className="text-[11px] font-mono space-y-0.5 mt-1">
                  {data.teamGraph.edges.map((e, i) => (<li key={i} className="text-muted-foreground">{e}</li>))}
                </ul>
              ) : <div className="text-[11px] text-muted-foreground">팀 그래프 정보 없음</div>}
            </div>
          </div>

          {/* 필터 + 검색 */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex bg-secondary rounded overflow-hidden text-xs">
              {[
                ['all', `전체 ${stats.total}`],
                ['linked', `활성 ${stats.linked}`],
                ['available', `미활성 ${stats.total - stats.linked}`],
                ['auto-company', `auto-company ${stats.autoCompany}`],
              ].map(([k, label]) => (
                <button key={k} onClick={() => setFilter(k as typeof filter)} className={`px-3 py-1.5 ${filter === k ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}>
                  {label}
                </button>
              ))}
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="스킬 검색(이름·설명)…"
              className="flex-1 max-w-xs px-3 py-1.5 text-xs bg-secondary/50 border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
            <div className="text-[11px] text-muted-foreground">{filtered.length}건 표시</div>
          </div>

          {/* 스킬 표 */}
          <section className="border border-border rounded bg-card overflow-hidden">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left py-2 px-3 font-medium">스킬</th>
                  <th className="text-left py-2 px-3 font-medium">출처</th>
                  <th className="text-left py-2 px-3 font-medium">상태</th>
                  <th className="text-left py-2 px-3 font-medium">사용 에이전트</th>
                  <th className="text-left py-2 px-3 font-medium">설명</th>
                  <th className="text-right py-2 px-3 font-medium">액션</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={6} className="py-8 text-center text-muted-foreground">표시할 스킬이 없습니다.</td></tr>
                ) : filtered.map((s) => (
                  <tr key={`${s.source}-${s.slug}`} className="border-b border-border/40 hover:bg-secondary/30">
                    <td className="py-2 px-3 font-medium text-foreground"><Sparkles className="w-3 h-3 inline mr-1 text-primary" />{s.name ?? s.slug}</td>
                    <td className="py-2 px-3"><span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${SOURCE_BADGE[s.source]}`}>{s.source}</span></td>
                    <td className="py-2 px-3">
                      {s.linked ? (
                        <span className="inline-flex items-center gap-1 text-green-700 text-[10px] font-medium">
                          <CheckCircle2 className="w-3 h-3" /> 활성{s.linkedKind === 'symlink' ? '(링크)' : ''}
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">미활성</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-muted-foreground">{s.referencedBy.length === 0 ? '-' : s.referencedBy.slice(0, 3).join(', ') + (s.referencedBy.length > 3 ? ` +${s.referencedBy.length - 3}` : '')}</td>
                    <td className="py-2 px-3 text-muted-foreground max-w-[420px]">
                      <div className="line-clamp-2">{s.description ?? '-'}</div>
                    </td>
                    <td className="py-2 px-3 text-right whitespace-nowrap">
                      <button onClick={() => openDoc(s)} className="inline-flex items-center gap-1 px-2 py-1 mr-1 bg-secondary hover:bg-secondary/80 rounded text-[10px]" title="SKILL.md 내용 보기">
                        <Eye className="w-3 h-3" /> 보기
                      </button>
                      {s.source === 'auto-company' && (
                        s.linked && s.linkedKind === 'symlink' ? (
                          <button onClick={() => toggleLink(s)} disabled={busy === s.slug} className="inline-flex items-center gap-1 px-2 py-1 bg-red-500/15 text-red-700 hover:bg-red-500/25 rounded text-[10px] disabled:opacity-50" title="triplan 에서 비활성화(심볼릭 제거)">
                            <Unlink className="w-3 h-3" /> 비활성
                          </button>
                        ) : !s.linked ? (
                          <button onClick={() => toggleLink(s)} disabled={busy === s.slug} className="inline-flex items-center gap-1 px-2 py-1 bg-primary/15 text-primary hover:bg-primary/25 rounded text-[10px] disabled:opacity-50" title="triplan에 심볼릭 활성화">
                            <LinkIcon className="w-3 h-3" /> 활성화
                          </button>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">실파일</span>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* 에이전트 목록 (참고용) */}
          <section className="border border-border rounded bg-card">
            <div className="px-4 py-2 border-b border-border text-xs font-medium flex items-center gap-2"><Bot className="w-4 h-4" /> 에이전트 정의 ({data?.agents.length ?? 0})</div>
            <ul className="text-xs divide-y divide-border/40">
              {(data?.agents ?? []).map((a) => (
                <li key={a.file} className="px-4 py-2">
                  <span className="font-medium text-foreground">{a.name ?? a.file.split('/').pop()}</span>
                  {a.description && <span className="text-muted-foreground ml-2 line-clamp-1">— {a.description}</span>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {/* SKILL.md 뷰어 모달 */}
      {docOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setDocOpen(null)}>
          <div className="bg-card border border-border max-w-4xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-border">
              <div className="text-sm font-bold flex items-center gap-2"><Sparkles className="w-4 h-4" /> {docOpen.slug} / SKILL.md</div>
              <button onClick={() => setDocOpen(null)} className="p-1 hover:bg-secondary rounded"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {docOpen.loading ? <div className="text-sm text-muted-foreground">불러오는 중…</div>
                : docOpen.error ? <div className="text-sm text-red-500">{docOpen.error}</div>
                  : <pre className="text-xs whitespace-pre-wrap break-words font-mono">{docOpen.content}</pre>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
