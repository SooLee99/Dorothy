import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

/**
 * Phase 6-AP — Codex 한도 중 orchestrator만 임시 Claude fallback (confirm-gate).
 *
 * 안전 규칙:
 *  - confirm===true 일 때만 적용/롤백 (GET status는 항상 안전)
 *  - 적용 전 agents.json 백업 필수
 *  - orchestrator 단일 대상만 변경, 다른 9개 에이전트 미접촉
 *  - count===11, legacy UUID 0, codex+opus 미발생 검증
 *  - model 공란 유지(provider default)
 *  - metadata.temporaryProviderFallback 기록 → rollback 가능
 *  - PM-tick/Kanban/Stop Hook/Vault 미접촉(이 라우트는 agents.json만 다룸)
 *  ※ 라이브 반영은 대시보드 reload 시(전원 in-memory 재로딩). 응답에 reloadHint 포함.
 */

const AGENTS = path.join(os.homedir(), '.dorothy', 'agents.json');
const LIMIT_FILE = path.join(os.homedir(), '.dorothy', 'runtime', 'claude-limit.json');
// 디스크는 바뀌었지만 Electron in-memory 맵에는 아직 반영되지 않았음을 나타내는 마커.
// 패널이 진입 시 이 마커를 보고 자동으로 reloadLiveAgents(브라우저 IPC)를 호출한다.
const PENDING_FILE = path.join(os.homedir(), '.dorothy', 'runtime', 'orchestrator-fallback.pending');
const CLAUDE_MODEL_RE = /opus|sonnet|haiku|claude/i;

function writePending(info: Record<string, unknown>) {
  try {
    fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
    fs.writeFileSync(PENDING_FILE, JSON.stringify(info, null, 2));
  } catch { /* ignore */ }
}
function clearPending() {
  try { if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE); } catch { /* ignore */ }
}
function hasPending(): boolean {
  try { return fs.existsSync(PENDING_FILE); } catch { return false; }
}

function readAgents(): { list: Record<string, unknown>[]; wrap: unknown } {
  const raw = JSON.parse(fs.readFileSync(AGENTS, 'utf-8'));
  return { list: Array.isArray(raw) ? raw : (raw.agents ?? []), wrap: raw };
}
function writeAgents(wrap: unknown) {
  fs.writeFileSync(AGENTS, JSON.stringify(wrap, null, 2));
}
function readLimit(): { resetAt?: string } | null {
  try { return JSON.parse(fs.readFileSync(LIMIT_FILE, 'utf-8')); } catch { return null; }
}

// Phase 6-AQ — 자동 fallback/restore 설정(app-settings.json). 기본: fallback off / restore on.
const SETTINGS = path.join(os.homedir(), '.dorothy', 'app-settings.json');
const K_AUTO_FALLBACK = 'dorothyOrchestratorAutoFallbackOnCodexLimit';
const K_AUTO_RESTORE = 'dorothyOrchestratorAutoRestoreAfterCodexCooldown';
function readSettings(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf-8')); } catch { return {}; }
}
function writeSettings(s: Record<string, unknown>) {
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
}
// Phase 6-BC — App Factory 프로젝트 에이전트(/apps/* 경로)는 triplan baseline 11 에서 제외.
const APPS_PREFIX = '/Users/soo/workspace/source-code/apps';
const isBaseline = (a: Record<string, unknown>) => !String(a.projectPath || a.worktreePath || '').startsWith(APPS_PREFIX);
function audit(list: Record<string, unknown>[]) {
  const base = list.filter(isBaseline);
  return {
    count: base.length,
    codex: base.filter(a => a.provider === 'codex').length,
    claude: base.filter(a => a.provider === 'claude').length,
    uuid: base.filter(a => /^[0-9a-f]{8}-/i.test(String(a.id))).length,
    codexOpus: base.filter(a => a.provider === 'codex' && CLAUDE_MODEL_RE.test(String(a.model || ''))).length,
    projectAgents: list.length - base.length, // App Factory 프로젝트 에이전트 수(참고)
  };
}

export async function GET() {
  const { list } = readAgents();
  const orch = list.find(a => a.id === 'orchestrator') as Record<string, unknown> | undefined;
  const limit = readLimit();
  const cooldownUntil = limit?.resetAt;
  const cooldownActive = !!(cooldownUntil && new Date(cooldownUntil).getTime() > Date.now());
  const fb = (orch?.metadata as Record<string, unknown> | undefined)?.temporaryProviderFallback as Record<string, unknown> | undefined;
  const s = readSettings();
  const autoFallbackEnabled = s[K_AUTO_FALLBACK] !== false; // 기본 false (없으면 false 취급)
  const autoFallback = s[K_AUTO_FALLBACK] === true;
  const autoRestore = s[K_AUTO_RESTORE] !== false; // 기본 true
  // restore 예정 시각: fallback metadata.cooldownUntil(우선) 또는 현재 한도 resetAt
  const restoreAt = (fb?.cooldownUntil as string | undefined) ?? cooldownUntil ?? null;
  const restoreEligible = !!(orch?.provider === 'claude' && fb && restoreAt && new Date(restoreAt).getTime() <= Date.now());
  const restoreRemainingMs = restoreAt ? Math.max(0, new Date(restoreAt).getTime() - Date.now()) : null;
  void autoFallbackEnabled;
  return NextResponse.json({
    cooldownActive, cooldownUntil: cooldownUntil ?? null,
    orchestratorProvider: orch?.provider ?? null,
    fallbackActive: !!fb,
    fallback: fb ?? null,
    liveReloadPending: hasPending(),
    autoFallback,                 // 설정값: codex 한도 시 자동 fallback (기본 off)
    autoRestore,                  // 설정값: cooldown 도달 시 자동 codex 복귀 (기본 on)
    restoreAt,                    // 자동 복귀 예정 시각(ISO)
    restoreEligible,              // 지금 복귀 가능 여부(시간 도달)
    restoreRemainingMs,           // 복귀까지 남은 ms (음수 없음)
    audit: audit(list),
  });
}

