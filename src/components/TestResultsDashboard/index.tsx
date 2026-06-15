'use client';

/**
 * E2E Test Results Dashboard (/test-results) — ⑤ 대시보드 (가) 범위.
 *
 * ②③의 bueongi E2E 결과·캡처를 ★읽기 표시만 한다. 사용자가
 * playwright-report/index.html을 직접 안 열어도 여기서 통과/실패·캡처를 본다.
 * (청사진 §3 "사람은 검토자".)
 *
 * 데이터: /api/dorothy/test-results
 *   - GitHub Actions run(권위·라이브) + 로컬 캡처(local-file:// 임베드, Electron 한정).
 *
 * fireauto 7패턴 적용분: ①마지막 갱신 시각 ②실패 강조 ④점진 공개(썸네일→확대)
 *   ⑤run 링크 칩 ⑦빈 상태("없음 → 무엇하면 생김"). ③⑥은 데이터 부재로 미적용(빈 골격).
 *
 * ★없는 데이터는 그리지 않는다 — 도는척·에픽 계층은 빈 상태 자리만(순서 3·5 후 채움).
 */

import { useCallback, useEffect, useState } from 'react';
import { FreshnessBadge } from '@/components/Freshness';
import {
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  ExternalLink,
  Image as ImageIcon,
  FileText,
  Inbox,
  Activity,
  Layers,
  AlertTriangle,
} from 'lucide-react';

interface RunSummary {
  id: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  branch: string;
  createdAt: string;
  htmlUrl: string;
  runNumber: number;
}
interface ApiResponse {
  ok: boolean;
  repo: string;
  project: string;
  projects: { id: string; label: string }[];
  generatedAt: string;
  source: { github: string; local: string };
  runs: RunSummary[];
  latestArtifacts: { name: string; sizeKb: number; expired: boolean }[];
  localCaptures: { name: string; path: string }[];
  localReportPath: string | null;
}

/** 캡처/리포트를 HTTP로 서빙(local-file:// 대신) — 브라우저·Electron 양쪽 표시. */
function captureUrl(absPath: string): string {
  return `/api/dorothy/test-results/capture?path=${encodeURIComponent(absPath)}`;
}

function fmt(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ko-KR', { hour12: false });
  } catch {
    return iso;
  }
}

function ConclusionBadge({ status, conclusion }: { status: string; conclusion: string | null }) {
  if (status !== 'completed') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-400 text-xs font-medium">
        <Clock className="w-3.5 h-3.5" /> {status || 'pending'}
      </span>
    );
  }
  if (conclusion === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-400 text-xs font-semibold">
        <CheckCircle2 className="w-3.5 h-3.5" /> 통과
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-red-400 text-xs font-semibold">
      <XCircle className="w-3.5 h-3.5" /> {conclusion ?? '실패'}
    </span>
  );
}

function EmptyState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="border border-dashed border-border rounded-lg py-10 px-6 flex flex-col items-center text-center text-muted-foreground">
      <div className="opacity-50 mb-3">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs mt-1 opacity-80">{hint}</p>
    </div>
  );
}

/** 미래 페이지(도는척·에픽)가 붙을 자리 — 데이터 없음을 정직히(fireauto ⑦). 채우지 않는다. */
function FutureSkeleton({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="border border-dashed border-border/60 rounded-lg p-4 flex items-center gap-3 opacity-60">
      <div className="text-muted-foreground">{icon}</div>
      <div>
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <p className="text-xs text-muted-foreground/80">{hint}</p>
      </div>
    </div>
  );
}

