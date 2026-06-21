'use client';

/**
 * 서비스 기동/정지 결과 팝업. 버튼 클릭 → 이 모달이 떠서 "어떻게 됐는지" 보여준다:
 *   - 요청 결과(메시지/pid/포트), 현재 포트 up/down(부모 프로브 prop),
 *   - 서비스 기동 로그(tail)를 ~2s 폴링해 실시간 표시(gradle/pnpm 실패 사유까지 보임).
 * 모달이 열려 있는 동안만 폴링한다. 닫으면 정지.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Loader2, X, Server, Monitor } from 'lucide-react';
import { probeView, type ProbeLike } from './lib';

export type ServiceRole = 'fe' | 'be';
export type ServiceAction = 'start' | 'stop';

export interface ServiceControlResult {
  ok: boolean;
  message: string;
  pid?: number;
  port?: number;
  logFile?: string;
}

export function ServiceActionModal({
  open, projectId, projectName, role, action, result, pending, probe, onClose,
}: {
  open: boolean;
  projectId: string;
  projectName?: string;
  role: ServiceRole;
  action: ServiceAction;
  result: ServiceControlResult | null; // null = 요청 진행 중
  pending: boolean;                    // 요청(POST) 진행 중
  probe?: ProbeLike;                   // 부모가 5s 폴링하는 현재 상태
  onClose: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [logExists, setLogExists] = useState(true);
  const logBoxRef = useRef<HTMLDivElement>(null);

  const fetchLog = useCallback(async () => {
    try {
      const res = await fetch(`/api/dorothy/projects/${encodeURIComponent(projectId)}/service-log/?role=${role}&lines=200`, { cache: 'no-store' });
      const j = await res.json().catch(() => null);
      if (j && Array.isArray(j.lines)) { setLines(j.lines); setLogExists(j.exists !== false); }
    } catch { /* 무시(다음 틱 재시도) */ }
  }, [projectId, role]);

  // 열려 있는 동안 로그 폴링(2s). 정지 동작이어도 직전 로그를 보여준다.
  // (액션마다 부모가 key 로 remount → 초기 state 로 자연 리셋. 초기 호출도 콜백으로 두어
  //  effect 본문에서 동기 setState 가 일어나지 않게 한다.)
  useEffect(() => {
    if (!open) return;
    let active = true;
    const tick = () => { if (active && !document.hidden) fetchLog(); };
    const t0 = setTimeout(tick, 0);          // 초기 1회
    const t = setInterval(tick, 2000);
    return () => { active = false; clearTimeout(t0); clearInterval(t); };
  }, [open, fetchLog]);

  // 새 줄 들어오면 맨 아래로 자동 스크롤
  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (!open) return null;

  const actionLabel = action === 'start' ? '기동' : '정지';
  const roleLabel = role.toUpperCase();
  const pv = probeView(probe);
  const up = pv.tone === 'success';

  // 상태 배지: 요청 진행중 / 성공·실패 / 라이브 포트
  const badge = pending
    ? { cls: 'bg-cyan-500/20 text-cyan-400', text: `${actionLabel} 요청 중`, spin: true }
    : result?.ok
      ? { cls: 'bg-emerald-500/20 text-emerald-500', text: `${actionLabel} 요청됨`, spin: false }
      : { cls: 'bg-rose-500/20 text-rose-400', text: '실패', spin: false };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog" aria-modal="true"
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl bg-card border border-border rounded-xl overflow-hidden shadow-xl"
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2.5">
            {role === 'fe' ? <Monitor className="w-4 h-4 text-muted-foreground" /> : <Server className="w-4 h-4 text-muted-foreground" />}
            <div>
              <h3 className="font-semibold text-sm text-foreground">{projectName || projectId} · {roleLabel} {actionLabel}</h3>
              <p className="text-[11px] text-muted-foreground">
                현재 상태:{' '}
                <span className={up ? 'text-emerald-500' : pv.tone === 'danger' ? 'text-rose-400' : 'text-muted-foreground'}>{pv.text}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-[11px] px-2 py-1 rounded flex items-center gap-1.5 ${badge.cls}`}>
              {badge.spin && <Loader2 className="w-3 h-3 animate-spin" />}{badge.text}
            </span>
            <button onClick={onClose} className="p-1.5 hover:bg-secondary rounded transition-colors" aria-label="닫기">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 결과 메시지 */}
        {result && (
          <div className={`px-4 py-2 text-xs border-b border-border ${result.ok ? 'text-foreground' : 'text-rose-500'}`}>
            {result.message}
            {result.pid != null && <span className="text-muted-foreground"> · pid {result.pid}</span>}
            {result.port != null && <span className="text-muted-foreground"> · :{result.port}</span>}
          </div>
        )}

        {/* 로그 tail */}
        <div className="px-4 pt-2 pb-1 text-[11px] text-muted-foreground flex items-center justify-between">
          <span>기동 로그 (2초마다 갱신)</span>
          {result?.logFile && <span className="font-mono opacity-70 truncate max-w-[60%]" title={result.logFile}>{result.logFile}</span>}
        </div>
        <div
          ref={logBoxRef}
          className="h-[340px] overflow-auto bg-[#0D0B08] text-[#d4d4d4] font-mono text-[11px] leading-relaxed px-4 py-3 whitespace-pre-wrap break-all"
        >
          {!logExists
            ? <span className="text-muted-foreground">아직 로그가 없습니다 (정지 동작이거나 외부 기동 — 로그 파일 미생성).</span>
            : lines.length === 0
              ? <span className="text-muted-foreground">로그 불러오는 중…</span>
              : lines.map((l, i) => <div key={i}>{l || ' '}</div>)}
        </div>

        {/* 푸터 */}
        <div className="px-4 py-3 border-t border-border flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground">
            {action === 'start'
              ? 'gradle/vite는 바인딩까지 수십초 걸릴 수 있습니다. 로그를 보며 기다리세요.'
              : '정지 요청을 보냈습니다.'}
          </p>
          <button onClick={onClose} className="px-4 py-1.5 text-sm rounded bg-secondary hover:bg-secondary/80 transition-colors">닫기</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
