import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 🅰 역할 팀 24h 루프(triplan-team-loop) 상태 집계 — 읽기 전용.
// - runtime/triplan-team-loop-state.json : 오케스트레이터(status/pass/currentRole)
// - runtime/auto-loop-state.json         : 에이전트별 상태(status/cooldownUntil/nextRun/lastError)
// - runtime/triplan-team-loop.pid        : 데몬 PID(생존 확인)
// - runtime/triplan-team-loop.paused     : 정지 플래그
// - companies.json agentMappings         : agentId→역할/이름/엔진 표시용
// 사용량 한도(usage limit)에 걸리면 wrapper 가 cooldownUntil 에 재가동 예정 시각을 기록한다.

interface AgentState {
  agentId?: string;
  status?: string;
  cycle?: number | string;
  lastRun?: string | null;
  nextRun?: string | null;
  cooldownUntil?: string | null;
  consecutiveErrors?: number | string;
  lastError?: string | null;
  updatedAt?: string;
}

// 파이프라인 순서 + 라우팅 규칙(frontend/cost → codex, 그 외 → claude). wrapper route_engine 미러.
const PIPELINE: { role: string; label: string }[] = [
  { role: 'approval-manager', label: '승인 관리자' },
  { role: 'pm', label: 'PM' },
  { role: 'backend', label: '백엔드' },
  { role: 'frontend', label: '프론트엔드' },
  { role: 'qa', label: 'QA' },
  { role: 'security', label: '보안' },
  { role: 'ops', label: '운영' },
  { role: 'cost', label: '비용' },
  { role: 'docs', label: '문서' },
];
const CODEX_ROLES = new Set(['frontend', 'cost', 'data-engineer', 'data', 'mobile']);

