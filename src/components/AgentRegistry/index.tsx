'use client';

/**
 * Phase 6-E — Agent Definition Registry panel.
 *
 * Rendered at the top of `/agents`. It reconciles three sources that the
 * legacy agent grid never showed together:
 *
 *   - Configured agents (agents.json)
 *   - Agent definition files (.claude/agents/*.md)  ← these were INVISIBLE before
 *   - Live AgentSessions (dorothy.db)
 *
 * It is strictly diagnostic: nothing here registers or mutates agents.json.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Bot, FileText, Radio, Settings2, AlertTriangle, RefreshCw,
  ChevronDown, ChevronRight, MessagesSquare, FilePlus2, X, CheckCircle2, Loader2,
} from 'lucide-react';
import {
  useDorothyAgentDefinitions,
  useDorothyAgentIdleStatuses,
  useDorothyRecentAgentCommunication,
  useDorothyClaudeLaunchReadiness,
} from '@/hooks/useDorothyRuns';
import { dorothyRunsClient } from '@/lib/dorothyRunsClient';
import type {
  AgentDefinition,
  AgentIdleStatus,
  AgentRegistrationPreview,
  RegisterAgentDefinitionResult,
} from '@/types/dorothy';
import {
  AGENT_DEFINITION_SOURCE_LABEL,
  IDLE_REASON_BADGE,
  COMMUNICATION_TYPE_BADGE,
  COMMUNICATION_TYPE_LABEL,
  WORKFLOW_KIND_LABEL,
} from '@/types/dorothy';
import { lookupProcessDisplay, processDisplayName, processShortName } from '@/lib/agentProcessDisplay';
import { IDLE_REASON_KO } from '@/lib/koreanLabels';
import type { AgentWarmupResult, CodexNormalizationResult } from '@/types/dorothy';

function normKey(id: string | null | undefined): string {
  if (!id) return '';
  return id.toLowerCase().replace(/[\s\-./]+/g, '_').replace(/^_+|_+$/g, '');
}

function relTime(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function IdleBadge({ status }: { status?: AgentIdleStatus }) {
  if (!status) return null;
  return (
    <span
      className={`px-1.5 py-px text-[10px] border rounded ${IDLE_REASON_BADGE[status.reason]}`}
      title={status.summary}
    >
      {IDLE_REASON_KO[status.reason]}
    </span>
  );
}

function DefinitionCard({
  def,
  idle,
  onPreview,
}: {
  def: AgentDefinition;
  idle?: AgentIdleStatus;
  onPreview?: (def: AgentDefinition) => void;
}) {
  // A file-based definition not yet linked to a configured agent is the only
  // registerable shape. configured / live_session are not registerable.
  const isFile = def.source === 'claude_project_file' || def.source === 'claude_user_file';
  const eligible = isFile && def.existsOnDisk && !def.configuredAgentId;
  return (
    <div className="border border-border bg-card p-3 rounded-md flex flex-col gap-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <Bot className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="font-medium text-sm truncate" title={def.id}>{processDisplayName(def.id, def.displayName)}</span>
        {def.hasLiveSession && (
          <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" title={`${def.activeSessionCount} active session(s)`} />
        )}
        <span className="ml-auto" />
        <IdleBadge status={idle} />
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[10px]">
        <span className="px-1.5 py-px border border-border rounded text-muted-foreground">
          {AGENT_DEFINITION_SOURCE_LABEL[def.source]}
        </span>
        {def.workflowKind && (
          <span className="px-1.5 py-px border border-border rounded text-muted-foreground">
            {WORKFLOW_KIND_LABEL[def.workflowKind]}
          </span>
        )}
        {def.existsOnDisk && (
          <span className="px-1.5 py-px border border-emerald-500/30 text-emerald-500 rounded">on disk</span>
        )}
        {!def.canSpawn && (
          <span className="px-1.5 py-px border border-yellow-500/30 text-yellow-500 rounded" title={def.spawnReason}>
            cannot spawn
          </span>
        )}
        {def.activeSessionCount > 0 && (
          <span className="px-1.5 py-px border border-border rounded text-muted-foreground">
            {def.activeSessionCount} live
          </span>
        )}
      </div>
      {/* Phase 6-I — registered / live-loaded / spawnable status row */}
      <div className="flex flex-wrap items-center gap-1 text-[10px]">
        <span className={`px-1.5 py-px border rounded ${def.isRegistered ? 'border-emerald-500/30 text-emerald-500' : 'border-border text-muted-foreground'}`}>
          {def.isRegistered ? 'registered' : 'not registered'}
        </span>
        {def.isRegistered && !def.isLiveLoaded && (
          <span className="px-1.5 py-px border border-amber-500/30 text-amber-500 rounded" title="Registered in agents.json but not yet in the live agent manager. Click 라이브 에이전트 재로드.">
            reload required
          </span>
        )}
        {def.isSpawnable ? (
          <span className="px-1.5 py-px border border-emerald-500/30 text-emerald-500 rounded">spawnable</span>
        ) : def.spawnBlockReason ? (
          <span className="px-1.5 py-px border border-yellow-500/30 text-yellow-500 rounded" title={`Spawn blocked: ${def.spawnBlockReason}`}>
            {def.spawnBlockReason === 'disabled' ? 'disabled'
              : def.spawnBlockReason === 'not_live_loaded' ? 'not live-loaded'
              : def.spawnBlockReason === 'not_registered' ? 'not spawnable'
              : def.spawnBlockReason === 'missing_definition' ? 'missing definition'
              : 'not spawnable'}
          </span>
        ) : null}
      </div>
      {/* Phase 6-L — provider / model compatibility */}
      {(def.provider || def.model) && (
        <div className="flex flex-wrap items-center gap-1 text-[10px]">
          {def.provider && (
            <span className="px-1.5 py-px border border-border rounded text-muted-foreground">{def.provider}</span>
          )}
          {def.model && (
            <span className="px-1.5 py-px border border-border rounded text-muted-foreground">{def.model}</span>
          )}
          {def.modelCompatibility && (
            def.modelCompatibility.ok ? (
              <span className="px-1.5 py-px border border-emerald-500/30 text-emerald-500 rounded">compatible</span>
            ) : (
              <span className="px-1.5 py-px border border-rose-500/30 text-rose-500 rounded" title={def.modelCompatibility.message}>
                model blocked
              </span>
            )
          )}
        </div>
      )}
      {def.modelCompatibility && !def.modelCompatibility.ok && (
        <p className="text-[10px] text-rose-500">{def.modelCompatibility.message}</p>
      )}
      {/* Phase 6-N — process-based info (agentId secondary, KO phase/io/next) */}
      <div className="text-[10px] text-muted-foreground/80 space-y-0.5">
        <div>agentId: <code className="font-mono">{def.id}</code></div>
        {(() => {
          const p = lookupProcessDisplay(def.id);
          if (!p) return null;
          return (
            <>
              <div>단계: {p.phaseKo}</div>
              {p.inputKo.length > 0 && <div>입력: {p.inputKo.join(', ')}</div>}
              {p.outputKo.length > 0 && <div>출력: {p.outputKo.join(', ')}</div>}
              {p.nextAgents.length > 0 && (
                <div>다음: {p.nextAgents.map(a => processDisplayName(a)).join(', ')}</div>
              )}
            </>
          );
        })()}
      </div>
      {def.roleSummary && (
        <p className="text-xs text-muted-foreground line-clamp-2">{def.roleSummary}</p>
      )}
      {def.filePath && (
        <p className="text-[10px] text-muted-foreground/70 truncate font-mono" title={def.filePath}>
          {def.filePath}
        </p>
      )}
      {def.lastSessionAt && (
        <p className="text-[10px] text-muted-foreground/70">last session {relTime(def.lastSessionAt)}</p>
      )}
      {isFile && onPreview && (
        <div className="mt-1 flex items-center gap-2">
          {eligible ? (
            <button
              onClick={() => onPreview(def)}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-primary/40 text-primary rounded hover:bg-primary/10 cursor-pointer"
              title="Preview registration into agents.json"
            >
              <FilePlus2 className="w-3 h-3" /> Preview Registration
            </button>
          ) : def.configuredAgentId ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-emerald-500/30 text-emerald-500 rounded">
              <CheckCircle2 className="w-3 h-3" /> Registered (configured)
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground">Not registerable (file missing).</span>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  count,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mb-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mb-2 hover:text-foreground transition-colors cursor-pointer"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Icon className="w-3.5 h-3.5" />
        {title}
        <span className="px-1 py-px text-[10px] bg-muted rounded">{count}</span>
      </button>
      {open && children}
    </section>
  );
}

/**
 * Registration preview + confirm panel (Phase 6-G). Loads a preview for one
 * definition, requires an explicit "I understand…" checkbox, then registers.
 * There is intentionally no bulk / "register all" affordance.
 */
function RegistrationPanel({
  def,
  onClose,
  onRegistered,
}: {
  def: AgentDefinition;
  onClose: () => void;
  onRegistered: () => void;
}) {
  const [preview, setPreview] = useState<AgentRegistrationPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RegisterAgentDefinitionResult | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreview(null); setLoadError(null);
    dorothyRunsClient.agentRegistration
      .preview({ agentDefinitionId: def.id })
      .then(res => {
        if (cancelled) return;
        if (res.ok && res.data?.preview) setPreview(res.data.preview);
        else setLoadError(res.error ?? 'Failed to load preview.');
      })
      .catch(e => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'preview failed'); });
    return () => { cancelled = true; };
  }, [def.id]);

  const doRegister = async () => {
    if (!preview?.canRegister || !confirmed || busy) return;
    setBusy(true); setResultError(null);
    try {
      const res = await dorothyRunsClient.agentRegistration.register({
        agentDefinitionId: def.id,
        confirm: true,
      });
      if (res.ok && res.data) {
        setResult(res.data);
        onRegistered();
      } else {
        setResultError(res.error ?? 'Registration failed.');
      }
    } catch (e) {
      setResultError(e instanceof Error ? e.message : 'register failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg max-w-lg w-full max-h-[85vh] overflow-y-auto p-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <FilePlus2 className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">Register “{def.displayName}” as Configured Agent</h3>
          <button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {!preview && !loadError && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-6">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading preview…
          </div>
        )}
        {loadError && <p className="text-xs text-rose-500 py-4">{loadError}</p>}

        {preview && !result && (
          <>
            <p className="text-[11px] text-muted-foreground mb-2">
              This appends one record to <code className="font-mono">~/.dorothy/agents.json</code> after a
              timestamped backup. Existing agents are never modified.
            </p>

            <div className="text-[11px] font-medium text-muted-foreground mb-1">Proposed agent record</div>
            <pre className="text-[10px] bg-background border border-border rounded p-2 overflow-x-auto mb-3">
{JSON.stringify(preview.proposedAgentRecord, null, 2)}
            </pre>

            {preview.warnings.length > 0 && (
              <ul className="mb-3 space-y-1">
                {preview.warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[11px] text-amber-500">
                    <AlertTriangle className="w-3 h-3 mt-px shrink-0" /> {w}
                  </li>
                ))}
              </ul>
            )}

            {!preview.canRegister ? (
              <p className="text-xs text-rose-500 mb-2">
                Cannot register: {preview.reason ?? 'not eligible.'}
              </p>
            ) : (
              <label className="flex items-start gap-2 text-xs text-foreground mb-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={e => setConfirmed(e.target.checked)}
                  className="mt-0.5"
                />
                I understand this will append to ~/.dorothy/agents.json
              </label>
            )}

            {resultError && <p className="text-xs text-rose-500 mb-2">{resultError}</p>}

            <div className="flex items-center gap-2">
              <button
                onClick={doRegister}
                disabled={!preview.canRegister || !confirmed || busy}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <FilePlus2 className="w-3 h-3" />}
                Register as Configured Agent
              </button>
              <button onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground cursor-pointer">
                Cancel
              </button>
            </div>
          </>
        )}

        {result && (
          <div className="py-2">
            <p className="flex items-center gap-2 text-sm text-emerald-500 mb-2">
              <CheckCircle2 className="w-4 h-4" /> Registered “{def.id}”.
            </p>
            {result.backupPath && (
              <p className="text-[11px] text-muted-foreground break-all mb-1">
                Backup: <code className="font-mono">{result.backupPath}</code>
              </p>
            )}
            {result.reloadResult?.ok && (
              <p className="text-[11px] text-emerald-500">
                Live agent manager reload: success
                {result.reloadResult.addedAgentIds.length > 0 &&
                  ` · added to live map: ${result.reloadResult.addedAgentIds.join(', ')}`}
              </p>
            )}
            {result.postRegistrationDefinition && (
              <p className={`text-[11px] ${result.postRegistrationDefinition.isSpawnable ? 'text-emerald-500' : 'text-amber-500'}`}>
                Spawnable: {result.postRegistrationDefinition.isSpawnable ? 'yes'
                  : `no (${result.postRegistrationDefinition.spawnBlockReason ?? 'unknown'})`}
              </p>
            )}
            {result.warnings?.map((w, i) => (
              <p key={i} className="text-[11px] text-amber-500 flex items-start gap-1.5 mt-1">
                <AlertTriangle className="w-3 h-3 mt-px shrink-0" />
                {w} Restart Dorothy dashboard or click “Reload Live Agents”.
              </p>
            ))}
            <button onClick={onClose} className="mt-3 px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground cursor-pointer">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AgentRegistryPanel() {
  const { snapshot, definitions, warnings, isLoading, dbUnavailable, refresh } = useDorothyAgentDefinitions();
  const { byAgent } = useDorothyAgentIdleStatuses();
  const { events: recentComms } = useDorothyRecentAgentCommunication({ limit: 15 });
  const { runtime } = useDorothyClaudeLaunchReadiness();
  const [collapsed, setCollapsed] = useState(false);
  const [previewDef, setPreviewDef] = useState<AgentDefinition | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadMsg, setReloadMsg] = useState<string | null>(null);
  // Phase 6-Q — batch warm-up + Codex normalization.
  const [warmupBusy, setWarmupBusy] = useState(false);
  const [warmupMsg, setWarmupMsg] = useState<string | null>(null);
  const [normBusy, setNormBusy] = useState(false);
  const [normMsg, setNormMsg] = useState<string | null>(null);

  const onWarmupAll = async () => {
    if (warmupBusy) return;
    if (typeof window !== 'undefined' && !window.confirm(
      '파일을 수정하지 않는 safe warm-up 세션만 실행합니다.\n이미 실행 중인 에이전트와 차단된 에이전트는 제외됩니다.',
    )) return;
    setWarmupBusy(true); setWarmupMsg(null);
    try {
      const res = await dorothyRunsClient.warmup.all({ confirm: true });
      if (res.ok && res.data?.result) {
        const r: AgentWarmupResult = res.data.result;
        setWarmupMsg(`Warm-up 실행: 시작 ${r.startedAgentIds.length} (${r.startedAgentIds.join(', ') || '-'}) · 건너뜀 ${r.skipped.length} · 실패 ${r.failed.length}`);
      } else {
        setWarmupMsg(`Warm-up 실패: ${res.error ?? 'unknown'}`);
      }
      await refresh();
    } catch (e) {
      setWarmupMsg(`Warm-up 실패: ${e instanceof Error ? e.message : 'error'}`);
    } finally {
      setWarmupBusy(false);
    }
  };

  const onNormalizeCodex = async () => {
    if (normBusy) return;
    const prev = await dorothyRunsClient.codexNormalize.preview();
    const n = prev.ok && prev.data?.preview ? prev.data.preview.targets.length : 0;
    if (n === 0) { setNormMsg('정합화 대상(codex+opus) 없음'); return; }
    if (typeof window !== 'undefined' && !window.confirm(
      `Codex + opus 설정 정합화\n대상 ${n}개: model='opus' 필드만 제거(provider 변경/삭제 없음).\n백업 생성 후 적용합니다.`,
    )) return;
    setNormBusy(true); setNormMsg(null);
    try {
      const res = await dorothyRunsClient.codexNormalize.apply({ confirm: true });
      if (res.ok && res.data?.result) {
        const r: CodexNormalizationResult = res.data.result;
        setNormMsg(`정합화 완료: ${r.changedAgentIds.length}개 model 제거${r.backupPath ? ` · 백업 생성` : ''}`);
      } else {
        setNormMsg(`정합화 실패: ${res.error ?? 'unknown'}`);
      }
      await refresh();
    } catch (e) {
      setNormMsg(`정합화 실패: ${e instanceof Error ? e.message : 'error'}`);
    } finally {
      setNormBusy(false);
    }
  };

  const onReloadLiveAgents = async () => {
    if (reloading) return;
    setReloading(true); setReloadMsg(null);
    try {
      const res = await dorothyRunsClient.agentDefinitions.reloadLiveAgents({ reason: 'manual' });
      if (res.ok && res.data?.result) {
        const r = res.data.result;
        if (r.ok) {
          setReloadMsg(
            `Reloaded live agents: ${r.beforeCount} → ${r.afterCount}` +
            (r.addedAgentIds.length ? ` · added: ${r.addedAgentIds.join(', ')}` : '') +
            (r.updatedAgentIds?.length ? ` · updated: ${r.updatedAgentIds.join(', ')}` : '') +
            (r.preservedActiveSessionIds?.length ? ` · preserved ${r.preservedActiveSessionIds.length} active` : '') +
            (r.removedAgentIds.length ? ` · missing-from-disk: ${r.removedAgentIds.length} (kept)` : '') +
            (r.alreadyInProgress ? ' · (coalesced)' : ''),
          );
        } else {
          setReloadMsg(`Reload failed: ${r.error ?? 'unknown'}`);
        }
      } else {
        setReloadMsg(`Reload failed: ${res.error ?? 'unavailable'}`);
      }
      await refresh();
    } catch (e) {
      setReloadMsg(`Reload failed: ${e instanceof Error ? e.message : 'error'}`);
    } finally {
      setReloading(false);
    }
  };

  const defByKey = useMemo(() => {
    const m = new Map<string, AgentDefinition>();
    for (const d of definitions) m.set(normKey(d.id), d);
    return m;
  }, [definitions]);

  const idleFor = (def: AgentDefinition): AgentIdleStatus | undefined => {
    const key = normKey(def.id);
    for (const [agentId, status] of byAgent) {
      if (normKey(agentId) === key) return status;
    }
    return undefined;
  };

  const grouped = useMemo(() => {
    const configured = definitions.filter(d => d.source === 'configured');
    const files = definitions.filter(
      d => d.source === 'claude_project_file' || d.source === 'claude_user_file',
    );
    const live = definitions.filter(d => d.source === 'live_session');
    return { configured, files, live };
  }, [definitions]);

  if (isLoading && definitions.length === 0) {
    return (
      <div className="border border-border bg-card/50 rounded-md p-3 mb-4 text-xs text-muted-foreground">
        Loading agent registry…
      </div>
    );
  }

  return (
    <div className="border border-border bg-card/40 rounded-md p-3 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Settings2 className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">에이전트 등록 현황</h2>
        <span className="text-[11px] text-muted-foreground">
          {snapshot.configuredCount} 등록 · {snapshot.fileCount} 정의파일 · {snapshot.liveSessionAgentCount} 라이브
        </span>
        <button
          onClick={onReloadLiveAgents}
          disabled={reloading}
          className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50 cursor-pointer"
          title="Re-read agents.json into the live agent manager (does not modify files or kill sessions)"
        >
          {reloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Reload Live Agents
        </button>
        <button
          onClick={() => refresh()}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
          title="Rescan .claude/agents and sessions"
        >
          <RefreshCw className="w-3 h-3" /> 다시 스캔
        </button>
        <button
          onClick={() => setCollapsed(c => !c)}
          className="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
        >
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </div>

      {reloadMsg && (
        <p className="text-[11px] text-muted-foreground mb-2">{reloadMsg}</p>
      )}

      {/* Phase 6-Q — batch warm-up + Codex normalization controls */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <button
          onClick={onWarmupAll}
          disabled={warmupBusy}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-primary/40 text-primary rounded hover:bg-primary/10 disabled:opacity-50 cursor-pointer"
          title="파일 수정 없는 safe warm-up 세션을 적격 에이전트에 일괄 실행"
        >
          {warmupBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} 전체 Warm-up 실행
        </button>
        <button
          onClick={onNormalizeCodex}
          disabled={normBusy}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-border text-muted-foreground rounded hover:text-foreground hover:bg-secondary disabled:opacity-50 cursor-pointer"
          title="codex 에이전트의 model='opus'(비호환) 필드 제거 → Codex 기본 모델 사용 (백업 후, confirm 필요)"
        >
          Codex + opus 설정 정합화
        </button>
        {warmupMsg && <span className="text-[11px] text-muted-foreground">{warmupMsg}</span>}
        {normMsg && <span className="text-[11px] text-muted-foreground">{normMsg}</span>}
      </div>

      {dbUnavailable && (
        <p className="text-[11px] text-yellow-500 mb-2">
          dorothy.db unavailable — live-session merge is empty; file + configured scan still shown.
        </p>
      )}

      {/* Phase 6-K — Claude launch readiness banner. */}
      {!runtime.binary.found ? (
        <p className="text-[11px] text-rose-500 mb-2">
          ⚠ Claude launch blocked: claude binary not found in dashboard PATH or well-known install dirs.
          Set <code className="font-mono">claudeBinaryPath</code> in app-settings.json or restart Dorothy.
        </p>
      ) : runtime.agents.some(a => !a.ready) ? (
        <p className="text-[11px] text-amber-500 mb-2">
          ⚠ {runtime.agents.filter(a => !a.ready).length} configured Claude agent(s) cannot launch
          (see Settings → Claude Runtime). claude: <span className="font-mono">{runtime.binary.source}</span>.
        </p>
      ) : runtime.binary.path ? (
        <p className="text-[11px] text-muted-foreground mb-2">
          Claude binary: <span className="text-emerald-500">found</span> ({runtime.binary.source}) · launch ready.
        </p>
      ) : null}

      {!collapsed && (
        <>
          {/* Mismatch warnings — only `definition_file_not_configured` is
              resolvable here (via Register). Others are warning-only. */}
          {warnings.length > 0 && (
            <Section title="등록 불일치 경고" icon={AlertTriangle} count={warnings.length} defaultOpen={false}>
              <ul className="space-y-1">
                {warnings.slice(0, 40).map((w, i) => {
                  const resolvable = w.kind === 'definition_file_not_configured';
                  const target = resolvable ? defByKey.get(normKey(w.agentId)) : undefined;
                  const eligible = target && target.existsOnDisk && !target.configuredAgentId;
                  return (
                    <li key={`${w.kind}-${w.agentId}-${i}`} className="flex items-start gap-2 text-xs">
                      <span className="px-1.5 py-px text-[10px] border border-amber-500/30 text-amber-500 rounded shrink-0 mt-px">
                        {w.kind}
                      </span>
                      <span className="text-muted-foreground flex-1">{w.summary}</span>
                      {eligible && (
                        <button
                          onClick={() => setPreviewDef(target!)}
                          className="shrink-0 inline-flex items-center gap-1 px-1.5 py-px text-[10px] border border-primary/40 text-primary rounded hover:bg-primary/10 cursor-pointer"
                        >
                          <FilePlus2 className="w-3 h-3" /> Register
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          {grouped.files.length > 0 && (
            <Section title="에이전트 정의 파일" icon={FileText} count={grouped.files.length}>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                {grouped.files.map(d => (
                  <DefinitionCard key={`file-${d.id}`} def={d} idle={idleFor(d)} onPreview={setPreviewDef} />
                ))}
              </div>
            </Section>
          )}

          {grouped.configured.length > 0 && (
            <Section title="등록된 에이전트" icon={Settings2} count={grouped.configured.length} defaultOpen={false}>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                {grouped.configured.map(d => (
                  <DefinitionCard key={`cfg-${d.id}`} def={d} idle={idleFor(d)} />
                ))}
              </div>
            </Section>
          )}

          {grouped.live.length > 0 && (
            <Section title="라이브 세션 (정의 파일 없음)" icon={Radio} count={grouped.live.length}>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                {grouped.live.map(d => (
                  <DefinitionCard key={`live-${d.id}`} def={d} idle={idleFor(d)} />
                ))}
              </div>
            </Section>
          )}

          {recentComms.length > 0 && (
            <Section title="최근 통신" icon={MessagesSquare} count={recentComms.length} defaultOpen={false}>
              <ul className="space-y-1">
                {recentComms.map(e => (
                  <li key={e.id} className="flex items-center gap-2 text-xs">
                    <span className={`px-1.5 py-px text-[10px] border rounded shrink-0 ${COMMUNICATION_TYPE_BADGE[e.type]}`}>
                      {COMMUNICATION_TYPE_LABEL[e.type]}
                    </span>
                    {e.fromAgentId && (
                      <span className="text-muted-foreground shrink-0">{processShortName(e.fromAgentId, e.fromAgentId)}</span>
                    )}
                    {e.toAgentId && (
                      <span className="text-muted-foreground shrink-0">→ {processShortName(e.toAgentId, e.toAgentId)}</span>
                    )}
                    <span className="truncate" title={e.summary ?? e.title}>{e.title}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground/70 shrink-0">{relTime(e.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {definitions.length === 0 && (
            <p className="text-xs text-muted-foreground py-2">No agent definitions found.</p>
          )}
        </>
      )}

      {previewDef && (
        <RegistrationPanel
          def={previewDef}
          onClose={() => setPreviewDef(null)}
          onRegistered={() => { void refresh(); }}
        />
      )}
    </div>
  );
}
