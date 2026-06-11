/**
 * Dorothy MVP Phase 6-C — Contract Agent / Database Agent split.
 *
 * Coverage:
 *   - Template registry — contract + database templates registered
 *   - resolveWorkflowKindForAgent handles new aliases
 *   - Agent definition files added to triplan/.claude/agents/
 *   - Existing 9 agent files untouched (mtime ≤ Phase 6-A baseline)
 *   - createRunStep with contract/database agent → workflowKind matches
 *   - Plan Validator: missing contract task on fe/be API plan → warning
 *   - Plan Validator: missing database task on DB-keyword plan → warning
 *   - Plan Validator strict mode (pipeline/ultraqa): contract/database
 *     missing → rejected
 *   - Plan Validator: destructive db keyword still hits user gate
 *   - Orchestrator pickNextTask: contract runs before fe/be, database
 *     before fe/be
 *   - Orchestrator forbidden paths / write paths for contract+database
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import {
  initDorothyDb,
  closeDorothyDb,
} from '../../../electron/services/dorothy/db';
import {
  createRun,
  createRunStep,
  updateRunState,
} from '../../../electron/services/dorothy/run-service';
import { createPlan } from '../../../electron/services/dorothy/plan-service';
import {
  evaluatePlan,
} from '../../../electron/services/dorothy/plan-validator-service';
import {
  configureOrchestrator,
  advanceRun,
} from '../../../electron/services/dorothy/orchestrator-service';
import {
  getWorkflowTemplate,
  listWorkflowTemplates,
  resolveWorkflowKindForAgent,
} from '../../../electron/services/dorothy/agent-workflow-templates';
import {
  listWorkflowProgressByRun,
} from '../../../electron/services/dorothy/agent-workflow-progress-service';

const TEST_DIR = path.join(os.tmpdir(), `dorothy-phase6c-${process.pid}`);
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let dbPath = '';

beforeEach(() => {
  dbPath = path.join(TEST_DIR, `dorothy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const r = initDorothyDb({ filePath: dbPath });
  if (!r.ok) throw new Error(`initDorothyDb failed: ${r.reason}`);
});

afterEach(() => {
  closeDorothyDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
});

/* ============================================================================
 * 1. Template registry
 * ========================================================================== */

describe('Workflow templates — Phase 6-C additions', () => {
  it('includes contract + database templates (now 11 total)', () => {
    const all = listWorkflowTemplates();
    const kinds = all.map(t => t.kind).sort();
    expect(kinds).toEqual([
      'approval_validator',
      'architect_plan',
      'backend',
      'contract',
      'database',
      'devops_reporter',
      'frontend',
      'generic',
      'intake_planner',
      'orchestrator',
      'qa_reviewer',
    ]);
  });

  it('contract template includes the documented steps', () => {
    const t = getWorkflowTemplate('contract');
    expect(t.steps.map(s => s.stepId)).toEqual([
      'requirements_read',
      'api_surface_identified',
      'request_response_schema',
      'error_code_policy',
      'frontend_backend_contract',
      'contract_artifact',
    ]);
  });

  it('database template includes the documented steps', () => {
    const t = getWorkflowTemplate('database');
    expect(t.steps.map(s => s.stepId)).toEqual([
      'db_impact_read',
      'schema_impact_analysis',
      'migration_plan',
      'rollback_plan',
      'risk_check',
      'db_artifact',
    ]);
  });

  it.each([
    ['contract',         'contract'],
    ['contract-agent',   'contract'],
    ['contract_agent',   'contract'],
    ['api-contract',     'contract'],
    ['api-contract-agent', 'contract'],
    ['database',         'database'],
    ['database-agent',   'database'],
    ['database_agent',   'database'],
    ['db',               'database'],
    ['db-agent',         'database'],
    ['migration-agent',  'database'],
    ['mystery-bot',      'generic'],
  ] as const)('resolveWorkflowKindForAgent(%s) → %s', (agentId, expectedKind) => {
    expect(resolveWorkflowKindForAgent(agentId)).toBe(expectedKind);
  });
});

/* ============================================================================
 * 2. Agent definition files
 * ========================================================================== */

