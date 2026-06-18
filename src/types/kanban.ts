/**
 * Kanban Board Types
 *
 * Task management with automatic agent spawning when tasks move to "planned" column.
 */

export type KanbanColumn = 'backlog' | 'planned' | 'ongoing' | 'done';

export interface TaskAttachment {
  path: string;                  // Full file path
  name: string;                  // Display name (filename)
  type: 'image' | 'pdf' | 'document' | 'other';
  size?: number;                 // File size in bytes
}

export interface KanbanTask {
  id: string;
  title: string;
  description: string;
  column: KanbanColumn;
  projectId: string;
  projectPath: string;           // For agent spawning
  assignedAgentId: string | null;
  agentCreatedForTask: boolean;  // If true, delete agent when task completes
  requiredSkills: string[];      // For agent matching
  priority: 'low' | 'medium' | 'high';
  progress: number;              // 0-100, synced from agent
  createdAt: string;
  updatedAt: string;
  completedAt?: string;          // When task was marked done
  order: number;                 // Position in column
  labels: string[];
  completionSummary?: string;    // Summary of what was done by the agent
  attachments: TaskAttachment[]; // Files attached to the task
  // Phase 6-AT2 — 실제 단계 이동 이력(담당/컬럼 변화 시 PM-tick 이 적재). 추정 아님.
  stageHistory?: StageEntry[];
  // Phase 6-BJ — 워크플로우 체크리스트(자동 작성 + 수동 편집). auto 항목은 단계/상태에서 done 파생.
  checklist?: ChecklistItem[];
}

export interface StageEntry {
  at: string;                    // ISO 기록 시각
  agentId: string | null;        // 그 시점 담당(=단계)
  column: string;                // 그 시점 컬럼
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  auto?: boolean;                // true = 워크플로우에서 자동 파생(사용자 체크와 구분)
}

export interface KanbanTaskCreate {
  title: string;
  description: string;
  projectId: string;
  projectPath: string;
  requiredSkills?: string[];
  priority?: 'low' | 'medium' | 'high';
  labels?: string[];
  attachments?: TaskAttachment[];
}

export interface KanbanTaskUpdate {
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

export interface KanbanMoveResult {
  success: boolean;
  task?: KanbanTask;
  agentSpawned?: boolean;
  agentId?: string;
  error?: string;
}

export const COLUMN_CONFIG: Record<KanbanColumn, { title: string; description: string; color: string }> = {
  backlog: {
    title: 'Backlog',
    description: 'Tasks waiting to be planned',
    color: 'gray',
  },
  planned: {
    title: 'Planned',
    description: 'Ready for agent assignment',
    color: 'blue',
  },
  ongoing: {
    title: 'Ongoing',
    description: 'Agent is working on it',
    color: 'amber',
  },
  done: {
    title: 'Done',
    description: 'Completed tasks',
    color: 'green',
  },
};

export const COLUMN_ORDER: KanbanColumn[] = ['backlog', 'planned', 'ongoing', 'done'];
