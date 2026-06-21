'use client';

/**
 * PR-2-U1 — Projects 영역. /api/dorothy/projects 배선 → ProjectCard 리스트.
 * 카드 클릭 → onSelect(project)(필터는 KanbanBoard 가 별도 슬롯에서 AND 합성). clearable.
 * ★상태: 로딩 / 에러 / 빈 / observed:false(repo 없음 등) 전부 깨짐 0.
 * ★조인 불가(repos 부재) → "매핑 확인 불가" 안내(거짓 필터 금지).
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { ProjectCard, type ProjectCardData, type ServiceRole, type ServiceAction } from './ProjectCard';
import { ServiceActionModal, type ServiceControlResult } from './ServiceActionModal';

export function ProjectsStrip({
  selectedId,
  onSelect,
  pollMs = 5000,
}: {
  selectedId: string | null;
  onSelect: (project: ProjectCardData | null) => void;
  pollMs?: number;
}) {
  const [projects, setProjects] = useState<ProjectCardData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  // triplan soo-auth(:18080) — capsule fe/be 밖 추가 백엔드. 별도 라우트로 상태/제어.
  const [authUp, setAuthUp] = useState<boolean | null>(null);
  const [authPending, setAuthPending] = useState(false);
  // 결과 팝업: 클릭 시 열려 어떻게 됐는지(메시지·로그·라이브 상태)를 보여준다.
  const [modal, setModal] = useState<{ projectId: string; role: ServiceRole; action: ServiceAction } | null>(null);
  const [modalResult, setModalResult] = useState<ServiceControlResult | null>(null);
  const [modalPending, setModalPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/dorothy/projects', { cache: 'no-store' });
      const j = await res.json();
      const list = j?.data?.projects;
      if (Array.isArray(list)) { setProjects(list); setError(null); }
      else setError(j?.meta?.error || '프로젝트 신호 없음');
    } catch {
      setError('프로젝트를 가져오지 못했습니다');
    }
    // soo-auth 상태(triplan 인증 서버) — 실패해도 프로젝트 로딩엔 영향 없음.
    try {
      const r = await fetch('/api/dorothy/services/soo-auth', { cache: 'no-store' });
      const a = await r.json();
      setAuthUp(typeof a?.up === 'boolean' ? a.up : null);
    } catch { setAuthUp(null); }
  }, []);

  // soo-auth 기동/정지(triplan 전용). 별도 라우트 → 스크립트 실행/포트 종료.
  const handleAuthAction = useCallback(async (action: ServiceAction) => {
    setAuthPending(true);
    try {
      await fetch('/api/dorothy/services/soo-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    } catch { /* 무시 — 폴링이 상태 반영 */ }
    finally { setAuthPending(false); load(); }
  }, [load]);

  useEffect(() => {
    load();
    // ★폴링은 탭이 보일 때만(document.hidden 시 스킵).
    const run = () => { if (!document.hidden) load(); };
    const t = setInterval(run, pollMs);
    document.addEventListener('visibilitychange', run);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', run); };
  }, [load, pollMs]);

  // ★basename 충돌 가드(§5): 여러 capsule 에 중복된 repo basename(frontend/backend 등)은 매칭 키에서 제외(거짓 포함 < 누락).
  const ambiguous = useMemo(() => {
    const cnt = new Map<string, number>();
    (projects ?? []).forEach((p) => (p.repos ?? []).forEach((r) => cnt.set(r, (cnt.get(r) ?? 0) + 1)));
    return new Set([...cnt.entries()].filter(([, n]) => n > 1).map(([r]) => r));
  }, [projects]);

  // 서비스 start/stop(★제어). 팝업을 열어 진행/결과/로그를 보여주고, 끝나면 즉시 재조회로 점 갱신.
  const handleServiceAction = useCallback(async (projectId: string, role: ServiceRole, action: ServiceAction) => {
    const key = `${projectId}:${role}`;
    setModal({ projectId, role, action });
    setModalResult(null);
    setModalPending(true);
    setPending((prev) => new Set(prev).add(key));
    try {
      // 끝 슬래시: next.config trailingSlash:true 의 308 왕복 회피(POST body 재전송 방지).
      const res = await fetch(`/api/dorothy/projects/${encodeURIComponent(projectId)}/service/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, action }),
      });
      const j = await res.json().catch(() => null);
      setModalResult(j && typeof j.message === 'string' ? j : { ok: res.ok, message: res.ok ? '완료' : `실패(${res.status})` });
    } catch {
      setModalResult({ ok: false, message: '요청 실패(네트워크)' });
    } finally {
      setModalPending(false);
      setPending((prev) => { const n = new Set(prev); n.delete(key); return n; });
      load(); // start 직후엔 아직 바인딩 전일 수 있음 → 폴링이 곧 따라잡음
    }
  }, [load]);

  const handlePick = useCallback((p: ProjectCardData | null) => {
    if (!p) return onSelect(null);
    const repos = (p.repos ?? []).filter((r) => !ambiguous.has(r)); // 충돌 basename 제외
    onSelect({ ...p, repos });
  }, [onSelect, ambiguous]);

  const selected = projects?.find((p) => p.projectId === selectedId) ?? null;
  const selRepos = selected ? (selected.repos ?? []).filter((r) => !ambiguous.has(r)) : [];
  const joinUnavailable = !!selected && selRepos.length === 0;

  return (
    <div className="px-6 pt-1 pb-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Projects</span>
        {selectedId && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-[11px] text-primary hover:underline"
          >
            필터 해제 · {selectedId}
          </button>
        )}
      </div>

      {projects === null && !error && <div className="text-xs text-muted-foreground">프로젝트 로딩…</div>}
      {error && <div className="text-xs text-rose-400">프로젝트 신호 오류: {error}</div>}
      {projects && projects.length === 0 && <div className="text-xs text-muted-foreground">표시할 프로젝트 없음</div>}

      {projects && projects.length > 0 && (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {projects.map((p) => (
            <div key={p.projectId} className="w-72 shrink-0">
              <ProjectCard
                project={p}
                selected={p.projectId === selectedId}
                onSelect={handlePick}
                onServiceAction={handleServiceAction}
                pendingRoles={pending}
                extraServices={p.projectId === 'triplan' ? [{
                  label: 'AUTH', up: authUp === true, pending: authPending, port: 18080,
                  onAct: () => handleAuthAction(authUp ? 'stop' : 'start'),
                }] : undefined}
              />
            </div>
          ))}
        </div>
      )}

      {modal && (
        <ServiceActionModal
          key={`${modal.projectId}:${modal.role}:${modal.action}`}
          open={!!modal}
          projectId={modal.projectId}
          projectName={projects?.find((p) => p.projectId === modal.projectId)?.name}
          role={modal.role}
          action={modal.action}
          result={modalResult}
          pending={modalPending}
          probe={(() => {
            const p = projects?.find((x) => x.projectId === modal.projectId);
            return modal.role === 'fe' ? p?.fe : p?.be;
          })()}
          onClose={() => setModal(null)}
        />
      )}

      {joinUnavailable && (
        <div className="text-[11px] text-amber-600 mt-1">
          이 프로젝트의 작업 매핑 확인 불가 — 필터를 적용하지 않습니다.
        </div>
      )}
    </div>
  );
}
