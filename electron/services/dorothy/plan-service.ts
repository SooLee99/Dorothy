/**
 * Dorothy MVP — Plan service.
 *
 * Tasks and Contracts live as JSON columns on the Plan row in MVP; they are
 * normalized into their own tables in Phase 5. Identifiers (`tasks[].taskId`,
 * `contracts[].contractId`) are preserved so the future migration is a
 * `JSON_EACH` insert — never a rename.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import type {
  Plan,
  PlanState,
  Priority,
  CreatePlanInput,
  TaskDraft,
  ContractDraft,
} from '../../types/dorothy';

interface PlanRow {
  id: string;
  run_id: string;
  title: string;
  description: string;
  state: string;
  rejection_reason: string | null;
  risk_level: string | null;
  adr_ref: string | null;
  contracts_json: string | null;
  tasks_json: string;
  created_at: string;
  updated_at: string;
}

function rowToPlan(r: PlanRow): Plan {
  let tasks: TaskDraft[] = [];
  let contracts: ContractDraft[] | undefined;
  try { tasks = JSON.parse(r.tasks_json) as TaskDraft[]; } catch { /* malformed → empty */ }
  if (r.contracts_json) {
    try { contracts = JSON.parse(r.contracts_json) as ContractDraft[]; } catch { /* ignore */ }
  }
  return {
    id: r.id,
    runId: r.run_id,
    title: r.title,
    description: r.description,
    state: r.state as PlanState,
    rejectionReason: r.rejection_reason,
    riskLevel: r.risk_level as Priority | null,
    adrRef: r.adr_ref,
    contracts,
    tasks,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createPlan(input: CreatePlanInput): Plan | null {
  const db = getDorothyDb();
  if (!db) return null;

  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO plans (
      id, run_id, title, description, state,
      rejection_reason, risk_level, adr_ref,
      contracts_json, tasks_json,
      created_at, updated_at
    ) VALUES (
      @id, @run_id, @title, @description, @state,
      NULL, @risk_level, @adr_ref,
      @contracts_json, @tasks_json,
      @now, @now
    )
  `).run({
    id,
    run_id: input.runId,
    title: input.title,
    description: input.description,
    state: input.state ?? 'draft',
    risk_level: input.riskLevel ?? null,
    adr_ref: input.adrRef ?? null,
    contracts_json: input.contracts ? JSON.stringify(input.contracts) : null,
    tasks_json: JSON.stringify(input.tasks ?? []),
    now,
  });

  return getPlan(id);
}

export function getPlan(id: string): Plan | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
  return row ? rowToPlan(row) : null;
}

export function listPlans(opts: { runId?: string; state?: PlanState; limit?: number } = {}): Plan[] {
  const db = getDorothyDb();
  if (!db) return [];

  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.runId) { where.push('run_id = @run_id'); params.run_id = opts.runId; }
  if (opts.state) { where.push('state = @state'); params.state = opts.state; }

  const sql = `
    SELECT * FROM plans
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC
    LIMIT @limit
  `;
  const rows = db.prepare(sql).all({ ...params, limit: opts.limit ?? 200 }) as PlanRow[];
  return rows.map(rowToPlan);
}

export function listPlansByRun(runId: string): Plan[] {
  return listPlans({ runId });
}

export interface UpdatePlanInput {
  id: string;
  state?: PlanState;
  rejectionReason?: string | null;
  riskLevel?: Priority | null;
  adrRef?: string | null;
  tasks?: TaskDraft[];
  contracts?: ContractDraft[];
  title?: string;
  description?: string;
}

export function updatePlan(input: UpdatePlanInput): Plan | null {
  const db = getDorothyDb();
  if (!db) return null;

  const current = getPlan(input.id);
  if (!current) return null;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE plans SET
      title             = COALESCE(@title, title),
      description       = COALESCE(@description, description),
      state             = COALESCE(@state, state),
      rejection_reason  = COALESCE(@rejection_reason, rejection_reason),
      risk_level        = COALESCE(@risk_level, risk_level),
      adr_ref           = COALESCE(@adr_ref, adr_ref),
      tasks_json        = COALESCE(@tasks_json, tasks_json),
      contracts_json    = COALESCE(@contracts_json, contracts_json),
      updated_at        = @now
    WHERE id = @id
  `).run({
    id: input.id,
    title: input.title ?? null,
    description: input.description ?? null,
    state: input.state ?? null,
    rejection_reason: input.rejectionReason ?? null,
    risk_level: input.riskLevel ?? null,
    adr_ref: input.adrRef ?? null,
    tasks_json: input.tasks ? JSON.stringify(input.tasks) : null,
    contracts_json: input.contracts ? JSON.stringify(input.contracts) : null,
    now,
  });

  return getPlan(input.id);
}
