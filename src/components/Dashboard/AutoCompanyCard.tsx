'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Play, Square, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { dorothyClient } from '@/lib/dorothyClient';
import { plainAutoStatus, toneClasses, type PlainStatus } from '@/lib/autoCompanyStatus';

interface AutoData {
  state?: Record<string, string>;
  paused?: boolean;
  pidAlive?: boolean;
  dorothyBusy?: boolean;
  error?: string;
}

// 대시보드용 오토컴퍼니 요약 + 시작/중지 카드. 전체 제어는 /auto-company 에서.
export default function AutoCompanyCard() {
  const [data, setData] = useState<AutoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const j = (await dorothyClient.autoCompany.get()) as AutoData;
      setData(j);
    } catch (e) {
      setData({ error: String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000); // 15초마다 상태 갱신
    return () => clearInterval(t);
  }, [load]);

  const plain: PlainStatus = plainAutoStatus({
    state: data?.state,
    paused: data?.paused,
    pidAlive: data?.pidAlive,
    dorothyBusy: data?.dorothyBusy,
  });
  const tone = toneClasses[plain.tone];
  const isOn = plain.tone === 'running' || plain.tone === 'resting';

  const control = async (action: 'start' | 'stop', confirmMsg: string) => {
    if (typeof window !== 'undefined' && !window.confirm(confirmMsg)) return;
    setBusy(true);
    setToast(null);
    try {
      const res = await dorothyClient.autoCompany.control(action);
      setToast(res?.error ? `실패: ${res.error}` : res?.message ?? '완료');
    } catch (e) {
      setToast(`실패: ${String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 4000);
      setTimeout(() => void load(), 1500);
    }
  };

  return (
    <div className={`rounded-xl border p-3 flex items-center gap-3 ${tone.bg}`}>
      <span className="text-2xl leading-none shrink-0">{loading ? '⏳' : plain.emoji}</span>
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-semibold flex items-center gap-2 ${tone.text}`}>
          <span className={`w-2 h-2 rounded-full ${tone.dot}`} />
          오토컴퍼니 · {loading ? '상태 확인 중…' : plain.headline}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {toast ?? (loading ? '' : plain.detail)}
        </div>
      </div>

      {!isOn ? (
        <button
          onClick={() => control('start', '자동 개발(오토컴퍼니)을 시작할까요? 24시간 스스로 작업해요.')}
          disabled={busy || loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-green-600 text-white hover:bg-green-600/90 disabled:opacity-50 shrink-0"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          시작
        </button>
      ) : (
        <button
          onClick={() => control('stop', '자동 개발을 중지(일시정지)할까요? 진행 중 작업이 멈춰요(내용은 보존).')}
          disabled={busy || loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-secondary hover:bg-secondary/80 disabled:opacity-50 shrink-0"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
          중지
        </button>
      )}

      <button
        onClick={() => void load()}
        disabled={busy}
        title="새로고침"
        className="p-1.5 rounded-md hover:bg-secondary/60 text-muted-foreground shrink-0"
      >
        <RefreshCw className="w-4 h-4" />
      </button>

      <Link
        href="/auto-company"
        className="flex items-center gap-1 px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground shrink-0"
      >
        자세히 <ChevronRight className="w-4 h-4" />
      </Link>
    </div>
  );
}
