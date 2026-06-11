/**
 * Dorothy MVP — ApprovalRequest service.
 *
 * Lives alongside (not replacing) the existing triplan/approvals/*.md mirror —
 * this service only persists the structured row; the md mirror happens in
 * Phase 4 via a separate file watcher.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import { safeCreateHookEvent } from './hook-event-service';
import { safeDetectDiagnosticFromHookEvent } from './diagnostic-detector';
import { safeUpdateWorkflowProgressFromHookEvent } from './agent-workflow-progress-service';
import type {
  ApprovalRequest,
  ApprovalState,
  CreateApprovalRequestInput,
  Priority,
} from '../../types/dorothy';

interface Row {
  id: string;
  run_id: string;
  plan_id: string | null;
  risk_level: string;
  topic: string | null;
  state: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  mirrored_md_path: string | null;
  created_at: string;
}

function rowToRequest(r: Row): ApprovalRequest {
  return {
    id: r.id,
    runId: r.run_id,
    planId: r.plan_id,
    riskLevel: r.risk_level as Priority,
    topic: r.topic,
    state: r.state as ApprovalState,
    decidedBy: (r.decided_by ?? null) as 'auto' | 'user' | 'policy' | null,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    mirroredMdPath: r.mirrored_md_path,
    createdAt: r.created_at,
  };
}

export function createApprovalRequest(input: CreateApprovalRequestInput): ApprovalRequest | null {
  const db = getDorothyDb();
  if (!db) return null;
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO approval_requests (
      id, run_id, plan_id, risk_level, topic, state,
      decided_by, decided_at, decision_note, mirrored_md_path, created_at
    ) VALUES (
      @id, @run_id, @plan_id, @risk_level, @topic, @state,
      NULL, NULL, NULL, @mirrored_md_path, @now
    )
  `).run({
    id,
    run_id: input.runId,
    plan_id: input.planId ?? null,
    risk_level: input.riskLevel,
    topic: input.topic ?? null,
    state: input.state ?? 'pending',
    mirrored_md_path: input.mirroredMdPath ?? null,
    now,
  });
  // Phase 5F — emit only when the request actually requires a user (not for
  // auto-decided rows). We never persist the raw comment body that triggered
  // the gate — the topic + state is enough.
  const initialState = input.state ?? 'pending';
  if (initialState === 'pending') {
    const ev = safeCreateHookEvent({
      type: 'approval_required',
      severity: 'warning',
      source: 'plan_validator',
      runId: input.runId,
      approvalRequestId: id,
      title: `Approval required (${input.topic ?? 'no-topic'})`,
      summary: input.topic ?? null,
      metadata: {
        topic: input.topic ?? null,
        riskLevel: input.riskLevel,
        planId: input.planId ?? null,
        state: initialState,
      },
    });
    // Phase 6-A — only high/critical risk approvals surface as Diagnostics.
    safeDetectDiagnosticFromHookEvent(ev);
    // Phase 6-B — drives the Approval Validator workflow into blocked.
    safeUpdateWorkflowProgressFromHookEvent(ev);
  }
  return getApprovalRequest(id);
}

export function getApprovalRequest(id: string): ApprovalRequest | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as
    | Row
    | undefined;
  return row ? rowToRequest(row) : null;
}

export interface DecideApprovalInput {
  id: string;
  state: ApprovalState;
  decidedBy: 'auto' | 'user' | 'policy';
  decisionNote?: string | null;
}

export function decideApprovalRequest(input: DecideApprovalInput): ApprovalRequest | null {
  const db = getDorothyDb();
  if (!db) return null;
  const current = getApprovalRequest(input.id);
  if (!current) return null;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE approval_requests SET
      state = @state,
      decided_by = @decided_by,
      decided_at = @now,
      decision_note = COALESCE(@note, decision_note)
    WHERE id = @id
  `).run({
    id: input.id,
    state: input.state,
    decided_by: input.decidedBy,
    note: input.decisionNote ?? null,
    now,
  });
  // Phase 5F — emit on every real state change.
  if (current.state !== input.state) {
    const failure = input.state === 'rejected' || input.state === 'expired';
    const ev = safeCreateHookEvent({
      type: 'approval_resolved',
      severity: failure ? 'warning' : 'info',
      source: 'plan_validator',
      runId: current.runId,
      approvalRequestId: input.id,
      title: `Approval ${input.state} (${current.topic ?? 'no-topic'})`,
      summary: input.decisionNote ?? current.topic ?? null,
      metadata: {
        topic: current.topic ?? null,
        from: current.state,
        to: input.state,
        decidedBy: input.decidedBy,
      },
    });
    // Phase 6-B — unblock the Approval Validator workflow.
    safeUpdateWorkflowProgressFromHookEvent(ev);
  }
  return getApprovalRequest(input.id);
}

export interface ListApprovalRequestsOptions {
  state?: ApprovalState;
  runId?: string;
  limit?: number;
}

export function listApprovalRequests(opts: ListApprovalRequestsOptions = {}): ApprovalRequest[] {
  const db = getDorothyDb();
  if (!db) return [];
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.state) { where.push('state = @state'); params.state = opts.state; }
  if (opts.runId) { where.push('run_id = @run_id'); params.run_id = opts.runId; }
  const sql = `
    SELECT * FROM approval_requests
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC
    LIMIT @limit
  `;
  const rows = db.prepare(sql).all({ ...params, limit: opts.limit ?? 200 }) as Row[];
  return rows.map(rowToRequest);
}
