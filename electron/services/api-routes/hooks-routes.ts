import { agents, saveAgents } from '../../core/agent-manager';
import { findAgentByIdOrSession } from './utils';
import { RouteApp, RouteContext } from './types';
import { AgentStatus } from '../../types';
import { broadcastToAllWindows } from '../../utils/broadcast';
import { scheduleTick } from '../../utils/agents-tick';
// MVP hook: mirror PTY status events into AgentSession rows. All calls are
// wrapped in try/catch so a dorothy.db failure cannot break the legacy
// AgentStatus update path that this file is responsible for.
import {
  endAgentSession,
  findActiveSessionForAgent,
  updateAgentSession,
} from '../dorothy/agent-session-service';
import { completeRunStep, recordDispatchCommitRef } from '../dorothy/orchestrator-service';
import { getDorothyDb } from '../dorothy/db';
import { parseUsageLimitMessage } from '../dorothy/usage-limit-parser';
import { recordRateLimitEventAndBlockRuns } from '../dorothy/rate-limit-bridge';
import { safeCreateHookEvent, makeExcerpt } from '../dorothy/hook-event-service';

/**
 * Phase 4 — look up the RunStep currently bound to an AgentSession.
 *
 * Returns null when:
 *   - dorothy.db is unavailable
 *   - no step has bound this session yet (orchestrator hasn't dispatched)
 *
 * Cheap (single indexed lookup); safe to call from every Stop hook.
 */
