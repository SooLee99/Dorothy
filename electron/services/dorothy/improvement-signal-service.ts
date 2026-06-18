/**
 * Dorothy MVP Phase 5C-B — ImprovementSignal service.
 *
 * "Dorothy noticed this pattern" candidates that a human triages. Strictly
 * no agent file / skill / code is mutated by this service — UI + manual
 * action only.
 *
 * Dedupe policy: identical fingerprints within a 24h window roll up into the
 * same row (occurrenceCount++ + updatedAt bump). Fingerprint is computed by
 * the caller; this service trusts and stores it.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import { safeCreateHookEvent, makeExcerpt } from './hook-event-service';
import { loadTasks, saveTasks, emitTaskEvent, type KanbanTask, type KanbanColumn } from '../../handlers/kanban-handlers';
import type {
  ImprovementSignal,
  ImprovementSignalSource,
  ImprovementSignalSeverity,
  ImprovementSignalStatus,
  CreateImprovementSignalInput,
  UpdateImprovementSignalStatusInput,
} from '../../types/dorothy';

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

interface Row {
  id: string;
  run_id: string | null;
  source: string;
  severity: string;
  title: string;
  summary: string;
  evidence_artifact_ids_json: string | null;
  related_agent_id: string | null;
  related_skill_id: string | null;
  fingerprint: string | null;
  occurrence_count: number;
  status: string;
  created_at: string;
  updated_at: string;
  // Phase 5E — null until the operator converts the signal to a KanbanTask.
  converted_task_id: string | null;
}

function rowToSignal(r: Row): ImprovementSignal {
  let ev: string[] | undefined;
  if (r.evidence_artifact_ids_json) {
    try { ev = JSON.parse(r.evidence_artifact_ids_json) as string[]; } catch { /* ignore */ }
  }
  return {
    id: r.id,
    runId: r.run_id,
    source: r.source as ImprovementSignalSource,
    severity: r.severity as ImprovementSignalSeverity,
    title: r.title,
    summary: r.summary,
    evidenceArtifactIds: ev,
    relatedAgentId: r.related_agent_id,
    relatedSkillId: r.related_skill_id,
    fingerprint: r.fingerprint,
    occurrenceCount: r.occurrence_count,
    status: r.status as ImprovementSignalStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    convertedTaskId: r.converted_task_id,
  };
}

/**
 * Stable fingerprint helper — exported so the auto-creation hooks compute
 * the same key the dedupe path expects.
 */
export function fingerprintFor(parts: {
  source: ImprovementSignalSource;
  runId?: string | null;
  relatedAgentId?: string | null;
  normalizedTitle: string;
}): string {
  const pieces = [
    parts.source,
    parts.runId ?? 'no-run',
    parts.relatedAgentId ?? 'no-agent',
    parts.normalizedTitle.toLowerCase().slice(0, 80),
  ];
  return pieces.join('::');
}

/**
 * Insert or update an improvement signal. If a recent (≤24h) row with the
 * same fingerprint exists, we bump `occurrence_count` and `updated_at`
 * instead of creating a duplicate.
 */
