import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// os.homedir → tmpDir 로 모킹해 ~/.hermes/kanban.db 를 임시 폴더에 만든다.
let tmpDir: string;
vi.mock('os', async importOriginal => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
let store: typeof import('../../../electron/services/kanban-store');

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-store-'));
  vi.resetModules();
  store = await import('../../../electron/services/kanban-store');
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('kanban-store (hermes SQLite, node:sqlite driver)', () => {
  it('creates schema and loads empty', () => {
    expect(store.loadTasks()).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, '.hermes', 'kanban.db'))).toBe(true);
  });

  it('createTask → loadTasks round-trips core fields', () => {
    const t = store.createTask({
      title: '로그인 버튼 정렬 수정',
      description: '정렬 버그',
      projectId: 'bueongi',
      projectPath: '/p/bueongi',
      priority: 'high',
      labels: ['slack'],
    });
    const all = store.loadTasks();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(t.id);
    expect(all[0].title).toBe('로그인 버튼 정렬 수정');
    expect(all[0].column).toBe('backlog');
    expect(all[0].priority).toBe('high');
    expect(all[0].projectId).toBe('bueongi');
    expect(all[0].labels).toEqual(['slack']);
  });

  it('saveTasks moves column and persists; reconcile soft-deletes removed managed tasks', () => {
    const a = store.createTask({ title: 'A', projectId: 'p', projectPath: '/p' });
    const b = store.createTask({ title: 'B', projectId: 'p', projectPath: '/p' });
    let all = store.loadTasks();
    // move A → done
    all = all.map(t => (t.id === a.id ? { ...t, column: 'done' as const } : t));
    store.saveTasks(all);
    expect(store.loadTasks().find(t => t.id === a.id)?.column).toBe('done');
    // delete B (remove from array)
    store.saveTasks(store.loadTasks().filter(t => t.id !== b.id));
    const after = store.loadTasks();
    expect(after.some(t => t.id === b.id)).toBe(false);
    expect(after.some(t => t.id === a.id)).toBe(true);
  });

  it('surfaces hermes-native rows (no dorothy_column) via status→column mapping', () => {
    // 네이티브 hermes 행을 직접 삽입(상태 ready) 후 backlog 로 보이는지.
    store.loadTasks(); // ensure schema/db exists
    const dbPath = path.join(tmpDir, '.hermes', 'kanban.db');
    // node:sqlite 로 직접 native 행 삽입
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO tasks (id, title, body, status, created_at, workspace_kind) VALUES (?,?,?,?,?, 'scratch')",
    ).run('t_native1', '[QA] 네이티브 작업', '본문', 'ready', Math.floor(Date.now() / 1000));
    db.close();
    const found = store.loadTasks().find(t => t.id === 't_native1');
    expect(found).toBeTruthy();
    expect(found?.column).toBe('backlog');
    expect(found?.description).toBe('본문');
  });
});
