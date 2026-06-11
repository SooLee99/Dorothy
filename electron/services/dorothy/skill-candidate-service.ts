/**
 * Dorothy MVP Phase 6-D — SkillCandidate service.
 *
 * A SkillCandidate captures "Dorothy noticed this pattern might justify a
 * Skill — but a human should decide". The candidate row records the proposed
 * skill shape (name, trigger, inputs, outputs, guardrails, validation) from
 * rule-based mapping; we never synthesise body content via LLM and we never
 * auto-create or auto-modify skill files. accepted / ready_for_registry
 * only marks the candidate ready for a human to register.
 *
 * Conversion entry points are all operator-initiated:
 *   - `convertImprovementSignalToSkillCandidate(signalId)`
 *   - `convertDiagnosticToSkillCandidate(diagnosticId)`
 *   - `convertSkillCandidateToKanbanTask(candidateId)`
 *
 * Dedupe policy:
 *   `createOrUpdateSkillCandidate` looks up an existing row in the last 24h
 *   with the same fingerprint whose status is not in
 *   {dismissed, converted_to_task, ready_for_registry, accepted} and bumps
 *   occurrence_count + updates summary + merges evidence ids.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDorothyDb } from './db';
import { maskSensitive } from './hook-event-service';
import {
  getImprovementSignal,
  fingerprintFor,
} from './improvement-signal-service';
import { getDiagnostic } from './diagnostic-service';
import {
  loadTasks,
  saveTasks,
  emitTaskEvent,
  type KanbanTask,
  type KanbanColumn,
} from '../../handlers/kanban-handlers';
import type {
  SkillCandidate,
  SkillCandidateCategory,
  SkillCandidateSeverity,
  SkillCandidateSource,
  SkillCandidateStatus,
  CreateSkillCandidateInput,
  UpdateSkillCandidateStatusInput,
  ImprovementSignal,
  ImprovementSignalSource,
  Diagnostic,
  DiagnosticSource,
} from '../../types/dorothy';

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_TITLE_LEN = 140;
const MAX_LONG_LEN = 500;
const MAX_LIST_ITEM_LEN = 160;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/* ============================================================================
 * Row mapping
 * ========================================================================== */

