/**
 * Dorothy — Kanban store backed by the hermes durable task board.
 *
 * ★단일 소스(근본): 칸반 데이터는 이제 hermes 의 `~/.hermes/kanban.db`(SQLite)
 *   `tasks` 테이블에 산다. 기존 `~/.dorothy/kanban-tasks.json` 은 폐기(마이그레이션 후).
 *   이렇게 해서 대시보드·슬랙·MCP·hermes CLI 가 ★같은 테이블/같은 진실을 공유한다.
 *
 * 설계 요지
 *  - hermes 의 `tasks` 테이블을 그대로 재사용하고, 대시보드 표현 전용 필드는
 *    nullable `dorothy_*` 컬럼으로 ADD COLUMN(멱등) 한다 → hermes 실행 메타(runs/
 *    links/locks/assignee/workspace)는 절대 건드리지 않음.
 *  - column 의 진실은 `dorothy_column`(있으면). 없으면 hermes `status` 에서 파생.
 *  - 드라이버 적응: Electron(런타임 ABI 일치) 은 better-sqlite3, 그 외(Node>=22:
 *    vitest/mcp/Next) 는 내장 node:sqlite. 두 드라이버 모두 prepare/get/all/run 동기 API.
 *  - 안전성: DB 접근 실패 시 throw 하지 않고 빈 배열/ no-op 으로 graceful degrade.
 *
 * 주의(문서화된 한계)
 *  - saveTasks(tasks[]) 는 load→mutate→save 패턴 전제. dorothy_managed=1 인데 배열에
 *    없는 행은 soft-delete(status='archived'). hermes-native 행은 자동 삭제하지 않는다.
 *  - upsert 시 status = columnToStatus(column) 로 동기화(대시보드 보드가 진실). 따라서
 *    대시보드에서 손댄 hermes 카드는 status 가 보드 컬럼에 맞춰진다.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

export type KanbanColumn = 'backlog' | 'planned' | 'ongoing' | 'done';

export interface TaskAttachment {
  path: string;
  name: string;
  type: 'image' | 'pdf' | 'document' | 'other';
  size?: number;
}

export interface KanbanTask {
  id: string;
  title: string;
  description: string;
  column: KanbanColumn;
  projectId: string;
  projectPath: string;
  assignedAgentId: string | null;
  agentCreatedForTask: boolean;
  requiredSkills: string[];
  priority: 'low' | 'medium' | 'high';
  progress: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  order: number;
  labels: string[];
  completionSummary?: string;
  attachments: TaskAttachment[];
}

// ── DB 위치: hermes 단일 소스. (os.homedir 은 테스트에서 모킹됨) ──
function dbFile(): string {
  return path.join(os.homedir(), '.hermes', 'kanban.db');
}

// ── 최소 드라이버 추상화(better-sqlite3 ↔ node:sqlite) ──
interface Stmt {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): void;
}
interface DB {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
}

function openDb(file: string): DB | null {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Electron 런타임은 better-sqlite3(ABI 일치), 그 외(Node>=22)는 node:sqlite.
    const useBetter = !!(process.versions as Record<string, string>).electron;
    if (useBetter) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const BetterSqlite3 = require('better-sqlite3');
      const db = new BetterSqlite3(file);
      return {
        prepare: (sql: string) => db.prepare(sql) as Stmt,
        exec: (sql: string) => db.exec(sql),
        close: () => db.close(),
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    return {
      prepare: (sql: string) => {
        const st = db.prepare(sql);
        return {
          all: (...p: unknown[]) => st.all(...p) as Record<string, unknown>[],
          get: (...p: unknown[]) => st.get(...p) as Record<string, unknown> | undefined,
          run: (...p: unknown[]) => st.run(...p),
        };
      },
      exec: (sql: string) => db.exec(sql),
      close: () => db.close(),
    };
  } catch (e) {
    console.error('[kanban-store] openDb failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

const DORO_COLS: Array<[string, string]> = [
  ['dorothy_managed', 'INTEGER'],
  ['dorothy_column', 'TEXT'],
  ['dorothy_order', 'INTEGER'],
  ['dorothy_project_id', 'TEXT'],
  ['dorothy_project_path', 'TEXT'],
  ['dorothy_progress', 'INTEGER'],
  ['dorothy_priority', 'TEXT'],
  ['dorothy_assigned_agent_id', 'TEXT'],
  ['dorothy_agent_created', 'INTEGER'],
  ['dorothy_required_skills', 'TEXT'],
  ['dorothy_labels', 'TEXT'],
  ['dorothy_attachments', 'TEXT'],
  ['dorothy_completion_summary', 'TEXT'],
  ['dorothy_completed_at', 'TEXT'],
  ['dorothy_updated_at', 'TEXT'],
];

// hermes 가 없을 때(테스트/신규 머신) 자체적으로 동작하도록 tasks 테이블을 보장.
// hermes 가 이미 만든 테이블이면 CREATE IF NOT EXISTS 는 no-op, 이후 ADD COLUMN 만 적용.
function ensureSchema(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT,
    assignee TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    priority INTEGER DEFAULT 100,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    workspace_kind TEXT NOT NULL DEFAULT 'scratch',
    workspace_path TEXT,
    spawn_failures INTEGER NOT NULL DEFAULT 0
  )`);
  const have = new Set((db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(r => r.name));
  for (const [name, type] of DORO_COLS) {
    if (!have.has(name)) {
      try {
        db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
      } catch {
        /* 동시성으로 이미 추가된 경우 무시 */
      }
    }
  }
}

