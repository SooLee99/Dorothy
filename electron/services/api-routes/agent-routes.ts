import * as path from 'path';
import * as fs from 'fs';
import * as pty from 'node-pty';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { agents, saveAgents, reloadAgentsFromDisk } from '../../core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../../core/pty-manager';
import {
  buildAgentTerminalSnapshot,
  buildBaselineSnapshots,
  isSnapshotBaselineAgent,
  maskLine,
  terminalLines,
  type AgentLike,
} from '../../core/terminal-output-mask';
import { buildFullPath } from '../../utils/path-builder';
import { recordStart, recordOutput, recordExit } from '../../core/observability/session-metrics';
import { AgentStatus, AgentCharacter } from '../../types';
import { RouteApp, RouteContext } from './types';

export function registerAgentRoutes(app_: RouteApp, ctx: RouteContext): void {
  // GET /api/agents/:id/wait — long-poll until agent status changes
  app_.get(/^\/api\/agents\/([^/]+)\/wait$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    const timeoutSec = parseInt(req.url.searchParams.get('timeout') || '300', 10);
    const currentStatus = agent.status;

    // Return immediately if already in terminal state
    if (currentStatus === 'completed' || currentStatus === 'error' || currentStatus === 'idle' || currentStatus === 'waiting') {
      sendJson({
        status: agent.status,
        lastCleanOutput: agent.lastCleanOutput,
        error: agent.error,
      });
      return;
    }

    // Long-poll: wait for status change event
    const agentId = req.params.id;
    let resolved = false;

    const respond = () => {
      if (resolved) return;
      resolved = true;
      const a = agents.get(agentId);
      sendJson({
        status: a?.status || 'idle',
        lastCleanOutput: a?.lastCleanOutput,
        error: a?.error,
      });
    };

    const onStatusChange = () => respond();
    ctx.agentStatusEmitter.on(`status:${agentId}`, onStatusChange);

    const timeout = setTimeout(() => {
      ctx.agentStatusEmitter.off(`status:${agentId}`, onStatusChange);
      if (!resolved) {
        resolved = true;
        const a = agents.get(agentId);
        sendJson({
          status: a?.status || 'running',
          lastCleanOutput: a?.lastCleanOutput,
          timeout: true,
        });
      }
    }, timeoutSec * 1000);

    // Clean up if client disconnects
    req.raw.on('close', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        ctx.agentStatusEmitter.off(`status:${agentId}`, onStatusChange);
      }
    });
  });

  // GET /api/agents
  app_.get('/api/agents', (req, sendJson) => {
    const agentList = Array.from(agents.values()).map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
      projectPath: a.projectPath,
      secondaryProjectPath: a.secondaryProjectPath,
      skills: a.skills,
      currentTask: a.currentTask,
      lastActivity: a.lastActivity,
      character: a.character,
      branchName: a.branchName,
      error: a.error,
    }));
    sendJson({ agents: agentList });
  });

  // GET /api/agents/terminal-snapshots — MUST be registered before the
  // `/api/agents/:id` regex (first-match wins) or :id would swallow it.
  // Phase 6-AE — read-only, masked snapshots for the 11 baseline operation
  // agents (legacy UUID / codex+opus excluded). Always returns 11 slots.
  app_.get('/api/agents/terminal-snapshots', (req, sendJson) => {
    const cap = Math.min(2000, Math.max(1, parseInt(req.url.searchParams.get('lines') || '200', 10)));
    const byId = new Map<string, AgentLike>();
    for (const a of agents.values()) {
      if (typeof a.id === 'string' && a.id) byId.set(a.id, a as AgentLike);
    }
    const updatedAt = new Date().toISOString();
    sendJson({ snapshots: buildBaselineSnapshots(byId, updatedAt, cap), updatedAt });
  });

  // GET /api/agents/:id
  app_.get(/^\/api\/agents\/([^/]+)$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    sendJson({ agent });
  });

  // GET /api/agents/:id/output
  // Phase 6-AE — read-only + SECRET-MASKED. Returns both the masked joined
  // string (back-compat) and a masked, ANSI-stripped outputLines[] array.
  app_.get(/^\/api\/agents\/([^/]+)\/output$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    const lines = parseInt(req.url.searchParams.get('lines') || '100', 10);
    // Phase 6-V — slug/file-based agents may have no output array yet.
    const raw = (agent.output ?? []).slice(-lines).join('');
    const output = maskLine(raw);
    sendJson({ output, outputLines: terminalLines(agent.output, lines), status: agent.status, masked: true });
  });

  // GET /api/agents/:id/terminal-snapshot — single baseline agent (404 if not baseline)
  app_.get(/^\/api\/agents\/([^/]+)\/terminal-snapshot$/, (req, sendJson) => {
    const id = req.params.id;
    if (!isSnapshotBaselineAgent(id)) {
      sendJson({ error: 'Not a managed operation agent' }, 404);
      return;
    }
    const cap = Math.min(2000, Math.max(1, parseInt(req.url.searchParams.get('lines') || '200', 10)));
    const agent = agents.get(id) as AgentLike | undefined;
    const updatedAt = new Date().toISOString();
    sendJson({ snapshot: buildAgentTerminalSnapshot(id, agent, updatedAt, cap), updatedAt });
  });

  // POST /api/agents
  app_.post('/api/agents', (req, sendJson) => {
    const { projectPath, name, skills = [], character, permissionMode, secondaryProjectPath } = req.body as {
      projectPath: string;
      name?: string;
      skills?: string[];
      character?: AgentCharacter;
      permissionMode?: 'normal' | 'auto' | 'bypass';
      secondaryProjectPath?: string;
    };

    if (!projectPath) {
      sendJson({ error: 'projectPath is required' }, 400);
      return;
    }

    const id = uuidv4();
    const agent: AgentStatus = {
      id,
      status: 'idle',
      projectPath,
      secondaryProjectPath,
      skills,
      output: [],
      lastActivity: new Date().toISOString(),
      character,
      name: name || `Agent ${id.slice(0, 6)}`,
      permissionMode: permissionMode || 'auto',
    };
    agents.set(id, agent);
    saveAgents();
    sendJson({ agent });
  });

  // POST /api/agents/reload-from-disk — Phase 6-AQ: agents.json 디스크 변경을
  // in-memory 맵으로 반영(헤드리스). PM-tick 의 fallback/restore 후 호출용.
  // reloadAgentsFromDisk 는 활성 PTY 세션을 보존하며 정의만 갱신한다.
  app_.post('/api/agents/reload-from-disk', async (req, sendJson) => {
    try {
      const reason = (req.body as { reason?: string } | undefined)?.reason || 'api';
      // ★mergeMetadataForExisting: true — 기존 에이전트의 안전 메타(provider/model 등)를 디스크에서 갱신.
      //   (이게 없으면 추가/삭제만 하고 provider 변경이 in-memory 에 반영 안 됨 — orchestrator claude 전환 불가)
      const result = await reloadAgentsFromDisk({ reason, mergeMetadataForExisting: true });
      sendJson({ ok: true, result });
    } catch (err) {
      sendJson({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // POST /api/agents/:id/start
  app_.post(/^\/api\/agents\/([^/]+)\/start$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    const { prompt, model, permissionMode: bodyPermissionMode, printMode } = req.body as {
      prompt: string; model?: string; permissionMode?: 'normal' | 'auto' | 'bypass'; printMode?: boolean;
    };
    if (!prompt) {
      sendJson({ error: 'prompt is required' }, 400);
      return;
    }

    const workingDir = (agent.worktreePath || agent.projectPath).replace(/'/g, "'\\''");
    const provider = (agent.provider || 'claude') as 'claude' | 'codex' | string;
    void bodyPermissionMode; // 정책: 항상 자율 모드(아래에서 provider 별로 강제 적용)

    const isAutomationAgent = agent.name?.toLowerCase().includes('automation:');
    const isSuperAgentApi = agent.name?.toLowerCase().includes('super agent') ||
                            agent.name?.toLowerCase().includes('orchestrator');
    const usePrintMode = printMode || isAutomationAgent;

    let command: string;
    if (provider === 'codex') {
      // OpenAI Codex CLI — 신뢰 프롬프트·승인·샌드박스 모두 우회(완전 자율).
      // 인터랙티브 모드에서 디렉토리 신뢰 프롬프트("Do you trust...")가 살아 있어
      // --dangerously-bypass-approvals-and-sandbox 로 통째 우회한다.
      command = `cd '${workingDir}' && codex --dangerously-bypass-approvals-and-sandbox`;
      if (agent.secondaryProjectPath) {
        command += ` --cd '${agent.secondaryProjectPath.replace(/'/g, "'\\''")}'`;
      }
      // claude-only 모델명(opus/sonnet/haiku/claude-*)은 codex 로 넘기지 않음(전형적 혼선 방지).
      const resolvedModel = model || agent.model;
      if (resolvedModel && !/^(opus|sonnet|haiku|claude(-|$))/i.test(resolvedModel)) {
        if (!/^[a-zA-Z0-9._:/-]+$/.test(resolvedModel)) {
          sendJson({ error: 'Invalid model name' }, 400);
          return;
        }
        command += ` --model '${resolvedModel}'`;
      }
      if (usePrintMode) command += ' exec';
    } else {
      // Anthropic Claude Code — 항상 --dangerously-skip-permissions (자율).
      command = `cd '${workingDir}' && claude`;
      if (usePrintMode) command += ' -p';
      if (isSuperAgentApi || isAutomationAgent) {
        const mcpConfigPath = path.join(app.getPath('home'), '.claude', 'mcp.json');
        if (fs.existsSync(mcpConfigPath)) {
          command += ` --mcp-config '${mcpConfigPath}'`;
        }
      }
      if (agent.secondaryProjectPath) {
        command += ` --add-dir '${agent.secondaryProjectPath.replace(/'/g, "'\\''")}'`;
      }
      command += ' --dangerously-skip-permissions';
      const resolvedModel = model || agent.model;
      if (resolvedModel) {
        if (!/^[a-zA-Z0-9._:/-]+$/.test(resolvedModel)) {
          sendJson({ error: 'Invalid model name' }, 400);
          return;
        }
        command += ` --model '${resolvedModel}'`;
      }
    }

    let finalPrompt = prompt;
    if (agent.skills && agent.skills.length > 0 && !isSuperAgentApi) {
      const skillsList = agent.skills.join(', ');
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${skillsList}. Invoke them with /<skill-name> when relevant to the task.] ${prompt}`;
    }
    command += ` '${finalPrompt.replace(/'/g, "'\\''")}'`;

    const shell = '/bin/bash';
    const fullPath = buildFullPath();

    const ptyProcess = pty.spawn(shell, ['-l', '-c', command], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: workingDir,
      env: {
        ...process.env,
        PATH: fullPath,
        TERM: 'xterm-256color',
        CLAUDE_SKILLS: agent.skills?.join(',') || '',
        CLAUDE_AGENT_ID: agent.id,
        CLAUDE_PROJECT_PATH: agent.projectPath,
      },
    });

    const ptyId = uuidv4();
    ptyProcesses.set(ptyId, ptyProcess);
    recordStart(ptyId, agent.id, ptyProcess.pid); // PR-0a — 세션 계측 시작

    agent.ptyId = ptyId;
    agent.status = 'running';
    agent.currentTask = prompt;
    agent.output = [];
    agent.lastCleanOutput = undefined;  // Clear stale output from previous task
    agent.error = undefined;            // Clear previous error state
    agent.lastActivity = new Date().toISOString();
    saveAgents();

    ptyProcess.onData((data: string) => {
      recordOutput(ptyId, data); // PR-0a — O(1) 계측
      agent.output.push(data);
      if (agent.output.length > 10000) {
        agent.output = agent.output.slice(-5000);
      }
      agent.lastActivity = new Date().toISOString();

      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('agent:output', { agentId: agent.id, data });
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      recordExit(ptyId, exitCode); // PR-0a — 종료 계측(즉시, setTimeout 밖)
      // Delay status change to let hooks (on-stop.sh, task-completed.sh) finish
      // capturing output before wait_for_agent resolves.
      setTimeout(() => {
        if (agent.status === 'running') {
          agent.status = exitCode === 0 ? 'completed' : 'error';
        }
        if (exitCode !== 0) {
          agent.error = `Process exited with code ${exitCode}`;
        }
        agent.lastActivity = new Date().toISOString();
        ptyProcesses.delete(ptyId);
        saveAgents();
        ctx.agentStatusEmitter.emit(`status:${agent.id}`);
      }, 1500);
    });

    sendJson({ success: true, agent: { id: agent.id, status: agent.status } });
  });

  // POST /api/agents/:id/stop
  app_.post(/^\/api\/agents\/([^/]+)\/stop$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    if (agent.ptyId) {
      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcesses.delete(agent.ptyId);
      }
    }
    agent.status = 'idle';
    agent.currentTask = undefined;
    agent.lastActivity = new Date().toISOString();
    saveAgents();
    ctx.agentStatusEmitter.emit(`status:${agent.id}`);
    sendJson({ success: true });
  });

  // POST /api/agents/:id/message
  app_.post(/^\/api\/agents\/([^/]+)\/message$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    const { message } = req.body as { message: string };
    if (!message) {
      sendJson({ error: 'message is required' }, 400);
      return;
    }

    if (!agent.ptyId || !ptyProcesses.has(agent.ptyId)) {
      const ptyId = await ctx.initAgentPtyCallback(agent);
      agent.ptyId = ptyId;
    }

    const ptyProcess = ptyProcesses.get(agent.ptyId);
    if (ptyProcess) {
      writeProgrammaticInput(ptyProcess, message, true);
      agent.status = 'running';
      agent.lastActivity = new Date().toISOString();
      saveAgents();
      sendJson({ success: true });
      return;
    }
    sendJson({ error: 'Failed to send message - PTY not available' }, 500);
  });

  // DELETE /api/agents/:id
  app_.delete(/^\/api\/agents\/([^/]+)$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    if (agent.ptyId) {
      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcesses.delete(agent.ptyId);
      }
    }
    agents.delete(req.params.id);
    saveAgents();
    sendJson({ success: true });
  });
}
