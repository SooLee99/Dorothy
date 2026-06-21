import { v4 as uuidv4 } from 'uuid';
import { agents, saveAgents } from '../../core/agent-manager';
import { generateTaskFromPrompt } from '../../utils/kanban-generate';
import { RouteApp, RouteContext } from './types';

export function registerKanbanRoutes(app: RouteApp, ctx: RouteContext): void {
  // POST /api/kanban/report-issue — 에이전트가 ★(A) 자기가 고칠(또는 팀이 고칠) 런타임 이슈를
  //   칸반 backlog 카드로 자동등록(dedup) + 새 카드면 슬랙 알림. 이후 run-kanban-sync→advanceRun 이
  //   오케스트레이터 분배로 이어간다(끊김 없는 순환). ★(B)사람 몫은 escalate.sh(action-items)로 분리.
  app.post('/api/kanban/report-issue', async (req, sendJson) => {
    const { title, detail, projectId, projectPath, agent, role } = req.body as {
      title?: string; detail?: string; projectId?: string; projectPath?: string; agent?: string; role?: string;
    };
    if (!title || typeof title !== 'string') { sendJson({ ok: false, message: 'title 필요' }, 400); return; }
    try {
      const { loadTasks, saveTasks, emitTaskEvent } = await import('../../handlers/kanban-handlers');
      const tasks = loadTasks();
      const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
      // ★dedup: 같은 제목의 미완료(non-done) 카드 있으면 새로 안 만든다(에이전트 매 사이클 반복 보고 → 1카드).
      const dupe = tasks.find((t) => t.column !== 'done' && norm(t.title) === norm(title));
      if (dupe) { sendJson({ ok: true, created: false, id: dupe.id, message: '이미 등록된 이슈(중복 스킵)' }); return; }
      const now = new Date().toISOString();
      const backlogOrders = tasks.filter((t) => t.column === 'backlog').map((t) => t.order ?? 0);
      const maxOrder = backlogOrders.length ? Math.max(...backlogOrders) : -1;
      const labels = ['agent-reported']; if (role) labels.push(`role:${role}`);
      const newTask = {
        id: uuidv4(), title, description: detail || '', column: 'backlog' as const,
        projectId: projectId || '', projectPath: projectPath || '',
        assignedAgentId: null, agentCreatedForTask: false, requiredSkills: [],
        priority: 'medium' as const, progress: 0, createdAt: now, updatedAt: now,
        order: maxOrder + 1, labels, attachments: [],
      };
      tasks.push(newTask);
      saveTasks(tasks);
      emitTaskEvent('kanban:task-updated', newTask);
      // 슬랙 알림(새 카드만) — 채널 미설정/슬랙 off 면 조용히 스킵.
      try {
        const slackApp = ctx.getSlackApp();
        const s = ctx.getAppSettings();
        if (slackApp && s?.slackChannelId) {
          await slackApp.client.chat.postMessage({
            channel: s.slackChannelId,
            text: `:jigsaw: 에이전트 이슈 칸반 등록${projectId ? ` (${projectId})` : ''}: ${title}`,
            mrkdwn: true,
          });
        }
      } catch { /* 슬랙 실패는 무시 — 카드 등록은 성공 */ }
      sendJson({ ok: true, created: true, id: newTask.id, title });
    } catch (err) {
      sendJson({ ok: false, message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // POST /api/kanban/generate
  app.post('/api/kanban/generate', async (req, sendJson) => {
    const { prompt, availableProjects } = req.body as {
      prompt: string;
      availableProjects: Array<{ path: string; name: string }>;
    };

    if (!prompt) {
      sendJson({ error: 'prompt is required' }, 400);
      return;
    }

    const task = await generateTaskFromPrompt(prompt, availableProjects);
    sendJson({ success: true, task });
  });

  // POST /api/kanban/complete
  app.post('/api/kanban/complete', async (req, sendJson) => {
    const { task_id, agent_id, session_id, summary } = req.body as {
      task_id?: string;
      agent_id?: string;
      session_id?: string;
      summary?: string;
    };

    try {
      const { loadTasks, saveTasks } = await import('../../handlers/kanban-handlers');

      const tasks = loadTasks();
      let task;

      if (task_id) {
        task = tasks.find(t => t.id === task_id);
      } else if (agent_id) {
        task = tasks.find(t => t.assignedAgentId === agent_id && t.column === 'ongoing');
      } else if (session_id) {
        let agentIdFromSession: string | undefined;
        for (const [id, agent] of agents) {
          if (agent.currentSessionId === session_id) {
            agentIdFromSession = id;
            break;
          }
        }
        if (agentIdFromSession) {
          task = tasks.find(t => t.assignedAgentId === agentIdFromSession && t.column === 'ongoing');
        }
      }

      if (!task) {
        sendJson({ success: true, message: 'No kanban task found for this agent' });
        return;
      }

      if (task.column !== 'ongoing') {
        sendJson({ success: true, message: 'Task already completed', currentColumn: task.column });
        return;
      }

      task.column = 'done';
      task.progress = 100;
      task.completedAt = new Date().toISOString();
      task.updatedAt = new Date().toISOString();
      if (summary) {
        task.completionSummary = summary;
      }

      if (task.agentCreatedForTask && task.assignedAgentId) {
        const agentToDelete = agents.get(task.assignedAgentId);
        if (agentToDelete) {
          console.log(`[Kanban] Deleting agent ${task.assignedAgentId} created for task`);
          agents.delete(task.assignedAgentId);
        }
      }

      saveTasks(tasks);

      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('kanban:task-updated', task);
      }

      console.log(`[Kanban] Task "${task.title}" marked as complete via hook`);
      sendJson({ success: true, task });
    } catch (err) {
      console.error('[Kanban] Failed to complete task:', err);
      sendJson({ error: 'Failed to complete task' }, 500);
    }
  });
}