export default function TestResultsDashboard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null); // 확대 캡처의 절대경로
  const [lastOk, setLastOk] = useState<number | null>(null); // fireauto ①: 마지막 성공 수신(클라이언트)
  const [projectId, setProjectId] = useState<string>(''); // 선택 프로젝트(빈값=API 기본=첫 프로젝트)

  const load = useCallback(async (pid?: string) => {
    setLoading(true);
    setError(null);
    try {
      const q = pid ? `?project=${encodeURIComponent(pid)}` : '';
      const res = await fetch(`/api/dorothy/test-results${q}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: ApiResponse = await res.json();
      setData(json);
      if (!projectId && json.project) setProjectId(json.project);
      setLastOk(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load(projectId || undefined);
    // projectId 변경 시 재조회
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const runs = data?.runs ?? [];
  const captures = data?.localCaptures ?? [];
  const hasFailure = runs.some(r => r.status === 'completed' && r.conclusion && r.conclusion !== 'success');

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header — fireauto ①: 마지막 갱신 시각 + 새로고침 */}
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-emerald-400" /> E2E 테스트 결과
        </h1>
        <div className="flex items-center gap-3">
          {/* fireauto ①: 클라이언트측 신선도(스냅샷 age·stale 드러냄) — 서버 generatedAt와 별개로 살아있는지 표시 */}
          <FreshnessBadge lastSuccessAt={lastOk} pollMs={30000} ok={!error} label="수신" />
          <button
            onClick={() => void load(projectId || undefined)}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-muted transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> 새로고침
          </button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-6">
        {data ? (
          <>
            {data.repo} · 마지막 갱신 {fmt(data.generatedAt)} · GitHub:{' '}
            <span className={data.source.github === 'ok' ? 'text-emerald-400' : 'text-amber-400'}>
              {data.source.github}
            </span>{' '}
            · 로컬 캡처: {data.source.local}
          </>
        ) : (
          '불러오는 중…'
        )}
      </p>

      {/* 프로젝트별 탭 — 데이터에 projects[] 있으면 표시 */}
      {(data?.projects?.length ?? 0) > 1 && (
        <div className="flex items-center gap-1.5 mb-5 border-b border-border">
          {data!.projects.map(p => {
            const active = (projectId || data!.project) === p.id;
            return (
              <button
                key={p.id}
                onClick={() => setProjectId(p.id)}
                className={`px-3 py-1.5 text-sm font-medium -mb-px border-b-2 transition-colors ${
                  active
                    ? 'border-blue-400 text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div className="mb-4 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> 불러오기 실패: {error}
        </div>
      )}

      {/* fireauto ②: 실패 강조 배너 */}
      {hasFailure && (
        <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-300 flex items-center gap-2">
          <XCircle className="w-4 h-4" /> 실패한 E2E run이 있습니다 — 아래 목록에서 확인하세요.
        </div>
      )}

      {/* Run 목록 (GitHub Actions, 권위) */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-muted-foreground mb-3">최근 실행 (GitHub Actions)</h2>
        {runs.length === 0 ? (
          <EmptyState
            icon={<Inbox className="w-8 h-8" />}
            title="아직 E2E 실행 기록이 없습니다."
            hint={
              data?.source.github === 'no-token'
                ? 'GitHub 토큰 미설정 — 연동 설정에서 appFactoryGithub 토큰을 등록하면 표시됩니다.'
                : 'bueongi에 push/PR이 생기면 GitHub Actions E2E 결과가 여기 표시됩니다.'
            }
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground text-xs">
                <tr>
                  <th className="text-left font-medium px-3 py-2">결과</th>
                  <th className="text-left font-medium px-3 py-2">브랜치 / 이벤트</th>
                  <th className="text-left font-medium px-3 py-2">실행 시각</th>
                  <th className="text-right font-medium px-3 py-2">Run</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => {
                  const failed = r.status === 'completed' && r.conclusion && r.conclusion !== 'success';
                  return (
                    <tr
                      key={r.id}
                      className={`border-t border-border ${failed ? 'bg-red-500/5' : ''}`}
                    >
                      <td className="px-3 py-2">
                        <ConclusionBadge status={r.status} conclusion={r.conclusion} />
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs">{r.branch || '—'}</span>
                        <span className="text-muted-foreground text-xs ml-2">{r.event}</span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground text-xs">{fmt(r.createdAt)}</td>
                      <td className="px-3 py-2 text-right">
                        {/* fireauto ⑤: run 링크 칩 */}
                        <a
                          href={r.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-400 hover:underline"
                        >
                          #{r.runNumber} <ExternalLink className="w-3 h-3" />
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* 최신 run artifact 링크 */}
        {(data?.latestArtifacts?.length ?? 0) > 0 && (
          <div className="mt-2 text-xs text-muted-foreground">
            최신 run artifact:{' '}
            {data!.latestArtifacts.map(a => (
              <span key={a.name} className="mr-2">
                <code>{a.name}</code> ({a.sizeKb}KB{a.expired ? ', 만료' : ''})
              </span>
            ))}
            <span className="opacity-70"> · 다운로드는 위 Run 페이지에서.</span>
          </div>
        )}
      </section>

      {/* 캡처 갤러리 (로컬, local-file://) — fireauto ④ 점진 공개 */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-muted-foreground">단계별 캡처 (로컬 마지막 실행)</h2>
          {data?.localReportPath && (
            <a
              href={captureUrl(data.localReportPath)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-400 hover:underline"
            >
              <FileText className="w-3.5 h-3.5" /> HTML 리포트 열기
            </a>
          )}
        </div>
        {captures.length === 0 ? (
          <EmptyState
            icon={<ImageIcon className="w-8 h-8" />}
            title="로컬 캡처가 없습니다."
            hint="해당 프로젝트에서 `npx playwright test`를 한 번 실행하면 screenshots/가 생성돼 여기 표시됩니다."
          />
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {captures.map(c => (
                <button
                  key={c.path}
                  onClick={() => setZoom(c.path)}
                  className="group border border-border rounded-md overflow-hidden bg-muted/30 hover:border-blue-400 transition-colors text-left"
                  title={c.name}
                >
                  <img
                    src={captureUrl(c.path)}
                    alt={c.name}
                    className="w-full h-32 object-cover object-top"
                    loading="lazy"
                  />
                  <div className="px-2 py-1 text-[11px] text-muted-foreground truncate">{c.name}</div>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground/70 mt-2">
              ※ 결과는 GitHub(권위), 캡처는 ★로컬 마지막 실행 기준 — 항상 일치하지 않을 수 있음.
            </p>
          </>
        )}
      </section>

      {/* 확장 골격 — 미래 페이지 빈 상태(데이터 없음, 채우지 않음) */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground mb-3">앞으로 (데이터 생기면 활성)</h2>
        <div className="space-y-2">
          <FutureSkeleton
            icon={<Activity className="w-5 h-5" />}
            title="에이전트 상태 (도는척 감지)"
            hint="리컨실러(청사진 순서 3) 도입 후 활성 — running/세션 화해 데이터 필요."
          />
          <FutureSkeleton
            icon={<Layers className="w-5 h-5" />}
            title="에픽 계층 (작업 분해)"
            hint="작업 분해(청사진 순서 5) 도입 후 활성 — 부모-자식 카드 데이터 필요."
          />
        </div>
      </section>

      {/* 확대 모달 */}
      {zoom && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
          onClick={() => setZoom(null)}
        >
          <img
            src={captureUrl(zoom)}
            alt="capture"
            className="max-w-full max-h-full rounded-lg shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
