'use client';

/**
 * Phase 6-BB — 프로젝트별 환경변수 / API 키 + 메모 관리.
 * 입력 → 저장(secret 0600, 화면 미표시) → "프로젝트에 .env 적용"으로 실제 사용 가능.
 * 메모는 project-notes 에 저장(주석/메모).
 */

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Save, FileDown, KeyRound } from 'lucide-react';

interface EnvVar { key: string; value: string; secret: boolean; note: string; hasValue?: boolean }

export function ProjectEnvNotes({ projectId }: { projectId: string }) {
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/dorothy/project-env?projectId=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
      const j = await r.json();
      setVars((j.vars ?? []).map((v: { key: string; value?: string; secret?: boolean; note?: string; hasValue?: boolean }) => ({ key: v.key, value: v.value ?? '', secret: !!v.secret, note: v.note ?? '', hasValue: !!v.hasValue })));
    } catch { /* ignore */ }
    try {
      const r2 = await fetch('/api/dorothy/project-notes', { cache: 'no-store' });
      const j2 = await r2.json();
      setNote(j2.notes?.[projectId]?.note ?? '');
    } catch { /* ignore */ }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const upd = (i: number, patch: Partial<EnvVar>) => setVars(v => v.map((x, j) => j === i ? { ...x, ...patch } : x));

  const save = useCallback(async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/dorothy/project-env', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set', projectId, vars: vars.filter(v => v.key.trim()) }),
      });
      const j = await r.json();
      await fetch('/api/dorothy/project-notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, note }),
      });
      setMsg(j.ok ? '저장됨 (secret 값은 화면에 다시 표시되지 않음)' : (j.error || '저장 실패'));
      await load();
    } finally { setBusy(false); }
  }, [vars, note, projectId, load]);

  const del = useCallback(async (key: string) => {
    setBusy(true);
    try {
      await fetch('/api/dorothy/project-env', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', projectId, key }) });
      await load();
    } finally { setBusy(false); }
  }, [projectId, load]);

  const apply = useCallback(async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/dorothy/project-env', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply', projectId }) });
      const j = await r.json();
      setMsg(j.ok ? `.env 적용됨 (${j.applied}개) — 프로젝트에서 바로 사용 가능 (git 제외)` : (j.error || '.env 적용 실패'));
    } finally { setBusy(false); }
  }, [projectId, load]);

  return (
    <div className="mt-2 border-t border-border pt-2 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground"><KeyRound className="w-3.5 h-3.5 text-amber-500" /> 환경변수 / API 키</div>
      <p className="text-[10px] text-muted-foreground">대시보드에 입력 → 저장 → &quot;프로젝트에 .env 적용&quot;하면 프로젝트가 실제로 사용합니다. secret(키)는 0600 저장·화면 미표시. 각 줄에 메모(주석) 가능.</p>
      <div className="space-y-1">
        {vars.map((v, i) => (
          <div key={i} className="grid grid-cols-12 gap-1 items-center">
            <input value={v.key} onChange={e => upd(i, { key: e.target.value.toUpperCase() })} placeholder="KEY" className="col-span-3 px-1.5 py-1 text-[11px] bg-background border border-border rounded font-mono" />
            <input type={v.secret ? 'password' : 'text'} value={v.value} onChange={e => upd(i, { value: e.target.value })} placeholder={v.secret && v.hasValue ? '•••• (설정됨, 변경 시 입력)' : 'VALUE'} autoComplete="off" className="col-span-4 px-1.5 py-1 text-[11px] bg-background border border-border rounded font-mono" />
            <label className="col-span-2 flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer"><input type="checkbox" checked={v.secret} onChange={e => upd(i, { secret: e.target.checked })} /> 비밀(키)</label>
            <input value={v.note} onChange={e => upd(i, { note: e.target.value })} placeholder="메모" className="col-span-2 px-1.5 py-1 text-[11px] bg-background border border-border rounded" />
            <button onClick={() => del(v.key)} disabled={busy || !v.key} className="col-span-1 text-rose-400 hover:bg-rose-500/10 rounded p-1 disabled:opacity-40" title="삭제"><Trash2 className="w-3 h-3" /></button>
          </div>
        ))}
      </div>
      <button onClick={() => setVars(v => [...v, { key: '', value: '', secret: false, note: '', hasValue: false }])} className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"><Plus className="w-3 h-3" /> 변수 추가</button>

      <label className="block text-[10px] text-muted-foreground mt-1">프로젝트 메모 / 주석
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="이 프로젝트에 대한 메모·주석 (예: API 키 발급처, 주의사항)" className="mt-0.5 w-full px-1.5 py-1 text-[11px] bg-background border border-border rounded resize-y" />
      </label>

      <div className="flex items-center gap-1.5">
        <button onClick={save} disabled={busy} className="inline-flex items-center gap-1 px-2 py-1 text-[10px] bg-foreground text-background rounded disabled:opacity-40"><Save className="w-3 h-3" /> 저장</button>
        <button onClick={apply} disabled={busy} className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-amber-500/40 text-amber-600 rounded disabled:opacity-40" title="저장된 환경변수를 프로젝트 .env로 써서 실제 사용 가능하게 함"><FileDown className="w-3 h-3" /> 프로젝트에 .env 적용</button>
        {msg && <span className="text-[10px] text-cyan-400">{msg}</span>}
      </div>
    </div>
  );
}
