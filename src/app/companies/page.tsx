'use client';

import { useEffect, useState, useCallback } from 'react';
import { Building2, Check, Plus, RefreshCw, FolderKanban, Pencil, X, Save } from 'lucide-react';
import { dorothyClient } from '@/lib/dorothyClient';

interface Company {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  defaultEngineProfileId?: string;
}
interface Project {
  id: string;
  companyId: string;
  name?: string;
  rootPath?: string;
}
interface CompaniesResponse {
  selectedCompanyId: string | null;
  companies: Company[];
  projects: Project[];
  error?: string;
}

export default function CompaniesPage() {
  const [data, setData] = useState<CompaniesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  // inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');

  const startEdit = (c: Company) => {
    setEditingId(c.id);
    setEditName(c.name);
    setEditDesc(c.description ?? '');
    setErr(null);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditDesc('');
  };
  const saveEdit = async (companyId: string) => {
    if (!editName.trim()) {
      setErr('이름은 비울 수 없습니다.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const json = await dorothyClient.companies.update(companyId, {
        name: editName.trim(),
        description: editDesc.trim(),
      });
      if (json.error) setErr(json.error || '수정 실패');
      else cancelEdit();
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const json = (await dorothyClient.companies.get()) as CompaniesResponse;
      if (json.error) setErr(json.error);
      setData(json);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const select = async (companyId: string) => {
    setBusy(true);
    setErr(null);
    try {
      const json = await dorothyClient.companies.select(companyId);
      if (json.error) setErr(json.error || '선택 실패');
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const addCompany = async () => {
    if (!newId.trim() || !newName.trim()) {
      setErr('id 와 이름은 필수입니다.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const json = await dorothyClient.companies.add({
        id: newId.trim(),
        name: newName.trim(),
        description: newDesc.trim(),
      });
      if (json.error) {
        setErr(json.error || '추가 실패');
      } else {
        setNewId('');
        setNewName('');
        setNewDesc('');
      }
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const projectsFor = (companyId: string) =>
    (data?.projects ?? []).filter((p) => p.companyId === companyId);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Building2 className="w-7 h-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">회사</h1>
            <p className="text-sm text-muted-foreground">회사를 선택하거나 추가합니다.</p>
          </div>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading || busy}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:bg-muted text-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          새로고침
        </button>
      </div>

      {err && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {err}
        </div>
      )}

      {/* Company list */}
      <div className="space-y-3 mb-8">
        {loading && <div className="text-muted-foreground text-sm">불러오는 중…</div>}
        {!loading && (data?.companies?.length ?? 0) === 0 && (
          <div className="text-muted-foreground text-sm">등록된 회사가 없습니다. 아래에서 추가하세요.</div>
        )}
        {data?.companies?.map((c) => {
          const selected = data.selectedCompanyId === c.id;
          const projs = projectsFor(c.id);
          return (
            <div
              key={c.id}
              className={`rounded-xl border p-4 transition-colors ${
                selected ? 'border-primary bg-primary/5' : 'border-border bg-card'
              }`}
            >
              {editingId === c.id ? (
                /* --- 수정 모드 --- */
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    회사 id <span className="font-mono">{c.id}</span>
                    <span className="opacity-70">(id 는 변경 불가)</span>
                  </div>
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="회사 이름"
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                  />
                  <input
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    placeholder="설명 (선택)"
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void saveEdit(c.id)}
                      disabled={busy || !editName.trim()}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90 disabled:opacity-50"
                    >
                      <Save className="w-4 h-4" /> 저장
                    </button>
                    <button
                      onClick={cancelEdit}
                      disabled={busy}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
                    >
                      <X className="w-4 h-4" /> 취소
                    </button>
                  </div>
                </div>
              ) : (
                /* --- 보기 모드 --- */
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{c.name}</span>
                      <span className="text-xs text-muted-foreground font-mono">{c.id}</span>
                      {selected && (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-primary/15 text-primary">
                          <Check className="w-3 h-3" /> 선택됨
                        </span>
                      )}
                    </div>
                    {c.description && (
                      <p className="text-sm text-muted-foreground mt-1">{c.description}</p>
                    )}
                    {projs.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        {projs.map((p) => (
                          <span
                            key={p.id}
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md border border-border text-muted-foreground"
                          >
                            <FolderKanban className="w-3 h-3" />
                            {p.name || p.id}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => startEdit(c)}
                      disabled={busy}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-60"
                    >
                      <Pencil className="w-4 h-4" /> 수정
                    </button>
                    <button
                      onClick={() => void select(c.id)}
                      disabled={busy || selected}
                      className={`px-3 py-1.5 rounded-lg text-sm ${
                        selected
                          ? 'bg-muted text-muted-foreground cursor-default'
                          : 'bg-primary text-primary-foreground hover:opacity-90'
                      } disabled:opacity-60`}
                    >
                      {selected ? '현재 회사' : '이 회사 선택'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add company */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="flex items-center gap-2 font-semibold mb-3">
          <Plus className="w-4 h-4" /> 회사 추가
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="회사 id (예: acme-corp)"
            className="px-3 py-2 rounded-lg border border-border bg-background text-sm font-mono"
          />
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="회사 이름 (예: Acme Corp)"
            className="px-3 py-2 rounded-lg border border-border bg-background text-sm"
          />
          <input
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="설명 (선택)"
            className="px-3 py-2 rounded-lg border border-border bg-background text-sm sm:col-span-2"
          />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={() => void addCompany()}
            disabled={busy || !newId.trim() || !newName.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" /> 추가
          </button>
          <span className="text-xs text-muted-foreground">
            추가 후 프로젝트는 <code className="font-mono">create-project.py</code> 로 생성합니다.
          </span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground mt-4">
        저장 위치: <code className="font-mono">~/.dorothy/companies.json</code> · agents.json 은 변경하지 않습니다.
      </p>
    </div>
  );
}