// ── 매핑 ──
function statusToColumn(s: string): KanbanColumn {
  return s === 'done' ? 'done' : s === 'in_progress' ? 'ongoing' : s === 'todo' ? 'planned' : 'backlog';
}
function columnToStatus(c: KanbanColumn): string {
  return c === 'done' ? 'done' : c === 'ongoing' ? 'in_progress' : c === 'planned' ? 'todo' : 'ready';
}
function intToPriority(n: number | null): 'low' | 'medium' | 'high' {
  if (n != null && n <= 50) return 'high';
  if (n != null && n >= 150) return 'low';
  return 'medium';
}
function priorityToInt(p: string): number {
  return p === 'high' ? 50 : p === 'low' ? 150 : 100;
}
function jparse<T>(s: unknown, d: T): T {
  try {
    return typeof s === 'string' && s ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
}
function toIso(unixSeconds: unknown): string {
  const n = typeof unixSeconds === 'number' ? unixSeconds : 0;
  return new Date(n * 1000).toISOString();
}

function rowToTask(r: Record<string, unknown>): KanbanTask {
  const status = String(r.status ?? 'ready');
  const column = (r.dorothy_column as KanbanColumn) || statusToColumn(status);
  const createdIso = toIso(r.created_at);
  return {
    id: String(r.id),
    title: String(r.title ?? ''),
    description: String(r.body ?? ''),
    column,
    projectId: (r.dorothy_project_id as string) || '',
    projectPath:
      (r.dorothy_project_path as string) ||
      (r.workspace_kind === 'dir' ? (r.workspace_path as string) || '' : ''),
    assignedAgentId: (r.dorothy_assigned_agent_id as string) || null,
    agentCreatedForTask: !!r.dorothy_agent_created,
    requiredSkills: jparse(r.dorothy_required_skills, [] as string[]),
    priority: (r.dorothy_priority as 'low' | 'medium' | 'high') || intToPriority(r.priority as number | null),
    progress: (r.dorothy_progress as number) ?? 0,
    createdAt: createdIso,
    updatedAt: (r.dorothy_updated_at as string) || createdIso,
    completedAt:
      (r.dorothy_completed_at as string) ||
      (typeof r.completed_at === 'number' ? toIso(r.completed_at) : undefined),
    order: (r.dorothy_order as number) ?? 0,
    labels: jparse(r.dorothy_labels, [] as string[]),
    completionSummary: (r.dorothy_completion_summary as string) || undefined,
    attachments: jparse(r.dorothy_attachments, [] as TaskAttachment[]),
  };
}

const UPSERT_SQL = `
  INSERT INTO tasks (id, title, body, status, priority, created_at, workspace_kind,
    dorothy_managed, dorothy_column, dorothy_order, dorothy_project_id, dorothy_project_path,
    dorothy_progress, dorothy_priority, dorothy_assigned_agent_id, dorothy_agent_created,
    dorothy_required_skills, dorothy_labels, dorothy_attachments, dorothy_completion_summary,
    dorothy_completed_at, dorothy_updated_at)
  VALUES (?,?,?,?,?,?, 'scratch',
    1, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?)
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

/** 모든 비-archived 작업을 대시보드 KanbanTask 형태로 로드. 실패 시 빈 배열. */
export function loadTasks(): KanbanTask[] {
  const db = openDb(dbFile());
  if (!db) return [];
  try {
    ensureSchema(db);
    const rows = db
      .prepare(
        "SELECT * FROM tasks WHERE status != 'archived' ORDER BY COALESCE(dorothy_order, 999999) ASC, created_at ASC",
      )
      .all();
    return rows.map(rowToTask);
  } catch (e) {
    console.error('[kanban-store] loadTasks failed:', e instanceof Error ? e.message : e);
    return [];
  } finally {
    db.close();
  }
}

/**
 * 전체 desired state(load→mutate→save 패턴) 를 DB 에 반영.
 *  - 배열의 각 task UPSERT(dorothy_managed=1).
 *  - dorothy_managed=1 인데 배열에 없는 행 → soft-delete(archived). native 행은 보존.
 */
export function saveTasks(tasks: KanbanTask[]): void {
  const db = openDb(dbFile());
  if (!db) return;
  try {
    ensureSchema(db);
    const upsert = db.prepare(UPSERT_SQL);
    db.prepare('BEGIN').run();
    try {
      const keep = new Set<string>();
      const now = new Date().toISOString();
      for (const t of tasks) {
        keep.add(t.id);
        upsert.run(
          t.id,
          t.title || '',
          t.description || '',
          columnToStatus(t.column),
          priorityToInt(t.priority || 'medium'),
          Math.floor(new Date(t.createdAt || now).getTime() / 1000),
          t.column,
          t.order ?? 0,
          t.projectId || '',
          t.projectPath || '',
          t.progress ?? 0,
          t.priority || 'medium',
          t.assignedAgentId || null,
          t.agentCreatedForTask ? 1 : 0,
          JSON.stringify(t.requiredSkills || []),
          JSON.stringify(t.labels || []),
          JSON.stringify(t.attachments || []),
          t.completionSummary || null,
          t.completedAt || null,
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
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
  } catch (e) {
    console.error('[kanban-store] saveTasks failed:', e instanceof Error ? e.message : e);
  } finally {
    db.close();
  }
}

/** 새 backlog 작업 생성 헬퍼(슬랙/직접 경로 공용). 생성된 task 반환. */
export function createTask(params: {
  title: string;
  description?: string;
  projectId: string;
  projectPath: string;
  priority?: 'low' | 'medium' | 'high';
  labels?: string[];
  requiredSkills?: string[];
}): KanbanTask {
  const tasks = loadTasks();
  const backlog = tasks.filter(t => t.column === 'backlog');
  const maxOrder = backlog.length ? Math.max(...backlog.map(t => t.order ?? 0)) : -1;
  const now = new Date().toISOString();
  const task: KanbanTask = {
    id: uuidv4(),
    title: params.title,
    description: params.description || '',
    column: 'backlog',
    projectId: params.projectId,
    projectPath: params.projectPath,
    assignedAgentId: null,
    agentCreatedForTask: false,
    requiredSkills: params.requiredSkills || [],
    priority: params.priority || 'medium',
    progress: 0,
    createdAt: now,
    updatedAt: now,
    order: maxOrder + 1,
    labels: params.labels || [],
    attachments: [],
  };
  saveTasks([...tasks, task]);
  return task;
}
