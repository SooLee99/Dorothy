/**
 * Dorothy - Main Electron Entry Point
 *
 * This file initializes and wires together all the modular components:
 * - Window management and protocol handling
 * - Agent state and PTY management
 * - IPC handlers for renderer communication
 * - External services (Telegram, Slack, HTTP API)
 * - MCP orchestrator integration
 * - Scheduler for automated tasks
 */

import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Types
import type { AppSettings, AgentStatus } from './types';

// Constants
import { APP_SETTINGS_FILE } from './constants';

// Core modules
import {
  createWindow,
  registerProtocolSchemes,
  setupProtocolHandler,
  getMainWindow,
} from './core/window-manager';

import {
  agents,
  loadAgents,
  saveAgents,
  initAgentPty,
  handleStatusChangeNotification,
  getSuperAgentOutputBuffer,
  clearSuperAgentOutputBuffer,
  reloadAgentsFromDisk,
} from './core/agent-manager';

import {
  ptyProcesses,
  quickPtyProcesses,
  skillPtyProcesses,
  pluginPtyProcesses,
  killAllPty,
  writeProgrammaticInput,
} from './core/pty-manager';

import { initTray, destroyTray } from './core/tray-manager';
import { broadcastToAllWindows } from './utils/broadcast';
import { extractStatusLine } from './utils/ansi';
import { scheduleTick } from './utils/agents-tick';

// Services
import { startApiServer, getApiToken } from './services/api-server';
import { API_PORT } from './constants';
import {
  initTelegramBotService,
  initTelegramBot as initTelegramBotHandlers,
  getTelegramBot,
  sendTelegramMessage,
  sendSuperAgentResponseToTelegram,
} from './services/telegram-bot';
import {
  initSlackBot,
  getSlackApp,
  getSlackResponseChannel,
  getSlackResponseThreadTs,
} from './services/slack-bot';
import {
  getClaudeSettings,
  getClaudeStats,
  getClaudeProjects,
  getClaudePlugins,
  getClaudeSkills,
  getClaudeHistory,
} from './services/claude-service';
import { configureStatusHooks } from './services/hooks-manager';
import {
  setupMcpOrchestrator,
  registerMcpOrchestratorHandlers,
  getMcpOrchestratorPath,
} from './services/mcp-orchestrator';

// Handlers
import { registerIpcHandlers, IpcHandlerDependencies } from './handlers/ipc-handlers';
import { registerSchedulerHandlers } from './handlers/scheduler-handlers';
import { registerAutomationHandlers } from './handlers/automation-handlers';
import { registerCLIPathsHandlers } from './handlers/cli-paths-handlers';
import { registerKanbanHandlers } from './handlers/kanban-handlers';
import { registerVaultHandlers } from './handlers/vault-handlers';
import { registerWorldHandlers } from './handlers/world-handlers';
import { registerTemplateHandlers } from './handlers/template-handlers';
import { registerDorothyHandlers } from './handlers/dorothy-handlers';
import { startBusyLockMaintainer } from './core/busy-lock';
import { initVaultDb, closeVaultDb } from './services/vault-db';
import { initDorothyDb, closeDorothyDb } from './services/dorothy/db';
import { configureOrchestrator } from './services/dorothy/orchestrator-service';
import {
  configureAutoResume,
  startAutoResumeTicker,
  stopAutoResumeTicker,
  normalizeAutoResumeMode,
} from './services/dorothy/auto-resume-scheduler';
import { registerDorothyRunsHandlers } from './handlers/dorothy-runs-handler';
import { initAutoUpdater, checkForUpdates, setMainWindowGetter } from './services/update-checker';
import { initKanbanAutomation, findMatchingAgent, createAgentForTask, startAgentForTask } from './services/kanban-automation';

// Utils
import {
  setMainWindow as setUtilsMainWindow,
  sendNotification,
  isSuperAgent,
  getSuperAgent,
  ensureDataDir,
  ensureDorothyClaudeMd,
  migrateFromClaudeManager,
} from './utils';

// ============== App Settings Management ==============

let appSettings: AppSettings = loadAppSettings();

