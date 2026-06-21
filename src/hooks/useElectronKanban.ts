'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import type { KanbanTask, KanbanColumn, KanbanTaskCreate, KanbanTaskUpdate, KanbanMoveResult } from '@/types/kanban';
import { isElectron } from './useElectron';

// 칸반 자동 반영 폴링 간격(ms). 외부 편집(파일/DB·다른 에이전트)을 이 주기로 흡수.
const KANBAN_POLL_MS = 8000;

// 표시에 영향을 주는 필드만 비교 — 같으면 state 교체를 건너뛴다(리렌더·드래그 방해 방지).
function sameTasks(a: KanbanTask[], b: KanbanTask[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const key = (t: KanbanTask) =>
    `${t.id}|${t.column}|${t.order}|${t.title}|${t.description}|${t.priority}|${t.progress}|${t.assignedAgentId ?? ''}|${(t.labels || []).join(',')}|${t.completionSummary ?? ''}`;
  // order 무관 비교를 위해 id 기준 정렬 후 직렬화
  const sa = a.map(key).sort().join('\n');
  const sb = b.map(key).sort().join('\n');
  return sa === sb;
}

/**
 * Hook for Kanban board management via Electron IPC
 */
export function useElectronKanban() {
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ★자동 반영(폴링)용 — 외부(파일/DB 직접 편집·다른 에이전트)에 의한 변경을 주기적으로 흡수.
  //   변경이 있을 때만 state 를 교체해 불필요한 리렌더·드래그 방해를 막는다(아래 sameTasks).
  const setTasksIfChanged = useCallback((next: KanbanTask[]) => {
    setTasks(prev => (sameTasks(prev, next) ? prev : next));
  }, []);

  // Fetch all tasks
  const fetchTasks = useCallback(async () => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      // Web fallback: read-only display via API route(:3500 → hermes DB).
      try {
        const res = await fetch('/api/dorothy/kanban');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            setTasksIfChanged(data as KanbanTask[]);
            setError(null);
          }
        }
      } catch (err) {
        console.error('Failed to fetch kanban from web fallback:', err);
      }
      setIsLoading(false);
      return;
    }

    try {
      const result = await window.electronAPI.kanban.list();
      if (result.error) {
        setError(result.error);
      } else {
        setTasksIfChanged(result.tasks as KanbanTask[]);
        setError(null);
      }
    } catch (err) {
      console.error('Failed to fetch kanban tasks:', err);
      setError('Failed to fetch tasks');
    } finally {
      setIsLoading(false);
    }
  }, [setTasksIfChanged]);

  // Create a new task
  // Note: State is updated via onTaskCreated event to avoid duplicates
  const createTask = useCallback(async (params: KanbanTaskCreate) => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      // Web mode is read-only. Open the Dorothy Electron app to edit Kanban tasks.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. 카드 이동·생성·삭제는 Electron 창에서 진행해 주세요.');
    }

    const result = await window.electronAPI.kanban.create(params);
    return result;
  }, []);

  // Update a task
  // Note: State is updated via onTaskUpdated event
  const updateTask = useCallback(async (params: KanbanTaskUpdate) => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      // Web mode is read-only. Open the Dorothy Electron app to edit Kanban tasks.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. 카드 이동·생성·삭제는 Electron 창에서 진행해 주세요.');
    }

    const result = await window.electronAPI.kanban.update(params);
    return result;
  }, []);

  // Move a task to a different column
  // Note: State is updated via onTaskUpdated event
  const moveTask = useCallback(async (
    id: string,
    column: KanbanColumn,
    order?: number
  ): Promise<KanbanMoveResult> => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      // Web mode is read-only. Open the Dorothy Electron app to edit Kanban tasks.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. 카드 이동·생성·삭제는 Electron 창에서 진행해 주세요.');
    }

    const result = await window.electronAPI.kanban.move({ id, column, order });
    return result as KanbanMoveResult;
  }, []);

  // Delete a task
  // Note: State is updated via onTaskDeleted event
  const deleteTask = useCallback(async (id: string) => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      // Web mode is read-only. Open the Dorothy Electron app to edit Kanban tasks.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. 카드 이동·생성·삭제는 Electron 창에서 진행해 주세요.');
    }

    const result = await window.electronAPI.kanban.delete(id);
    return result;
  }, []);

  // Reorder tasks within a column
  // Note: State is updated via onTaskUpdated events
  const reorderTasks = useCallback(async (taskIds: string[], column: KanbanColumn) => {
    if (!isElectron() || !window.electronAPI?.kanban) {
      // Web mode is read-only. Open the Dorothy Electron app to edit Kanban tasks.
      throw new Error('이 작업은 Dorothy 데스크톱 앱(Electron)에서만 동작합니다. 카드 이동·생성·삭제는 Electron 창에서 진행해 주세요.');
    }

    const result = await window.electronAPI.kanban.reorder({ taskIds, column });
    return result;
  }, []);

  // Get tasks by column
  const getTasksByColumn = useCallback((column: KanbanColumn): KanbanTask[] => {
    return tasks
      .filter(t => t.column === column)
      .sort((a, b) => a.order - b.order);
  }, [tasks]);

  // Subscribe to real-time events
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.kanban) return;

    const unsubCreated = window.electronAPI.kanban.onTaskCreated((task) => {
      setTasks(prev => {
        // Check if task already exists (might have been added by our own action)
        if (prev.some(t => t.id === task.id)) {
          return prev;
        }
        return [...prev, task as KanbanTask];
      });
    });

    const unsubUpdated = window.electronAPI.kanban.onTaskUpdated((task) => {
      setTasks(prev => prev.map(t => t.id === task.id ? task as KanbanTask : t));
    });

    const unsubDeleted = window.electronAPI.kanban.onTaskDeleted((event: { id: string }) => {
      setTasks(prev => prev.filter(t => t.id !== event.id));
    });

    return () => {
      unsubCreated();
      unsubUpdated();
      unsubDeleted();
    };
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // ★자동 반영: 주기적 폴링 + 탭 포커스/가시화 시 즉시 갱신.
  //   변경이 있을 때만 state 교체(sameTasks)라 외부 편집(파일/DB·다른 에이전트)이 자동 반영된다.
  //   숨겨진 탭에서는 폴링을 건너뛰어 낭비를 줄인다.
  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchTasks();
    };
    const interval = setInterval(tick, KANBAN_POLL_MS);
    const onFocus = () => fetchTasks();
    const onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden) fetchTasks();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchTasks]);

  return {
    tasks,
    isLoading,
    error,
    isElectron: isElectron(),
    createTask,
    updateTask,
    moveTask,
    deleteTask,
    reorderTasks,
    getTasksByColumn,
    refresh: fetchTasks,
  };
}

