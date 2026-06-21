import { ipcMain, BrowserWindow } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { generateTaskFromPrompt } from '../utils/kanban-generate';
// ★단일 소스: 칸반 데이터는 hermes SQLite(~/.hermes/kanban.db) 에 산다. load/save 는 store 로 위임.
import {
  loadTasks,
  saveTasks,
  type KanbanTask,
  type KanbanColumn,
  type TaskAttachment,
} from '../services/kanban-store';
// MVP Phase 3 / 4.5 — opportunistic Plan/Run mirror + Plan-aware routing.
// Best-effort: every call below is wrapped so a failure here cannot break
// the legacy auto-spawn flow.
import { onKanbanTaskChanged, getRunForKanbanTask } from '../services/dorothy/kanban-task-adapter';
import { listPlansByRun } from '../services/dorothy/plan-service';
import { selectAgentForOwnerRole, type LiveAgentSlim } from '../services/dorothy/agent-routing';

// ============================================
// Kanban Board IPC handlers
// ============================================

// KanbanColumn / TaskAttachment / KanbanTask 는 ../services/kanban-store 에서 import (단일 소스).

interface KanbanTaskCreate {
  title: string;
  description: string;
  projectId: string;
  projectPath: string;
  requiredSkills?: string[];
  priority?: 'low' | 'medium' | 'high';
  labels?: string[];
  attachments?: TaskAttachment[];
}

interface KanbanTaskUpdate {
  id: string;
  title?: string;
  description?: string;
  requiredSkills?: string[];
  priority?: 'low' | 'medium' | 'high';
  labels?: string[];
  progress?: number;
  assignedAgentId?: string | null;
  completionSummary?: string;
}

// Dependencies interface
export interface KanbanHandlerDependencies {
  getMainWindow: () => BrowserWindow | null;
  findMatchingAgent: (projectPath: string, requiredSkills: string[]) => Promise<string | null>;
  createAgentForTask: (task: KanbanTask) => Promise<string>;
  startAgent: (agentId: string, prompt: string, kanbanTaskId?: string) => Promise<void>;
  stopAgent: (agentId: string) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  getAgentOutput: (agentId: string) => string[];
  /**
   * MVP Phase 4.5 — live agent snapshot for Plan-aware ownerAgentId routing.
   * Optional so older callers (tests, legacy boot) keep working; when absent
   * we silently fall back to `findMatchingAgent` only.
   */
  getLiveAgents?: () => LiveAgentSlim[];
}

let deps: KanbanHandlerDependencies | null = null;

function emitTaskEvent(eventName: string, task: KanbanTask): void {
  deps?.getMainWindow()?.webContents.send(eventName, task);
}

/**
 * MVP Phase 4.5 — read the Plan attached to a KanbanTask (via the
 * dorothy.db mirror) and return the first pending task's ownerAgentId.
 *
 * The lookup is deliberately conservative:
 *   - No mirror Run → null (silent — legacy path runs).
 *   - Multiple Plans → newest by updatedAt.
 *   - No tasks[] or no ownerAgentId → null.
 *
 * Returns null on any error so callers can simply fall back to the
 * legacy findMatchingAgent path.
 */
function pickOwnerAgentForKanbanTask(kanbanTaskId: string): string | null {
  try {
    const run = getRunForKanbanTask(kanbanTaskId);
    if (!run) return null;
    const plans = listPlansByRun(run.id);
    if (plans.length === 0) return null;
    const plan = [...plans].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const firstTask = plan.tasks?.find(t => !!t.ownerAgentId);
    return firstTask?.ownerAgentId ?? null;
  } catch (err) {
    console.warn('[kanban] pickOwnerAgentForKanbanTask failed:', err);
    return null;
  }
}

/**
 * Register all Kanban IPC handlers
 */
