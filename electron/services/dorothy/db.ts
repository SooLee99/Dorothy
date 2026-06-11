/**
 * Dorothy MVP — SQLite store for Run-centric records.
 *
 * Layout follows the same `electron/services/vault-db.ts` shape so the two DBs
 * feel familiar side-by-side. We keep them in two different files so the new
 * Run model can never accidentally rewrite Vault's schema.
 *
 * Tables: see docs/rebuild-target-mvp/mvp-data-models.md §5.
 *
 * Failure mode:
 *   `initDorothyDb()` returns a status object instead of throwing. The caller
 *   (electron/main.ts) is expected to log the failure and continue; downstream
 *   services use `getDorothyDb()` and check the return value — if it is null
 *   they no-op (graceful degrade rather than crashing the app).
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { DOROTHY_DB_FILE, DATA_DIR } from '../../constants';

let db: Database.Database | null = null;

export interface DorothyDbInitResult {
  ok: boolean;
  reason?: string;
  path: string;
}

export interface DorothyDbInitOptions {
  /**
   * Override the on-disk path. Used by tests so we can spin up isolated
   * databases under os.tmpdir() without polluting the production
   * `~/.dorothy/dorothy.db`. Production callers leave this undefined.
   */
  filePath?: string;
}

/**
 * Returns the singleton handle, or null when init failed or was never called.
 * Callers must tolerate null — services are designed to no-op when the DB is
 * absent so the rest of Dorothy keeps running.
 */
export function getDorothyDb(): Database.Database | null {
  return db;
}

/**
 * Throws when the DB is unavailable. Use only in code paths that have already
 * gated on `getDorothyDb()` returning non-null — typically tests.
 */
export function requireDorothyDb(): Database.Database {
  if (!db) {
    throw new Error(
      'Dorothy DB not initialized. Call initDorothyDb() first or check getDorothyDb() for null.'
    );
  }
  return db;
}

