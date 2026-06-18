/**
 * Dorothy MVP Phase 6-J — Agent dispatch readiness (dry-run only).
 *
 * Answers "could the orchestrator dispatch this agent right now, and if not,
 * WHY?" by combining:
 *   - the idle-reason chain (approval / rate-limit / dependency / handoff /
 *     run-mode / auto-spawn) — see agent-idle-reason-service.ts
 *   - the registry spawnability (isRegistered / isLiveLoaded / isSpawnable) —
 *     see agent-definition-registry.ts
 *
 * It NEVER calls startAgent, never spawns a PTY, never consumes a Claude token,
 * and never mutates anything. Pure read-only diagnosis for the dashboard.
 */

import {
  computeIdleStatuses,
  type IdleComputeOptions,
  type AgentIdleStatus,
} from './agent-idle-reason-service';
import {
  buildAgentRegistry,
  normalizeAgentKey,
  type AgentDefinition,
  type AgentRegistryOptions,
} from './agent-definition-registry';

export type DispatchBlockerReason =
  | 'no_pending_runstep'
  | 'agent_not_registered'
  | 'agent_not_live_loaded'
  | 'agent_not_spawnable'
  | 'approval_required'
  | 'runmode_policy'
  | 'dependency_not_completed'
  | 'handoff_missing'
  | 'rate_limited'
  | 'auto_spawn_disabled'
  | 'provider_unavailable'
  // Phase 6-K — launch / environment blockers (claude binary + paths).
  | 'claude_binary_missing'
  | 'project_path_missing'
  | 'mcp_config_missing'
  | 'add_dir_missing'
  | 'launch_command_invalid'
  // Phase 6-L — provider / model compatibility blockers.
  | 'provider_model_mismatch'
  | 'provider_unknown'
  | 'model_missing'
  // Phase 6-M — Codex-specific persistent / stale-session blockers.
  | 'codex_persistent_model_mismatch'
  | 'stale_session_model_mismatch'
  | 'unknown';

export interface AgentDispatchReadiness {
  agentId: string;
  ready: boolean;
  reason?: DispatchBlockerReason;
  summary: string;
  runId?: string;
  runStepId?: string;
}

export interface DispatchReadinessOptions extends IdleComputeOptions {
  /** Inject registry definitions for tests; otherwise built from disk + DB. */
  definitions?: AgentDefinition[];
  /** Live-loaded ids passed through to the registry build. */
  liveLoadedAgentIds?: string[];
  /** Override registry build options for tests. */
  registryOptions?: AgentRegistryOptions;
  /** Phase 6-K — global: the claude binary is not resolvable. When true, every
   *  pending-step agent is blocked on `claude_binary_missing`. */
  claudeBinaryMissing?: boolean;
  /** Phase 6-K — per-agent launch blocker (project_path_missing, etc.), keyed
   *  by agentId. Overrides other blockers for that agent. */
  launchBlockByAgent?: Map<string, DispatchBlockerReason>;
}

/** idle reasons that mean "a pending step exists but is blocked". */
const PENDING_BLOCKED = new Set<AgentIdleStatus['reason']>([
  'waiting_for_approval',
  'blocked_by_rate_limit',
  'blocked_by_runmode_policy',
  'waiting_for_dependency',
  'waiting_for_handoff',
  'waiting_for_validation',
  'auto_resume_dry_run',
  'orchestrator_autospawn_disabled',
  'unknown',
]);

function idleReasonToBlocker(reason: AgentIdleStatus['reason']): DispatchBlockerReason {
  switch (reason) {
    case 'waiting_for_approval':            return 'approval_required';
    case 'blocked_by_rate_limit':           return 'rate_limited';
    case 'auto_resume_dry_run':             return 'rate_limited';
    case 'blocked_by_runmode_policy':       return 'runmode_policy';
    case 'waiting_for_dependency':          return 'dependency_not_completed';
    case 'waiting_for_handoff':             return 'handoff_missing';
    case 'waiting_for_validation':          return 'runmode_policy';
    case 'orchestrator_autospawn_disabled': return 'auto_spawn_disabled';
    default:                                return 'unknown';
  }
}

