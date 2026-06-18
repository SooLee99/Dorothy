/**
 * Dorothy MVP Phase 4 — Plan Validator service.
 *
 * Inspects a freshly-drafted Plan and decides one of:
 *   - auto_approved : safe + low risk
 *   - conditional   : safe + medium risk, allow with note
 *   - pending       : needs user (high/critical risk, gated topic)
 *   - rejected      : structural problem in the Plan
 *
 * Writes:
 *   - approval_requests row
 *   - runs.state / plans.state transition
 *   - one-line append to triplan/approvals/{approved,pending,rejected}-decisions.md
 *     when the workspace path is reachable
 *
 * Reads:
 *   - the Plan
 *   - approval-policy.md (advisory text — we don't parse it strictly; the
 *     authoritative checks live in this file)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  createApprovalRequest,
  decideApprovalRequest,
} from './approval-request-service';
import { updatePlan, getPlan } from './plan-service';
import { updateRunState, getRun } from './run-service';
import { policyFor } from './run-mode-policy';
import type { Plan, ApprovalState, Priority } from '../../types/dorothy';

const USER_GATE_TOPICS = [
  'sec-1', 'sec-', 'auth', 'authentication', 'login', 'token',
  'push', 'force-push', 'force_push', 'production', 'prod',
  'secret', 'credential', 'api_key', 'apikey',
  'cost', 'billing', 'payment',
  'drop ', 'truncate', 'delete from',
];

const FORBIDDEN_PATHS_HINT = [
  '.git/',
  '~/.dorothy/agents.json',
  '~/.dorothy/vault.db',
  'secrets/',
  'approval-policy.md',
];

const TRIPLAN_ROOT_DEFAULT = '/Users/soo/workspace/source-code/triplan';

function approvalsDir(): string {
  // Allow override for tests; otherwise assume the canonical workspace.
  return process.env.DOROTHY_TRIPLAN_ROOT
    ? path.join(process.env.DOROTHY_TRIPLAN_ROOT, 'approvals')
    : path.join(TRIPLAN_ROOT_DEFAULT, 'approvals');
}

/* ============================================================================
 * Check primitives
 * ========================================================================== */

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ValidationVerdict {
  /** Final decision sink for ApprovalRequest.state */
  approvalState: ApprovalState;
  /** Whether plan/run should be marked approved or held */
  shouldApprove: boolean;
  /** When true, runs.state should be `approval_required` */
  needsUserGate: boolean;
  /** When true, plan was structurally invalid (rejected) */
  rejected: boolean;
  topic?: string;
  checks: CheckResult[];
  notes: string[];
}