export function createImprovementSignal(input: CreateImprovementSignalInput): ImprovementSignal | null {
  const db = getDorothyDb();
  if (!db) return null;

  const now = new Date();
  const nowIso = now.toISOString();
  const severity: ImprovementSignalSeverity = input.severity ?? 'medium';

  // Dedupe path — only when a fingerprint is supplied.
  if (input.fingerprint) {
    const since = new Date(now.getTime() - DEDUPE_WINDOW_MS).toISOString();
    const existing = db.prepare(`
      SELECT * FROM improvement_signals
      WHERE fingerprint = @fp
        AND updated_at >= @since
        AND status NOT IN ('dismissed', 'converted_to_task')
      ORDER BY updated_at DESC
      LIMIT 1
    `).get({ fp: input.fingerprint, since }) as Row | undefined;
    if (existing) {
      const nextCount = (existing.occurrence_count ?? 1) + 1;
      db.prepare(`
        UPDATE improvement_signals SET
          occurrence_count = @count,
          updated_at = @now,
          summary = @summary
        WHERE id = @id
      `).run({
        id: existing.id,
        count: nextCount,
        now: nowIso,
        // Refresh summary with the latest observation so the UI shows the
        // newest evidence.
        summary: input.summary,
      });
      // Phase 5F — surface the dedupe bump as an "updated" timeline row so
      // the operator can spot patterns roll up.
      safeCreateHookEvent({
        type: 'improvement_signal_updated',
        severity: 'info',
        source: 'improvement',
        runId: existing.run_id,
        improvementSignalId: existing.id,
        title: `ImprovementSignal rolled up (×${nextCount}) — ${input.title}`,
        summary: makeExcerpt(input.summary, 240),
        metadata: {
          source: input.source,
          severity: existing.severity,
          fingerprint: input.fingerprint ?? null,
          occurrenceCount: nextCount,
          status: existing.status,
        },
      });
      return getImprovementSignal(existing.id);
    }
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO improvement_signals (
      id, run_id, source, severity, title, summary,
      evidence_artifact_ids_json, related_agent_id, related_skill_id,
      fingerprint, occurrence_count, status, created_at, updated_at
    ) VALUES (
      @id, @run_id, @source, @severity, @title, @summary,
      @ev_json, @agent_id, @skill_id,
      @fp, @count, 'open', @now, @now
    )
  `).run({
    id,
    run_id: input.runId ?? null,
    source: input.source,
    severity,
    title: input.title,
    summary: input.summary,
    ev_json: input.evidenceArtifactIds && input.evidenceArtifactIds.length
      ? JSON.stringify(input.evidenceArtifactIds)
      : null,
    agent_id: input.relatedAgentId ?? null,
    skill_id: input.relatedSkillId ?? null,
    fp: input.fingerprint ?? null,
    count: input.occurrenceCount ?? 1,
    now: nowIso,
  });
  // Phase 5F — surface the new signal on the unified timeline.
  safeCreateHookEvent({
    type: 'improvement_signal_created',
    severity: severity === 'high' ? 'warning' : 'info',
    source: 'improvement',
    runId: input.runId ?? null,
    agentId: input.relatedAgentId ?? null,
    improvementSignalId: id,
    title: `ImprovementSignal — ${input.title}`,
    summary: makeExcerpt(input.summary, 240),
    metadata: {
      source: input.source,
      severity,
      fingerprint: input.fingerprint ?? null,
      occurrenceCount: input.occurrenceCount ?? 1,
      status: 'open',
    },
  });
  return getImprovementSignal(id);
}

export function getImprovementSignal(id: string): ImprovementSignal | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM improvement_signals WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToSignal(row) : null;
}

export interface ListImprovementSignalsOptions {
  status?: ImprovementSignalStatus | ImprovementSignalStatus[];
  source?: ImprovementSignalSource;
  runId?: string;
  severity?: ImprovementSignalSeverity;
  limit?: number;
  offset?: number;
}

export function listImprovementSignals(opts: ListImprovementSignalsOptions = {}): ImprovementSignal[] {
  const db = getDorothyDb();
  if (!db) return [];
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.status) {
    if (Array.isArray(opts.status)) {
      const placeholders = opts.status.map((_, i) => `@st${i}`);
      opts.status.forEach((s, i) => { params[`st${i}`] = s; });
      where.push(`status IN (${placeholders.join(',')})`);
    } else {
      where.push('status = @status'); params.status = opts.status;
    }
  }
  if (opts.source) { where.push('source = @source'); params.source = opts.source; }
  if (opts.runId) { where.push('run_id = @run_id'); params.run_id = opts.runId; }
  if (opts.severity) { where.push('severity = @sev'); params.sev = opts.severity; }
  const sql = `
    SELECT * FROM improvement_signals
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC
    LIMIT @limit OFFSET @offset
  `;
  const rows = db.prepare(sql).all({ ...params, limit: opts.limit ?? 200, offset: opts.offset ?? 0 }) as Row[];
  return rows.map(rowToSignal);
}

export function listImprovementSignalsByRun(runId: string): ImprovementSignal[] {
  return listImprovementSignals({ runId });
}

/* ============================================================================
 * Phase 5E — Convert ImprovementSignal → KanbanTask
 *
 * Always operator-initiated. We:
 *   - refuse to convert a signal already in `converted_to_task`
 *   - refuse to re-mint a KanbanTask when `converted_task_id` is set;
 *     return the existing task instead
 *   - write a `KanbanTask` row with the kanban-handlers' canonical shape
 *     (no schema drift)
 *   - flip the signal's status + stamp converted_task_id
 *
 * The task lives in the user-facing JSON file (`~/.dorothy/kanban-tasks.json`)
 * so the Kanban board sees it without an additional integration.
 */

export interface ConvertSignalToTaskOptions {
  /** Defaults to 'backlog' so the operator decides when to promote it. */
  column?: KanbanColumn;
  /** Optional projectId / projectPath override; falls back to the signal's
   *  relatedAgentId-derived defaults when absent. */
  projectId?: string;
  projectPath?: string;
}

export interface ConvertSignalToTaskResult {
  ok: boolean;
  signal: ImprovementSignal | null;
  task: KanbanTask | null;
  reason?: string;
}

export function convertImprovementSignalToKanbanTask(
  signalId: string,
  options: ConvertSignalToTaskOptions = {},
): ConvertSignalToTaskResult {
  const db = getDorothyDb();
  if (!db) {
    return { ok: false, signal: null, task: null, reason: 'dorothy.db not initialized' };
  }
  const signal = getImprovementSignal(signalId);
  if (!signal) {
    return { ok: false, signal: null, task: null, reason: 'signal not found' };
  }

  // Already-converted guard: short-circuit with the existing task when we
  // can find it; otherwise just mark the signal converted_to_task.
  if (signal.status === 'converted_to_task' || signal.convertedTaskId) {
    if (signal.convertedTaskId) {
      const tasks = loadTasks();
      const existing = tasks.find(t => t.id === signal.convertedTaskId);
      if (existing) {
        return { ok: true, signal, task: existing, reason: 'already-converted' };
      }
    }
    return { ok: false, signal, task: null, reason: 'already-converted (no task row found)' };
  }

  const column: KanbanColumn = options.column ?? 'backlog';

  // Build the task. Note: kanban-handlers' KanbanTask shape requires
  // projectId/projectPath; we have to pick safe defaults because an
  // ImprovementSignal isn't tied to a project by construction.
  const taskId = uuidv4();
  const labels = [
    'improvement',
    `source:${signal.source}`,
    `severity:${signal.severity}`,
  ];
  if (signal.fingerprint) labels.push(`fp:${signal.fingerprint.slice(0, 40)}`);

  const lines: string[] = [];
  lines.push(signal.summary);
  lines.push('');
  lines.push('---');
  lines.push(`source: ${signal.source}`);
  lines.push(`severity: ${signal.severity}`);
  if (signal.runId) lines.push(`runId: ${signal.runId}`);
  if (signal.relatedAgentId) lines.push(`relatedAgentId: ${signal.relatedAgentId}`);
  if (signal.evidenceArtifactIds?.length) lines.push(`evidenceArtifactIds: ${signal.evidenceArtifactIds.join(', ')}`);
  if (signal.fingerprint) lines.push(`fingerprint: ${signal.fingerprint}`);
  lines.push(`improvementSignalId: ${signal.id}`);

  const now = new Date().toISOString();
  const tasks = loadTasks();
  // Place at the end of the chosen column for predictable ordering.
  const inColumn = tasks.filter(t => t.column === column);
  const order = inColumn.length > 0 ? Math.max(...inColumn.map(t => t.order)) + 1 : 0;

  const task: KanbanTask = {
    id: taskId,
    title: `[Improvement] ${signal.title}`,
    description: lines.join('\n'),
    column,
    projectId: options.projectId ?? 'dorothy-improvements',
    projectPath: options.projectPath ?? '/',
    assignedAgentId: null,
    agentCreatedForTask: false,
    requiredSkills: [],
    priority: signal.severity === 'high' ? 'high' : signal.severity === 'low' ? 'low' : 'medium',
    progress: 0,
    createdAt: now,
    updatedAt: now,
    order,
    labels,
    attachments: [],
  };

  try {
    tasks.push(task);
    saveTasks(tasks);
    try { emitTaskEvent('kanban:task-created', task); } catch { /* ignore */ }
  } catch (err) {
    return {
      ok: false,
      signal,
      task: null,
      reason: err instanceof Error ? `saveTasks failed: ${err.message}` : 'saveTasks failed',
    };
  }

  // Stamp the conversion onto the signal row.
  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE improvement_signals SET
      status = 'converted_to_task',
      converted_task_id = @task_id,
      updated_at = @now,
      summary = summary || '\n\n— converted to KanbanTask ' || @task_id
    WHERE id = @id
  `).run({ id: signal.id, task_id: taskId, now: nowIso });

  // Phase 5F — emit both events: the status flip on the signal and the
  // new KanbanTask. Convert is always operator-initiated; no auto path.
  safeCreateHookEvent({
    type: 'improvement_signal_updated',
    severity: 'info',
    source: 'improvement',
    runId: signal.runId ?? null,
    improvementSignalId: signal.id,
    kanbanTaskId: taskId,
    title: `ImprovementSignal converted to KanbanTask`,
    metadata: {
      from: signal.status,
      to: 'converted_to_task',
      source: signal.source,
      severity: signal.severity,
      fingerprint: signal.fingerprint ?? null,
      convertedTaskId: taskId,
    },
  });
  safeCreateHookEvent({
    type: 'kanban_task_created',
    severity: 'info',
    source: 'kanban',
    runId: signal.runId ?? null,
    improvementSignalId: signal.id,
    kanbanTaskId: taskId,
    title: `KanbanTask created from ImprovementSignal — ${signal.title}`,
    metadata: {
      column,
      priority: task.priority,
      labels: task.labels,
      improvementSignalId: signal.id,
    },
  });

  return { ok: true, signal: getImprovementSignal(signal.id), task };
}

export function updateImprovementSignalStatus(input: UpdateImprovementSignalStatusInput): ImprovementSignal | null {
  const db = getDorothyDb();
  if (!db) return null;
  const current = getImprovementSignal(input.id);
  if (!current) return null;
  const now = new Date().toISOString();
  const nextSummary = input.note
    ? `${current.summary}\n\n— note: ${input.note}`
    : current.summary;
  db.prepare(`
    UPDATE improvement_signals SET
      status = @status,
      summary = @summary,
      updated_at = @now
    WHERE id = @id
  `).run({ id: input.id, status: input.status, summary: nextSummary, now });
  // Phase 5F — emit only when status actually changed.
  if (current.status !== input.status) {
    safeCreateHookEvent({
      type: 'improvement_signal_updated',
      severity: 'info',
      source: 'improvement',
      runId: current.runId ?? null,
      improvementSignalId: input.id,
      title: `ImprovementSignal ${current.status} → ${input.status}`,
      summary: makeExcerpt(input.note ?? null, 240),
      metadata: {
        from: current.status,
        to: input.status,
        source: current.source,
        severity: current.severity,
        fingerprint: current.fingerprint ?? null,
      },
    });
  }
  return getImprovementSignal(input.id);
}