interface SkillCandidateRow {
  id: string;
  title: string;
  summary: string;
  category: string;
  source: string;
  status: string;
  severity: string;
  run_id: string | null;
  diagnostic_id: string | null;
  improvement_signal_id: string | null;
  workflow_progress_id: string | null;
  related_agent_id: string | null;
  related_skill_id: string | null;
  proposed_skill_name: string | null;
  proposed_skill_desc: string | null;
  proposed_trigger: string | null;
  proposed_inputs_json: string | null;
  proposed_outputs_json: string | null;
  proposed_guardrails_json: string | null;
  proposed_validation_json: string | null;
  evidence_hook_event_ids_json: string | null;
  evidence_artifact_ids_json: string | null;
  evidence_handoff_ids_json: string | null;
  fingerprint: string | null;
  occurrence_count: number;
  converted_task_id: string | null;
  created_at: string;
  updated_at: string;
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function rowToCandidate(r: SkillCandidateRow): SkillCandidate {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    category: r.category as SkillCandidateCategory,
    source: r.source as SkillCandidateSource,
    status: r.status as SkillCandidateStatus,
    severity: r.severity as SkillCandidateSeverity,
    runId: r.run_id,
    diagnosticId: r.diagnostic_id,
    improvementSignalId: r.improvement_signal_id,
    workflowProgressId: r.workflow_progress_id,
    relatedAgentId: r.related_agent_id,
    relatedSkillId: r.related_skill_id,
    proposedSkillName: r.proposed_skill_name,
    proposedSkillDescription: r.proposed_skill_desc,
    proposedTrigger: r.proposed_trigger,
    proposedInputs: parseList(r.proposed_inputs_json),
    proposedOutputs: parseList(r.proposed_outputs_json),
    proposedGuardrails: parseList(r.proposed_guardrails_json),
    proposedValidation: parseList(r.proposed_validation_json),
    evidenceHookEventIds: parseList(r.evidence_hook_event_ids_json),
    evidenceArtifactIds: parseList(r.evidence_artifact_ids_json),
    evidenceHandoffIds: parseList(r.evidence_handoff_ids_json),
    fingerprint: r.fingerprint,
    occurrenceCount: r.occurrence_count,
    convertedTaskId: r.converted_task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ============================================================================
 * Masking + clamping
 * ========================================================================== */

function clampString(value: string | null | undefined, max: number): string {
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function maskString(value: string | null | undefined): string | null {
  if (value == null) return null;
  const masked = maskSensitive(value);
  return typeof masked === 'string' ? masked : String(masked ?? '');
}

function normField(value: string | null | undefined, max = MAX_LONG_LEN): string | null {
  if (value == null) return null;
  return clampString(maskString(value) ?? '', max);
}

function normList(values: string[] | undefined, capCount = 12, capLen = MAX_LIST_ITEM_LEN): string[] {
  if (!values) return [];
  return values
    .slice(0, capCount)
    .map(v => clampString(maskString(v) ?? '', capLen))
    .filter(v => v.length > 0);
}

/** Make a safe slug from a title — alphanumeric + dashes, lowercase, capped at 60 chars. */
export function slugifySkillName(title: string): string {
  const lower = title.toLowerCase();
  const stripped = lower
    .replace(/^\[[^\]]*\]\s*/g, '') // strip leading "[Diagnostic]" / "[Skill]" markers
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = stripped.slice(0, 60).replace(/-+$/g, '');
  return trimmed || 'skill';
}

/* ============================================================================
 * Source → category mapping
 * ========================================================================== */

const IMPROVEMENT_SOURCE_TO_CATEGORY: Record<ImprovementSignalSource, SkillCandidateCategory> = {
  qa_failure:               'qa',
  ci_failure:               'devops',
  rate_limit:               'orchestration',
  approval_required:        'security',
  review_changes_requested: 'qa',
  retry_exceeded:           'orchestration',
  manual_note:              'general',
};

const DIAGNOSTIC_SOURCE_TO_CATEGORY: Record<DiagnosticSource, SkillCandidateCategory> = {
  qa_failure:     'qa',
  ci_failure:     'devops',
  rate_limit:     'orchestration',
  resume_failure: 'orchestration',
  approval_block: 'security',
  github_review:  'qa',
  orchestrator:   'orchestration',
  agent_session:  'general',
  hook_event:     'general',
  manual:         'general',
};

function severityFromImprovement(input: ImprovementSignal): SkillCandidateSeverity {
  // ImprovementSignalSeverity = 'low' | 'medium' | 'high'
  return input.severity;
}

function severityFromDiagnostic(input: Diagnostic): SkillCandidateSeverity {
  // Diagnostic 'critical' → high (SkillCandidate has 3-level severity).
  if (input.severity === 'critical' || input.severity === 'high') return 'high';
  if (input.severity === 'low') return 'low';
  return 'medium';
}

/* ============================================================================
 * CRUD
 * ========================================================================== */

export function createSkillCandidate(input: CreateSkillCandidateInput): SkillCandidate | null {
  const db = getDorothyDb();
  if (!db) return null;

  const id = uuidv4();
  const now = new Date().toISOString();
  const status: SkillCandidateStatus = input.status ?? 'open';
  const severity: SkillCandidateSeverity = input.severity ?? 'medium';
  const category: SkillCandidateCategory = input.category ?? 'general';

  const title = clampString(maskString(input.title) ?? '', MAX_TITLE_LEN);
  const summary = normField(input.summary, MAX_LONG_LEN) ?? '';

  const proposedInputs = normList(input.proposedInputs);
  const proposedOutputs = normList(input.proposedOutputs);
  const proposedGuardrails = normList(input.proposedGuardrails);
  const proposedValidation = normList(input.proposedValidation);
  const hookIds = (input.evidenceHookEventIds ?? []).slice(0, 50);
  const artifactIds = (input.evidenceArtifactIds ?? []).slice(0, 50);
  const handoffIds = (input.evidenceHandoffIds ?? []).slice(0, 50);

  db.prepare(`
    INSERT INTO skill_candidates (
      id, title, summary, category, source, status, severity,
      run_id, diagnostic_id, improvement_signal_id, workflow_progress_id,
      related_agent_id, related_skill_id,
      proposed_skill_name, proposed_skill_desc, proposed_trigger,
      proposed_inputs_json, proposed_outputs_json,
      proposed_guardrails_json, proposed_validation_json,
      evidence_hook_event_ids_json, evidence_artifact_ids_json, evidence_handoff_ids_json,
      fingerprint, occurrence_count, converted_task_id,
      created_at, updated_at
    ) VALUES (
      @id, @title, @summary, @category, @source, @status, @severity,
      @run_id, @diagnostic_id, @improvement_signal_id, @workflow_progress_id,
      @related_agent_id, @related_skill_id,
      @proposed_skill_name, @proposed_skill_desc, @proposed_trigger,
      @inputs_json, @outputs_json,
      @guardrails_json, @validation_json,
      @hook_ids_json, @artifact_ids_json, @handoff_ids_json,
      @fingerprint, @occurrence_count, NULL,
      @now, @now
    )
  `).run({
    id,
    title,
    summary,
    category,
    source: input.source,
    status,
    severity,
    run_id: input.runId ?? null,
    diagnostic_id: input.diagnosticId ?? null,
    improvement_signal_id: input.improvementSignalId ?? null,
    workflow_progress_id: input.workflowProgressId ?? null,
    related_agent_id: input.relatedAgentId ?? null,
    related_skill_id: input.relatedSkillId ?? null,
    proposed_skill_name: normField(input.proposedSkillName, MAX_TITLE_LEN),
    proposed_skill_desc: normField(input.proposedSkillDescription, MAX_LONG_LEN),
    proposed_trigger: normField(input.proposedTrigger, MAX_LONG_LEN),
    inputs_json: proposedInputs.length ? JSON.stringify(proposedInputs) : null,
    outputs_json: proposedOutputs.length ? JSON.stringify(proposedOutputs) : null,
    guardrails_json: proposedGuardrails.length ? JSON.stringify(proposedGuardrails) : null,
    validation_json: proposedValidation.length ? JSON.stringify(proposedValidation) : null,
    hook_ids_json: hookIds.length ? JSON.stringify(hookIds) : null,
    artifact_ids_json: artifactIds.length ? JSON.stringify(artifactIds) : null,
    handoff_ids_json: handoffIds.length ? JSON.stringify(handoffIds) : null,
    fingerprint: input.fingerprint ?? null,
    occurrence_count: input.occurrenceCount ?? 1,
    now,
  });

  return getSkillCandidate(id);
}

/** Same as createSkillCandidate, but never throws. */
export function safeCreateSkillCandidate(input: CreateSkillCandidateInput): SkillCandidate | null {
  try {
    return createSkillCandidate(input);
  } catch (err) {
    console.warn(
      '[skill-candidate] safeCreate suppressed:',
      err instanceof Error ? err.message : 'unknown',
    );
    return null;
  }
}

/**
 * fingerprint dedupe within a 24h window. accepted / dismissed / converted /
 * ready_for_registry rows are terminal — same fingerprint after that creates
 * a new row.
 */
export function createOrUpdateSkillCandidate(input: CreateSkillCandidateInput): SkillCandidate | null {
  const db = getDorothyDb();
  if (!db) return null;

  if (input.fingerprint) {
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    const existing = db.prepare(`
      SELECT * FROM skill_candidates
      WHERE fingerprint = @fp
        AND updated_at >= @since
        AND status NOT IN ('dismissed', 'converted_to_task', 'ready_for_registry', 'accepted')
      ORDER BY updated_at DESC
      LIMIT 1
    `).get({ fp: input.fingerprint, since }) as SkillCandidateRow | undefined;

    if (existing) {
      const nextCount = (existing.occurrence_count ?? 1) + 1;
      const now = new Date().toISOString();
      const mergedHookIds = Array.from(new Set([
        ...parseList(existing.evidence_hook_event_ids_json),
        ...(input.evidenceHookEventIds ?? []),
      ])).slice(0, 100);
      const mergedArtifactIds = Array.from(new Set([
        ...parseList(existing.evidence_artifact_ids_json),
        ...(input.evidenceArtifactIds ?? []),
      ])).slice(0, 100);
      const mergedHandoffIds = Array.from(new Set([
        ...parseList(existing.evidence_handoff_ids_json),
        ...(input.evidenceHandoffIds ?? []),
      ])).slice(0, 100);
      db.prepare(`
        UPDATE skill_candidates SET
          occurrence_count = @count,
          updated_at = @now,
          summary = @summary,
          evidence_hook_event_ids_json = @hook_ids_json,
          evidence_artifact_ids_json   = @artifact_ids_json,
          evidence_handoff_ids_json    = @handoff_ids_json
        WHERE id = @id
      `).run({
        id: existing.id,
        count: nextCount,
        now,
        summary: normField(input.summary, MAX_LONG_LEN) ?? existing.summary,
        hook_ids_json: mergedHookIds.length ? JSON.stringify(mergedHookIds) : null,
        artifact_ids_json: mergedArtifactIds.length ? JSON.stringify(mergedArtifactIds) : null,
        handoff_ids_json: mergedHandoffIds.length ? JSON.stringify(mergedHandoffIds) : null,
      });
      return getSkillCandidate(existing.id);
    }
  }
  return createSkillCandidate(input);
}

export function getSkillCandidate(id: string): SkillCandidate | null {
  const db = getDorothyDb();
  if (!db) return null;
  const row = db.prepare('SELECT * FROM skill_candidates WHERE id = ?').get(id) as
    | SkillCandidateRow
    | undefined;
  return row ? rowToCandidate(row) : null;
}

export interface ListSkillCandidatesOptions {
  runId?: string;
  agentId?: string;
  category?: SkillCandidateCategory | SkillCandidateCategory[];
  source?: SkillCandidateSource | SkillCandidateSource[];
  severity?: SkillCandidateSeverity | SkillCandidateSeverity[];
  status?: SkillCandidateStatus | SkillCandidateStatus[];
  onlyOpen?: boolean;
  minOccurrences?: number;
  limit?: number;
  offset?: number;
}

function clampLimit(n: number | undefined): number {
  const v = n ?? DEFAULT_LIMIT;
  if (v <= 0) return DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

export function listSkillCandidates(opts: ListSkillCandidatesOptions = {}): SkillCandidate[] {
  const db = getDorothyDb();
  if (!db) return [];
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.runId)    { where.push('run_id = @run_id'); params.run_id = opts.runId; }
  if (opts.agentId)  { where.push('related_agent_id = @agent_id'); params.agent_id = opts.agentId; }
  if (opts.onlyOpen) { where.push("status = 'open'"); }
  if (opts.minOccurrences && opts.minOccurrences > 0) {
    where.push('occurrence_count >= @min_occ');
    params.min_occ = opts.minOccurrences;
  }
  if (opts.category) {
    if (Array.isArray(opts.category)) {
      const ph = opts.category.map((_, i) => `@cat${i}`);
      opts.category.forEach((c, i) => { params[`cat${i}`] = c; });
      where.push(`category IN (${ph.join(',')})`);
    } else { where.push('category = @category'); params.category = opts.category; }
  }
  if (opts.source) {
    if (Array.isArray(opts.source)) {
      const ph = opts.source.map((_, i) => `@src${i}`);
      opts.source.forEach((s, i) => { params[`src${i}`] = s; });
      where.push(`source IN (${ph.join(',')})`);
    } else { where.push('source = @source'); params.source = opts.source; }
  }
  if (opts.severity) {
    if (Array.isArray(opts.severity)) {
      const ph = opts.severity.map((_, i) => `@sev${i}`);
      opts.severity.forEach((s, i) => { params[`sev${i}`] = s; });
      where.push(`severity IN (${ph.join(',')})`);
    } else { where.push('severity = @severity'); params.severity = opts.severity; }
  }
  if (opts.status) {
    if (Array.isArray(opts.status)) {
      const ph = opts.status.map((_, i) => `@st${i}`);
      opts.status.forEach((s, i) => { params[`st${i}`] = s; });
      where.push(`status IN (${ph.join(',')})`);
    } else { where.push('status = @status'); params.status = opts.status; }
  }
  const limit = clampLimit(opts.limit);
  const offset = opts.offset ?? 0;
  const sql = `
    SELECT * FROM skill_candidates
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `;
  const rows = db.prepare(sql).all({ ...params, limit, offset }) as SkillCandidateRow[];
  return rows.map(rowToCandidate);
}

export function listSkillCandidatesByRun(runId: string, opts: Omit<ListSkillCandidatesOptions, 'runId'> = {}): SkillCandidate[] {
  return listSkillCandidates({ ...opts, runId });
}

export function updateSkillCandidateStatus(input: UpdateSkillCandidateStatusInput): SkillCandidate | null {
  const db = getDorothyDb();
  if (!db) return null;
  const current = getSkillCandidate(input.id);
  if (!current) return null;
  const now = new Date().toISOString();
  const nextSummary = input.note
    ? clampString(`${current.summary}\n\n— note: ${normField(input.note, 200) ?? ''}`, MAX_LONG_LEN * 2)
    : current.summary;
  db.prepare(`
    UPDATE skill_candidates SET
      status = @status,
      summary = @summary,
      updated_at = @now
    WHERE id = @id
  `).run({ id: input.id, status: input.status, summary: nextSummary, now });
  return getSkillCandidate(input.id);
}

/* ============================================================================
 * ImprovementSignal → SkillCandidate
 * ========================================================================== */

function proposedTriggerFor(source: ImprovementSignalSource | DiagnosticSource): string {
  switch (source) {
    case 'qa_failure':       return 'QA RunStep failed (test_execution or review)';
    case 'ci_failure':       return 'CI workflow ended with conclusion=failure';
    case 'rate_limit':       return 'Provider returned a usage / rate-limit signal';
    case 'resume_failure':   return 'Auto resume scheduler reported lastResumeError';
    case 'approval_required':
    case 'approval_block':   return 'Approval gate keyword + risk-level high|critical';
    case 'review_changes_requested':
    case 'github_review':    return 'PR review with state=changes_requested';
    case 'retry_exceeded':   return 'Orchestrator exhausted maxFixAttempts for a step';
    case 'orchestrator':     return 'Orchestrator surfaced a structural failure';
    case 'agent_session':    return 'Agent session ended with failed/timeout';
    case 'manual_note':
    case 'manual':           return 'Operator filed manual note';
    case 'hook_event':       return 'HookEvent matched a manual probe';
    default:                 return 'Pattern detected';
  }
}

function proposedGuardrailsFor(args: {
  category: SkillCandidateCategory;
  source: SkillCandidateSource | ImprovementSignalSource | DiagnosticSource;
}): string[] {
  const guards: string[] = [
    'Skill must not write to .env* / secrets/** / production/** / production-db/**',
    'Skill must not auto-execute destructive DB operations (drop / truncate / delete from)',
    'Skill must not auto-create or auto-merge GitHub PRs',
    'Risky keywords (production / secret / auth / deploy) keep ApprovalRequest gate',
  ];
  if (args.category === 'database') {
    guards.push('Skill must not auto-execute migrations; produce migration-plan.md + rollback-plan.md only');
  }
  if (args.category === 'contract') {
    guards.push('Skill must not edit FE / BE implementation code; produce contract artifact only');
  }
  return guards;
}

function proposedInputsFor(args: {
  category: SkillCandidateCategory;
  evidenceArtifactIds?: string[];
  evidenceHookEventIds?: string[];
}): string[] {
  const inputs: string[] = [
    'Run context (runId, runStepId, agentId)',
    'Linked HookEvent / Diagnostic / ImprovementSignal evidence ids',
  ];
  if (args.category === 'qa')         inputs.push('Failing validation command + last output excerpt');
  if (args.category === 'devops')     inputs.push('CI workflow name + conclusion');
  if (args.category === 'contract')   inputs.push('FE/BE task pair + existing api-contract.md (if any)');
  if (args.category === 'database')   inputs.push('Existing schema snapshot + planned migration SQL');
  if (args.category === 'security')   inputs.push('Approval topic + riskLevel + decision note');
  return inputs;
}

function proposedOutputsFor(args: { category: SkillCandidateCategory }): string[] {
  switch (args.category) {
    case 'qa':            return ['Failing AC list', 'Re-run command', 'Suggested fix excerpt'];
    case 'devops':        return ['CI failure summary', 'Re-dispatch checklist'];
    case 'contract':      return ['api-contract.md', 'openapi.yaml / dto-schema.json', 'error-codes.md'];
    case 'database':      return ['db-impact-report.md', 'migration-plan.md', 'rollback-plan.md'];
    case 'orchestration': return ['Retry budget summary', 'Resume schedule decision'];
    case 'security':      return ['ApprovalRequest topic + suggested decision note'];
    case 'documentation': return ['Knowledge note + cross-references'];
    default:              return ['Triage note + next-step recommendation'];
  }
}

function proposedValidationFor(args: { category: SkillCandidateCategory }): string[] {
  switch (args.category) {
    case 'qa':            return ['Replay failing validation command + diff against prior pass'];
    case 'devops':        return ['Confirm CI run state transitioned to success on re-dispatch'];
    case 'contract':      return ['openapi.yaml parses + dto-schema.json validates against examples'];
    case 'database':      return ['Migration plan + rollback plan both present; no destructive operation executed'];
    case 'orchestration': return ['Resume Now succeeds OR retry budget remains > 0'];
    case 'security':      return ['Approval decision is recorded by an authorised user'];
    default:              return ['Manual operator review'];
  }
}

export function convertImprovementSignalToSkillCandidate(improvementSignalId: string): {
  ok: boolean;
  signal: ImprovementSignal | null;
  candidate: SkillCandidate | null;
  reason?: string;
} {
  const db = getDorothyDb();
  if (!db) return { ok: false, signal: null, candidate: null, reason: 'dorothy.db not initialized' };
  const signal = getImprovementSignal(improvementSignalId);
  if (!signal) return { ok: false, signal: null, candidate: null, reason: 'signal not found' };

  const category = IMPROVEMENT_SOURCE_TO_CATEGORY[signal.source] ?? 'general';
  const title = clampString(`[Skill] ${signal.title}`, MAX_TITLE_LEN);

  const lines: string[] = [];
  lines.push(signal.summary);
  lines.push('');
  lines.push('---');
  lines.push(`source: ${signal.source}`);
  lines.push(`severity: ${signal.severity}`);
  if (signal.runId)              lines.push(`runId: ${signal.runId}`);
  if (signal.relatedAgentId)     lines.push(`relatedAgentId: ${signal.relatedAgentId}`);
  if (signal.evidenceArtifactIds?.length) lines.push(`evidenceArtifactIds: ${signal.evidenceArtifactIds.slice(0, 10).join(', ')}`);
  if (signal.fingerprint)        lines.push(`fingerprint: ${signal.fingerprint}`);
  lines.push(`improvementSignalId: ${signal.id}`);

  const proposedSkillName = slugifySkillName(signal.title);
  const fp = signal.fingerprint ?? fingerprintFor({
    source: signal.source,
    runId: signal.runId ?? null,
    relatedAgentId: signal.relatedAgentId ?? null,
    normalizedTitle: `skill:${signal.title}`,
  });

  const candidate = createOrUpdateSkillCandidate({
    title,
    summary: lines.join('\n'),
    category,
    source: 'improvement_signal',
    status: 'open',
    severity: severityFromImprovement(signal),
    runId: signal.runId ?? null,
    improvementSignalId: signal.id,
    relatedAgentId: signal.relatedAgentId ?? null,
    proposedSkillName,
    proposedSkillDescription: clampString(signal.summary, MAX_LONG_LEN),
    proposedTrigger: proposedTriggerFor(signal.source),
    proposedInputs: proposedInputsFor({
      category,
      evidenceArtifactIds: signal.evidenceArtifactIds,
    }),
    proposedOutputs: proposedOutputsFor({ category }),
    proposedGuardrails: proposedGuardrailsFor({ category, source: signal.source }),
    proposedValidation: proposedValidationFor({ category }),
    evidenceArtifactIds: signal.evidenceArtifactIds,
    fingerprint: fp,
  });

  return { ok: !!candidate, signal, candidate, reason: candidate ? undefined : 'createSkillCandidate returned null' };
}

/* ============================================================================
 * Diagnostic → SkillCandidate
 * ========================================================================== */

export function convertDiagnosticToSkillCandidate(diagnosticId: string): {
  ok: boolean;
  diagnostic: Diagnostic | null;
  candidate: SkillCandidate | null;
  reason?: string;
} {
  const db = getDorothyDb();
  if (!db) return { ok: false, diagnostic: null, candidate: null, reason: 'dorothy.db not initialized' };
  const diag = getDiagnostic(diagnosticId);
  if (!diag) return { ok: false, diagnostic: null, candidate: null, reason: 'diagnostic not found' };

  const category = DIAGNOSTIC_SOURCE_TO_CATEGORY[diag.source] ?? 'general';
  const title = clampString(`[Diagnostic Skill] ${diag.title}`, MAX_TITLE_LEN);

  const lines: string[] = [];
  lines.push(diag.summary);
  lines.push('');
  lines.push('---');
  lines.push(`source: ${diag.source}`);
  lines.push(`severity: ${diag.severity}`);
  if (diag.rootCause)    lines.push(`rootCause: ${diag.rootCause}`);
  if (diag.impact)       lines.push(`impact: ${diag.impact}`);
  if (diag.suggestedFix) lines.push(`suggestedFix: ${diag.suggestedFix}`);
  if (diag.runId)        lines.push(`runId: ${diag.runId}`);
  if (diag.agentId)      lines.push(`agentId: ${diag.agentId}`);
  if (diag.evidenceHookEventIds.length) {
    lines.push(`evidenceHookEventIds: ${diag.evidenceHookEventIds.slice(0, 10).join(', ')}`);
  }
  if (diag.evidenceArtifactIds?.length) {
    lines.push(`evidenceArtifactIds: ${diag.evidenceArtifactIds.slice(0, 10).join(', ')}`);
  }
  if (diag.fingerprint)  lines.push(`fingerprint: ${diag.fingerprint}`);
  lines.push(`diagnosticId: ${diag.id}`);

  const proposedSkillName = slugifySkillName(diag.title);
  const fp = diag.fingerprint ?? fingerprintFor({
    source: 'manual_note',
    runId: diag.runId ?? null,
    relatedAgentId: diag.agentId ?? null,
    normalizedTitle: `skill-from-diag:${diag.title}`,
  });

  const candidate = createOrUpdateSkillCandidate({
    title,
    summary: lines.join('\n'),
    category,
    source: 'diagnostic',
    status: 'open',
    severity: severityFromDiagnostic(diag),
    runId: diag.runId ?? null,
    diagnosticId: diag.id,
    relatedAgentId: diag.agentId ?? null,
    proposedSkillName,
    proposedSkillDescription: clampString(diag.summary, MAX_LONG_LEN),
    proposedTrigger: proposedTriggerFor(diag.source),
    proposedInputs: proposedInputsFor({
      category,
      evidenceArtifactIds: diag.evidenceArtifactIds,
      evidenceHookEventIds: diag.evidenceHookEventIds,
    }),
    proposedOutputs: proposedOutputsFor({ category }),
    proposedGuardrails: proposedGuardrailsFor({ category, source: diag.source }),
    proposedValidation: proposedValidationFor({ category }),
    evidenceHookEventIds: diag.evidenceHookEventIds,
    evidenceArtifactIds: diag.evidenceArtifactIds,
    fingerprint: fp,
  });

  return { ok: !!candidate, diagnostic: diag, candidate, reason: candidate ? undefined : 'createSkillCandidate returned null' };
}

/* ============================================================================
 * SkillCandidate → KanbanTask
 *
 * Always operator-initiated. We refuse re-conversion when the candidate
 * already has `convertedTaskId` set.
 * ========================================================================== */

export interface ConvertSkillCandidateToTaskOptions {
  column?: KanbanColumn;
}

export interface ConvertSkillCandidateResult {
  ok: boolean;
  candidate: SkillCandidate | null;
  task: KanbanTask | null;
  reason?: string;
}

export function convertSkillCandidateToKanbanTask(
  candidateId: string,
  options: ConvertSkillCandidateToTaskOptions = {},
): ConvertSkillCandidateResult {
  const db = getDorothyDb();
  if (!db) return { ok: false, candidate: null, task: null, reason: 'dorothy.db not initialized' };
  const candidate = getSkillCandidate(candidateId);
  if (!candidate) return { ok: false, candidate: null, task: null, reason: 'candidate not found' };

  if (candidate.status === 'converted_to_task' || candidate.convertedTaskId) {
    if (candidate.convertedTaskId) {
      const tasks = loadTasks();
      const existing = tasks.find(t => t.id === candidate.convertedTaskId);
      if (existing) {
        return { ok: true, candidate, task: existing, reason: 'already-converted' };
      }
    }
    return { ok: false, candidate, task: null, reason: 'already-converted (no task row found)' };
  }

  const column: KanbanColumn = options.column ?? 'backlog';
  const taskId = uuidv4();
  const now = new Date().toISOString();

  const labels = [
    'skill-candidate',
    `category:${candidate.category}`,
    `source:${candidate.source}`,
    `severity:${candidate.severity}`,
  ];
  if (candidate.fingerprint) labels.push(`fp:${candidate.fingerprint.slice(0, 40)}`);

  const lines: string[] = [];
  lines.push(candidate.summary);
  lines.push('');
  lines.push('---');
  lines.push(`category: ${candidate.category}`);
  lines.push(`source: ${candidate.source}`);
  lines.push(`severity: ${candidate.severity}`);
  if (candidate.proposedSkillName)        lines.push(`proposedSkillName: ${candidate.proposedSkillName}`);
  if (candidate.proposedTrigger)          lines.push(`proposedTrigger: ${candidate.proposedTrigger}`);
  if (candidate.proposedInputs?.length)   lines.push(`proposedInputs: ${candidate.proposedInputs.join('; ')}`);
  if (candidate.proposedOutputs?.length)  lines.push(`proposedOutputs: ${candidate.proposedOutputs.join('; ')}`);
  if (candidate.proposedGuardrails?.length) lines.push(`proposedGuardrails: ${candidate.proposedGuardrails.join('; ')}`);
  if (candidate.proposedValidation?.length) lines.push(`proposedValidation: ${candidate.proposedValidation.join('; ')}`);
  if (candidate.evidenceHookEventIds?.length) lines.push(`evidenceHookEventIds: ${candidate.evidenceHookEventIds.slice(0, 10).join(', ')}`);
  if (candidate.evidenceArtifactIds?.length)  lines.push(`evidenceArtifactIds: ${candidate.evidenceArtifactIds.slice(0, 10).join(', ')}`);
  if (candidate.evidenceHandoffIds?.length)   lines.push(`evidenceHandoffIds: ${candidate.evidenceHandoffIds.slice(0, 10).join(', ')}`);
  lines.push(`skillCandidateId: ${candidate.id}`);

  const tasks = loadTasks();
  const inColumn = tasks.filter(t => t.column === column);
  const order = inColumn.length > 0 ? Math.max(...inColumn.map(t => t.order)) + 1 : 0;

  const task: KanbanTask = {
    id: taskId,
    title: clampString(`[SkillCandidate] ${candidate.title}`, MAX_TITLE_LEN),
    description: clampString(lines.join('\n'), 4000),
    column,
    projectId: 'dorothy-skill-candidates',
    projectPath: '/',
    assignedAgentId: null,
    agentCreatedForTask: false,
    requiredSkills: [],
    priority: candidate.severity === 'high' ? 'high' : candidate.severity === 'low' ? 'low' : 'medium',
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
      candidate,
      task: null,
      reason: err instanceof Error ? `saveTasks failed: ${err.message}` : 'saveTasks failed',
    };
  }

  db.prepare(`
    UPDATE skill_candidates SET
      status = 'converted_to_task',
      converted_task_id = @task_id,
      updated_at = @now
    WHERE id = @id
  `).run({ id: candidate.id, task_id: taskId, now });

  return { ok: true, candidate: getSkillCandidate(candidate.id), task };
}

/* ============================================================================
 * Counters
 * ========================================================================== */

export interface SkillCandidateCounts {
  open: number;
  triaged: number;
  accepted: number;
  dismissed: number;
  convertedToTask: number;
  readyForRegistry: number;
  total: number;
}

export function countSkillCandidates(): SkillCandidateCounts {
  const db = getDorothyDb();
  const empty: SkillCandidateCounts = {
    open: 0, triaged: 0, accepted: 0, dismissed: 0,
    convertedToTask: 0, readyForRegistry: 0, total: 0,
  };
  if (!db) return empty;
  type Row = { status: string; n: number };
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM skill_candidates GROUP BY status').all() as Row[];
  for (const r of rows) {
    empty.total += r.n;
    switch (r.status) {
      case 'open':                empty.open = r.n; break;
      case 'triaged':             empty.triaged = r.n; break;
      case 'accepted':            empty.accepted = r.n; break;
      case 'dismissed':           empty.dismissed = r.n; break;
      case 'converted_to_task':   empty.convertedToTask = r.n; break;
      case 'ready_for_registry':  empty.readyForRegistry = r.n; break;
    }
  }
  return empty;
}