export function evaluatePlan(plan: Plan): ValidationVerdict {
  const checks: CheckResult[] = [];
  const notes: string[] = [];

  // Phase 5E — read the RunMode policy off the linked Run. Plan.runId is
  // mandatory so this read is cheap; we tolerate null because some legacy
  // tests build a Plan without a Run.
  const run = getRun(plan.runId);
  const mode = run?.mode ?? null;
  const modePolicy = policyFor(mode);

  // 1) Risk level
  const risk = highestRisk(plan);
  const riskHigh = risk === 'high' || risk === 'critical';
  checks.push({
    name: 'risk-level',
    passed: !riskHigh,
    detail: `riskLevel=${risk}`,
  });

  // 2) Agent assignment
  const allAssigned = (plan.tasks ?? []).every(t => !!t.ownerAgentId);
  checks.push({
    name: 'agent-assignment',
    passed: allAssigned,
    detail: allAssigned ? undefined : 'one or more tasks lack ownerAgentId',
  });

  // 3) Validation commands present (acceptanceCriteria proxy)
  const allHaveAC = (plan.tasks ?? []).every(t => (t.acceptanceCriteria?.length ?? 0) > 0);
  checks.push({
    name: 'acceptance-criteria',
    passed: allHaveAC,
    detail: allHaveAC ? undefined : 'one or more tasks lack acceptanceCriteria',
  });

  // Phase 5E — ultraqa requires explicit validationCommands on every task.
  // The acceptance-criteria check above is a *minimum* — ultraqa needs the
  // stronger validationCommands signal. When the policy demands it and any
  // task is missing them, mark the plan rejected.
  if (modePolicy.requireValidationCommands) {
    const tasksWithoutVC = (plan.tasks ?? []).filter(t => (t.validationCommands?.length ?? 0) === 0);
    const allHaveVC = tasksWithoutVC.length === 0 && (plan.tasks ?? []).length > 0;
    checks.push({
      name: 'validation-commands',
      passed: allHaveVC,
      detail: allHaveVC
        ? undefined
        : `ultraqa mode requires validation commands — missing on ${tasksWithoutVC.length} task(s)`,
    });
  }

  // Phase 6-C — contract / database task presence checks.
  //
  // A Plan touching both frontend AND backend with API-like keywords should
  // include a contract-agent task; a Plan with DB-impact keywords should
  // include a database-agent task. The check severity scales with RunMode:
  //   - team:                  warning (auto_approved + note)
  //   - pipeline / ultraqa:    rejected (needs revision)
  //   - manual:                warning (operator already gates)
  //   - persistent / others:   warning
  const taskOwners = new Set((plan.tasks ?? []).map(t => t.ownerAgentId));
  const haystackLower = renderHaystack(plan).toLowerCase();
  const hasFrontend = taskOwners.has('frontend');
  const hasBackend = taskOwners.has('backend');
  const hasContractAgent = taskOwners.has('contract-agent');
  const hasDatabaseAgent = taskOwners.has('database-agent');

  // API-related keywords that suggest a shared contract is needed.
  const apiKeywords = [
    'api', 'endpoint', 'dto', 'request', 'response', 'schema',
    'openapi', 'graphql', 'rest', 'http', 'json',
    'controller', 'service', 'handler', 'route',
  ];
  // DB-impact keywords. Risk keywords (drop / truncate / delete from) still
  // hit the existing user-gate path separately — we don't suppress them.
  const dbKeywords = [
    'db ', 'database', 'schema', 'migration', 'table', 'index',
    'foreign key', 'rollback', 'drop ', 'truncate', 'delete from',
  ];

  const looksApi = apiKeywords.some(k => haystackLower.includes(k));
  const looksDb = dbKeywords.some(k => haystackLower.includes(k));

  // Pipeline / ultraqa are stricter — missing contract / db tasks block.
  const strictMode = mode === 'pipeline' || mode === 'ultraqa';

  const needsContract = hasFrontend && hasBackend && looksApi && !hasContractAgent;
  checks.push({
    name: 'contract-task-present',
    passed: !needsContract,
    detail: needsContract
      ? 'frontend/backend API work should include a contract task (contract-agent)'
      : undefined,
  });
  if (needsContract) {
    notes.push('frontend/backend API work should include a contract task');
  }

  const needsDatabase = looksDb && !hasDatabaseAgent;
  checks.push({
    name: 'database-task-present',
    passed: !needsDatabase,
    detail: needsDatabase
      ? 'database-impact work should include a database task (database-agent)'
      : undefined,
  });
  if (needsDatabase) {
    notes.push('database-impact work should include a database task');
  }

  // 4) Forbidden path / user-gated topic detection — single combined scan
  const haystack = renderHaystack(plan).toLowerCase();
  const matchedGateTopic = USER_GATE_TOPICS.find(t => haystack.includes(t));
  const matchedForbiddenPath = FORBIDDEN_PATHS_HINT.find(p => haystack.includes(p));

  checks.push({
    name: 'forbidden-paths',
    passed: !matchedForbiddenPath,
    detail: matchedForbiddenPath ? `mention of "${matchedForbiddenPath}"` : undefined,
  });
  checks.push({
    name: 'user-gate-topic',
    passed: !matchedGateTopic,
    detail: matchedGateTopic ? `topic "${matchedGateTopic}" triggers user gate` : undefined,
  });

  // 5) Structural rejection wins over everything else.
  // Phase 5E — ultraqa's missing validation commands also count as structural.
  // Phase 6-C — pipeline / ultraqa modes additionally reject when an API or
  // DB-impact plan is missing its contract / database task.
  const validationCheck = checks.find(c => c.name === 'validation-commands');
  const validationFailed = validationCheck ? !validationCheck.passed : false;
  const strictContractMissing = strictMode && needsContract;
  const strictDbMissing = strictMode && needsDatabase;
  const rejected = !allAssigned || !allHaveAC || validationFailed
    || strictContractMissing || strictDbMissing;
  if (rejected) {
    if (validationFailed) {
      notes.push('ultraqa mode requires validation commands');
    }
    if (strictContractMissing) {
      notes.push(`${mode} mode requires a contract-agent task for FE/BE API work`);
    }
    if (strictDbMissing) {
      notes.push(`${mode} mode requires a database-agent task for DB-impact work`);
    }
    return {
      approvalState: 'rejected',
      shouldApprove: false,
      needsUserGate: false,
      rejected: true,
      checks,
      notes,
    };
  }

  // 6) User gate triggers when either gated topic OR risk is high/critical
  //    OR a forbidden-path mention is present.
  // Phase 5E — manual mode's `approvalGateAlwaysOn` forces the gate even when
  // none of the other signals fire. We never relax an existing gate from this
  // path — only add one when manual policy is on.
  let needsUserGate = !!matchedGateTopic || riskHigh || !!matchedForbiddenPath;
  let modeGateApplied = false;
  if (!needsUserGate && modePolicy.approvalGateAlwaysOn) {
    needsUserGate = true;
    modeGateApplied = true;
  }
  if (needsUserGate) {
    const topic = matchedGateTopic
      ? `gate:${matchedGateTopic}`
      : matchedForbiddenPath
      ? `forbidden:${matchedForbiddenPath}`
      : modeGateApplied
      ? `mode:${mode}`
      : `risk:${risk}`;
    if (modeGateApplied) {
      notes.push('manual mode requires explicit approval');
    }
    return {
      approvalState: 'pending',
      shouldApprove: false,
      needsUserGate: true,
      rejected: false,
      topic,
      checks,
      notes,
    };
  }

  // 7) Conditional vs auto-approved
  const conditional = risk === 'medium';
  if (conditional) notes.push('medium-risk plan auto-approved with condition');
  return {
    approvalState: conditional ? 'conditional' : 'auto_approved',
    shouldApprove: true,
    needsUserGate: false,
    rejected: false,
    checks,
    notes,
  };
}