function lookupStepIdForSession(sessionId: string): string | null {
  try {
    const db = getDorothyDb();
    if (!db) return null;
    const row = db.prepare('SELECT id FROM run_steps WHERE agent_session_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(sessionId) as { id: string } | undefined;
    return row?.id ?? null;
  } catch (err) {
    console.warn('[hooks] lookupStepIdForSession failed (ignored):', err);
    return null;
  }
}

/* ============================================================================
 * Phase 5F — agent output → HookEvent throttling
 *
 * The agent output hook can fire dozens of times per minute. We want a
 * "session activity" pulse on the Run Detail timeline without flooding it,
 * so we:
 *   1. Only emit when the output contains a noteworthy signal — error /
 *      failed / handoff marker / "usage limit" / waiting / completed.
 *   2. Otherwise throttle to one row per session per 5 seconds.
 *
 * The excerpt is masked + clipped to 500 chars by `makeExcerpt`.
 * ========================================================================== */

const OUTPUT_THROTTLE_MS = 5_000;
const lastOutputEventAt = new Map<string, number>();

const NOTEWORTHY_PATTERNS: Array<{ re: RegExp; severity: 'warning' | 'error' | 'info'; tag: string }> = [
  { re: /\b(error|exception|traceback|stack trace)\b/i, severity: 'warning', tag: 'error-keyword' },
  { re: /\b(failed|failure|fatal)\b/i,                  severity: 'warning', tag: 'failure-keyword' },
  { re: /(claude.+(usage|rate).+limit|usage limit reached)/i, severity: 'warning', tag: 'usage-limit' },
  { re: /\b(handoff|HANDOFF[-_ ]MARK)\b/i,              severity: 'info',    tag: 'handoff-marker' },
  { re: /\b(completed|finished|done\.)\b/i,             severity: 'info',    tag: 'completed-keyword' },
];

function classifyOutput(output: string): { emit: boolean; severity: 'info' | 'warning' | 'error'; tag: string } {
  for (const p of NOTEWORTHY_PATTERNS) {
    if (p.re.test(output)) return { emit: true, severity: p.severity, tag: p.tag };
  }
  return { emit: false, severity: 'info', tag: 'plain' };
}

export function registerHooksRoutes(app: RouteApp, ctx: RouteContext): void {
  // POST /api/hooks/output — capture clean text output from agent transcript
  app.post('/api/hooks/output', (req, sendJson) => {
    const { agent_id, session_id, output } = req.body as {
      agent_id: string;
      session_id?: string;
      output: string;
    };

    if (!agent_id || !output) {
      sendJson({ error: 'agent_id and output are required' }, 400);
      return;
    }

    const agent = findAgentByIdOrSession(agent_id, session_id);
    if (agent) {
      agent.lastCleanOutput = output;
      saveAgents();
    }

    // Phase 5C-B — sniff agent output for "Claude usage limit reached" so we
    // schedule a resume even when the user hasn't wired the PM-tick script.
    // Wrapped in try/catch + best-effort so this can never break the legacy
    // hook path.
    try {
      const parsed = parseUsageLimitMessage(output);
      if (parsed.detected && getDorothyDb()) {
        const active = agent ? findActiveSessionForAgent(agent.id) : null;
        const runStepId = active ? lookupStepIdForSession(active.id) : null;
        recordRateLimitEventAndBlockRuns({
          engine: 'claude',
          provider: 'claude',
          source: 'agent_output',
          message: null,                       // do not persist full body
          messageExcerpt: parsed.originalMessageExcerpt,
          resumeAt: parsed.resumeAt ?? null,
          parseConfidence: parsed.confidence,
          affectedSessionIds: active ? [active.id] : undefined,
          affectedRunStepIds: runStepId ? [runStepId] : undefined,
          affectedRunIds: active?.runId ? [active.runId] : undefined,
        });
      }
    } catch (err) {
      console.warn('[hooks] usage-limit sniff (output) failed (ignored):', err instanceof Error ? err.message : 'unknown');
    }

    // Phase 5F — mirror noteworthy output into the HookEvent timeline.
    // Throttled + masked + capped; the full transcript stays in the PTY log.
    try {
      const active = agent ? findActiveSessionForAgent(agent.id) : null;
      const cls = classifyOutput(output);
      const lockKey = active?.id ?? agent_id;
      const lastAt = lastOutputEventAt.get(lockKey) ?? 0;
      const now = Date.now();
      if (cls.emit || now - lastAt > OUTPUT_THROTTLE_MS) {
        lastOutputEventAt.set(lockKey, now);
        const stepId = active ? lookupStepIdForSession(active.id) : null;
        safeCreateHookEvent({
          type: 'agent_session_output',
          severity: cls.severity,
          source: 'hook',
          runId: active?.runId ?? null,
          runStepId: stepId,
          agentSessionId: active?.id ?? null,
          agentId: agent?.id ?? agent_id,
          title: `Agent output (${cls.tag}) — ${agent?.name ?? agent_id}`,
          summary: makeExcerpt(output),
          metadata: { tag: cls.tag, sessionId: session_id ?? null },
        });
      }
    } catch (err) {
      console.warn('[hooks] HookEvent output emit failed (ignored):', err instanceof Error ? err.message : 'unknown');
    }

    sendJson({ success: true });
  });

  // POST /api/hooks/status
  app.post('/api/hooks/status', (req, sendJson) => {
    const { agent_id, session_id, status, waiting_reason, current_task } = req.body as {
      agent_id: string;
      session_id: string;
      status: 'running' | 'waiting' | 'idle' | 'completed';
      source?: string;
      reason?: string;
      waiting_reason?: string;
      current_task?: string;
    };

    console.log(`[hooks] POST /api/hooks/status — agent_id=${agent_id}, status=${status}, session_id=${session_id}`);

    if (!agent_id || !status) {
      sendJson({ error: 'agent_id and status are required' }, 400);
      return;
    }

    const agent: AgentStatus | undefined = findAgentByIdOrSession(agent_id, session_id);
    if (!agent) {
      sendJson({ success: false, message: 'Agent not found' });
      return;
    }

    const oldStatus = agent.status;

    if (status === 'running' && agent.status !== 'running') {
      agent.status = 'running';
      agent.currentSessionId = session_id;
      if (current_task) agent.currentTask = current_task;
    } else if (status === 'waiting' && agent.status !== 'waiting') {
      agent.status = 'waiting';
    } else if (status === 'idle') {
      agent.status = 'idle';
      agent.currentSessionId = undefined;
    } else if (status === 'completed') {
      agent.status = 'completed';
    }

    agent.lastActivity = new Date().toISOString();

    if (oldStatus !== agent.status) {
      console.log(`[hooks] Status changed: ${agent.id} ${oldStatus} → ${agent.status}`);
      ctx.handleStatusChangeNotificationCallback(agent, agent.status);
      ctx.agentStatusEmitter.emit(`status:${agent.id}`);

      broadcastToAllWindows('agent:status', {
        agentId: agent.id,
        status: agent.status,
        waitingReason: waiting_reason,
      });
      scheduleTick();

      // ★#2 dispatch 경로 ref — worker dispatch(/start)는 RunStep 이 없어 completeRunStep(②ref)이
      //   안 닿는다(실측: agent_sessions=0·바인딩 dead). 완료/idle 전이 시 commit-ref 를 직접 기록.
      //   feat/* 만·중복 sha skip·비치명(helper 내부 가드). 기존 동작 불변.
      if (agent.status === 'completed' || agent.status === 'idle') {
        recordDispatchCommitRef(agent.id);
      }
    }

    // MVP: mirror the same event into AgentSession (best-effort, isolated).
    // Legacy agents.json behavior above is the source of truth; we only
    // augment with the structured Session row when the DB is available.
    try {
      const active = findActiveSessionForAgent(agent.id);
      if (active) {
        if (agent.status === 'waiting') {
          updateAgentSession({ id: active.id, waitingForUserInput: true });
        } else if (agent.status === 'running') {
          updateAgentSession({ id: active.id, waitingForUserInput: false });
        } else if (agent.status === 'completed' || agent.status === 'idle') {
          endAgentSession({ id: active.id, endStatus: 'completed' });
          // Phase 4 — drive the orchestrator forward. We don't pass a
          // runStepId from here; completeRunStep looks the binding up via
          // run_steps.agent_session_id (populated by orchestrator.dispatch).
          const stepId = lookupStepIdForSession(active.id);
          if (stepId) {
            // Fire-and-forget — orchestrator failures must not bubble back
            // into the legacy hook flow.
            void completeRunStep({ runStepId: stepId, endStatus: 'completed' })
              .catch(err => console.warn('[hooks] orchestrator completeRunStep failed (ignored):', err));
          }
        }
      }
    } catch (err) {
      console.warn('[hooks] dorothy AgentSession mirror failed (ignored):', err);
    }

    sendJson({ success: true, agent: { id: agent.id, status: agent.status } });
  });

  // POST /api/hooks/task-completed — dedicated endpoint for TaskCompleted hook
  app.post('/api/hooks/task-completed', (req, sendJson) => {
    const { agent_id, session_id } = req.body as {
      agent_id: string;
      session_id?: string;
    };

    if (!agent_id) {
      sendJson({ error: 'agent_id is required' }, 400);
      return;
    }

    const agent = findAgentByIdOrSession(agent_id, session_id);
    if (!agent) {
      sendJson({ success: false, message: 'Agent not found' });
      return;
    }

    const oldStatus = agent.status;
    agent.status = 'completed';
    agent.lastActivity = new Date().toISOString();

    const agentName = agent.name || `Agent ${agent.id.slice(0, 6)}`;

    // Send native notification if user has completion notifications enabled
    if (ctx.getAppSettings().notificationsEnabled && ctx.getAppSettings().notifyOnComplete) {
      ctx.sendNotificationCallback(
        `${agentName} finished`,
        agent.currentTask ? `Done: ${agent.currentTask.slice(0, 80)}` : 'Task completed successfully.',
        agent.id,
        ctx.getAppSettings()
      );
    }

    if (oldStatus !== 'completed') {
      console.log(`[hooks] Task completed: ${agent.id} ${oldStatus} → completed`);
      ctx.handleStatusChangeNotificationCallback(agent, 'completed');
      ctx.agentStatusEmitter.emit(`status:${agent.id}`);

      broadcastToAllWindows('agent:status', {
        agentId: agent.id,
        status: agent.status,
      });
      scheduleTick();
    }

    // MVP: close out the matching AgentSession row + drive the orchestrator.
    try {
      const active = findActiveSessionForAgent(agent.id);
      if (active) {
        endAgentSession({ id: active.id, endStatus: 'completed' });
        const stepId = lookupStepIdForSession(active.id);
        if (stepId) {
          void completeRunStep({ runStepId: stepId, endStatus: 'completed' })
            .catch(err => console.warn('[hooks] orchestrator completeRunStep failed (ignored):', err));
        }
      }
    } catch (err) {
      console.warn('[hooks] dorothy AgentSession mirror (task-completed) failed:', err);
    }

    // ★#2 dispatch 경로 ref — TaskCompleted 시점에도 commit-ref 직접 기록(완료 전이 시 1회).
    if (oldStatus !== 'completed') {
      recordDispatchCommitRef(agent.id);
    }

    sendJson({ success: true, agent: { id: agent.id, status: agent.status } });
  });

  // POST /api/hooks/agent-stopped — Send notification when agent finishes a response (Stop hook)
  app.post('/api/hooks/agent-stopped', (req, sendJson) => {
    const { agent_id, session_id } = req.body as {
      agent_id: string;
      session_id?: string;
    };

    if (!agent_id) {
      sendJson({ error: 'agent_id is required' }, 400);
      return;
    }

    const agent = findAgentByIdOrSession(agent_id, session_id);
    if (!agent) {
      sendJson({ success: false, message: 'Agent not found' });
      return;
    }

    if (ctx.getAppSettings().notificationsEnabled && ctx.getAppSettings().notifyOnStop) {
      const agentName = agent.name || `Agent ${agent.id.slice(0, 6)}`;
      ctx.sendNotificationCallback(
        `${agentName}`,
        agent.lastCleanOutput ? agent.lastCleanOutput.slice(0, 80) : 'Agent has finished and is ready for the next prompt.',
        agent.id,
        ctx.getAppSettings()
      );
    }

    sendJson({ success: true });
  });

  // POST /api/hooks/notification
  app.post('/api/hooks/notification', (req, sendJson) => {
    const { agent_id, session_id, type, title, message } = req.body as {
      agent_id: string;
      session_id: string;
      type: string;
      title: string;
      message: string;
    };

    if (!agent_id || !type) {
      sendJson({ error: 'agent_id and type are required' }, 400);
      return;
    }

    const agent = findAgentByIdOrSession(agent_id, session_id);
    const agentName = agent?.name || 'Claude';

    if (type === 'permission_prompt') {
      if (ctx.getAppSettings().notifyOnWaiting) {
        ctx.sendNotificationCallback(
          `${agentName} needs permission`,
          message || 'Claude needs your permission to proceed',
          agent?.id,
          ctx.getAppSettings()
        );
      }
    } else if (type === 'idle_prompt') {
      if (ctx.getAppSettings().notifyOnWaiting) {
        ctx.sendNotificationCallback(
          `${agentName} is waiting`,
          message || 'Claude is waiting for your input',
          agent?.id,
          ctx.getAppSettings()
        );
      }
    }

    broadcastToAllWindows('agent:notification', {
      agentId: agent?.id,
      type,
      title,
      message,
    });

    sendJson({ success: true });
  });
}