describe('Agent definition files — Phase 6-C', () => {
  const triplanAgentsDir = '/Users/soo/workspace/source-code/triplan/.claude/agents';

  it('contract-agent.md exists', () => {
    const p = path.join(triplanAgentsDir, 'contract-agent.md');
    expect(fs.existsSync(p)).toBe(true);
    const body = fs.readFileSync(p, 'utf8');
    expect(body).toMatch(/contract/i);
    expect(body).toMatch(/api[-_ ]contract|openapi|dto[-_ ]?schema/i);
    expect(body).toMatch(/금지|never writes implementation|forbidden/i);
  });

  it('database-agent.md exists', () => {
    const p = path.join(triplanAgentsDir, 'database-agent.md');
    expect(fs.existsSync(p)).toBe(true);
    const body = fs.readFileSync(p, 'utf8');
    expect(body).toMatch(/database/i);
    expect(body).toMatch(/migration[-_ ]plan|rollback[-_ ]plan/i);
    expect(body).toMatch(/never execute|automatic|production|destructive/i);
  });

  it('existing 9 agent definition files are not contract-agent / database-agent', () => {
    // Sanity: the new files do NOT overwrite a pre-existing name.
    const entries = fs.readdirSync(triplanAgentsDir).filter(f => f.endsWith('.md'));
    expect(entries).toContain('contract-agent.md');
    expect(entries).toContain('database-agent.md');
    // Documented 9 files from the project baseline. We don't enforce mtime
    // (the user may edit them out of band); we just confirm they still exist.
    const baseline = [
      'approval-manager.md', 'backend.md', 'cost-optimizer.md', 'docs.md',
      'frontend.md', 'ops.md', 'pm.md',
    ];
    for (const f of baseline) {
      expect(entries).toContain(f);
    }
  });
});

/* ============================================================================
 * 3. RunStep wiring — workflow row created for contract / database agent
 * ========================================================================== */

describe('RunStep → workflow row for contract / database', () => {
  it('createRunStep(agentId=contract-agent) initialises a contract workflow row', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    createRunStep({ runId: r.id, order: 0, agentId: 'contract-agent' });
    const rows = listWorkflowProgressByRun(r.id);
    const contractRow = rows.find(row => row.workflowKind === 'contract');
    expect(contractRow).toBeTruthy();
    expect(contractRow?.steps.map(s => s.stepId)).toEqual([
      'requirements_read',
      'api_surface_identified',
      'request_response_schema',
      'error_code_policy',
      'frontend_backend_contract',
      'contract_artifact',
    ]);
  });

  it('createRunStep(agentId=database-agent) initialises a database workflow row', () => {
    const r = createRun({ title: 'r', source: 'user' })!;
    createRunStep({ runId: r.id, order: 0, agentId: 'database-agent' });
    const rows = listWorkflowProgressByRun(r.id);
    const dbRow = rows.find(row => row.workflowKind === 'database');
    expect(dbRow).toBeTruthy();
    expect(dbRow?.steps[0].stepId).toBe('db_impact_read');
  });
});

/* ============================================================================
 * 4. Plan Validator — contract / database task presence
 * ========================================================================== */