function safeReadJson<T = unknown>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const home = os.homedir();
    const runtimeDir = path.join(home, '.dorothy', 'runtime');
    const loopState = safeReadJson<{ status?: string; pass?: string; currentRole?: string; updatedAt?: string }>(
      path.join(runtimeDir, 'triplan-team-loop-state.json'),
    );
    const agentStates = safeReadJson<Record<string, AgentState>>(path.join(runtimeDir, 'auto-loop-state.json')) || {};

    // 데몬 생존(PID) + 정지 플래그
    const pauseFlag = fs.existsSync(path.join(runtimeDir, 'triplan-pm-tick.paused'));
    let pidAlive = false;
    let pid: number | null = null;
    try {
      const raw = fs.readFileSync(path.join(runtimeDir, 'triplan-team-loop.pid'), 'utf-8').trim();
      pid = parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 0);
        pidAlive = true;
      }
    } catch {
      pidAlive = false;
    }

    // agentId → 역할/이름/엔진 매핑
    const companies = safeReadJson<{ agentMappings?: { agentId: string; roleId: string; name?: string; engine?: string }[] }>(
      path.join(home, '.dorothy', 'companies.json'),
    );
    const byRole = new Map<string, { agentId: string; name?: string; engine?: string }>();
    for (const m of companies?.agentMappings ?? []) byRole.set(m.roleId, { agentId: m.agentId, name: m.name, engine: m.engine });

    // 🅒 모델: 실제 상태는 대시보드 에이전트(agents.json) 라이브 status 에서.
    const agentsRaw = safeReadJson<unknown>(path.join(home, '.dorothy', 'agents.json'));
    const liveById = new Map<string, { status?: string }>();
    const liveArr = Array.isArray(agentsRaw)
      ? agentsRaw
      : agentsRaw && typeof agentsRaw === 'object'
        ? Object.values((agentsRaw as { agents?: unknown }).agents ?? agentsRaw)
        : [];
    for (const a of liveArr as { id?: string; status?: string }[]) {
      if (a && a.id) liveById.set(a.id, { status: a.status });
    }

    const now = Date.now();
    const agents = PIPELINE.map(({ role, label }) => {
      const map = byRole.get(role);
      const live = map ? liveById.get(map.agentId) : undefined;
      const st = map ? agentStates[map.agentId] : undefined;
      const cooldownUntil = st?.cooldownUntil || st?.nextRun || null;
      let resumeInSeconds: number | null = null;
      if (cooldownUntil) {
        const t = Date.parse(cooldownUntil);
        if (!Number.isNaN(t)) resumeInSeconds = Math.max(0, Math.round((t - now) / 1000));
      }
      const engine: 'claude' | 'codex' = CODEX_ROLES.has(role) ? 'codex' : 'claude';
      return {
        role,
        label,
        name: map?.name ?? label,
        engine, // 실제 라우팅된 엔진(auto → 이 값)
        status: live?.status ?? st?.status ?? 'pending',
        cycle: st?.cycle ?? null,
        lastRun: st?.lastRun ?? null,
        cooldownUntil,
        resumeInSeconds, // 사용량 한도 시 재가동까지 남은 초
        consecutiveErrors: st?.consecutiveErrors ?? 0,
        lastError: st?.lastError ?? null,
        isCurrent: (live?.status === 'running') || loopState?.currentRole === role,
      };
    });

    // 엔진별 가용성: Claude/Codex 는 사용량 한도를 엔진 단위로 공유한다.
    // 같은 엔진 에이전트 중 cooldownUntil 이 가장 늦은 시각 = 그 엔진이 다시 쓸 수 있게 되는 시각.
    const engineCooldown: Record<'claude' | 'codex', { until: string | null; resumeInSeconds: number | null }> = {
      claude: { until: null, resumeInSeconds: null },
      codex: { until: null, resumeInSeconds: null },
    };
    for (const a of agents) {
      if (a.cooldownUntil) {
        const t = Date.parse(a.cooldownUntil);
        if (!Number.isNaN(t) && t > now) {
          const cur = engineCooldown[a.engine].until ? Date.parse(engineCooldown[a.engine].until!) : 0;
          if (t > cur) {
            engineCooldown[a.engine] = { until: a.cooldownUntil, resumeInSeconds: Math.round((t - now) / 1000) };
          }
        }
      }
    }
    // 엔진 한도 신호(runtime/claude-limit.json) — pm-tick 가 PM output 에서 파싱해 기록한 리셋 시각(권위 있는 엔진 단위 신호).
    const claudeLimit = safeReadJson<{ resetAt?: string }>(path.join(home, '.dorothy', 'runtime', 'claude-limit.json'));
    if (claudeLimit?.resetAt) {
      const t = Date.parse(claudeLimit.resetAt);
      if (!Number.isNaN(t) && t > now) {
        engineCooldown.claude = { until: claudeLimit.resetAt, resumeInSeconds: Math.round((t - now) / 1000) };
      }
    }
    // 에이전트별 "지금 사용 가능?" 판정 — 자기 엔진이 cooldown 이면 대기.
    const agentsWithAvail = agents.map((a) => {
      const ec = engineCooldown[a.engine];
      const available = !ec.until;
      return {
        ...a,
        available, // true = 지금 사용 가능, false = 재충전 대기
        availableAt: available ? null : ec.until, // 사용 가능해지는 시각(ISO)
        availableInSeconds: available ? null : ec.resumeInSeconds, // 남은 초
      };
    });

    // 전체 실행 상태 요약 (🅒: 라이브 에이전트 상태 기준)
    const anyCooldown = agents.some((a) => a.resumeInSeconds != null && a.resumeInSeconds > 0);
    const anyRunning = agents.some((a) => a.status === 'running' || a.status === 'waiting');
    const running = anyRunning;
    const soonestResume = agents
      .filter((a) => a.resumeInSeconds != null && a.resumeInSeconds > 0)
      .sort((a, b) => (a.resumeInSeconds! - b.resumeInSeconds!))[0]?.cooldownUntil ?? null;

    let overall: 'running' | 'paused' | 'cooldown' | 'idle';
    if (pauseFlag) overall = 'paused';
    else if (anyCooldown) overall = 'cooldown';
    else if (anyRunning) overall = 'running';
    else overall = 'idle';

    return NextResponse.json({
      overall, // running | cooldown | paused | stopped
      running,
      paused: pauseFlag,
      pidAlive,
      pid,
      loop: loopState, // { status, pass, currentRole, updatedAt }
      currentRole: loopState?.currentRole ?? null,
      pass: loopState?.pass ?? null,
      soonestResume, // 가장 이른 재가동 예정 시각(ISO) — 없으면 null
      intervalSeconds: 3600, // 패스 사이 대기(plist LOOP_INTERVAL)
      engines: {
        // 엔진별 가용성 요약 (available=지금 사용 가능, until=재충전 완료 예정 시각)
        claude: { available: !engineCooldown.claude.until, until: engineCooldown.claude.until, resumeInSeconds: engineCooldown.claude.resumeInSeconds },
        codex: { available: !engineCooldown.codex.until, until: engineCooldown.codex.until, resumeInSeconds: engineCooldown.codex.resumeInSeconds },
      },
      usage: safeReadJson(path.join(home, '.dorothy', 'runtime', 'usage-consumption.json')),
      agents: agentsWithAvail,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