function readinessForAgent(
  idle: AgentIdleStatus,
  def: AgentDefinition | undefined,
  launch?: { binaryMissing?: boolean; agentBlock?: DispatchBlockerReason },
): AgentDispatchReadiness {
  const ctx = { agentId: idle.agentId, runId: idle.runId, runStepId: idle.runStepId };

  // Already running — nothing to dispatch; not a blocker.
  if (idle.reason === 'active') {
    return { ...ctx, ready: false, summary: 'Agent session is currently running.' };
  }
  if (idle.reason === 'completed') {
    return { ...ctx, ready: false, summary: 'Work completed; no pending step.' };
  }
  // No work assigned.
  if (idle.reason === 'no_assigned_runstep') {
    return { ...ctx, ready: false, reason: 'no_pending_runstep', summary: 'No pending RunStep is assigned to this agent.' };
  }

  // From here a pending step exists but is blocked. Registry spawnability is a
  // hard prerequisite — an unregistered / not-live / disabled agent cannot be
  // dispatched no matter what the step state is.
  if (PENDING_BLOCKED.has(idle.reason)) {
    // Phase 6-K — launch/environment blockers gate everything: even a
    // perfectly-queued step can't run if the claude binary or paths are bad.
    if (launch?.binaryMissing) {
      return { ...ctx, ready: false, reason: 'claude_binary_missing', summary: `"${idle.agentId}" cannot start: Claude binary was not found in the dashboard PATH.` };
    }
    if (launch?.agentBlock) {
      return { ...ctx, ready: false, reason: launch.agentBlock, summary: `"${idle.agentId}" cannot start: ${launch.agentBlock.replace(/_/g, ' ')}.` };
    }
    // Phase 6-L — provider/model mismatch is a hard launch blocker.
    if (def?.modelCompatibility && def.modelCompatibility.ok === false) {
      const r: DispatchBlockerReason =
        def.modelCompatibility.reason === 'provider_unknown' ? 'provider_unknown'
          : def.modelCompatibility.reason === 'model_missing' ? 'model_missing'
            : 'provider_model_mismatch';
      return { ...ctx, ready: false, reason: r, summary: def.modelCompatibility.message };
    }
    if (def) {
      if (!def.isRegistered) {
        return { ...ctx, ready: false, reason: 'agent_not_registered', summary: `"${idle.agentId}" has a pending step but is not registered in agents.json.` };
      }
      if (!def.isLiveLoaded) {
        return { ...ctx, ready: false, reason: 'agent_not_live_loaded', summary: `"${idle.agentId}" is registered but not live-loaded. Click Reload Live Agents.` };
      }
      if (!def.isSpawnable) {
        const r: DispatchBlockerReason =
          def.spawnBlockReason === 'disabled' ? 'agent_not_spawnable'
            : def.spawnBlockReason === 'provider_unavailable' ? 'provider_unavailable'
              : 'agent_not_spawnable';
        return { ...ctx, ready: false, reason: r, summary: `"${idle.agentId}" is not spawnable (${def.spawnBlockReason ?? 'unknown'}).` };
      }
    }

    // 'unknown' idle reason + a spawnable agent == queued and dispatchable.
    if (idle.reason === 'unknown') {
      return { ...ctx, ready: true, summary: 'Pending step is ready to dispatch (no blocker detected).' };
    }
    return { ...ctx, ready: false, reason: idleReasonToBlocker(idle.reason), summary: idle.summary };
  }

  return { ...ctx, ready: false, reason: 'unknown', summary: idle.summary };
}

/* ============================================================================
 * Public surface
 * ========================================================================== */

export function computeDispatchReadiness(opts: DispatchReadinessOptions = {}): AgentDispatchReadiness[] {
  const idleStatuses = computeIdleStatuses(opts);

  const defs = opts.definitions ?? buildAgentRegistry({
    ...(opts.registryOptions ?? {}),
    liveLoadedAgentIds: opts.liveLoadedAgentIds ?? opts.registryOptions?.liveLoadedAgentIds,
  }).definitions;
  const defByKey = new Map<string, AgentDefinition>();
  for (const d of defs) defByKey.set(normalizeAgentKey(d.id), d);

  const launchBlockByKey = new Map<string, DispatchBlockerReason>();
  if (opts.launchBlockByAgent) {
    for (const [aid, reason] of opts.launchBlockByAgent) launchBlockByKey.set(normalizeAgentKey(aid), reason);
  }

  return idleStatuses.map(idle =>
    readinessForAgent(
      idle,
      defByKey.get(normalizeAgentKey(idle.agentId)),
      { binaryMissing: opts.claudeBinaryMissing, agentBlock: launchBlockByKey.get(normalizeAgentKey(idle.agentId)) },
    ),
  );
}

export function getDispatchReadiness(
  agentId: string,
  opts: DispatchReadinessOptions = {},
): AgentDispatchReadiness {
  const all = computeDispatchReadiness({ ...opts, agentIds: [agentId] });
  return all[0] ?? { agentId, ready: false, reason: 'unknown', summary: 'No readiness computed.' };
}

/** Roll-up counts for the dashboard summary. */
export interface DispatchReadinessCounts {
  ready: number;
  blocked: number;
  total: number;
  byReason: Partial<Record<DispatchBlockerReason, number>>;
}

export function countDispatchReadiness(items: AgentDispatchReadiness[]): DispatchReadinessCounts {
  const byReason: Partial<Record<DispatchBlockerReason, number>> = {};
  let ready = 0;
  let blocked = 0;
  for (const it of items) {
    if (it.ready) { ready++; continue; }
    if (it.reason) {
      blocked++;
      byReason[it.reason] = (byReason[it.reason] ?? 0) + 1;
    }
  }
  return { ready, blocked, total: items.length, byReason };
}
