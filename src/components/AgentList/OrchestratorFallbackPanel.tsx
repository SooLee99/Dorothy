'use client';

/**
 * Phase 6-AP — Codex 한도 중 orchestrator만 임시 Claude로 전환하는 confirm-gate 패널.
 * confirm 체크 시에만 적용/롤백. agents.json 백업 후 orchestrator 단일 변경.
 *
 * 라이브 반영(자동): apply/rollback 시 route가 pending 마커를 남기고, 이 패널이 진입/폴링 중
 * liveReloadPending 을 감지하면 자동으로 reloadLiveAgents(브라우저 IPC)를 호출해 디스크 변경을
 * Electron in-memory 맵으로 밀어넣는다. 성공하면 markLiveReloaded 로 마커를 삭제(self-clearing).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { dorothyRunsClient } from '@/lib/dorothyRunsClient';

interface Status {
  cooldownActive: boolean;
  cooldownUntil: string | null;
  orchestratorProvider: string | null;
  fallbackActive: boolean;
  liveReloadPending: boolean;
  autoFallback: boolean;
  autoRestore: boolean;
  restoreAt: string | null;
  restoreEligible: boolean;
  restoreRemainingMs: number | null;
  audit: { count: number; codex: number; claude: number; uuid: number; codexOpus: number };
}

function fmtRemaining(ms: number | null): string {
  if (ms == null) return '-';
  if (ms <= 0) return '복귀 가능(시간 도달)';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}시간 ${m % 60}분 후` : `${m}분 후`;
}

interface ProviderState {
  codex: { limited: boolean; cooldownUntil: string | null };
  claude: { limited: boolean; cooldownUntil: string | null };
  safePause: { active: boolean; until: string | null; reason: string | null; remainingMs: number | null };
  orchestrator: { provider: string | null; fallbackActive: boolean };
  usage: { claudePctRemaining: number | null; codexMode: string | null };
}

export default function OrchestratorFallbackPanel() {
  const [s, setS] = useState<Status | null>(null);
  const [pls, setPls] = useState<ProviderState | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const autoRef = useRef(false);  // 자동 반영 in-flight 가드
  const triedRef = useRef(false); // 마운트당 1회만 자동 시도(브리지 없을 때 무한루프 방지)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/dorothy/orchestrator-fallback', { cache: 'no-store' });
      setS(await r.json());
    } catch { /* ignore */ }
    try {
      const r2 = await fetch('/api/dorothy/provider-limit-state', { cache: 'no-store' });
      setPls(await r2.json());
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { void load(); const id = setInterval(load, 15000); return () => clearInterval(id); }, [load]);

  // 디스크(agents.json)를 electron in-memory 맵으로 반영. 이걸 호출해야 다음 사이클
  // /start가 새 provider로 spawn하고, saveAgents()가 디스크를 되돌리지 않는다.
  const reloadLive = useCallback(async (): Promise<{ ok: boolean; msg: string }> => {
    try {
      const res = await dorothyRunsClient.agentDefinitions.reloadLiveAgents({ reason: 'orchestrator_fallback' });
      const r = res.ok ? res.data?.result : undefined;
      if (r?.ok) return { ok: true, msg: `라이브 반영 완료(${r.beforeCount}→${r.afterCount}${r.updatedAgentIds?.length ? `, 갱신 ${r.updatedAgentIds.join(',')}` : ''})` };
      return { ok: false, msg: `라이브 반영 실패: ${r?.error ?? '대시보드(Electron)에서만 가능'}` };
    } catch {
      return { ok: false, msg: '라이브 반영 실패(브리지 없음 — 대시보드에서 실행 필요)' };
    }
  }, []);

  const markReloaded = useCallback(async () => {
    try {
      await fetch('/api/dorothy/orchestrator-fallback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'markLiveReloaded' }),
      });
    } catch { /* ignore */ }
  }, []);

  // 자동 라이브 반영: 디스크엔 적용됐는데 메모리 미반영(pending)일 때 1회 자동 실행
  useEffect(() => {
    if (!s?.liveReloadPending) return;
    if (autoRef.current || triedRef.current) return;
    triedRef.current = true;
    autoRef.current = true;
    void (async () => {
      const r = await reloadLive();
      if (r.ok) { await markReloaded(); setMsg(`자동 라이브 반영됨 · ${r.msg}`); }
      else { setMsg(`자동 반영 실패 — 아래 "라이브 반영" 버튼을 눌러주세요 · ${r.msg}`); }
      await load();
      autoRef.current = false;
    })();
  }, [s, reloadLive, markReloaded, load]);

  const act = useCallback(async (action: 'apply' | 'rollback') => {
    if (!confirm) { setMsg('확인 체크박스를 먼저 선택하세요'); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/dorothy/orchestrator-fallback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, confirm: true }),
      });
      const j = await r.json();
      if (j.ok) {
        // 디스크 기록 직후 즉시 in-memory 반영 → 다음 PM-tick이 새 provider로 spawn
        const live = await reloadLive();
        if (live.ok) await markReloaded();
        setMsg(`${action === 'apply' ? '임시 전환됨' : '되돌림'} · ${live.msg}`);
      } else {
        setMsg(`실패: ${j.error}`);
      }
      setConfirm(false);
      await load();
    } finally { setBusy(false); }
  }, [confirm, load, reloadLive, markReloaded]);

  const setAuto = useCallback(async (key: 'fallback' | 'restore', value: boolean) => {
    setBusy(true);
    try {
      await fetch('/api/dorothy/orchestrator-fallback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setAuto', key, value }),
      });
      await load();
    } finally { setBusy(false); }
  }, [load]);

  const onReloadOnly = useCallback(async () => {
    setBusy(true);
    const r = await reloadLive();
    if (r.ok) await markReloaded();
    setMsg(r.msg);
    setBusy(false);
    await load();
  }, [reloadLive, markReloaded, load]);

  // 한도/ fallback / 미반영(pending) 중 아무 것도 없으면 패널 숨김(평상시 노이즈 방지)
  if (!s) return null;
  if (!s.cooldownActive && !s.fallbackActive && !s.liveReloadPending && !pls?.safePause?.active) return null;

  const sp = pls?.safePause;
  return (
    <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      {sp?.active && (
        <div className="mb-2 rounded border border-red-500/50 bg-red-500/10 p-2">
          <div className="text-sm font-semibold text-red-600">⛔ 모든 모델 사용 한도 도달 — 안전 대기 중</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            새 자동개발 작업을 시작하지 않고 안전 대기합니다. 다음 사용 가능 시간에 자동으로 재개됩니다.
            {sp.until && ` · 재개 예정 ${new Date(sp.until).toLocaleString()} (${fmtRemaining(sp.remainingMs ?? null)})`}
          </p>
        </div>
      )}
      {pls && (
        <div className="mb-2 flex items-center gap-3 text-[11px]">
          <span>Codex: <b className={pls.codex.limited ? 'text-red-600' : 'text-green-600'}>{pls.codex.limited ? '한도 초과' : '사용 가능'}</b>
            {pls.codex.limited && pls.codex.cooldownUntil && ` (~${new Date(pls.codex.cooldownUntil).toLocaleTimeString()})`}</span>
          <span>Claude: <b className={pls.claude.limited ? 'text-red-600' : 'text-green-600'}>{pls.claude.limited ? '한도 초과' : '사용 가능'}</b>
            {pls.usage.claudePctRemaining != null && ` (잔여 ${pls.usage.claudePctRemaining}%)`}</span>
        </div>
      )}
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="w-4 h-4 text-amber-500" />
        <span className="text-sm font-semibold text-foreground">
          {s.fallbackActive ? 'orchestrator 임시 Claude 전환 중' : 'Codex 사용 한도 감지됨'}
        </span>
        <button onClick={load} className="ml-auto text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"><RefreshCw className="w-3 h-3" /> 새로고침</button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {s.fallbackActive
          ? 'orchestrator가 임시로 Claude로 동작하도록 설정되어 있습니다. Codex 한도 회복 후 되돌릴 수 있습니다.'
          : 'Codex 한도 중입니다 — 자동개발 조율(orchestrator)이 멈출 수 있습니다. orchestrator만 임시로 Claude로 전환하면 한도와 무관하게 계속 진행할 수 있습니다.'}
      </p>
      {s.liveReloadPending && (
        <p className="text-[11px] text-amber-600 mt-1">⏳ 디스크 변경을 Electron 메모리에 반영 중입니다(자동)… 자동 반영이 안 되면 아래 "라이브 반영" 버튼을 눌러주세요.</p>
      )}
      <p className="text-[10px] text-muted-foreground mt-0.5">
        orchestrator provider: <b className="text-foreground">{s.orchestratorProvider}</b>
        {s.cooldownUntil && ` · 한도 리셋: ${new Date(s.cooldownUntil).toLocaleString()}`}
        {` · count=${s.audit.count} codex=${s.audit.codex} claude=${s.audit.claude} (codex+opus=${s.audit.codexOpus}, legacy=${s.audit.uuid})`}
      </p>
      {s.fallbackActive && (
        <p className="text-[11px] text-foreground mt-1">
          🔁 자동 Codex 복귀: <b>{s.autoRestore ? '켜짐' : '꺼짐'}</b>
          {s.restoreAt && ` · 예정 ${new Date(s.restoreAt).toLocaleString()} (${s.restoreEligible ? '복귀 가능 — 다음 PM-tick에서 자동 복귀' : fmtRemaining(s.restoreRemainingMs)})`}
        </p>
      )}
      <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
        <label className="flex items-center gap-1 cursor-pointer" title="cooldown 도달 시 PM-tick이 orchestrator를 자동으로 Codex로 복귀(권장 켜짐)">
          <input type="checkbox" checked={s.autoRestore} disabled={busy} onChange={e => setAuto('restore', e.target.checked)} />
          cooldown 후 자동 Codex 복귀
        </label>
        <label className="flex items-center gap-1 cursor-pointer" title="Codex 한도 감지 시 PM-tick이 orchestrator를 자동으로 Claude로 전환(기본 꺼짐 — 모델/비용 변경이라 수동 권장)">
          <input type="checkbox" checked={s.autoFallback} disabled={busy} onChange={e => setAuto('fallback', e.target.checked)} />
          Codex 한도 시 자동 Claude 전환
        </label>
      </div>
      <label className="flex items-center gap-1.5 text-[11px] text-foreground mt-2 cursor-pointer">
        <input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} />
        백업 후 적용하는 것에 동의합니다 (orchestrator 단일 대상, 되돌리기 가능)
      </label>
      <div className="flex items-center gap-1.5 mt-1.5">
        {!s.fallbackActive ? (
          <button onClick={() => act('apply')} disabled={!confirm || busy} className="px-2.5 py-1 text-[11px] bg-foreground text-background rounded disabled:opacity-40">
            orchestrator를 Claude로 임시 전환
          </button>
        ) : (
          <button onClick={() => act('rollback')} disabled={!confirm || busy} className="px-2.5 py-1 text-[11px] bg-foreground text-background rounded disabled:opacity-40">
            orchestrator를 Codex로 되돌리기
          </button>
        )}
        <button onClick={onReloadOnly} disabled={busy} className="px-2.5 py-1 text-[11px] border border-border rounded text-foreground hover:bg-secondary disabled:opacity-40" title="디스크의 agents.json을 Electron 메모리로 즉시 반영(다음 사이클부터 적용·되돌림 방지)">
          라이브 반영(새로고침)
        </button>
      </div>
      {msg && <p className="text-[11px] text-cyan-400 mt-1">{msg}</p>}
    </div>
  );
}