export function initDorothyDb(options: DorothyDbInitOptions = {}): DorothyDbInitResult {
  const filePath = options.filePath ?? DOROTHY_DB_FILE;

  if (db) {
    return { ok: true, path: filePath };
  }

  try {
    const targetDir = path.dirname(filePath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    // Belt-and-suspenders for the default path: ensure the canonical data dir
    // exists too (other Dorothy services assume it does).
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    db = new Database(filePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    runMigrations(db);

    console.log('[dorothy-db] initialized at', filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[dorothy-db] init failed — running without dorothy.db:', reason);
    // Best effort: drop any partial handle so getDorothyDb() returns null.
    try { db?.close(); } catch { /* ignore */ }
    db = null;
    return { ok: false, reason, path: filePath };
  }
}

export function closeDorothyDb(): void {
  if (db) {
    try {
      db.close();
    } catch (err) {
      console.error('[dorothy-db] close failed:', err);
    }
    db = null;
    console.log('[dorothy-db] closed');
  }
}

/* ============================================================================
 * Schema
 *
 * Kept inline (rather than V1__init.sql) to match vault-db.ts. CREATE TABLE
 * IF NOT EXISTS means a fresh install and an upgrade-in-place follow the
 * same path. New columns added in future MVP phases should ALTER TABLE here
 * with try/catch since SQLite does not support `ADD COLUMN IF NOT EXISTS`.
 * ========================================================================== */

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      source          TEXT NOT NULL CHECK(source IN ('user','kanban','pm_tick','automation','schedule')),
      source_ref_id   TEXT,
      priority        TEXT NOT NULL CHECK(priority IN ('low','medium','high','critical')),
      state           TEXT NOT NULL,
      blocked_reason  TEXT,
      error_reason    TEXT,
      plan_id         TEXT,
      kanban_task_id  TEXT,
      created_at      TEXT NOT NULL,
      started_at      TEXT,
      closed_at       TEXT,
      comment         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
    CREATE INDEX IF NOT EXISTS idx_runs_kanban ON runs(kanban_task_id);
    CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);

    CREATE TABLE IF NOT EXISTS run_steps (
      id                  TEXT PRIMARY KEY,
      run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      step_order          INTEGER NOT NULL,
      agent_id            TEXT NOT NULL,
      state               TEXT NOT NULL,
      prompt_ref          TEXT,
      started_at          TEXT,
      ended_at            TEXT,
      retry_count         INTEGER NOT NULL DEFAULT 0,
      error_reason        TEXT,
      agent_session_id    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id, step_order);
    CREATE INDEX IF NOT EXISTS idx_run_steps_state ON run_steps(state);

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id                      TEXT PRIMARY KEY,
      run_id                  TEXT,
      run_step_id             TEXT REFERENCES run_steps(id) ON DELETE SET NULL,
      agent_id                TEXT NOT NULL,
      provider                TEXT NOT NULL,
      worktree_path           TEXT,
      started_at              TEXT NOT NULL,
      exited_at               TEXT,
      end_status              TEXT,
      waiting_for_user_input  INTEGER NOT NULL DEFAULT 0,
      pid                     INTEGER,
      raw_log_ref             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON agent_sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_step ON agent_sessions(run_step_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON agent_sessions(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_run ON agent_sessions(run_id);

    CREATE TABLE IF NOT EXISTS plans (
      id                  TEXT PRIMARY KEY,
      run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      title               TEXT NOT NULL,
      description         TEXT NOT NULL,
      state               TEXT NOT NULL,
      rejection_reason    TEXT,
      risk_level          TEXT,
      adr_ref             TEXT,
      contracts_json      TEXT,
      tasks_json          TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plans_run ON plans(run_id);
    CREATE INDEX IF NOT EXISTS idx_plans_state ON plans(state);

    CREATE TABLE IF NOT EXISTS artifacts (
      id                      TEXT PRIMARY KEY,
      run_id                  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      run_step_id             TEXT REFERENCES run_steps(id) ON DELETE SET NULL,
      type                    TEXT NOT NULL,
      path                    TEXT,
      content_ref             TEXT,
      produced_by_agent_id    TEXT NOT NULL,
      meta_json               TEXT,
      created_at              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);
    CREATE INDEX IF NOT EXISTS idx_artifacts_path ON artifacts(path);

    CREATE TABLE IF NOT EXISTS handoffs (
      id                          TEXT PRIMARY KEY,
      run_id                      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      from_run_step_id            TEXT NOT NULL REFERENCES run_steps(id),
      to_run_step_id              TEXT NOT NULL REFERENCES run_steps(id),
      summary                     TEXT NOT NULL,
      attached_artifact_ids_json  TEXT,
      created_at                  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_handoffs_run ON handoffs(run_id);

    CREATE TABLE IF NOT EXISTS approval_requests (
      id                  TEXT PRIMARY KEY,
      run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      plan_id             TEXT REFERENCES plans(id) ON DELETE SET NULL,
      risk_level          TEXT NOT NULL,
      topic               TEXT,
      state               TEXT NOT NULL,
      decided_by          TEXT,
      decided_at          TEXT,
      decision_note       TEXT,
      mirrored_md_path    TEXT,
      created_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approval_state ON approval_requests(state);
    CREATE INDEX IF NOT EXISTS idx_approval_run ON approval_requests(run_id);

    CREATE TABLE IF NOT EXISTS rate_limit_events (
      id                          TEXT PRIMARY KEY,
      engine                      TEXT NOT NULL,
      detected_at                 TEXT NOT NULL,
      reset_at                    TEXT,
      resumed_at                  TEXT,
      resolved_at                 TEXT,
      source                      TEXT NOT NULL,
      message                     TEXT,
      raw_ref                     TEXT,
      affected_run_ids_json       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_active ON rate_limit_events(resolved_at);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_engine ON rate_limit_events(engine, detected_at DESC);

    CREATE TABLE IF NOT EXISTS intake_requests (
      id                      TEXT PRIMARY KEY,
      source                  TEXT NOT NULL,
      source_ref_id           TEXT,
      raw_content             TEXT NOT NULL,
      parsed_summary          TEXT,
      classified_priority     TEXT,
      classified_domain       TEXT,
      routed_run_id           TEXT,
      created_at              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_intake_source ON intake_requests(source, created_at DESC);

    /* ----- Phase 5A — PullRequest + CIRun -------------------------------- */

    CREATE TABLE IF NOT EXISTS pull_requests (
      id                  TEXT PRIMARY KEY,
      -- run_id is a *hint* extracted from the PR body/branch; we don't FK it
      -- to runs(id) because webhook deliveries may name Runs that do not (or
      -- no longer) exist in dorothy.db. The UI tolerates orphan runIds.
      run_id              TEXT,
      provider            TEXT NOT NULL,
      external_ref        TEXT NOT NULL UNIQUE,
      owner               TEXT NOT NULL,
      repo                TEXT NOT NULL,
      number              INTEGER NOT NULL,
      url                 TEXT NOT NULL,
      branch              TEXT NOT NULL,
      base_branch         TEXT NOT NULL,
      state               TEXT NOT NULL,
      title               TEXT NOT NULL,
      -- body_artifact_id is also a hint — kept un-FK'd to match run_id above.
      body_artifact_id    TEXT,
      author_agent_id     TEXT,
      reviewers_json      TEXT,
      ci_run_ids_json     TEXT,
      merged_at           TEXT,
      closed_at           TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prs_run ON pull_requests(run_id);
    CREATE INDEX IF NOT EXISTS idx_prs_external ON pull_requests(external_ref);
    CREATE INDEX IF NOT EXISTS idx_prs_owner_repo_number ON pull_requests(owner, repo, number);
    CREATE INDEX IF NOT EXISTS idx_prs_state ON pull_requests(state);

    CREATE TABLE IF NOT EXISTS ci_runs (
      id                  TEXT PRIMARY KEY,
      -- Same rationale as pull_requests.run_id — webhook-supplied hint, not
      -- a referential guarantee.
      run_id              TEXT,
      pull_request_id     TEXT REFERENCES pull_requests(id) ON DELETE SET NULL,
      provider            TEXT NOT NULL,
      workflow            TEXT NOT NULL,
      external_ref        TEXT NOT NULL UNIQUE,
      url                 TEXT,
      state               TEXT NOT NULL,
      conclusion          TEXT,
      started_at          TEXT NOT NULL,
      completed_at        TEXT,
      logs_url            TEXT,
      summary             TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ci_run ON ci_runs(run_id);
    CREATE INDEX IF NOT EXISTS idx_ci_pr ON ci_runs(pull_request_id);
    CREATE INDEX IF NOT EXISTS idx_ci_external ON ci_runs(external_ref);
    CREATE INDEX IF NOT EXISTS idx_ci_state ON ci_runs(state);

    /* ----- Phase 5C-B — ImprovementSignal -------------------------------- */

    CREATE TABLE IF NOT EXISTS improvement_signals (
      id                      TEXT PRIMARY KEY,
      run_id                  TEXT,
      source                  TEXT NOT NULL,
      severity                TEXT NOT NULL,
      title                   TEXT NOT NULL,
      summary                 TEXT NOT NULL,
      evidence_artifact_ids_json  TEXT,
      related_agent_id        TEXT,
      related_skill_id        TEXT,
      fingerprint             TEXT,
      occurrence_count        INTEGER NOT NULL DEFAULT 1,
      status                  TEXT NOT NULL,
      created_at              TEXT NOT NULL,
      updated_at              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_improvements_run     ON improvement_signals(run_id);
    CREATE INDEX IF NOT EXISTS idx_improvements_status  ON improvement_signals(status);
    CREATE INDEX IF NOT EXISTS idx_improvements_source  ON improvement_signals(source);
    CREATE INDEX IF NOT EXISTS idx_improvements_fp      ON improvement_signals(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_improvements_created ON improvement_signals(created_at DESC);
  `);

  /* ----- Phase 5C-B — rate_limit_events column additions ----------------
   * SQLite cannot ADD COLUMN IF NOT EXISTS; we try each, swallow the dup
   * error, and otherwise re-throw so a real schema bug surfaces. */
  const extraCols = [
    'provider TEXT',
    'resume_at TEXT',
    'resume_status TEXT',
    'affected_session_ids_json TEXT',
    'affected_run_step_ids_json TEXT',
    'retry_count INTEGER NOT NULL DEFAULT 0',
    'last_resume_error TEXT',
    'message_excerpt TEXT',
    'parse_confidence TEXT',
  ];
  for (const col of extraCols) {
    try {
      database.exec(`ALTER TABLE rate_limit_events ADD COLUMN ${col}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) {
        throw err;
      }
    }
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_rate_limit_resume_status ON rate_limit_events(resume_status);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_resume_at     ON rate_limit_events(resume_at);
  `);

  /* ----- Phase 5D — runs.mode / mode_source / mode_reason -------------- */
  const runExtraCols = [
    'mode TEXT',
    'mode_source TEXT',
    'mode_reason TEXT',
  ];
  for (const col of runExtraCols) {
    try {
      database.exec(`ALTER TABLE runs ADD COLUMN ${col}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) {
        throw err;
      }
    }
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_runs_mode ON runs(mode);
  `);

  /* ----- Phase 5E — improvement_signals.converted_task_id -------------- */
  const improvementExtraCols = [
    'converted_task_id TEXT',
  ];
  for (const col of improvementExtraCols) {
    try {
      database.exec(`ALTER TABLE improvement_signals ADD COLUMN ${col}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) {
        throw err;
      }
    }
  }

  /* ----- Phase 5F — hook_events ----------------------------------------
   * Single denormalised table; everything is FK-light (we treat foreign rows
   * as hints, not enforced). The renderer keys off these columns to filter /
   * group by Run / RunStep / AgentSession. No cascading deletes — keeping the
   * event row when its parent disappears is intentional (audit trail). */
  database.exec(`
    CREATE TABLE IF NOT EXISTS hook_events (
      id                      TEXT PRIMARY KEY,
      type                    TEXT NOT NULL,
      severity                TEXT NOT NULL,
      run_id                  TEXT,
      run_step_id             TEXT,
      agent_session_id        TEXT,
      agent_id                TEXT,
      artifact_id             TEXT,
      handoff_id              TEXT,
      approval_request_id     TEXT,
      rate_limit_event_id     TEXT,
      pull_request_id         TEXT,
      ci_run_id               TEXT,
      improvement_signal_id   TEXT,
      kanban_task_id          TEXT,
      source                  TEXT NOT NULL,
      title                   TEXT NOT NULL,
      summary                 TEXT,
      metadata_json           TEXT,
      created_at              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hook_events_run        ON hook_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_hook_events_step       ON hook_events(run_step_id);
    CREATE INDEX IF NOT EXISTS idx_hook_events_session    ON hook_events(agent_session_id);
    CREATE INDEX IF NOT EXISTS idx_hook_events_type       ON hook_events(type);
    CREATE INDEX IF NOT EXISTS idx_hook_events_severity   ON hook_events(severity);
    CREATE INDEX IF NOT EXISTS idx_hook_events_created    ON hook_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hook_events_source     ON hook_events(source);
  `);

  /* ----- Phase 6-A — diagnostics --------------------------------------
   * Diagnostics are HookEvent-derived problem instances. evidence_*_json
   * are JSON arrays so we can carry the underlying HookEvent / Artifact id
   * lists without normalizing prematurely. Same audit-trail-no-cascade
   * philosophy as hook_events. */
  database.exec(`
    CREATE TABLE IF NOT EXISTS diagnostics (
      id                            TEXT PRIMARY KEY,
      run_id                        TEXT,
      run_step_id                   TEXT,
      agent_session_id              TEXT,
      agent_id                      TEXT,
      source                        TEXT NOT NULL,
      severity                      TEXT NOT NULL,
      status                        TEXT NOT NULL,
      title                         TEXT NOT NULL,
      summary                       TEXT NOT NULL,
      root_cause                    TEXT,
      impact                        TEXT,
      suggested_fix                 TEXT,
      evidence_hook_event_ids_json  TEXT,
      evidence_artifact_ids_json    TEXT,
      related_improvement_signal_id TEXT,
      related_kanban_task_id        TEXT,
      fingerprint                   TEXT,
      occurrence_count              INTEGER NOT NULL DEFAULT 1,
      created_at                    TEXT NOT NULL,
      updated_at                    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_diagnostics_run      ON diagnostics(run_id);
    CREATE INDEX IF NOT EXISTS idx_diagnostics_step     ON diagnostics(run_step_id);
    CREATE INDEX IF NOT EXISTS idx_diagnostics_session  ON diagnostics(agent_session_id);
    CREATE INDEX IF NOT EXISTS idx_diagnostics_source   ON diagnostics(source);
    CREATE INDEX IF NOT EXISTS idx_diagnostics_severity ON diagnostics(severity);
    CREATE INDEX IF NOT EXISTS idx_diagnostics_status   ON diagnostics(status);
    CREATE INDEX IF NOT EXISTS idx_diagnostics_created  ON diagnostics(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_diagnostics_fp       ON diagnostics(fingerprint);
  `);

  /* ----- Phase 6-B — agent_workflow_progress -------------------------------
   * Single row per (runId, runStepId, agentSessionId, agentId) quartet.
   * `steps_json` stores the AgentWorkflowStepProgress[] array verbatim;
   * step-level evidence id lists are nested inside that JSON so the row
   * stays denormalised and cheap to read for the Run Detail tab. */
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_workflow_progress (
      id                   TEXT PRIMARY KEY,
      run_id               TEXT NOT NULL,
      run_step_id          TEXT,
      agent_session_id     TEXT,
      agent_id             TEXT NOT NULL,
      workflow_kind        TEXT NOT NULL,
      status               TEXT NOT NULL,
      current_step_id      TEXT,
      current_step_label   TEXT,
      steps_json           TEXT NOT NULL,
      progress_percent     INTEGER NOT NULL DEFAULT 0,
      blocked_reason       TEXT,
      failed_reason        TEXT,
      stalled_reason       TEXT,
      last_event_at        TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_awp_run        ON agent_workflow_progress(run_id);
    CREATE INDEX IF NOT EXISTS idx_awp_step       ON agent_workflow_progress(run_step_id);
    CREATE INDEX IF NOT EXISTS idx_awp_session    ON agent_workflow_progress(agent_session_id);
    CREATE INDEX IF NOT EXISTS idx_awp_agent      ON agent_workflow_progress(agent_id);
    CREATE INDEX IF NOT EXISTS idx_awp_kind       ON agent_workflow_progress(workflow_kind);
    CREATE INDEX IF NOT EXISTS idx_awp_status     ON agent_workflow_progress(status);
    CREATE INDEX IF NOT EXISTS idx_awp_updated    ON agent_workflow_progress(updated_at DESC);
  `);

  /* ----- Phase 6-D — skill_candidates ----------------------------------
   * Candidate "skill" rows derived from ImprovementSignal / Diagnostic /
   * recurring workflow patterns. We deliberately never write actual skill
   * files from this row — accepted / ready_for_registry only marks the
   * candidate ready for a human to register. Future Phase 6-E (Evolution
   * Agent) is the only path that should generate skill files, with explicit
   * approval. */
  database.exec(`
    CREATE TABLE IF NOT EXISTS skill_candidates (
      id                       TEXT PRIMARY KEY,
      title                    TEXT NOT NULL,
      summary                  TEXT NOT NULL,
      category                 TEXT NOT NULL,
      source                   TEXT NOT NULL,
      status                   TEXT NOT NULL,
      severity                 TEXT NOT NULL,
      run_id                   TEXT,
      diagnostic_id            TEXT,
      improvement_signal_id    TEXT,
      workflow_progress_id     TEXT,
      related_agent_id         TEXT,
      related_skill_id         TEXT,
      proposed_skill_name      TEXT,
      proposed_skill_desc      TEXT,
      proposed_trigger         TEXT,
      proposed_inputs_json     TEXT,
      proposed_outputs_json    TEXT,
      proposed_guardrails_json TEXT,
      proposed_validation_json TEXT,
      evidence_hook_event_ids_json TEXT,
      evidence_artifact_ids_json   TEXT,
      evidence_handoff_ids_json    TEXT,
      fingerprint              TEXT,
      occurrence_count         INTEGER NOT NULL DEFAULT 1,
      converted_task_id        TEXT,
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skill_cand_status     ON skill_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_skill_cand_category   ON skill_candidates(category);
    CREATE INDEX IF NOT EXISTS idx_skill_cand_source     ON skill_candidates(source);
    CREATE INDEX IF NOT EXISTS idx_skill_cand_run        ON skill_candidates(run_id);
    CREATE INDEX IF NOT EXISTS idx_skill_cand_diagnostic ON skill_candidates(diagnostic_id);
    CREATE INDEX IF NOT EXISTS idx_skill_cand_imp_signal ON skill_candidates(improvement_signal_id);
    CREATE INDEX IF NOT EXISTS idx_skill_cand_agent      ON skill_candidates(related_agent_id);
    CREATE INDEX IF NOT EXISTS idx_skill_cand_fp         ON skill_candidates(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_skill_cand_created    ON skill_candidates(created_at DESC);
  `);

  /* ----- Phase 6-W — App Factory (app_candidates + app_factory_plans) ------
   * Planning-only tables. An AppCandidate is an independent app/company/project
   * idea; an AppFactoryPlan is a *preview* (architecture + MVP scope + Kanban
   * preview tasks). JSON arrays/objects are stored verbatim in *_json columns.
   * These tables are additive and backward-compatible (CREATE IF NOT EXISTS);
   * no existing table is touched. */
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_candidates (
      id                        TEXT PRIMARY KEY,
      rank                      INTEGER,
      title                     TEXT NOT NULL,
      target_users_json         TEXT,
      problem                   TEXT,
      daily_use_level           TEXT,
      substitute_level          TEXT,
      substitutes_json          TEXT,
      core_mvp_features_json     TEXT,
      api_sources_json          TEXT,
      provider                  TEXT,
      implementation_difficulty TEXT,
      monetization_json         TEXT,
      risks_json                TEXT,
      project_slug              TEXT NOT NULL,
      company_name              TEXT,
      suggested_project_path    TEXT,
      status                    TEXT NOT NULL,
      created_at                TEXT NOT NULL,
      updated_at                TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_app_cand_status  ON app_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_app_cand_slug    ON app_candidates(project_slug);
    CREATE INDEX IF NOT EXISTS idx_app_cand_created ON app_candidates(created_at DESC);

    CREATE TABLE IF NOT EXISTS app_factory_plans (
      id                       TEXT PRIMARY KEY,
      app_candidate_id         TEXT NOT NULL,
      summary                  TEXT NOT NULL,
      suggested_architecture   TEXT NOT NULL,
      mvp_scope_json           TEXT,
      out_of_scope_json        TEXT,
      data_model_draft_json    TEXT,
      api_contract_draft_json  TEXT,
      kanban_preview_tasks_json TEXT,
      risk_policy_json         TEXT,
      status                   TEXT NOT NULL,
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_app_plan_candidate ON app_factory_plans(app_candidate_id);
    CREATE INDEX IF NOT EXISTS idx_app_plan_status    ON app_factory_plans(status);
    CREATE INDEX IF NOT EXISTS idx_app_plan_created   ON app_factory_plans(created_at DESC);
  `);
}