/**
 * Hook to sync agent events with kanban tasks
 * Updates task progress and moves to "done" when agent completes
 */
export function useKanbanAgentSync(
  tasks: KanbanTask[],
  updateTask: (params: KanbanTaskUpdate) => Promise<unknown>,
  moveTask: (id: string, column: KanbanColumn) => Promise<unknown>
) {
  // Use ref to always have latest tasks without re-subscribing
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const updateTaskRef = useRef(updateTask);
  updateTaskRef.current = updateTask;

  const moveTaskRef = useRef(moveTask);
  moveTaskRef.current = moveTask;

  useEffect(() => {
    if (!isElectron()) return;

    console.log('[Kanban Sync] Setting up agent event listeners');

    // Listen to agent status changes - only for progress updates, NOT for completion
    // The detectAgentStatus patterns are too broad and trigger false "completed" states
    const unsubStatus = window.electronAPI?.agent.onStatus?.((event: {
      agentId: string;
      status: string;
      timestamp: string;
    }) => {
      // Find task assigned to this agent
      const task = tasksRef.current.find(t => t.assignedAgentId === event.agentId);
      if (!task || task.column !== 'ongoing') return;

      // Only update progress for running status, NOT for completion
      // Completion is handled by onComplete (PTY exit) which is more reliable
      if (event.status === 'running' && task.progress < 50) {
        updateTaskRef.current({ id: task.id, progress: 50 });
      }
    });

    // onComplete fires when PTY actually exits - this is the reliable completion signal
    const unsubComplete = window.electronAPI?.agent.onComplete(async (event) => {
      console.log(`[Kanban Sync] Received complete event:`, event);

      const task = tasksRef.current.find(t => t.assignedAgentId === event.agentId);
      if (!task) {
        console.log(`[Kanban Sync] No task found for agent ${event.agentId}`);
        return;
      }

      console.log(`[Kanban Sync] Agent ${event.agentId} completed with exit code: ${event.exitCode} for task "${task.title}"`);

      if (task.column === 'ongoing') {
        const isSuccess = event.exitCode === 0;
        console.log(`[Kanban Sync] Moving task ${task.id} to done (success: ${isSuccess})`);

        // Get agent output for completion summary
        let completionSummary = isSuccess ? 'Task completed successfully.' : 'Task completed with errors.';
        try {
          const agent = await window.electronAPI?.agent.get(event.agentId);
          if (agent?.output && agent.output.length > 0) {
            // Get last 50 lines of output as summary (or less if not available)
            const outputLines = agent.output.slice(-50);
            completionSummary = outputLines.join('');
          }
        } catch (err) {
          console.error('[Kanban Sync] Failed to get agent output:', err);
        }

        updateTaskRef.current({ id: task.id, progress: 100, completionSummary });
        moveTaskRef.current(task.id, 'done');
      }
    });

    return () => {
      unsubStatus?.();
      unsubComplete?.();
    };
  }, []); // Empty deps - we use refs to avoid re-subscribing
}
