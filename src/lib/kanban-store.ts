/**
 * Next 서버(웹 API) 용 Kanban store — ★단일 소스 hermes SQLite(~/.hermes/kanban.db).
 *
 * electron/services/kanban-store.ts · mcp-kanban/src/kanban-store.ts 와 ★동일 DB/스키마 계약.
 * Next route handler 는 system node(>=22) Node 런타임에서 실행 → 내장 node:sqlite 사용.
 * (이 파일을 쓰는 route 들은 `export const runtime = 'nodejs'` 이어야 한다.)
 */
import { DatabaseSync } from 'node:sqlite';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export type KanbanColumn = 'backlog' | 'planned' | 'ongoing' | 'done';

export interface KanbanTask {
  id: string;
  title: string;
  description: string;
  column: KanbanColumn;
  projectId: string;
  projectPath: string;
  assignedAgentId: string | null;
  requiredSkills: string[];
  priority: 'low' | 'medium' | 'high';
  progress: number;
  createdAt: string;
  updatedAt: string;
  order: number;
  labels: string[];
  completionSummary?: string;
  // 호출측이 추가 필드를 실어도 보존되지 않지만 타입상 허용.
  [k: string]: unknown;
}

function dbFile(): string {
  return path.join(os.homedir(), '.hermes', 'kanban.db');
}

const DORO_COLS: Array<[string, string]> = [
  ['dorothy_managed', 'INTEGER'], ['dorothy_column', 'TEXT'], ['dorothy_order', 'INTEGER'],
  ['dorothy_project_id', 'TEXT'], ['dorothy_project_path', 'TEXT'], ['dorothy_progress', 'INTEGER'],
  ['dorothy_priority', 'TEXT'], ['dorothy_assigned_agent_id', 'TEXT'], ['dorothy_agent_created', 'INTEGER'],
  ['dorothy_required_skills', 'TEXT'], ['dorothy_labels', 'TEXT'], ['dorothy_attachments', 'TEXT'],
  ['dorothy_completion_summary', 'TEXT'], ['dorothy_completed_at', 'TEXT'], ['dorothy_updated_at', 'TEXT'],
];

function open(readOnly = false): DatabaseSync {
  const dir = path.dirname(dbFile());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbFile(), readOnly ? { readOnly: true } : undefined);
  if (!readOnly) {
    db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT,
      status TEXT NOT NULL DEFAULT 'ready', priority INTEGER DEFAULT 100, created_by TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
      workspace_kind TEXT NOT NULL DEFAULT 'scratch', workspace_path TEXT,
      spawn_failures INTEGER NOT NULL DEFAULT 0
    )`);
    const have = new Set(
      (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(r => r.name),
    );
    for (const [name, type] of DORO_COLS) {
      if (!have.has(name)) {
        try { db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`); } catch { /* 이미 추가됨 */ }
      }
    }
  }
  return db;
}

const statusToColumn = (s: string): KanbanColumn =>
  s === 'done' ? 'done' : s === 'in_progress' ? 'ongoing' : s === 'todo' ? 'planned' : 'backlog';
const columnToStatus = (c: KanbanColumn): string =>
  c === 'done' ? 'done' : c === 'ongoing' ? 'in_progress' : c === 'planned' ? 'todo' : 'ready';
const intToPriority = (n: number | null): 'low' | 'medium' | 'high' =>
  n != null && n <= 50 ? 'high' : n != null && n >= 150 ? 'low' : 'medium';
const priorityToInt = (p: string): number => (p === 'high' ? 50 : p === 'low' ? 150 : 100);
function jparse<T>(s: unknown, d: T): T {
  try { return typeof s === 'string' && s ? (JSON.parse(s) as T) : d; } catch { return d; }
}

function rowToTask(r: Record<string, unknown>): KanbanTask {
  const status = String(r.status ?? 'ready');
  const createdIso = new Date((Number(r.created_at) || 0) * 1000).toISOString();
  return {
    id: String(r.id),
    title: String(r.title ?? ''),
    description: String(r.body ?? ''),
    column: (r.dorothy_column as KanbanColumn) || statusToColumn(status),
    projectId: (r.dorothy_project_id as string) || '',
    projectPath:
      (r.dorothy_project_path as string) ||
      (r.workspace_kind === 'dir' ? (r.workspace_path as string) || '' : ''),
    assignedAgentId: (r.dorothy_assigned_agent_id as string) || null,
    requiredSkills: jparse(r.dorothy_required_skills, [] as string[]),
    priority: (r.dorothy_priority as 'low' | 'medium' | 'high') || intToPriority(r.priority as number | null),
    progress: (r.dorothy_progress as number) ?? 0,
    createdAt: createdIso,
    updatedAt: (r.dorothy_updated_at as string) || createdIso,
    order: (r.dorothy_order as number) ?? 0,
    labels: jparse(r.dorothy_labels, [] as string[]),
    completionSummary: (r.dorothy_completion_summary as string) || undefined,
  };
}