export async function POST(req: Request) {
  let body: { action?: string; confirm?: boolean } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const { action } = body;
  // 마커 정리는 비파괴적(agents.json 미변경) → confirm 불필요. 패널이 라이브 반영 성공 후 호출.
  if (action === 'markLiveReloaded') {
    clearPending();
    return NextResponse.json({ ok: true, cleared: true });
  }
  // 자동 fallback/restore 설정 토글 — 설정값만 변경(agents.json 미변경) → confirm 불필요.
  if (action === 'setAuto') {
    const b = body as { key?: string; value?: boolean };
    if ((b.key !== 'fallback' && b.key !== 'restore') || typeof b.value !== 'boolean') {
      return NextResponse.json({ ok: false, error: 'key: fallback|restore, value: boolean 필요' }, { status: 400 });
    }
    const s = readSettings();
    s[b.key === 'fallback' ? K_AUTO_FALLBACK : K_AUTO_RESTORE] = b.value;
    writeSettings(s);
    return NextResponse.json({ ok: true, autoFallback: s[K_AUTO_FALLBACK] === true, autoRestore: s[K_AUTO_RESTORE] !== false });
  }
  if (body.confirm !== true) {
    return NextResponse.json({ ok: false, error: 'confirm:true 필요 (사용자 확인 없이는 적용 불가)' }, { status: 400 });
  }
  const { list, wrap } = readAgents();
  const baseCount = list.filter(isBaseline).length; // 프로젝트 에이전트 제외한 triplan baseline
  if (baseCount !== 11) return NextResponse.json({ ok: false, error: `baseline count!=11 (${baseCount}) — 적용 중단` }, { status: 409 });
  const orch = list.find(a => a.id === 'orchestrator') as Record<string, unknown> | undefined;
  if (!orch) return NextResponse.json({ ok: false, error: 'orchestrator 없음' }, { status: 404 });

  // backup
  const bk = `${AGENTS}.fallback.bak.${Date.now()}`;
  fs.copyFileSync(AGENTS, bk);
  const now = new Date().toISOString();

  if (action === 'apply') {
    if (orch.provider !== 'codex') {
      return NextResponse.json({ ok: false, error: `orchestrator provider가 codex가 아님(${orch.provider}) — 이미 fallback이거나 비정상`, backup: bk }, { status: 409 });
    }
    const limit = readLimit();
    orch.metadata = (orch.metadata as Record<string, unknown>) ?? {};
    (orch.metadata as Record<string, unknown>).temporaryProviderFallback = {
      from: 'codex', to: 'claude', reason: 'codex_usage_limit', appliedAt: now,
      cooldownUntil: limit?.resetAt ?? null,
      autoRestore: readSettings()[K_AUTO_RESTORE] !== false, // 기본 true → cooldown 후 PM-tick 자동 복귀
      status: 'active',
    };
    orch.provider = 'claude';
    orch.model = ''; // claude default
    writeAgents(wrap);
    // codex 한도로 멈춘 cooldown 해제(orchestrator가 claude이므로 codex 한도 무관)
    try { if (fs.existsSync(LIMIT_FILE)) fs.unlinkSync(LIMIT_FILE); } catch { /* ignore */ }
    writePending({ action: 'apply', at: now }); // 패널이 자동으로 in-memory 반영
    return NextResponse.json({ ok: true, applied: true, backup: bk, audit: audit(list), reloadHint: '대시보드를 reload하면 다음 사이클부터 orchestrator가 Claude로 동작합니다.' });
  }

  if (action === 'rollback') {
    const fb = (orch.metadata as Record<string, unknown> | undefined)?.temporaryProviderFallback;
    if (orch.provider !== 'claude' || !fb) {
      return NextResponse.json({ ok: false, error: 'fallback 상태가 아님 — 롤백 불필요', backup: bk }, { status: 409 });
    }
    orch.provider = 'codex';
    orch.model = '';
    // 기록 보존(history) — PM-tick 자동 restore 와 동일 배열에 archive
    const md = orch.metadata as Record<string, unknown>;
    const hist = (md.temporaryProviderFallbackHistory as Record<string, unknown>[] | undefined) ?? [];
    hist.push({ ...(fb as Record<string, unknown>), restoredAt: now, status: 'restored', restoredBy: 'manual' });
    md.temporaryProviderFallbackHistory = hist;
    delete md.temporaryProviderFallback;
    writeAgents(wrap);
    writePending({ action: 'rollback', at: now }); // 패널이 자동으로 in-memory 반영
    return NextResponse.json({ ok: true, rolledBack: true, backup: bk, audit: audit(list), reloadHint: '대시보드를 reload하면 orchestrator가 다시 Codex로 동작합니다.' });
  }

  return NextResponse.json({ ok: false, error: 'unknown action', backup: bk }, { status: 400 });
}