export function registerKanbanHandlers(dependencies: KanbanHandlerDependencies): void {
  deps = dependencies;

  // List all tasks
  ipcMain.handle('kanban:list', async () => {
    try {
      const tasks = loadTasks();
      return { tasks };
    } catch (err) {
      console.error('Error listing kanban tasks:', err);
      return { tasks: [], error: err instanceof Error ? err.message : 'Failed to list tasks' };
    }
  });

  // Create a new task (defaults to backlog)
  ipcMain.handle('kanban:create', async (_event, params: KanbanTaskCreate) => {
    try {
      const tasks = loadTasks();

      // Find max order in backlog for positioning
      const backlogTasks = tasks.filter(t => t.column === 'backlog');
      const maxOrder = backlogTasks.length > 0
        ? Math.max(...backlogTasks.map(t => t.order))
        : -1;

      const newTask: KanbanTask = {
        id: uuidv4(),
        title: params.title,
        description: params.description,
        column: 'backlog',
        projectId: params.projectId,
        projectPath: params.projectPath,
        assignedAgentId: null,
        agentCreatedForTask: false,
        requiredSkills: params.requiredSkills || [],
        priority: params.priority || 'medium',
        progress: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        order: maxOrder + 1,
        labels: params.labels || [],
        attachments: params.attachments || [],
      };

      tasks.push(newTask);
      saveTasks(tasks);

      emitTaskEvent('kanban:task-created', newTask);

      return { success: true, task: newTask };
    } catch (err) {
      console.error('Error creating kanban task:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to create task' };
    }
  });

  // Update task properties (not column - use move for that)
  ipcMain.handle('kanban:update', async (_event, params: KanbanTaskUpdate) => {
    try {
      const tasks = loadTasks();
      const index = tasks.findIndex(t => t.id === params.id);

      if (index === -1) {
        return { success: false, error: 'Task not found' };
      }

      const task = tasks[index];

      // Update allowed fields
      if (params.title !== undefined) task.title = params.title;
      if (params.description !== undefined) task.description = params.description;
      if (params.requiredSkills !== undefined) task.requiredSkills = params.requiredSkills;
      if (params.priority !== undefined) task.priority = params.priority;
      if (params.labels !== undefined) task.labels = params.labels;
      if (params.progress !== undefined) task.progress = params.progress;
      if (params.assignedAgentId !== undefined) task.assignedAgentId = params.assignedAgentId;
      if (params.completionSummary !== undefined) task.completionSummary = params.completionSummary;

      task.updatedAt = new Date().toISOString();

      saveTasks(tasks);
      emitTaskEvent('kanban:task-updated', task);

      return { success: true, task };
    } catch (err) {
      console.error('Error updating kanban task:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to update task' };
    }
  });

  // Move task to a different column (triggers automation for planned)
  ipcMain.handle('kanban:move', async (_event, params: { id: string; column: KanbanColumn; order?: number }) => {
    try {
      const tasks = loadTasks();
      const index = tasks.findIndex(t => t.id === params.id);

      if (index === -1) {
        return { success: false, error: 'Task not found' };
      }

      const task = tasks[index];
      const previousColumn = task.column;
      const targetColumn = params.column;

      // Block moving ongoing tasks - they can only be deleted to stop
      if (previousColumn === 'ongoing' && targetColumn !== 'done') {
        console.log(`Blocked move: ongoing task "${task.title}" cannot be moved (delete to stop agent)`);
        return { success: false, error: 'Cannot move in-progress tasks. Delete to stop the agent.' };
      }

      // Block moving done tasks
      if (previousColumn === 'done') {
        console.log(`Blocked move: done task "${task.title}" cannot be moved`);
        return { success: false, error: 'Cannot move completed tasks.' };
      }

      // Calculate new order in target column
      const columnTasks = tasks.filter(t => t.column === targetColumn && t.id !== task.id);
      const newOrder = params.order ?? (columnTasks.length > 0
        ? Math.max(...columnTasks.map(t => t.order)) + 1
        : 0);

      // Update task
      task.column = targetColumn;
      task.order = newOrder;
      task.updatedAt = new Date().toISOString();

      // Reset progress when moving back to backlog
      if (targetColumn === 'backlog') {
        task.progress = 0;
        task.assignedAgentId = null;
      }

      // Set completedAt when moving to done and cleanup agent if needed
      if (targetColumn === 'done') {
        task.completedAt = new Date().toISOString();
        task.progress = 100;

        // Delete agent if it was created specifically for this task
        if (task.agentCreatedForTask && task.assignedAgentId && deps) {
          console.log(`Deleting agent ${task.assignedAgentId} created for task "${task.title}"`);
          try {
            await deps.deleteAgent(task.assignedAgentId);
          } catch (deleteErr) {
            console.error('Failed to delete agent:', deleteErr);
          }
        }
      }

      let agentSpawned = false;
      let agentId: string | null = null;

      // MVP Phase 3 — mirror the kanban column change into dorothy.db so the
      // Run Board reflects the user action. The adapter is tolerant of a
      // missing DB and never throws.
      try {
        onKanbanTaskChanged({
          id: task.id,
          title: task.title,
          column: task.column,
          priority: task.priority,
        }, { source: 'kanban' });
      } catch (mirrorErr) {
        console.warn('[kanban] dorothy Run mirror failed (ignored):', mirrorErr);
      }

      // Trigger automation when moving to "planned"
      if (targetColumn === 'planned' && previousColumn !== 'planned' && deps) {
        console.log(`Task "${task.title}" moved to planned - triggering automation`);

        try {
          // MVP Phase 4.5 — Plan-aware routing.
          //   Priority 1: Plan.tasks[*].ownerAgentId → matching live agent.
          //   Priority 2 (fallback): legacy `findMatchingAgent`.
          //   Priority 3 (no match): `createAgentForTask` like before.
          //
          // The lookup is wrapped end-to-end so a DB/routing failure cannot
          // skip the legacy path that was working before this wedge.
          try {
            const ownerAgentId = pickOwnerAgentForKanbanTask(task.id);
            if (ownerAgentId && deps.getLiveAgents) {
              const liveAgents = deps.getLiveAgents();
              const liveId = selectAgentForOwnerRole(ownerAgentId, liveAgents);
              if (liveId) {
                agentId = liveId;
                console.log(`[kanban] Plan ownerAgentId=${ownerAgentId} matched live agent ${liveId} — using that.`);
              } else {
                console.log(`[kanban] Plan ownerAgentId=${ownerAgentId} has no idle live match; falling back to findMatchingAgent.`);
              }
            }
          } catch (planLookupErr) {
            console.warn('[kanban] Plan-aware routing failed (falling back):', planLookupErr);
          }

          // Try to find a matching agent first (legacy fallback)
          if (!agentId) {
            agentId = await deps.findMatchingAgent(task.projectPath, task.requiredSkills);
          }

          if (!agentId) {
            // Create a new agent for this task
            console.log('No matching agent found, creating new agent');
            agentId = await deps.createAgentForTask(task);
            agentSpawned = true;
            task.agentCreatedForTask = true;
          } else {
            console.log(`Found matching agent: ${agentId}`);
            task.agentCreatedForTask = false;
          }

          // Assign agent to task
          task.assignedAgentId = agentId;

          // Save task in planned state first (visual feedback)
          saveTasks(tasks);
          emitTaskEvent('kanban:task-updated', task);

          // Wait 3 seconds for visual feedback before moving to ongoing
          await new Promise(resolve => setTimeout(resolve, 3000));

          // Move to ongoing
          task.column = 'ongoing';
          task.updatedAt = new Date().toISOString();

          // Save before starting agent
          saveTasks(tasks);
          emitTaskEvent('kanban:task-updated', task);

          // Build prompt from task
          let prompt = `# Task: ${task.title}\n\n${task.description}`;

          // Add JIRA-specific project discovery instructions
          const isJiraTask = task.labels?.some(l => l.startsWith('jira:'));
          if (isJiraTask) {
            prompt += '\n\n## Project Discovery\n';
            prompt += 'This task originates from JIRA. The configured project path may not be exact.\n';
            prompt += 'Before starting work, verify you are in the correct project directory:\n';
            prompt += '1. Check if the current working directory contains the relevant codebase\n';
            prompt += '2. If not, search for the project by listing directories under ~/Documents, ~/Projects, ~/repos, or ~/Desktop\n';
            prompt += '3. Look for directory names that match the JIRA project name, key, or related repository\n';
            prompt += '4. Use `ls` and `find` to locate the right project, then `cd` into it before starting work\n';
            prompt += '5. If you cannot find the project, proceed with the task in the current directory and note this in your completion summary\n';
          }

          // Add attachments section if there are any
          if (task.attachments && task.attachments.length > 0) {
            prompt += '\n\n## Reference Files\n';
            prompt += 'The following files are attached for reference. Please read/view them to understand the context:\n\n';
            for (const attachment of task.attachments) {
              prompt += `- ${attachment.name}: \`${attachment.path}\`\n`;
            }
          }

          // Add task completion instructions
          prompt += '\n\n## Task Completion\n';
          prompt += `**Task ID:** \`${task.id}\`\n\n`;
          prompt += `**IMPORTANT:** When you have completed this task, you MUST call the \`mark_task_done\` MCP tool with:\n`;
          prompt += `- \`task_id\`: \`${task.id}\`\n`;
          prompt += `- \`summary\`: A brief 1-3 sentence summary of what you accomplished\n\n`;
          prompt += `This will move the task to the "Done" column on the kanban board.`;

          // Start the agent with kanban task ID for hook-based completion
          await deps.startAgent(agentId, prompt, task.id);

          console.log(`Agent ${agentId} started for task "${task.title}" (kanban task: ${task.id})`);
        } catch (automationErr) {
          console.error('Automation error:', automationErr);
          // Task stays in planned if automation fails
          task.column = 'planned';
        }
      }

      saveTasks(tasks);
      emitTaskEvent('kanban:task-updated', task);

      return {
        success: true,
        task,
        agentSpawned,
        agentId,
      };
    } catch (err) {
      console.error('Error moving kanban task:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to move task' };
    }
  });

  // Delete a task (stops agent if ongoing)
  ipcMain.handle('kanban:delete', async (_event, id: string) => {
    try {
      const tasks = loadTasks();
      const index = tasks.findIndex(t => t.id === id);

      if (index === -1) {
        return { success: false, error: 'Task not found' };
      }

      const [deletedTask] = tasks.splice(index, 1);

      // Stop the agent if task was in progress
      if (deletedTask.assignedAgentId && deletedTask.column === 'ongoing' && deps) {
        console.log(`Stopping agent ${deletedTask.assignedAgentId} for deleted task "${deletedTask.title}"`);
        try {
          await deps.stopAgent(deletedTask.assignedAgentId);
        } catch (stopErr) {
          console.error('Failed to stop agent:', stopErr);
          // Continue with deletion even if stop fails
        }
      }

      saveTasks(tasks);

      deps?.getMainWindow()?.webContents.send('kanban:task-deleted', { id });

      return { success: true };
    } catch (err) {
      console.error('Error deleting kanban task:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to delete task' };
    }
  });

  // Reorder tasks within a column
  ipcMain.handle('kanban:reorder', async (_event, params: { taskIds: string[]; column: KanbanColumn }) => {
    try {
      const tasks = loadTasks();

      // Update order for each task in the array
      params.taskIds.forEach((taskId, index) => {
        const task = tasks.find(t => t.id === taskId);
        if (task && task.column === params.column) {
          task.order = index;
          task.updatedAt = new Date().toISOString();
        }
      });

      saveTasks(tasks);

      // Emit update for all affected tasks
      params.taskIds.forEach(taskId => {
        const task = tasks.find(t => t.id === taskId);
        if (task) {
          emitTaskEvent('kanban:task-updated', task);
        }
      });

      return { success: true };
    } catch (err) {
      console.error('Error reordering kanban tasks:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to reorder tasks' };
    }
  });

  // Generate task details from natural language prompt using Claude CLI
  ipcMain.handle('kanban:generate', async (_event, params: { prompt: string; availableProjects: Array<{ path: string; name: string }> }) => {
    const { prompt, availableProjects } = params;

    if (!prompt) {
      return { success: false, error: 'prompt is required' };
    }

    const task = await generateTaskFromPrompt(prompt, availableProjects);
    return { success: true, task };
  });

  // Get a single task by ID
  ipcMain.handle('kanban:get', async (_event, id: string) => {
    try {
      const tasks = loadTasks();
      const task = tasks.find(t => t.id === id);

      if (!task) {
        return { success: false, error: 'Task not found' };
      }

      return { success: true, task };
    } catch (err) {
      console.error('Error getting kanban task:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to get task' };
    }
  });
}

// Export for direct use in automation service
export { loadTasks, saveTasks, emitTaskEvent };
export type { KanbanTask, KanbanColumn };