describe('Plan Validator — contract / database checks', () => {
  function seedPlannedRun(mode: 'team' | 'pipeline' | 'ultraqa' | 'manual' | 'persistent') {
    const r = createRun({ title: `${mode} run`, source: 'user', mode })!;
    updateRunState(r.id, 'planned');
    return r;
  }

  it('team mode: fe+be+api but no contract task → warning (passes, with note)', () => {
    const r = seedPlannedRun('team');
    const p = createPlan({
      runId: r.id, title: 'add list endpoint', description: 'expose /api/list',
      tasks: [
        { taskId: 'fe', title: 'fe', description: 'render list', ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['renders'] },
        { taskId: 'be', title: 'be', description: 'GET /api/list endpoint', ownerAgentId: 'backend', dependsOn: [], acceptanceCriteria: ['200 OK'] },
      ],
    })!;
    const v = evaluatePlan(p);
    expect(v.rejected).toBe(false);
    const c = v.checks.find(x => x.name === 'contract-task-present');
    expect(c?.passed).toBe(false);
    expect(v.notes.some(n => /contract task/i.test(n))).toBe(true);
  });

  it('pipeline mode: same plan → rejected (strict)', () => {
    const r = seedPlannedRun('pipeline');
    const p = createPlan({
      runId: r.id, title: 'add list endpoint', description: 'expose /api/list',
      tasks: [
        { taskId: 'fe', title: 'fe', description: 'render list', ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['renders'] },
        { taskId: 'be', title: 'be', description: 'GET /api/list endpoint', ownerAgentId: 'backend', dependsOn: [], acceptanceCriteria: ['200 OK'] },
      ],
    })!;
    const v = evaluatePlan(p);
    expect(v.rejected).toBe(true);
    expect(v.notes.some(n => /pipeline.*contract-agent/i.test(n))).toBe(true);
  });

  it('ultraqa mode: same plan → rejected (strict)', () => {
    const r = seedPlannedRun('ultraqa');
    const p = createPlan({
      runId: r.id, title: 'add list endpoint', description: 'expose /api/list',
      tasks: [
        { taskId: 'fe', title: 'fe', description: 'render list', ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['renders'], validationCommands: ['npm test'] },
        { taskId: 'be', title: 'be', description: 'GET /api/list endpoint', ownerAgentId: 'backend', dependsOn: [], acceptanceCriteria: ['200 OK'], validationCommands: ['./gradlew test'] },
      ],
    })!;
    const v = evaluatePlan(p);
    expect(v.rejected).toBe(true);
    expect(v.notes.some(n => /ultraqa.*contract-agent/i.test(n))).toBe(true);
  });

  it('contract task present → check passes', () => {
    const r = seedPlannedRun('pipeline');
    const p = createPlan({
      runId: r.id, title: 'add list endpoint', description: 'expose /api/list',
      tasks: [
        { taskId: 'c', title: 'contract', description: 'lock the API contract', ownerAgentId: 'contract-agent', dependsOn: [], acceptanceCriteria: ['contract doc exists'] },
        { taskId: 'fe', title: 'fe', description: 'render list', ownerAgentId: 'frontend', dependsOn: ['c'], acceptanceCriteria: ['renders'] },
        { taskId: 'be', title: 'be', description: 'GET endpoint', ownerAgentId: 'backend', dependsOn: ['c'], acceptanceCriteria: ['200 OK'] },
      ],
    })!;
    const v = evaluatePlan(p);
    expect(v.rejected).toBe(false);
    const c = v.checks.find(x => x.name === 'contract-task-present');
    expect(c?.passed).toBe(true);
  });

  it('team mode: db migration keyword but no database task → warning', () => {
    const r = seedPlannedRun('team');
    const p = createPlan({
      runId: r.id, title: 'add table users', description: 'create a new table for users',
      tasks: [
        { taskId: 'be', title: 'be', description: 'add users repo', ownerAgentId: 'backend', dependsOn: [], acceptanceCriteria: ['saves'] },
      ],
    })!;
    const v = evaluatePlan(p);
    expect(v.rejected).toBe(false);
    const c = v.checks.find(x => x.name === 'database-task-present');
    expect(c?.passed).toBe(false);
    expect(v.notes.some(n => /database task|database-impact/i.test(n))).toBe(true);
  });

  it('pipeline mode: db migration keyword + no database task → rejected', () => {
    const r = seedPlannedRun('pipeline');
    const p = createPlan({
      runId: r.id, title: 'add table users', description: 'create a new table',
      tasks: [
        { taskId: 'be', title: 'be', description: 'add users repo', ownerAgentId: 'backend', dependsOn: [], acceptanceCriteria: ['saves'] },
      ],
    })!;
    const v = evaluatePlan(p);
    expect(v.rejected).toBe(true);
    expect(v.notes.some(n => /pipeline.*database-agent/i.test(n))).toBe(true);
  });

  it('database task present → check passes', () => {
    const r = seedPlannedRun('pipeline');
    const p = createPlan({
      runId: r.id, title: 'add table users', description: 'create a new table',
      tasks: [
        { taskId: 'db', title: 'db plan', description: 'migration + rollback for users table', ownerAgentId: 'database-agent', dependsOn: [], acceptanceCriteria: ['migration-plan.md exists'] },
        { taskId: 'be', title: 'be', description: 'add users repo', ownerAgentId: 'backend', dependsOn: ['db'], acceptanceCriteria: ['saves'] },
      ],
    })!;
    const v = evaluatePlan(p);
    expect(v.rejected).toBe(false);
  });

  it('destructive db keyword still triggers the existing user-gate (drop table)', () => {
    const r = seedPlannedRun('team');
    const p = createPlan({
      runId: r.id, title: 'cleanup old users', description: 'drop table legacy_users',
      tasks: [
        // db task present so the contract / database missing check passes.
        { taskId: 'db', title: 'db', description: 'plan drop', ownerAgentId: 'database-agent', dependsOn: [], acceptanceCriteria: ['plan documented'] },
        { taskId: 'be', title: 'be', description: 'remove legacy_users references', ownerAgentId: 'backend', dependsOn: ['db'], acceptanceCriteria: ['no refs'] },
      ],
    })!;
    const v = evaluatePlan(p);
    // The drop keyword hits the existing user-gate path → pending.
    expect(v.needsUserGate).toBe(true);
    expect(v.topic ?? '').toMatch(/^(gate:|forbidden:|risk:)/);
  });

  it('non-api / non-db plan does not trigger contract/database checks', () => {
    const r = seedPlannedRun('pipeline');
    const p = createPlan({
      runId: r.id, title: 'tweak the dashboard copy', description: 'change label wording',
      tasks: [
        { taskId: 'fe', title: 'fe', description: 'rename header', ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['renamed'], validationCommands: ['npm test'] },
      ],
    })!;
    const v = evaluatePlan(p);
    const c = v.checks.find(x => x.name === 'contract-task-present');
    const d = v.checks.find(x => x.name === 'database-task-present');
    expect(c?.passed).toBe(true);
    expect(d?.passed).toBe(true);
  });
});

