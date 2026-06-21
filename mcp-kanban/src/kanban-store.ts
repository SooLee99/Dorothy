/**
 * mcp-kanban — Kanban store backed by the hermes durable task board.
 *
 * ★단일 소스(근본): 칸반 데이터는 hermes `~/.hermes/kanban.db`(SQLite) `tasks` 테이블에 산다.
 *   대시보드(electron/services/kanban-store.ts)·슬랙·hermes CLI 와 ★같은 테이블/같은 진실 공유.
 *   매핑/스키마는 electron/services/kanban-store.ts 와 동일 계약(드라이버만 node:sqlite).
 *
 * 런타임: mcp-kanban 은 system `node`(>=22) 로 실행 → 내장 node:sqlite 사용(네이티브 의존 0).
 */
import { DatabaseSync } from "node:sqlite";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

export type KanbanColumn = "backlog" | "planned" | "ongoing" | "done";

export interface KanbanTask {
  id: string;
  title: string;
  description: string;
  column: KanbanColumn;
  projectId: string;
  projectPath: string;
  assignedAgentId: string | null;
  requiredSkills: string[];
  priority: "low" | "medium" | "high";
  progress: number;
  createdAt: string;
  updatedAt: string;
  order: number;
  labels: string[];
  completionSummary?: string;
}

function dbFile(): string {
  return path.join(os.homedir(), ".hermes", "kanban.db");
}

const DORO_COLS: Array<[string, string]> = [
  ["dorothy_managed", "INTEGER"],
  ["dorothy_column", "TEXT"],
  ["dorothy_order", "INTEGER"],
  ["dorothy_project_id", "TEXT"],
  ["dorothy_project_path", "TEXT"],
  ["dorothy_progress", "INTEGER"],
  ["dorothy_priority", "TEXT"],
  ["dorothy_assigned_agent_id", "TEXT"],
  ["dorothy_agent_created", "INTEGER"],
  ["dorothy_required_skills", "TEXT"],
  ["dorothy_labels", "TEXT"],
  ["dorothy_attachments", "TEXT"],
  ["dorothy_completion_summary", "TEXT"],
  ["dorothy_completed_at", "TEXT"],
  ["dorothy_updated_at", "TEXT"],
];

function open(): DatabaseSync {
  const dir = path.dirname(dbFile());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbFile());
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT,
    status TEXT NOT NULL DEFAULT 'ready', priority INTEGER DEFAULT 100, created_by TEXT,
    created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
    workspace_kind TEXT NOT NULL DEFAULT 'scratch', workspace_path TEXT,
    spawn_failures INTEGER NOT NULL DEFAULT 0
  )`);
  const have = new Set(
    (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((r) => r.name),
  );
  for (const [name, type] of DORO_COLS) {
    if (!have.has(name)) {
      try {
        db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
      } catch {
        /* 동시성으로 이미 추가됨 → 무시 */
      }
    }
  }
  return db;
}

const statusToColumn = (s: string): KanbanColumn =>
  s === "done" ? "done" : s === "in_progress" ? "ongoing" : s === "todo" ? "planned" : "backlog";
const columnToStatus = (c: KanbanColumn): string =>
  c === "done" ? "done" : c === "ongoing" ? "in_progress" : c === "planned" ? "todo" : "ready";
const intToPriority = (n: number | null): "low" | "medium" | "high" =>
  n != null && n <= 50 ? "high" : n != null && n >= 150 ? "low" : "medium";
const priorityToInt = (p: string): number => (p === "high" ? 50 : p === "low" ? 150 : 100);
function jparse<T>(s: unknown, d: T): T {
  try {
    return typeof s === "string" && s ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
}

function rowToTask(r: Record<string, unknown>): KanbanTask {
  const status = String(r.status ?? "ready");
  const createdIso = new Date((Number(r.created_at) || 0) * 1000).toISOString();
  return {
    id: String(r.id),
    title: String(r.title ?? ""),
    description: String(r.body ?? ""),
    column: (r.dorothy_column as KanbanColumn) || statusToColumn(status),
    projectId: (r.dorothy_project_id as string) || "",
    projectPath:
      (r.dorothy_project_path as string) ||
      (r.workspace_kind === "dir" ? (r.workspace_path as string) || "" : ""),
    assignedAgentId: (r.dorothy_assigned_agent_id as string) || null,
    requiredSkills: jparse(r.dorothy_required_skills, [] as string[]),
    priority: (r.dorothy_priority as "low" | "medium" | "high") || intToPriority(r.priority as number | null),
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
    db = open();
    const rows = db
      .prepare(
        "SELECT * FROM tasks WHERE status != 'archived' ORDER BY COALESCE(dorothy_order, 999999) ASC, created_at ASC",
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToTask);
  } catch (e) {
    console.error("[mcp-kanban store] loadTasks failed:", e instanceof Error ? e.message : e);
    return [];
  } finally {
    db?.close();
  }
}

export function saveTasks(tasks: KanbanTask[]): void {
  let db: DatabaseSync | null = null;
  try {
    db = open();
    const upsert = db.prepare(UPSERT_SQL);
    db.prepare("BEGIN").run();
    try {
      const keep = new Set<string>();
      const now = new Date().toISOString();
      for (const t of tasks) {
        keep.add(t.id);
        upsert.run(
          t.id,
          t.title || "",
          t.description || "",
          columnToStatus(t.column),
          priorityToInt(t.priority || "medium"),
          Math.floor(new Date(t.createdAt || now).getTime() / 1000),
          t.column,
          t.order ?? 0,
          t.projectId || "",
          t.projectPath || "",
          t.progress ?? 0,
          t.priority || "medium",
          t.assignedAgentId || null,
          0,
          JSON.stringify(t.requiredSkills || []),
          JSON.stringify(t.labels || []),
          JSON.stringify([]),
          t.completionSummary || null,
          null,
          t.updatedAt || now,
        );
      }
      const managed = db
        .prepare("SELECT id FROM tasks WHERE dorothy_managed=1 AND status != 'archived'")
        .all() as Array<{ id: string }>;
      const archive = db.prepare("UPDATE tasks SET status='archived', dorothy_updated_at=? WHERE id=?");
      for (const { id } of managed) {
        if (!keep.has(id)) archive.run(now, id);
      }
      db.prepare("COMMIT").run();
    } catch (e) {
      db.prepare("ROLLBACK").run();
      throw e;
    }
  } catch (e) {
    console.error("[mcp-kanban store] saveTasks failed:", e instanceof Error ? e.message : e);
  } finally {
    db?.close();
  }
}