const UPSERT_SQL = `
  INSERT INTO tasks (id, title, body, status, priority, created_at, workspace_kind,
    dorothy_managed, dorothy_column, dorothy_order, dorothy_project_id, dorothy_project_path,
    dorothy_progress, dorothy_priority, dorothy_assigned_agent_id, dorothy_agent_created,
    dorothy_required_skills, dorothy_labels, dorothy_attachments, dorothy_completion_summary,
    dorothy_completed_at, dorothy_updated_at)
  VALUES (?,?,?,?,?,?, 'scratch', 1, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title, body=excluded.body, status=excluded.status, priority=excluded.priority,
    dorothy_managed=1, dorothy_column=excluded.dorothy_column, dorothy_order=excluded.dorothy_order,
    dorothy_project_id=excluded.dorothy_project_id, dorothy_project_path=excluded.dorothy_project_path,
    dorothy_progress=excluded.dorothy_progress, dorothy_priority=excluded.dorothy_priority,
    dorothy_assigned_agent_id=excluded.dorothy_assigned_agent_id, dorothy_agent_created=excluded.dorothy_agent_created,
    dorothy_required_skills=excluded.dorothy_required_skills, dorothy_labels=excluded.dorothy_labels,
    dorothy_attachments=excluded.dorothy_attachments, dorothy_completion_summary=excluded.dorothy_completion_summary,
    dorothy_completed_at=excluded.dorothy_completed_at, dorothy_updated_at=excluded.dorothy_updated_at
`;

export function loadTasks(): KanbanTask[] {
  let db: DatabaseSync | null = null;
  try {
    db = open(true);
    const rows = db
      .prepare(
        "SELECT * FROM tasks WHERE status != 'archived' ORDER BY COALESCE(dorothy_order, 999999) ASC, created_at ASC",
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToTask);
  } catch (e) {
    console.error('[web kanban store] loadTasks failed:', e instanceof Error ? e.message : e);
    return [];
  } finally {
    db?.close();
  }
}

/** 전체 desired state 반영(load→mutate→save). dorothy_managed=1 인데 배열에 없는 행은 soft-delete. */
export function saveTasks(tasks: Array<Record<string, unknown>>): void {
  let db: DatabaseSync | null = null;
  try {
    db = open(false);
    const upsert = db.prepare(UPSERT_SQL);
    db.prepare('BEGIN').run();
    try {
      const keep = new Set<string>();
      const now = new Date().toISOString();
      for (const tt of tasks) {
        const t = tt as Partial<KanbanTask> & Record<string, unknown>;
        const id = String(t.id);
        const column = (t.column as KanbanColumn) || 'backlog';
        keep.add(id);
        upsert.run(
          id,
          String(t.title ?? ''),
          String(t.description ?? ''),
          columnToStatus(column),
          priorityToInt((t.priority as string) || 'medium'),
          Math.floor(new Date((t.createdAt as string) || now).getTime() / 1000),
          column,
          (t.order as number) ?? 0,
          (t.projectId as string) || '',
          (t.projectPath as string) || '',
          (t.progress as number) ?? 0,
          (t.priority as string) || 'medium',
          (t.assignedAgentId as string) || null,
          t.agentCreatedForTask ? 1 : 0,
          JSON.stringify(t.requiredSkills || []),
          JSON.stringify(t.labels || []),
          JSON.stringify(t.attachments || []),
          (t.completionSummary as string) || null,
          (t.completedAt as string) || null,
          (t.updatedAt as string) || now,
        );
      }
      const managed = db
        .prepare("SELECT id FROM tasks WHERE dorothy_managed=1 AND status != 'archived'")
        .all() as Array<{ id: string }>;
      const archive = db.prepare("UPDATE tasks SET status='archived', dorothy_updated_at=? WHERE id=?");
      for (const { id } of managed) {
        if (!keep.has(id)) archive.run(now, id);
      }
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
  } catch (e) {
    console.error('[web kanban store] saveTasks failed:', e instanceof Error ? e.message : e);
  } finally {
    db?.close();
  }
}