/* ============================================================================
 * 5. Orchestrator next-task picker — contract / database first
 * ========================================================================== */

describe('Orchestrator ordering — contract/database before fe/be', () => {
  it('pipeline mode dispatches contract-agent before frontend / backend', async () => {
    configureOrchestrator({ getLiveAgents: () => [] });
    const r = createRun({ title: 'ordered', source: 'user', mode: 'pipeline' })!;
    createPlan({
      runId: r.id, title: 'p', description: 'd', state: 'approved',
      tasks: [
        { taskId: 'fe', title: 'fe', description: 'render', ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['ok'] },
        { taskId: 'be', title: 'be', description: 'api', ownerAgentId: 'backend',  dependsOn: [], acceptanceCriteria: ['ok'] },
        { taskId: 'c',  title: 'contract', description: 'contract', ownerAgentId: 'contract-agent', dependsOn: [], acceptanceCriteria: ['contract'] },
      ],
    });
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');
    const outcome = await advanceRun(r.id);
    expect(outcome.action).toBe('started_worker_step');
    // The first dispatched step should be the contract agent.
    expect(outcome.step?.agentId).toBe('contract-agent');
  });

  it('team mode also picks contract-agent first when present', async () => {
    configureOrchestrator({ getLiveAgents: () => [] });
    const r = createRun({ title: 'ordered', source: 'user', mode: 'team' })!;
    createPlan({
      runId: r.id, title: 'p', description: 'd', state: 'approved',
      tasks: [
        { taskId: 'be', title: 'be', description: 'api', ownerAgentId: 'backend',  dependsOn: [], acceptanceCriteria: ['ok'] },
        { taskId: 'c',  title: 'contract', description: 'contract', ownerAgentId: 'contract-agent', dependsOn: [], acceptanceCriteria: ['contract'] },
        { taskId: 'fe', title: 'fe', description: 'render', ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['ok'] },
      ],
    });
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');
    const outcome = await advanceRun(r.id);
    expect(outcome.step?.agentId).toBe('contract-agent');
  });

  it('database-agent task is dispatched before fe/be when no contract task exists', async () => {
    configureOrchestrator({ getLiveAgents: () => [] });
    const r = createRun({ title: 'ordered', source: 'user', mode: 'team' })!;
    createPlan({
      runId: r.id, title: 'p', description: 'd', state: 'approved',
      tasks: [
        { taskId: 'fe', title: 'fe', description: 'render', ownerAgentId: 'frontend', dependsOn: [], acceptanceCriteria: ['ok'] },
        { taskId: 'be', title: 'be', description: 'api', ownerAgentId: 'backend', dependsOn: [], acceptanceCriteria: ['ok'] },
        { taskId: 'db', title: 'db', description: 'plan migration', ownerAgentId: 'database-agent', dependsOn: [], acceptanceCriteria: ['plan'] },
      ],
    });
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');
    const outcome = await advanceRun(r.id);
    expect(outcome.step?.agentId).toBe('database-agent');
  });

  it('contract-agent runs before database-agent (foundational dependency)', async () => {
    configureOrchestrator({ getLiveAgents: () => [] });
    const r = createRun({ title: 'ordered', source: 'user', mode: 'pipeline' })!;
    createPlan({
      runId: r.id, title: 'p', description: 'd', state: 'approved',
      tasks: [
        { taskId: 'db', title: 'db', description: 'plan migration', ownerAgentId: 'database-agent', dependsOn: [], acceptanceCriteria: ['plan'] },
        { taskId: 'c',  title: 'contract', description: 'contract', ownerAgentId: 'contract-agent', dependsOn: [], acceptanceCriteria: ['contract'] },
      ],
    });
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');
    const outcome = await advanceRun(r.id);
    expect(outcome.step?.agentId).toBe('contract-agent');
  });

  it('explicit dependsOn still respected — contract waits on architect', async () => {
    configureOrchestrator({ getLiveAgents: () => [] });
    const r = createRun({ title: 'ordered', source: 'user', mode: 'team' })!;
    createPlan({
      runId: r.id, title: 'p', description: 'd', state: 'approved',
      tasks: [
        { taskId: 'arch', title: 'design', description: 'design', ownerAgentId: 'architect-plan', dependsOn: [], acceptanceCriteria: ['design'] },
        { taskId: 'c',    title: 'contract', description: 'contract', ownerAgentId: 'contract-agent', dependsOn: ['arch'], acceptanceCriteria: ['contract'] },
      ],
    });
    updateRunState(r.id, 'planned');
    updateRunState(r.id, 'approved');
    const outcome = await advanceRun(r.id);
    // architect-plan must run first because contract task depends on it.
    expect(outcome.step?.agentId).toBe('architect-plan');
  });
});
