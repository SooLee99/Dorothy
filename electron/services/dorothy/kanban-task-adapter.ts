/**
 * Dorothy MVP — KanbanTask ↔ Run adapter.
 *
 * Two-way mirror. The existing `~/.dorothy/kanban-tasks.json` and the existing
 * `electron/handlers/kanban-handlers.ts:259-333` auto-spawn flow are **not**
 * touched. This adapter is called from those existing call sites and from the
 * new Run service to keep the JSON file and the SQLite row in sync.
 *
 * Loop prevention:
 *   Calls into this adapter accept a `source` discriminator. The hooks that
 *   originate from a KanbanTask change pass source='kanban'; the hooks that
 *   originate from a Run change pass source='run'. The adapter only writes
 *   into the *other* side — it never round-trips back to the originator.
 *
 *   In addition, a `silent: true` flag tells the adapter to suppress all
 *   mirroring (used when bulk-importing or rehydrating state).
 *
 * Mapping (per docs/rebuild-target-mvp/mvp-data-models.md §8):
 *   KanbanColumn 'backlog'  ↔ no Run, or Run.state='created'
 *   KanbanColumn 'planned'  ↔ Run.state ∈ {planned, approved}
 *   KanbanColumn 'ongoing'  ↔ Run.state ∈ {running, verifying, needs_fix, reporting, blocked}
 *   KanbanColumn 'done'     ↔ Run.state='completed'
 *
 *   Run.state ∈ {failed, cancelled}: see §8 — the Kanban row is *not* deleted.
 *   The adapter logs a marker on the Run (errorReason / comment) and leaves
 *   the KanbanTask where the user last placed it (typically 'ongoing').
 *   A future enhancement (Phase 4) will add a stripe/badge for these.
 */

import type { Run, RunState } from '../../types/dorothy';
import { createRun, getRun, listRuns, updateRunState } from './run-service';
import { decideRunMode } from './run-mode-router';

export type KanbanColumn = 'backlog' | 'planned' | 'ongoing' | 'done';

export type SyncSource = 'kanban' | 'run' | 'manual';

export interface KanbanTaskLike {
  id: string;
  title: string;
  column: KanbanColumn;
  priority?: 'low' | 'medium' | 'high';
}

/* ============================================================================
 * Column → Run.state policy
 * ========================================================================== */

/** What Run.state should we *write* when a Kanban move happens? */
function targetStateForColumn(column: KanbanColumn): RunState | null {
  switch (column) {
    case 'backlog':  return 'created';
    case 'planned':  return 'approved'; // planned column already passed the auto-spawn gate
    case 'ongoing':  return 'running';
    case 'done':     return 'completed';
    default:         return null;
  }
}

/** What Kanban column should mirror a given Run.state? */
export function columnForRunState(state: RunState): KanbanColumn | null {
  switch (state) {
    case 'created':            return 'backlog';
    case 'planned':
    case 'approval_required':
    case 'approved':           return 'planned';
    case 'running':
    case 'verifying':
    case 'needs_fix':
    case 'reporting':
    case 'blocked':            return 'ongoing';
    case 'completed':          return 'done';
    case 'failed':
    case 'cancelled':          return null; // see file header
  }
}

/* ============================================================================
 * Kanban → Run direction
 *
 * Called from `electron/handlers/kanban-handlers.ts` after the JSON-side state
 * has been persisted. Always best-effort; never throws into the kanban path.
 * ========================================================================== */

export interface OnKanbanChangeOptions {
  source?: SyncSource;
  silent?: boolean;
}

/**
 * Called when a KanbanTask is created, moved, or completed. Returns the Run
 * that mirrors it (creating one if necessary). Returns null when the DB is
 * unavailable or `silent` was passed — both cases are safe no-ops for the
 * caller.
 */
export function onKanbanTaskChanged(
  task: KanbanTaskLike,
  options: OnKanbanChangeOptions = {}
): Run | null {
  if (options.silent) return null;
  if (options.source === 'run') return null; // came from the Run side — do not loop

  const target = targetStateForColumn(task.column);
  if (target === null) return null;

  // 1) Look for an existing Run already linked to this Kanban task.
  const existing = listRuns({ kanbanTaskId: task.id, limit: 1 })[0];

  if (!existing) {
    // 2) No mirror yet — create a Run only if the column means "user actually
    //    started this work". A bare backlog item does not warrant a Run row.
    if (task.column === 'backlog') return null;
    try {
      // Phase 5D — route a default mode from the kanban title. Failures here
      // never bubble up; mode columns are nullable and the router falls back
      // to `team` when nothing matches.
      let mode: Run['mode'] = null;
      let modeSource: Run['modeSource'] = null;
      let modeReason: Run['modeReason'] = null;
      try {
        const decision = decideRunMode(task.title);
        mode = decision.mode;
        modeSource = decision.source;
        modeReason = decision.reason;
      } catch { /* ignore router failures — keep mode null */ }
      return createRun({
        title: task.title,
        source: 'kanban',
        sourceRefId: task.id,
        priority: task.priority ?? 'medium',
        state: target,
        kanbanTaskId: task.id,
        mode,
        modeSource,
        modeReason,
      });
    } catch (err) {
      console.warn('[kanban-adapter] createRun on Kanban change failed:', err);
      return null;
    }
  }

  // 3) Mirror exists — bump it to the target state (no-op if already there).
  if (existing.state === target) return existing;

  try {
    return updateRunState(existing.id, target, {
      comment: `mirrored from kanban column "${task.column}"`,
    });
  } catch (err) {
    console.warn('[kanban-adapter] updateRunState on Kanban change failed:', err);
    return existing;
  }
}

/* ============================================================================
 * Run → Kanban direction
 *
 * Returns the column the kanban row *should* be in. The caller (typically the
 * new Run IPC handler) is responsible for loading kanban-tasks.json, comparing,
 * and writing it back through the existing `saveTasks` path. We intentionally
 * do *not* import kanban-handlers.ts here — that would create a circular
 * dependency and would also bypass the existing emit/auto-spawn flow.
 *
 * `failed` / `cancelled` Runs return `null` so callers know to leave the
 * KanbanTask row alone (see file header).
 * ========================================================================== */

export function targetKanbanColumn(run: Run, options: OnKanbanChangeOptions = {}): KanbanColumn | null {
  if (options.silent) return null;
  if (options.source === 'kanban') return null;
  if (!run.kanbanTaskId) return null;
  return columnForRunState(run.state);
}

/** Test/debug helper for orchestration code. */
export function getRunForKanbanTask(kanbanTaskId: string): Run | null {
  const runs = listRuns({ kanbanTaskId, limit: 1 });
  return runs[0] ?? null;
}

export { getRun };
