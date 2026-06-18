'use client';

/**
 * Phase 6-AH — GitHub 연동 설정 (read-mostly + non-secret config).
 *
 * 보안: secret 값(웹훅 시크릿/토큰)은 이 화면에서 저장하지 않습니다. 설정 여부
 * (configured 불리언)만 표시하고, 실제 토큰 입력은 기존 Settings 흐름에 위임합니다.
 * 어떤 secret도 렌더/로그하지 않습니다.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Github, RefreshCw, CheckCircle2, XCircle, Link as LinkIcon, ShieldAlert, Save } from 'lucide-react';
import type { IntegrationSettings } from '@/types/integrations';

function StatusBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-green-500 text-xs font-medium"><CheckCircle2 className="w-3.5 h-3.5" /> 설정됨</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-muted-foreground text-xs"><XCircle className="w-3.5 h-3.5" /> 미설정</span>
  );
}

function Tabs() {
  return (
    <div className="flex gap-2 text-sm">
      <Link href="/integrations/github" className="px-3 py-1.5 rounded bg-foreground text-background">GitHub</Link>
      <Link href="/integrations/notifications" className="px-3 py-1.5 rounded bg-secondary text-muted-foreground hover:text-foreground">Slack / Kakao 알림</Link>
    </div>
  );
}

export default function GithubIntegrationPage() {
  const [s, setS] = useState<IntegrationSettings | null>(null);
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/dorothy/integrations', { cache: 'no-store' });
      const j = await r.json();
      const set = j.settings as IntegrationSettings;
      setS(set);
      setOwner(set.github.defaultOwner ?? '');
      setRepo(set.github.defaultRepo ?? '');
      setEnabled(set.github.enabled);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await fetch('/api/dorothy/integrations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: { github: { enabled, defaultOwner: owner, defaultRepo: repo } } }),
      });
      await load();
    } finally { setSaving(false); }
  }, [enabled, owner, repo, load]);

  return (
    <div className="space-y-4 lg:space-y-6 pt-4 lg:pt-6 max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl lg:text-2xl font-bold flex items-center gap-2"><Github className="w-6 h-6" /> GitHub 연동</h1>
        <button onClick={() => { setLoading(true); void load(); }} className="flex items-center gap-2 px-3 py-2 text-sm bg-secondary rounded hover:bg-secondary/80">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> 새로고침
        </button>
      </div>
      <Tabs />

      {/* Webhook 상태 */}
      <section className="border border-border rounded bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">Webhook 상태</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="flex items-center justify-between border border-border rounded px-3 py-2">
            <span className="text-muted-foreground">Webhook Secret</span>
            <StatusBadge ok={!!s?.github.webhookSecretConfigured} />
          </div>
          <div className="flex items-center justify-between border border-border rounded px-3 py-2">
            <span className="text-muted-foreground">App / Token</span>
            <StatusBadge ok={!!s?.github.tokenConfigured} />
          </div>
        </div>
        <div className="text-sm">
          <div className="text-muted-foreground mb-1">Webhook URL</div>
          <code className="font-mono text-xs bg-secondary px-2 py-1 rounded inline-flex items-center gap-1"><LinkIcon className="w-3 h-3" />{s?.github.webhookUrl ?? '/api/github/webhook'}</code>
        </div>
        <div className="text-[11px] text-muted-foreground">
          구독 이벤트: <code className="font-mono">pull_request</code>, <code className="font-mono">push</code>, <code className="font-mono">check_suite</code>, <code className="font-mono">workflow_run</code>
        </div>
      </section>

      {/* 비-secret 설정 */}
      <section className="border border-border rounded bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">기본 저장소 설정 (비밀값 아님)</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> GitHub 연동 사용
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-sm">Owner
            <input value={owner} onChange={e => setOwner(e.target.value)} placeholder="예: my-org" className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded" />
          </label>
          <label className="text-sm">Repo
            <input value={repo} onChange={e => setRepo(e.target.value)} placeholder="예: triplan" className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded" />
          </label>
        </div>
        <button onClick={save} disabled={saving} className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-foreground text-background rounded disabled:opacity-50">
          <Save className="w-4 h-4" /> {saving ? '저장 중…' : '저장'}
        </button>
      </section>

      {/* secret 안내 */}
      <section className="border border-amber-500/30 bg-amber-500/5 rounded p-4 text-sm space-y-2">
        <h2 className="text-sm font-semibold flex items-center gap-2 text-amber-500"><ShieldAlert className="w-4 h-4" /> 토큰 / Webhook Secret 입력</h2>
        <p className="text-muted-foreground text-[13px]">
          보안 정책상 이 화면은 <b>비밀값을 저장하지 않습니다</b>. Webhook Secret · App/Personal Access Token은
          기존 <Link href="/settings" className="underline">설정(Settings)</Link> 흐름에서 입력·저장됩니다.
          저장된 비밀값은 어디에도 다시 표시되지 않습니다.
        </p>
        <p className="text-[11px] text-muted-foreground">{`토큰은 저장 후 다시 표시되지 않습니다.`}</p>
      </section>

      {/* 연결 테스트 (dry-run/local) */}
      <section className="border border-border rounded bg-card p-4 text-sm space-y-2">
        <h2 className="text-sm font-semibold">연결 테스트</h2>
        <p className="text-muted-foreground text-[13px]">
          로컬 검증만 수행합니다: Webhook URL 경로(<code className="font-mono">/api/github/webhook</code>) 존재 여부와 Secret 설정 여부 확인.
          실제 GitHub API 호출/발송은 하지 않습니다.
        </p>
        <div className="text-[13px]">
          판정: {s ? (s.github.webhookSecretConfigured ? '✅ Webhook 수신 준비됨(Secret 설정됨)' : '⚠️ Webhook Secret 미설정 — Settings에서 설정 필요') : '…'}
        </div>
      </section>
    </div>
  );
}
