'use client';

/**
 * Phase 6-AH — Slack / KakaoTalk 알림 연동 설정.
 *
 * 보안: secret(웹훅 URL/봇 토큰/REST key)은 저장하지 않습니다. 설정 여부만 표시하고
 * 비-secret 설정(채널/redirectUri/사용여부)만 저장합니다. 어떤 secret도 렌더/로그 안 함.
 *
 * KakaoTalk 주의: 카카오 개인 메시지 발송은 Slack 웹훅처럼 단순하지 않습니다(채널/권한/
 * 템플릿 제약). 따라서 "바로 발송 가능"으로 표시하지 않고 설정 단계만 안내합니다.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, RefreshCw, CheckCircle2, XCircle, ShieldAlert, Save, MessageSquare } from 'lucide-react';
import type { IntegrationSettings } from '@/types/integrations';
import { NOTIFICATION_EVENTS } from '@/types/integrations';

function StatusBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-green-500 text-xs font-medium"><CheckCircle2 className="w-3.5 h-3.5" /> 설정됨</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-muted-foreground text-xs"><XCircle className="w-3.5 h-3.5" /> 미설정</span>
  );
}

const KAKAO_STATUS_KO: Record<string, string> = {
  not_configured: '미설정',
  configured: '설정됨(발송은 별도 구현 필요)',
  pending_provider_setup: 'Kakao Developers 설정 대기',
};

function Tabs() {
  return (
    <div className="flex gap-2 text-sm">
      <Link href="/integrations/github" className="px-3 py-1.5 rounded bg-secondary text-muted-foreground hover:text-foreground">GitHub</Link>
      <Link href="/integrations/notifications" className="px-3 py-1.5 rounded bg-foreground text-background">Slack / Kakao 알림</Link>
    </div>
  );
}

export default function NotificationsIntegrationPage() {
  const [s, setS] = useState<IntegrationSettings | null>(null);
  const [slackEnabled, setSlackEnabled] = useState(false);
  const [channel, setChannel] = useState('');
  const [kakaoEnabled, setKakaoEnabled] = useState(false);
  const [redirectUri, setRedirectUri] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/dorothy/integrations', { cache: 'no-store' });
      const j = await r.json();
      const set = j.settings as IntegrationSettings;
      setS(set);
      setSlackEnabled(set.slack.enabled);
      setChannel(set.slack.channel ?? '');
      setKakaoEnabled(set.kakao.enabled);
      setRedirectUri(set.kakao.redirectUri ?? '');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await fetch('/api/dorothy/integrations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: {
          slack: { enabled: slackEnabled, channel },
          kakao: { enabled: kakaoEnabled, redirectUri },
        } }),
      });
      await load();
    } finally { setSaving(false); }
  }, [slackEnabled, channel, kakaoEnabled, redirectUri, load]);

  return (
    <div className="space-y-4 lg:space-y-6 pt-4 lg:pt-6 max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl lg:text-2xl font-bold flex items-center gap-2"><Bell className="w-6 h-6" /> 알림 연동</h1>
        <button onClick={() => { setLoading(true); void load(); }} className="flex items-center gap-2 px-3 py-2 text-sm bg-secondary rounded hover:bg-secondary/80">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> 새로고침
        </button>
      </div>
      <Tabs />

      {/* Slack */}
      <section className="border border-border rounded bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold flex items-center gap-2"><MessageSquare className="w-4 h-4" /> Slack</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="flex items-center justify-between border border-border rounded px-3 py-2">
            <span className="text-muted-foreground">Incoming Webhook</span>
            <StatusBadge ok={!!s?.slack.webhookConfigured} />
          </div>
          <div className="flex items-center justify-between border border-border rounded px-3 py-2">
            <span className="text-muted-foreground">Bot Token</span>
            <StatusBadge ok={!!s?.slack.botTokenConfigured} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={slackEnabled} onChange={e => setSlackEnabled(e.target.checked)} /> Slack 알림 사용
        </label>
        <label className="text-sm block">채널 (channelId 또는 #채널명)
          <input value={channel} onChange={e => setChannel(e.target.value)} placeholder="예: #dev-alerts" className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded" />
        </label>
        <p className="text-[11px] text-muted-foreground">Webhook URL · Bot Token 등 비밀값은 <Link href="/settings" className="underline">설정(Settings)</Link>에서 입력합니다. 저장 후 다시 표시되지 않습니다.</p>
      </section>

      {/* Kakao */}
      <section className="border border-border rounded bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">KakaoTalk</h2>
        <div className="flex items-center justify-between border border-border rounded px-3 py-2 text-sm">
          <span className="text-muted-foreground">상태</span>
          <span className="text-xs">{KAKAO_STATUS_KO[s?.kakao.status ?? 'not_configured']}</span>
        </div>
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] text-muted-foreground space-y-1">
          <p className="text-amber-500 font-medium flex items-center gap-1"><ShieldAlert className="w-3.5 h-3.5" /> 지원 범위 안내</p>
          <p>카카오톡 <b>개인 메시지 발송은 Slack 웹훅처럼 즉시 가능하지 않습니다</b>. Kakao Developers 앱 등록, 메시지 템플릿, 사용자 동의(scope), redirect URI 설정이 필요하며, "나에게 보내기" 외 친구 발송은 추가 권한이 필요합니다.</p>
          <p>이 화면은 현재 <b>설정 단계만 지원</b>하며 실제 발송은 별도 구현이 필요합니다(과장 표시하지 않음).</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={kakaoEnabled} onChange={e => setKakaoEnabled(e.target.checked)} /> Kakao 설정 사용(준비)
        </label>
        <label className="text-sm block">Redirect URI
          <input value={redirectUri} onChange={e => setRedirectUri(e.target.value)} placeholder="예: https://localhost/oauth/kakao" className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded" />
        </label>
        <div className="flex items-center justify-between border border-border rounded px-3 py-2 text-sm">
          <span className="text-muted-foreground">REST API Key</span>
          <StatusBadge ok={!!s?.kakao.apiKeyConfigured} />
        </div>
        <p className="text-[11px] text-muted-foreground">REST API Key는 비밀값이므로 이 화면에 저장/표시하지 않습니다.</p>
      </section>

      <button onClick={save} disabled={saving} className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-foreground text-background rounded disabled:opacity-50">
        <Save className="w-4 h-4" /> {saving ? '저장 중…' : '비-secret 설정 저장'}
      </button>

      {/* 알림 이벤트 + 테스트 */}
      <section className="border border-border rounded bg-card p-4 space-y-2 text-sm">
        <h2 className="text-sm font-semibold">알림 이벤트</h2>
        <div className="flex flex-wrap gap-1.5">
          {NOTIFICATION_EVENTS.map(e => (
            <span key={e.key} className="text-[11px] px-2 py-0.5 rounded bg-secondary text-muted-foreground">{e.label}</span>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">테스트 발송은 기본 <code className="font-mono">dryRun=true</code>이며 실제 외부 전송은 확인 절차가 필요합니다. (이번 단계는 설정·상태 표시 우선)</p>
      </section>
    </div>
  );
}