function loadAppSettings(): AppSettings {
  const defaults: AppSettings = {
    notificationsEnabled: true,
    notifyOnWaiting: true,
    notifyOnComplete: true,
    notifyOnStop: true,
    notifyOnError: true,
    telegramEnabled: false,
    telegramBotToken: '',
    telegramChatId: '',
    telegramAuthToken: '',
    telegramAuthorizedChatIds: [],
    telegramRequireMention: false,
    slackEnabled: false,
    slackBotToken: '',
    slackAppToken: '',
    slackSigningSecret: '',
    slackChannelId: '',
    jiraEnabled: false,
    jiraDomain: '',
    jiraEmail: '',
    jiraApiToken: '',
    socialDataEnabled: false,
    socialDataApiKey: '',
    xPostingEnabled: false,
    xApiKey: '',
    xApiSecret: '',
    xAccessToken: '',
    xAccessTokenSecret: '',
    tasmaniaEnabled: false,
    tasmaniaServerPath: '',
    gwsEnabled: false,
    gwsSkillsInstalled: false,
    verboseModeEnabled: false,
    statusLineEnabled: false,
    chromeEnabled: false,
    autoCheckUpdates: true,
    opencodeEnabled: false,
    opencodeDefaultModel: '',
    defaultProvider: 'claude',
    cliPaths: {
      claude: '',
      codex: '',
      gemini: '',
      opencode: '',
      pi: '',
      gws: '',
      gcloud: '',
      gh: '',
      node: '',
      additionalPaths: [],
    },
  };
  try {
    if (fs.existsSync(APP_SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf-8'));
      return { ...defaults, ...saved };
    }
  } catch (err) {
    console.error('Failed to load app settings:', err);
  }
  return defaults;
}

function saveAppSettingsToFile(settings: AppSettings) {
  try {
    ensureDataDir();
    fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Failed to save app settings:', err);
  }
}

// ============== Telegram Bot Initialization ==============

function initTelegramBot() {
  // First inject dependencies into the Telegram bot service
  initTelegramBotService(
    agents,
    ptyProcesses,
    appSettings,
    getMainWindow(),
    () => getSuperAgent(agents),
    saveAgents,
    getClaudeStats,
    (agent: AgentStatus) => initAgentPty(
      agent,
      getMainWindow(),
      handleStatusChangeNotificationWrapper,
      saveAgents
    ),
    saveAppSettingsToFile
  );

  // Then initialize the bot with handlers
  initTelegramBotHandlers();
}

// ============== Notification Handler Wrapper ==============

function handleStatusChangeNotificationWrapper(agent: AgentStatus, newStatus: string) {
  handleStatusChangeNotification(
    agent,
    newStatus,
    appSettings,
    sendNotification,
    (text: string) => sendTelegramMessage(text),
    sendSuperAgentResponseToTelegram
  );
}

// ============== IPC Handler Dependencies ==============

function createIpcDependencies(): IpcHandlerDependencies {
  return {
    // State
    ptyProcesses,
    agents,
    skillPtyProcesses,
    quickPtyProcesses,
    pluginPtyProcesses,

    // Functions
    getMainWindow,
    getAppSettings: () => appSettings,
    setAppSettings: (settings: AppSettings) => { appSettings = settings; },
    saveAppSettings: saveAppSettingsToFile,
    saveAgents,
    initAgentPty: (agent: AgentStatus) => initAgentPty(
      agent,
      getMainWindow(),
      handleStatusChangeNotificationWrapper,
      saveAgents
    ),
    handleStatusChangeNotification: handleStatusChangeNotificationWrapper,
    isSuperAgent,
    getMcpOrchestratorPath,
    initTelegramBot,
    initSlackBot: () => initSlackBot(appSettings, (settings) => {
      appSettings = settings;
      saveAppSettingsToFile(settings);
    }, getMainWindow()),
    getTelegramBot,
    getSlackApp,
    getSuperAgentTelegramTask: () => {
      // Import from agent-manager state
      const { superAgentTelegramTask } = require('./core/agent-manager');
      return superAgentTelegramTask;
    },
    getSuperAgentOutputBuffer,
    setSuperAgentOutputBuffer: (buffer: string[]) => {
      // This is handled internally by agent-manager
      clearSuperAgentOutputBuffer();
      buffer.forEach(item => getSuperAgentOutputBuffer().push(item));
    },

    // Claude data functions
    getClaudeSettings,
    getClaudeStats,
    getClaudeProjects,
    getClaudePlugins,
    getClaudeSkills,
    getClaudeHistory,
  };
}

// ============== API Server Initialization ==============

function initApiServer() {
  startApiServer(
    getMainWindow(),
    appSettings,
    getTelegramBot,
    getSlackApp,
    getSlackResponseChannel(),
    getSlackResponseThreadTs(),
    handleStatusChangeNotificationWrapper,
    sendNotification,
    (agent: AgentStatus) => initAgentPty(
      agent,
      getMainWindow(),
      handleStatusChangeNotificationWrapper,
      saveAgents
    ),
    () => appSettings
  );
}

// ============== App Initialization ==============

// Register protocol schemes before app is ready
registerProtocolSchemes();

// 3번 정밀화 — UI heartbeat(앱 본체 기반) 타이머. 최소화 유지·완전 닫힘만 정지.
let uiHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

app.whenReady().then(async () => {
  console.log('App ready, initializing...');

  // Ensure data directory exists
  ensureDataDir();

  // Write Dorothy's CLAUDE.md to ~/.dorothy/ so all spawned agents can load it
  ensureDorothyClaudeMd();

  // Install/update statusline script if enabled (ensures script is always up-to-date after app updates)
  // statusLineEnabled defaults to true for new users
  try {
    const { enableStatusLine, disableStatusLine } = await import('./utils/statusline');
    if (appSettings.statusLineEnabled !== false) {
      enableStatusLine();
    } else {
      disableStatusLine();
    }
  } catch {
    // ignore statusline errors on startup
  }

  // Migrate data from ~/.claude-manager if it exists (rebrand migration)
  migrateFromClaudeManager();

  // Load agents from disk
  loadAgents();

  // Setup protocol handler for production
  setupProtocolHandler();

  // Create the main window
  createWindow();

  // Set the main window reference in utils
  setUtilsMainWindow(getMainWindow());

  // 3번 정밀화 — UI heartbeat: 창이 하나라도 있으면(최소화 포함) ui-heartbeat 갱신 → pm-tick이 "보는 눈" 판정.
  //   ★최소화/가림 = 창이 getAllWindows에 여전히 카운트 → 갱신 계속 → 자동 가동 유지.
  //   ★완전 닫힘 = getAllWindows 0 → 갱신 중단 → grace 90s 후 stale → pm-tick SKIP.
  //   ★자동 launch 0 — getAllWindows 읽기만(창 안 띄움). 강제종료/크래시는 :31415 체크 + stale 이중 방어.
  const uiHeartbeatPath = path.join(os.homedir(), '.dorothy', 'runtime', 'ui-heartbeat');
  uiHeartbeatTimer = setInterval(() => {
    try {
      if (BrowserWindow.getAllWindows().length > 0) {
        fs.mkdirSync(path.dirname(uiHeartbeatPath), { recursive: true });
        fs.writeFileSync(uiHeartbeatPath, new Date().toISOString());
      }
    } catch { /* best-effort — heartbeat 실패는 앱 동작 안 막음 */ }
  }, 15000);

  // Initialize macOS menu bar tray with custom popup panel
  initTray();

  // Register all IPC handlers
  const deps = createIpcDependencies();
  registerIpcHandlers(deps);
  registerSchedulerHandlers({
    agents,
    getAppSettings: () => appSettings,
  });
  registerAutomationHandlers();
  registerMcpOrchestratorHandlers();
  registerCLIPathsHandlers({
    getAppSettings: () => appSettings,
    setAppSettings: (settings) => { appSettings = settings; },
    saveAppSettings: saveAppSettingsToFile,
  });

  // Register agent template handlers (no deps — self-contained)
  registerTemplateHandlers();

  // Register Dorothy company/auto-company/harness/approvals handlers (self-contained)
  registerDorothyHandlers();

  // Auto-Company 데몬과의 상호 배제용 busy-lock 유지 (에이전트 작업 중이면 데몬이 양보)
  startBusyLockMaintainer();

  // Register kanban handlers
  registerKanbanHandlers({
    getMainWindow,
    findMatchingAgent,
    createAgentForTask,
    startAgent: startAgentForTask,
    stopAgent: async (agentId: string) => {
      const agent = agents.get(agentId);
      if (agent?.ptyId) {
        const ptyProcess = ptyProcesses.get(agent.ptyId);
        if (ptyProcess) {
          // Send Ctrl+C to interrupt
          ptyProcess.write('\x03');
        }
        agent.status = 'idle';
        agent.currentTask = undefined;
        agent.lastActivity = new Date().toISOString();
        saveAgents();

        broadcastToAllWindows('agent:status', {
          type: 'status',
          agentId,
          status: 'idle',
          timestamp: new Date().toISOString(),
        });
      }
    },
    deleteAgent: async (agentId: string) => {
      const agent = agents.get(agentId);
      if (agent) {
        // Stop PTY if running
        if (agent.ptyId) {
          const ptyProcess = ptyProcesses.get(agent.ptyId);
          if (ptyProcess) {
            ptyProcess.kill();
          }
          ptyProcesses.delete(agent.ptyId);
        }
        // Remove agent
        agents.delete(agentId);
        saveAgents();
        console.log(`Agent ${agentId} deleted`);
      }
    },
    getAgentOutput: (agentId: string) => {
      const agent = agents.get(agentId);
      return agent?.output || [];
    },
    // Phase 4.5 — Plan-aware ownerAgentId routing uses this snapshot.
    getLiveAgents: () => Array.from(agents.values()).map(a => ({
      id: a.id,
      status: a.status,
      name: a.name,
      projectPath: a.projectPath,
      skills: a.skills,
    })),
  });

  // Initialize vault database
  initVaultDb();

  // Initialize Dorothy MVP run-model database (separate file from vault.db).
  // initDorothyDb returns a status object instead of throwing — on failure we
  // log and keep going so the rest of Dorothy stays usable.
  const dorothyDbResult = initDorothyDb();
  if (!dorothyDbResult.ok) {
    console.error('[main] Dorothy MVP DB unavailable:', dorothyDbResult.reason);
  }

  // Register the new Run/RunStep/AgentSession/Plan/Artifact/Handoff IPC.
  // Handlers themselves degrade gracefully when the DB is null.
  registerDorothyRunsHandlers({
    // Phase 6-H — let the registry IPC reload agents.json into the live
    // agent-manager map without restarting or killing active sessions.
    reloadLiveAgents: (reason?: string) => reloadAgentsFromDisk({ reason, mergeMetadataForExisting: true }),
    // Phase 6-I — live-loaded ids for isLiveLoaded / isSpawnable computation.
    getLiveAgentIds: () => Array.from(agents.keys()),
    // Phase 6-Q — warm-up support: live statuses + internal start adapter.
    getLiveAgentStatuses: () => Array.from(agents.values()).map(a => ({ id: a.id, status: a.status })),
    startAgentByApi: async ({ agentId, prompt }) => {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/api/agents/${agentId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getApiToken()}` },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '<no body>');
        throw new Error(`/api/agents/${agentId}/start returned ${res.status}: ${body.slice(0, 120)}`);
      }
    },
  });

  // MVP Phase 3/4.5 — give the orchestrator the live agent snapshot and a
  // start adapter. The adapter is gated by `dorothyOrchestratorAutoSpawn`
  // (default false): when the flag is off, the orchestrator only *picks*
  // the next worker; the legacy kanban-handlers / `/api/agents/:id/start`
  // path stays in charge of actually spawning. When the flag is on, the
  // orchestrator calls the existing HTTP start endpoint directly so we
  // reuse provider routing, MCP config wiring, and PTY plumbing without
  // duplicating any of it.
  configureOrchestrator({
    getLiveAgents: () => Array.from(agents.values()).map(a => ({
      id: a.id,
      status: a.status,
      // We don't store roleId on AgentStatus today; the heuristic uses
      // `name` (which often contains the role) via selectAgentForOwnerRole's
      // case-insensitive `includes` check.
      name: a.name,
      projectPath: a.projectPath,
      skills: a.skills,
    })),
    startAgent: async ({ agentId, prompt, runId, runStepId }) => {
      // Feature flag — default off. Tests / IPC mutations re-read this on
      // every call, so flipping the setting in /settings takes effect at
      // the next dispatch with no app restart.
      if (!appSettings.dorothyOrchestratorAutoSpawn) {
        throw new Error('orchestratorAutoSpawn disabled — leave step pending for legacy spawn');
      }
      const res = await fetch(`http://127.0.0.1:${API_PORT}/api/agents/${agentId}/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getApiToken()}`,
        },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '<no body>');
        throw new Error(`/api/agents/${agentId}/start returned ${res.status}: ${body.slice(0, 200)}`);
      }
      // The hooks-routes.ts AgentSession mirror will write a row when the
      // existing `/api/hooks/status` event fires for this agent. We attach
      // the session→step binding lazily on the orchestrator side so the
      // moment a Stop hook arrives, `completeRunStep` looks up the right
      // RunStep.
      void runId; void runStepId;
    },
  });

  // Phase 5C-B — Auto Resume Scheduler. Default mode is 'dry-run'; we tick
  // every 60s so a resume target waiting on a 5-hour cooldown wakes within
  // ~1 minute of the reset time. The scheduler reuses the same HTTP-based
  // startAgent adapter as the orchestrator above.
  configureAutoResume({
    getMode: () => normalizeAutoResumeMode(appSettings.dorothyAutoResumeRateLimitedSessions),
    getLiveAgents: () => Array.from(agents.values()).map(a => ({
      id: a.id,
      status: a.status,
      name: a.name,
    })),
    startAgent: async ({ agentId, prompt, runId, runStepId }) => {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/api/agents/${agentId}/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getApiToken()}`,
        },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '<no body>');
        throw new Error(`/api/agents/${agentId}/start returned ${res.status}: ${body.slice(0, 200)}`);
      }
      void runId; void runStepId;
    },
  });
  startAutoResumeTicker(60_000);

  // Register vault handlers
  registerVaultHandlers({ getMainWindow });

  // Register world (generative zone) handlers
  registerWorldHandlers({ getMainWindow });

  // Initialize kanban automation service
  initKanbanAutomation({
    agents,
    createAgent: async (config) => {
      // Create agent directly - similar to agent:create handler
      const { v4: uuidv4 } = await import('uuid');
      const pty = await import('node-pty');

      const id = uuidv4();
      const shell = process.env.SHELL || '/bin/zsh';
      let cwd = config.projectPath;

      if (!fs.existsSync(cwd)) {
        cwd = os.homedir();
      }

      // Always include world-builder skill
      const allSkills = [...new Set([...config.skills, 'world-builder'])];

      const ptyProcess = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env: {
          ...process.env as { [key: string]: string },
          CLAUDE_SKILLS: allSkills.join(','),
          CLAUDE_AGENT_ID: id,
          CLAUDE_PROJECT_PATH: config.projectPath,
        },
      });

      const ptyId = uuidv4();
      ptyProcesses.set(ptyId, ptyProcess);

      const status: AgentStatus = {
        id,
        status: 'idle',
        projectPath: config.projectPath,
        skills: allSkills,
        output: [],
        lastActivity: new Date().toISOString(),
        ptyId,
        character: config.character || 'robot',
        name: config.name || `Agent ${id.slice(0, 4)}`,
        permissionMode: config.permissionMode || 'auto',
      };

      agents.set(id, status);
      saveAgents();

      // Setup PTY event handlers
      ptyProcess.onData((data) => {
        const agent = agents.get(id);
        if (agent) {
          agent.output.push(data);
          agent.lastActivity = new Date().toISOString();
          agent.statusLine = extractStatusLine(agent.output);
        }
        broadcastToAllWindows('agent:output', {
          type: 'output',
          agentId: id,
          ptyId,
          data,
          timestamp: new Date().toISOString(),
        });
        scheduleTick();
      });

      ptyProcess.onExit(({ exitCode }) => {
        const agent = agents.get(id);
        if (agent) {
          const newStatus = exitCode === 0 ? 'completed' : 'error';
          agent.status = newStatus;
          agent.lastActivity = new Date().toISOString();
          handleStatusChangeNotificationWrapper(agent, newStatus);
        }
        ptyProcesses.delete(ptyId);
        // Emit status event so kanban sync can detect completion
        broadcastToAllWindows('agent:status', {
          type: 'status',
          agentId: id,
          status: exitCode === 0 ? 'completed' : 'error',
          timestamp: new Date().toISOString(),
        });
        broadcastToAllWindows('agent:complete', {
          type: 'complete',
          agentId: id,
          ptyId,
          exitCode,
          timestamp: new Date().toISOString(),
        });
        scheduleTick();
      });

      return status;
    },
    startAgent: async (agentId, prompt) => {
      const agent = agents.get(agentId);
      if (!agent) throw new Error('Agent not found');

      // Initialize PTY if needed
      if (!agent.ptyId || !ptyProcesses.has(agent.ptyId)) {
        const ptyId = await initAgentPty(
          agent,
          getMainWindow(),
          handleStatusChangeNotificationWrapper,
          saveAgents
        );
        agent.ptyId = ptyId;
      }

      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (!ptyProcess) throw new Error('PTY not found');

      // Build Claude command - always use dangerous mode for kanban tasks
      let command = 'claude --dangerously-skip-permissions';
      if (appSettings.verboseModeEnabled) {
        command += ' --verbose';
      }

      // Build final prompt with skills
      let finalPrompt = prompt;
      if (agent.skills && agent.skills.length > 0) {
        const skillsList = agent.skills.join(', ');
        finalPrompt = `[IMPORTANT: Use these skills for this session: ${skillsList}. Invoke them with /<skill-name> when relevant to the task.] ${prompt}`;
      }

      const escapedPrompt = finalPrompt.replace(/'/g, "'\\''");
      command += ` '${escapedPrompt}'`;

      // Update status
      agent.status = 'running';
      agent.currentTask = prompt.slice(0, 100);
      agent.lastActivity = new Date().toISOString();

      const workingPath = (agent.worktreePath || agent.projectPath).replace(/'/g, "'\\''");
      const fullCommand = `cd '${workingPath}' && ${command}`;

      // For long commands, write to a temp script to avoid PTY line-wrapping mangling
      if (fullCommand.length > 100) {
        const tmpScript = path.join(os.tmpdir(), `claude-agent-${agentId}.sh`);
        fs.writeFileSync(tmpScript, `#!/bin/bash\n${fullCommand}\n`, { mode: 0o755 });
        writeProgrammaticInput(ptyProcess, `bash '${tmpScript}'`);
      } else {
        writeProgrammaticInput(ptyProcess, fullCommand);
      }

      saveAgents();
    },
    saveAgents,
  });

  // Initialize services
  initTelegramBot();
  initSlackBot(appSettings, (settings) => {
    appSettings = settings;
    saveAppSettingsToFile(settings);
  }, getMainWindow());
  initApiServer();

  // Setup MCP orchestrator and hooks
  await setupMcpOrchestrator(appSettings);
  await configureStatusHooks();

  // Initialize electron-updater (wires up IPC events for progress, downloaded, error)
  initAutoUpdater(getMainWindow);
  setMainWindowGetter(getMainWindow);

  // Auto-check for updates on startup (electron-updater sends 'app:update-available' automatically)
  if (appSettings.autoCheckUpdates !== false) {
    setTimeout(() => {
      checkForUpdates().catch((err) => {
        console.error('Auto-update check failed:', err);
      });
    }, 5000);
  }

  console.log('App initialization complete');
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Re-create window on macOS when dock icon is clicked
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    setUtilsMainWindow(getMainWindow());
  }
});

// Save agents and kill all PTY processes before quitting
app.on('before-quit', () => {
  console.log('App quitting, saving agents and killing all PTY processes...');
  if (uiHeartbeatTimer) { clearInterval(uiHeartbeatTimer); uiHeartbeatTimer = null; } // 3번 정밀화 — heartbeat 정리
  destroyTray();
  saveAgents();
  killAllPty();
  stopAutoResumeTicker();
  closeVaultDb();
  closeDorothyDb();
});

// Handle certificate errors in development
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (url.startsWith('https://localhost')) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

export { appSettings, getTelegramBot };