/* ============================================================================
 * Side-effecting orchestration — call this from IPC / orchestrator code.
 * ========================================================================== */

export interface ValidatePlanResult {
  verdict: ValidationVerdict;
  approvalRequestId: string | null;
  mirroredMdPath: string | null;
}

export function validatePlan(planId: string): ValidatePlanResult | null {
  const plan = getPlan(planId);
  if (!plan) return null;
  const verdict = evaluatePlan(plan);

  // 1) Create or update the structured ApprovalRequest row.
  const req = createApprovalRequest({
    runId: plan.runId,
    planId: plan.id,
    riskLevel: highestRisk(plan),
    topic: verdict.topic ?? null,
    state: 'pending',
  });

  let mirroredMdPath: string | null = null;

  if (req) {
    // Move it to the final decision state (auto path) immediately, so the UI
    // doesn't see a fleeting 'pending' for already-decided ones.
    if (verdict.approvalState !== 'pending') {
      decideApprovalRequest({
        id: req.id,
        state: verdict.approvalState,
        decidedBy: 'policy',
        decisionNote: verdict.notes.join('; ') || undefined,
      });
    }

    // 2) Mirror to triplan/approvals/*.md, best-effort. Failures are logged
    //    and do not affect the structured decision.
    mirroredMdPath = mirrorDecisionToMd(plan, verdict);
  }

  // 3) Transition Plan.state and Run.state.
  if (verdict.rejected) {
    updatePlan({ id: plan.id, state: 'rejected', rejectionReason: verdict.checks.filter(c => !c.passed).map(c => c.detail).join('; ') });
    // We deliberately do NOT auto-fail the Run — Phase 3 leaves the Run in
    // 'planned' so the user / planner can retry with a cleaner Plan.
  } else if (verdict.needsUserGate) {
    updatePlan({ id: plan.id, state: 'pending' });
    const run = getRun(plan.runId);
    if (run && run.state === 'planned') {
      updateRunState(plan.runId, 'approval_required');
    }
  } else {
    updatePlan({ id: plan.id, state: 'approved' });
    const run = getRun(plan.runId);
    if (run && (run.state === 'planned' || run.state === 'approval_required')) {
      updateRunState(plan.runId, 'approved');
    }
  }

  return { verdict, approvalRequestId: req?.id ?? null, mirroredMdPath };
}

