/**
 * PR-2-S1 — Tasks 신호(read-only). kanban-tasks.json 재사용.
 *   GET /api/tasks         — 작업 목록(요약 신호)
 *   GET /api/tasks/{id}     — 작업 상세(design/evidence/artifacts/session)
 *
 * ★추측 0: 연결 데이터 없는 필드는 observed:false. evidence.verified 는 실제 근거 연결 시에만 true.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { envelope } from '../../core/observability';
import { toTaskSummary, toTaskDetail, type KanbanTaskLike } from '../../core/observability/task-signal';
import { RouteApp, RouteContext } from './types';

const KANBAN_FILE = path.join(os.homedir(), '.dorothy', 'kanban-tasks.json');

function readTasks(): KanbanTaskLike[] {
  try {
    const raw = JSON.parse(fs.readFileSync(KANBAN_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.tasks ?? []);
  } catch {
    return [];
  }
}

export function registerTasksRoutes(app_: RouteApp, _ctx: RouteContext): void {
  // GET /api/tasks — 요약 목록. (선택 필터: ?status=, ?project=)
  app_.get('/api/tasks', (req, sendJson) => {
    const status = req.url.searchParams.get('status');
    const project = req.url.searchParams.get('project');
    let tasks = readTasks().map(toTaskSummary);
    if (status) tasks = tasks.filter((t) => t.status === status);
    if (project) tasks = tasks.filter((t) => t.project.observed === true && t.project.value === project);
    sendJson(envelope({ tasks }, { sources: ['kanban-tasks.json'] }));
  });

  // GET /api/tasks/:id — 상세.
  app_.get(/^\/api\/tasks\/([^/]+)$/, (req, sendJson) => {
    const id = decodeURIComponent(req.params.id);
    const t = readTasks().find((x) => x.id === id);
    if (!t) {
      sendJson(envelope(null, { sources: ['kanban-tasks.json'], partial: true }), 404);
      return;
    }
    sendJson(envelope(toTaskDetail(t), { sources: ['kanban-tasks.json'] }));
  });
}
