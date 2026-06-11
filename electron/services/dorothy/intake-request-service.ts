/**
 * Dorothy MVP — IntakeRequest service.
 *
 * Optional in MVP — used when an external source (Telegram, Slack, JIRA,
 * Command Center) wants to record the raw inbound message before it becomes
 * a Run. If you can synthesise the Run directly there's no need to write an
 * IntakeRequest first.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import type {
  IntakeRequest,
  CreateIntakeRequestInput,
  RunSource,
  Priority,
} from '../../types/dorothy';

interface Row {
  id: string;
  source: string;
  source_ref_id: string | null;
  raw_content: string;
  parsed_summary: string | null;
  classified_priority: string | null;
  classified_domain: string | null;
  routed_run_id: string | null;
  created_at: string;
}

function rowToIntake(r: Row): IntakeRequest {
  return {
    id: r.id,
    source: r.source as RunSource,
    sourceRefId: r.source_ref_id,
    rawContent: r.raw_content,
    parsedSummary: r.parsed_summary,
    classifiedPriority: r.classified_priority as Priority | null,
    classifiedDomain: r.classified_domain,
    routedRunId: r.routed_run_id,
    createdAt: r.created_at,
  };
}

export function createIntakeRequest(input: CreateIntakeRequestInput): IntakeRequest | null {
  const db = getDorothyDb();
  if (!db) return null;
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO intake_requests (
      id, source, source_ref_id, raw_content,
      parsed_summary, classified_priority, classified_domain,
      routed_run_id, created_at
    ) VALUES (
      @id, @source, @source_ref_id, @raw_content,
      @parsed_summary, @classified_priority, @classified_domain,
      @routed_run_id, @now
    )
  `).run({
    id,
    source: input.source,
    source_ref_id: input.sourceRefId ?? null,
    raw_content: input.rawContent,
    parsed_summary: input.parsedSummary ?? null,
    classified_priority: input.classifiedPriority ?? null,
    classified_domain: input.classifiedDomain ?? null,
    routed_run_id: input.routedRunId ?? null,
    now,
  });
  return getIntakeRequest(id);
}

export function getIntakeRequest(id: string): IntakeRequest | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM intake_requests WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToIntake(row) : null;
}

export function attachIntakeToRun(id: string, runId: string): IntakeRequest | null {
  const db = getDorothyDb();
  if (!db) return null;
  db.prepare('UPDATE intake_requests SET routed_run_id = @run WHERE id = @id')
    .run({ id, run: runId });
  return getIntakeRequest(id);
}