/* ============================================================================
 * Helpers
 * ========================================================================== */

function highestRisk(plan: Plan): Priority {
  const order: Priority[] = ['low', 'medium', 'high', 'critical'];
  let best: Priority = plan.riskLevel ?? 'low';
  for (const t of plan.tasks ?? []) {
    const r = t.estimatedRiskLevel ?? 'low';
    if (order.indexOf(r) > order.indexOf(best)) best = r;
  }
  return best;
}

function renderHaystack(plan: Plan): string {
  const parts: string[] = [];
  parts.push(plan.title ?? '', plan.description ?? '');
  for (const t of plan.tasks ?? []) {
    parts.push(t.title ?? '', t.description ?? '', ...(t.acceptanceCriteria ?? []));
  }
  return parts.join('\n');
}

function mirrorDecisionToMd(plan: Plan, verdict: ValidationVerdict): string | null {
  let targetName: string;
  switch (verdict.approvalState) {
    case 'auto_approved':
    case 'conditional':
      targetName = 'approved-decisions.md';
      break;
    case 'pending':
      targetName = 'pending-approvals.md';
      break;
    case 'rejected':
    case 'expired':
    case 'user_approved':
      // user_approved / expired / rejected are written when the user acts;
      // initial mirror handles only the validator-side decisions.
      targetName = verdict.approvalState === 'rejected' ? 'rejected-decisions.md' : 'approved-decisions.md';
      break;
    default:
      targetName = 'pending-approvals.md';
  }

  const dir = approvalsDir();
  const filePath = path.join(dir, targetName);
  try {
    if (!fs.existsSync(dir)) return null; // not a triplan workspace — silently skip

    const stamp = new Date().toISOString();
    const head = verdict.approvalState.toUpperCase();
    const reason = verdict.checks.filter(c => !c.passed).map(c => `${c.name}: ${c.detail ?? 'failed'}`).join('; ');
    const line = `- [${stamp}] ${head} plan=${plan.id} run=${plan.runId} risk=${highestRisk(plan)}` +
                 (verdict.topic ? ` topic=${verdict.topic}` : '') +
                 (reason ? ` reason="${reason}"` : '') + '\n';

    fs.appendFileSync(filePath, line, { encoding: 'utf8' });
    return filePath;
  } catch (err) {
    console.warn('[plan-validator] md mirror failed (ignored):', err);
    return null;
  }
}

// Tiny helper kept around for the IPC handler so it can pretty-print checks.
export function summarizeVerdict(v: ValidationVerdict): string {
  const passes = v.checks.filter(c => c.passed).length;
  const total = v.checks.length;
  return `${v.approvalState} — ${passes}/${total} checks passed`
       + (v.topic ? ` (topic=${v.topic})` : '')
       + (v.notes.length ? ` — ${v.notes.join('; ')}` : '');
}

// Sanity nullable import escape so unused `os` doesn't get tree-shaken at
// transpile time on platforms that need it.
void os;
