import * as path from 'path';
import * as fs from 'fs';
import { App as SlackApp, LogLevel } from '@slack/bolt';
import { AgentStatus, AppSettings } from '../types';
import { SLACK_CHARACTER_FACES } from '../constants';
import { formatSlackAgentStatus, isSuperAgent, getSuperAgent, getSuperAgentInstructions } from '../utils';
import { agents, saveAgents, initAgentPty } from '../core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../core/pty-manager';
import { getMainWindow } from '../core/window-manager';
import { handleTasksChannelMessage, createTaskDirect } from './slack-kanban';
import { getProjectServiceStatus, type ServiceProbe } from './dorothy/service-status';
import { startService, stopService, type ServiceRole } from './dorothy/service-control';
import { app } from 'electron';

// Slack bot state
let slackApp: SlackApp | null = null;
let slackResponseChannel: string | null = null;
let slackResponseThreadTs: string | null = null; // Track thread timestamp for replies
let superAgentSlackTask = false;
let superAgentSlackBuffer: string[] = [];

// Export references for external access
export function getSlackApp(): SlackApp | null {
  return slackApp;
}

export function setSlackApp(app: SlackApp | null): void {
  slackApp = app;
}

export function getSlackResponseChannel(): string | null {
  return slackResponseChannel;
}

export function setSlackResponseChannel(channel: string | null): void {
  slackResponseChannel = channel;
}

export function getSlackResponseThreadTs(): string | null {
  return slackResponseThreadTs;
}

export function setSlackResponseThreadTs(ts: string | null): void {
  slackResponseThreadTs = ts;
}

export function getSuperAgentSlackTask(): boolean {
  return superAgentSlackTask;
}

export function setSuperAgentSlackTask(value: boolean): void {
  superAgentSlackTask = value;
}

export function getSuperAgentSlackBuffer(): string[] {
  return superAgentSlackBuffer;
}

export function setSuperAgentSlackBuffer(buffer: string[]): void {
  superAgentSlackBuffer = buffer;
}

export function clearSuperAgentSlackBuffer(): void {
  superAgentSlackBuffer = [];
}

// Helper to initialize agent PTY with proper callbacks
async function initAgentPtyWithCallbacks(agent: AgentStatus): Promise<string> {
  return initAgentPty(
    agent,
    getMainWindow(),
    (agent: AgentStatus, newStatus: string) => {
      // Simple status change handler - just update the agent
      agent.status = newStatus as AgentStatus['status'];
    },
    saveAgents
  );
}

// Send message to Slack
export async function sendSlackMessage(
  text: string,
  appSettings: AppSettings,
  channel?: string
): Promise<void> {
  if (!slackApp || (!channel && !appSettings.slackChannelId)) return;

  const targetChannel = channel || appSettings.slackChannelId;
  try {
    // Slack has a 4000 char limit for text, truncate if needed
    const maxLen = 3900;
    const truncated =
      text.length > maxLen ? text.slice(0, maxLen) + '\n\n_(truncated)_' : text;
    await slackApp.client.chat.postMessage({
      channel: targetChannel,
      text: `:crown: ${truncated}`,
      mrkdwn: true,
    });
  } catch (err) {
    console.error('Failed to send Slack message:', err);
  }
}

// Initialize Slack bot
export function initSlackBot(
  appSettings: AppSettings,
  onSettingsChanged: (settings: AppSettings) => void,
  mainWindow?: Electron.BrowserWindow | null
): void {
  // Stop existing bot if any
  if (slackApp) {
    slackApp.stop().catch(err => console.error('Error stopping Slack app:', err));
    slackApp = null;
  }

  if (!appSettings.slackEnabled || !appSettings.slackBotToken || !appSettings.slackAppToken) {
    console.log('Slack bot disabled or missing tokens');
    return;
  }

  try {
    slackApp = new SlackApp({
      token: appSettings.slackBotToken,
      appToken: appSettings.slackAppToken,
      socketMode: true,
      logLevel: LogLevel.DEBUG,
    });

    // Handle app mentions
    slackApp.event('app_mention', async ({ event, say }) => {
      console.log('Slack app_mention event received:', JSON.stringify(event, null, 2));
      // Remove the bot mention from the text
      const text = event.text.replace(/<@[A-Z0-9]+>/gi, '').trim();
      slackResponseChannel = event.channel;
      // Use thread_ts if replying in a thread, otherwise use the message ts to start a thread
      slackResponseThreadTs =
        (event as { thread_ts?: string; ts?: string }).thread_ts ||
        (event as { ts?: string }).ts ||
        null;

      // Save channel ID
      if (appSettings.slackChannelId !== event.channel) {
        appSettings.slackChannelId = event.channel;
        onSettingsChanged(appSettings);
        mainWindow?.webContents.send('settings:updated', appSettings);
      }

      await handleSlackCommand(text, event.channel, say, appSettings, mainWindow);
    });

    // Handle direct messages - use 'message' event with subtype filter
    slackApp.message(async ({ message, say }) => {
      // Cast to any for flexibility with Slack's complex message types
      const msg = message as {
        bot_id?: string;
        subtype?: string;
        text?: string;
        channel: string;
        ts?: string;
        thread_ts?: string;
      };
      console.log('Slack message event received:', JSON.stringify(msg, null, 2));

      // Skip bot messages and message changes/deletions
      if (msg.bot_id) return;
      if (msg.subtype) return; // Skip edited, deleted, etc.
      if (!msg.text) return;

      const channel = msg.channel;
      slackResponseChannel = channel;
      // Use thread_ts if replying in a thread, otherwise use the message ts to start a thread
      slackResponseThreadTs = msg.thread_ts || msg.ts || null;

      // ── 채널 라우팅(1-B/2-A): #-tasks 채널은 ★빠른 단발 LLM → 칸반 create 경로로 분리.
      //   ★PTY 주입(writeProgrammaticInput)을 ★타지 않으므로 바쁜 Super Agent 와 무관 = 30분 지연 없음.
      //   tasksChannelId 는 런타임 설정(app-settings.json)에서 읽는다(없으면 no-op로 기존 경로 유지).
      const tasksChannelId = (appSettings as unknown as { tasksChannelId?: string }).tasksChannelId;
      if (tasksChannelId && channel === tasksChannelId) {
        await handleTasksChannelMessage(channel, msg.text, say, appSettings, task => {
          mainWindow?.webContents.send('kanban:task-created', task);
        });
        return;
      }

      // Save channel for responses
      if (appSettings.slackChannelId !== channel) {
        appSettings.slackChannelId = channel;
        onSettingsChanged(appSettings);
        mainWindow?.webContents.send('settings:updated', appSettings);
      }

      await sendToSuperAgentFromSlack(channel, msg.text, say, appSettings, mainWindow);
    });

    // Log all events for debugging
    slackApp.use(async ({ next, payload }) => {
      console.log('Slack event payload type:', payload?.type || 'unknown');
      await next();
    });

    // Start the app
    slackApp
      .start()
      .then(() => {
        console.log('Slack bot started (Socket Mode)');
      })
      .catch(err => {
        console.error('Failed to start Slack bot:', err);
        slackApp = null;
      });
  } catch (err) {
    console.error('Failed to initialize Slack bot:', err);
    slackApp = null;
  }
}

// Handle Slack commands
export async function handleSlackCommand(
  text: string,
  channel: string,
  say: (msg: string) => Promise<unknown>,
  appSettings: AppSettings,
  mainWindow?: Electron.BrowserWindow | null
): Promise<void> {
  const lowerText = text.toLowerCase().trim();

  if (lowerText === 'help' || lowerText === '') {
    await say(
      `:crown: *Dorothy Bot*\n\n` +
        `*Commands:*\n` +
        `• \`status\` - Show all agents status\n` +
        `• \`agents\` - List agents with details\n` +
        `• \`projects\` - List all projects\n` +
        `• \`services\` / \`svc\` - 프로젝트별 백엔드·프론트 서비스 up/down + 헬스\n` +
        `• \`svc start|stop <project> <fe|be>\` - 서비스 기동/정지 (예: svc start bueongi be)\n` +
        `• \`start <agent> <task>\` - Start an agent\n` +
        `• \`stop <agent>\` - Stop an agent\n` +
        `• \`loop\` / \`loop status\` - 팀 루프(자동개발) 상태\n` +
        `• \`loop on|off <project>\` - 팀 루프 재개/정지 (project: triplan|bueongi)\n` +
        `• \`usage\` - Show usage & cost stats\n` +
        `• \`help\` - Show this help message\n\n` +
        `Or just send a message to talk to the Super Agent!`
    );
    return;
  }

  if (lowerText === 'status') {
    const agentList = Array.from(agents.values());
    if (agentList.length === 0) {
      await say(':package: No agents created yet.');
      return;
    }

    const running = agentList.filter(a => a.status === 'running');
    const waiting = agentList.filter(a => a.status === 'waiting');
    const idle = agentList.filter(a => a.status === 'idle' || a.status === 'completed');
    const error = agentList.filter(a => a.status === 'error');

    let response = `:bar_chart: *Agents Status*\n\n`;
    if (running.length > 0) {
      response += `:large_green_circle: *Running (${running.length}):*\n`;
      running.forEach(a => {
        response += formatSlackAgentStatus(a);
      });
      response += '\n';
    }
    if (waiting.length > 0) {
      response += `:large_yellow_circle: *Waiting (${waiting.length}):*\n`;
      waiting.forEach(a => {
        response += formatSlackAgentStatus(a);
      });
      response += '\n';
    }
    if (error.length > 0) {
      response += `:red_circle: *Error (${error.length}):*\n`;
      error.forEach(a => {
        response += formatSlackAgentStatus(a);
      });
      response += '\n';
    }
    if (idle.length > 0) {
      response += `:white_circle: *Idle (${idle.length}):*\n`;
      idle.forEach(a => {
        response += formatSlackAgentStatus(a);
      });
    }

    await say(response);
    return;
  }

  if (lowerText === 'agents') {
    const agentList = Array.from(agents.values());
    if (agentList.length === 0) {
      await say(':package: No agents created yet.');
      return;
    }

    let response = `:robot_face: *All Agents*\n\n`;
    agentList.forEach(a => {
      response += formatSlackAgentStatus(a) + '\n';
    });

    await say(response);
    return;
  }

  if (lowerText === 'projects') {
    const agentList = Array.from(agents.values()).filter(a => !isSuperAgent(a));

    if (agentList.length === 0) {
      await say(':package: No projects with agents yet.');
      return;
    }

    const projectsMap = new Map<string, AgentStatus[]>();
    agentList.forEach(agent => {
      const path = agent.projectPath;
      if (!projectsMap.has(path)) {
        projectsMap.set(path, []);
      }
      projectsMap.get(path)!.push(agent);
    });

    let response = `:file_folder: *Projects*\n\n`;
    projectsMap.forEach((projectAgents, projectPath) => {
      const projectName = projectPath.split('/').pop() || 'Unknown';
      response += `:open_file_folder: *${projectName}*\n`;
      response += `    \`${projectPath}\`\n`;
      response += `    :busts_in_silhouette: Agents: ${projectAgents
        .map(a => {
          const emoji = SLACK_CHARACTER_FACES[a.character || ''] || ':robot_face:';
          const status =
            a.status === 'running'
              ? ':large_green_circle:'
              : a.status === 'waiting'
                ? ':large_yellow_circle:'
                : a.status === 'error'
                  ? ':red_circle:'
                  : ':white_circle:';
          return `${emoji}${a.name}${status}`;
        })
        .join(', ')}\n\n`;
    });

    await say(response);
    return;
  }

  if (lowerText === 'usage') {
    try {
      const stats = await getClaudeStats();

      if (!stats) {
        await say(':bar_chart: No usage data available yet.');
        return;
      }

      // Use same pricing as Telegram
      const MODEL_PRICING: Record<
        string,
        {
          inputPerMTok: number;
          outputPerMTok: number;
          cacheHitsPerMTok: number;
          cache5mWritePerMTok: number;
        }
      > = {
        'claude-opus-4-5-20251101': {
          inputPerMTok: 5,
          outputPerMTok: 25,
          cacheHitsPerMTok: 0.5,
          cache5mWritePerMTok: 6.25,
        },
        'claude-opus-4-5': {
          inputPerMTok: 5,
          outputPerMTok: 25,
          cacheHitsPerMTok: 0.5,
          cache5mWritePerMTok: 6.25,
        },
        'claude-sonnet-4': {
          inputPerMTok: 3,
          outputPerMTok: 15,
          cacheHitsPerMTok: 0.3,
          cache5mWritePerMTok: 3.75,
        },
      };

      const getModelPricing = (modelId: string) => {
        if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId];
        const lower = modelId.toLowerCase();
        if (lower.includes('opus-4-5') || lower.includes('opus-4.5'))
          return MODEL_PRICING['claude-opus-4-5'];
        if (lower.includes('sonnet')) return MODEL_PRICING['claude-sonnet-4'];
        return MODEL_PRICING['claude-sonnet-4'];
      };

      let totalCost = 0;
      let totalInput = 0;
      let totalOutput = 0;

      if (stats.modelUsage) {
        Object.entries(stats.modelUsage).forEach(([modelId, usageUnknown]) => {
          const usage = usageUnknown as Record<string, unknown>;
          const input = (usage.inputTokens as number) || 0;
          const output = (usage.outputTokens as number) || 0;
          const cacheRead = (usage.cacheReadInputTokens as number) || 0;
          const cacheWrite = (usage.cacheCreationInputTokens as number) || 0;

          totalInput += input;
          totalOutput += output;

          const pricing = getModelPricing(modelId);
          const inputCost = (input * pricing.inputPerMTok) / 1000000;
          const outputCost = (output * pricing.outputPerMTok) / 1000000;
          const cacheReadCost = (cacheRead * pricing.cacheHitsPerMTok) / 1000000;
          const cacheWriteCost = (cacheWrite * pricing.cache5mWritePerMTok) / 1000000;
          totalCost += inputCost + outputCost + cacheReadCost + cacheWriteCost;
        });
      }

      let statsText = ':bar_chart: *Usage Stats*\n\n';
      statsText += `Input Tokens: ${totalInput.toLocaleString()}\n`;
      statsText += `Output Tokens: ${totalOutput.toLocaleString()}\n`;
      statsText += `Total Cost: $${totalCost.toFixed(2)}\n`;

      await say(statsText);
    } catch (err) {
      console.error('Failed to get usage stats:', err);
      await say(':x: Failed to get usage stats');
    }
    return;
  }

  // 슬랙에서 칸반 작업 추가: `task <설명>` 또는 `add <설명>`. (전용 채널 불요·@멘션으로 기존 채널서 동작·자유대화 무손상)
  if (lowerText.startsWith('task ') || lowerText.startsWith('add ')) {
    const prefixLen = lowerText.startsWith('task ') ? 5 : 4;
    const title = text.slice(prefixLen).trim();
    if (!title) {
      await say(':x: 사용법: `task <작업 설명>` (또는 `add <설명>`). 예: `task bueongi 공유 화면 버그 수정`');
      return;
    }
    // 프로젝트 추정: bueongi 키워드면 bueongi, 아니면 triplan 기본(대시보드에서 재배정 가능).
    const isBueongi = /bueongi|부엉/i.test(title);
    const proj = isBueongi
      ? { id: 'bueongi', path: '/Users/soo/workspace/source-code/apps/bueongi/frontend-src' }
      : { id: 'triplan', path: '/Users/soo/workspace/source-code/triplan' };
    try {
      const created = createTaskDirect({ title, description: '', projectId: proj.id, projectPath: proj.path });
      mainWindow?.webContents.send('kanban:task-created', created);
      await say(`:white_check_mark: 칸반 backlog 추가: *${created.title}* (project: ${proj.id})\n대시보드 /kanban 에서 확인·재배정·우선순위 조정 가능.`);
    } catch (err) {
      await say(`:x: 작업 추가 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (lowerText.startsWith('start ')) {
    const parts = text.slice(5).trim().split(' ');
    const agentName = parts[0].toLowerCase();
    const task = parts.slice(1).join(' ');

    if (!task) {
      await say(':x: Usage: `start <agent> <task>`');
      return;
    }

    const agent = Array.from(agents.values()).find(
      a => a.name?.toLowerCase().includes(agentName) || a.id === agentName
    );

    if (!agent) {
      await say(`:x: Agent "${agentName}" not found.`);
      return;
    }

    if (agent.status === 'running') {
      await say(`:warning: ${agent.name} is already running.`);
      return;
    }

    try {
      const workingPath = (agent.worktreePath || agent.projectPath).replace(/'/g, "'\\''");

      if (!agent.ptyId || !ptyProcesses.has(agent.ptyId)) {
        const ptyId = await initAgentPtyWithCallbacks(agent);
        agent.ptyId = ptyId;
      }

      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (!ptyProcess) {
        await say(':x: Failed to initialize agent terminal.');
        return;
      }

      let command = 'claude';
      if (agent.permissionMode === 'auto' || agent.permissionMode === 'bypass' || (!agent.permissionMode && agent.skipPermissions)) command += ' --dangerously-skip-permissions';
      if (agent.secondaryProjectPath) {
        command += ` --add-dir '${agent.secondaryProjectPath.replace(/'/g, "'\\''")}'`;
      }
      command += ` --add-dir '${require('os').homedir()}/.dorothy'`;
      command += ` '${task.replace(/'/g, "'\\''")}'`;

      agent.status = 'running';
      agent.currentTask = task.slice(0, 100);
      agent.lastActivity = new Date().toISOString();
      writeProgrammaticInput(ptyProcess, `cd '${workingPath}' && ${command}`);
      saveAgents();

      const emoji = isSuperAgent(agent) ? ':crown:' : SLACK_CHARACTER_FACES[agent.character || ''] || ':robot_face:';
      await say(`:rocket: Started *${agent.name}*\n\n${emoji} Task: ${task}`);
    } catch (err) {
      console.error('Failed to start agent from Slack:', err);
      await say(`:x: Failed to start agent: ${err}`);
    }
    return;
  }

  if (lowerText.startsWith('stop ')) {
    const agentName = text.slice(5).trim().toLowerCase();

    const agent = Array.from(agents.values()).find(
      a => a.name?.toLowerCase().includes(agentName) || a.id === agentName
    );

    if (!agent) {
      await say(`:x: Agent "${agentName}" not found.`);
      return;
    }

    if (agent.status !== 'running' && agent.status !== 'waiting') {
      await say(`:warning: ${agent.name} is not running.`);
      return;
    }

    if (agent.ptyId) {
      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (ptyProcess) {
        ptyProcess.write('\x03'); // Ctrl+C
      }
    }
    agent.status = 'idle';
    agent.currentTask = undefined;
    saveAgents();

    await say(`:octagonal_sign: Stopped *${agent.name}*`);
    return;
  }

  // 슬랙 서비스 상태판 + 제어: `svc`(상태) / `svc start|stop <project> <fe|be>`(기동·정지).
  //   상태 프로브는 대시보드 /api/projects 와 같은 공유 로직(같은 진실). 제어는 service-control 모듈.
  //   ★capsule 정의 프로젝트/경로만 · localhost dev 가정 · 자동 재시작 없음(명시 호출만).
  if (lowerText === 'services' || lowerText === 'svc' || lowerText === 'service' ||
      lowerText.startsWith('svc ') || lowerText.startsWith('services ') || lowerText.startsWith('service ')) {
    const svcParts = lowerText.split(/\s+/);
    const sub = svcParts[1]; // undefined | 'start' | 'stop' | (그 외=무시)

    // svc start|stop <project> <fe|be>
    if (sub === 'start' || sub === 'stop') {
      const proj = svcParts[2];
      const role = svcParts[3] as ServiceRole | undefined;
      if (!proj || (role !== 'fe' && role !== 'be')) {
        await say(`:x: 사용법: \`svc ${sub} <project> <fe|be>\` (예: \`svc start bueongi be\`)`);
        return;
      }
      await say(`:hourglass_flowing_sand: *${proj}* ${role.toUpperCase()} ${sub === 'start' ? '기동' : '정지'} 중…`);
      try {
        const r = sub === 'start' ? await startService(proj, role) : await stopService(proj, role);
        const icon = r.ok ? (sub === 'start' ? ':arrow_forward:' : ':double_vertical_bar:') : ':x:';
        await say(`${icon} *${proj}* ${role.toUpperCase()}: ${r.message}`);
      } catch (err) {
        await say(`:x: 제어 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    const fmt = (label: string, p: ServiceProbe | null): string => {
      if (!p) return `${label} :grey_question: 포트 미설정`;
      if (p.up) {
        const lat = typeof p.latencyMs === 'number' ? ` ${p.latencyMs}ms` : '';
        return `${label} :large_green_circle: up (:${p.port}${lat})`;
      }
      const why = p.reason === 'probe-timeout' ? 'timeout' : 'unreachable';
      return `${label} :red_circle: down (:${p.port} · ${why})`;
    };
    try {
      const statuses = await getProjectServiceStatus();
      if (statuses.length === 0) {
        await say(':grey_question: 등록된 프로젝트가 없습니다 (project-capsules.json 비어있음).');
        return;
      }
      let resp = ':satellite_antenna: *서비스 상태 (프로젝트별 백엔드·프론트)*\n';
      for (const s of statuses) {
        resp += `\n*${s.name}*${s.status ? ` _(${s.status})_` : ''}\n`;
        resp += `  ${fmt('FE', s.fe)}\n`;
        resp += `  ${fmt('BE', s.be)}\n`;
      }
      resp += '\n_FE=프론트(/) · BE=백엔드(/health) · 127.0.0.1 read-only 프로브_';
      resp += '\n제어: `svc start|stop <project> <fe|be>` (예: `svc start bueongi be`)';
      await say(resp);
    } catch (err) {
      await say(`:x: 서비스 상태 조회 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // 슬랙 사령탑: 팀 루프(자동개발) 제어. 정지/재개는 runtime/<proj>-team-loop.paused 플래그로
  //   토글한다 — launchd(com.<proj>.teamloop)가 KeepAlive PathState 로 플래그 존재 시 데몬을
  //   중지, 부재 시 재시작한다(데몬 직접 kill 안 함·되돌리기 쉬움·에이전트 경계서 깨끗).
  if (lowerText === 'loop' || lowerText.startsWith('loop ')) {
    const PROJECTS = ['triplan', 'bueongi'];
    const runtimeDir = path.join(require('os').homedir(), '.dorothy', 'runtime');
    const flagPath = (p: string) => path.join(runtimeDir, `${p}-team-loop.paused`);
    const statePath = (p: string) => path.join(runtimeDir, `${p}-team-loop-state.json`);
    const readState = (p: string): { status?: string; pass?: string; currentRole?: string } | null => {
      try {
        return JSON.parse(fs.readFileSync(statePath(p), 'utf8'));
      } catch {
        return null;
      }
    };

    const parts = lowerText.split(/\s+/);
    const action = parts[1] || 'status';
    const target = parts[2];

    if (action === 'status') {
      let resp = ':satellite_antenna: *Team-loop 상태 (자동개발)*\n';
      for (const p of PROJECTS) {
        const paused = fs.existsSync(flagPath(p));
        const st = readState(p);
        const live = st
          ? `${st.status ?? '?'}${st.pass ? ` (pass ${st.pass}${st.currentRole ? ', ' + st.currentRole : ''})` : ''}`
          : '상태파일 없음';
        resp += `• *${p}*: ${paused ? ':double_vertical_bar: 정지(paused)' : ':arrow_forward: 가동'} — ${live}\n`;
      }
      resp += '\n사용법: `loop on <project>` · `loop off <project>` (project: triplan | bueongi)';
      await say(resp);
      return;
    }

    const isOff = action === 'off' || action === 'pause';
    const isOn = action === 'on' || action === 'resume';
    if (!isOff && !isOn) {
      await say(':x: 사용법: `loop status` · `loop on <project>` · `loop off <project>` (project: triplan | bueongi)');
      return;
    }
    if (!target || !PROJECTS.includes(target)) {
      await say(`:x: 프로젝트를 지정하세요: ${PROJECTS.map(p => '`' + p + '`').join(' | ')}. 예: \`loop off bueongi\``);
      return;
    }

    try {
      if (isOff) {
        fs.writeFileSync(flagPath(target), `paused via slack at ${new Date().toISOString()}\n`);
        await say(`:double_vertical_bar: *${target}* 팀 루프 정지 — 현재 에이전트 사이클 종료 후 멈춥니다. 재개: \`loop on ${target}\``);
      } else {
        if (fs.existsSync(flagPath(target))) fs.unlinkSync(flagPath(target));
        await say(`:arrow_forward: *${target}* 팀 루프 재개 — 다음 패스부터 자동개발 순환을 시작합니다.`);
      }
    } catch (err) {
      await say(`:x: 루프 제어 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // Default: forward to Super Agent
  await sendToSuperAgentFromSlack(channel, text, say, appSettings, mainWindow);
}

// Send message to Super Agent from Slack
export async function sendToSuperAgentFromSlack(
  channel: string,
  message: string,
  say: (msg: string) => Promise<unknown>,
  appSettings: AppSettings,
  mainWindow?: Electron.BrowserWindow | null
): Promise<void> {
  const superAgent = getSuperAgent(agents);

  if (!superAgent) {
    await say(
      ':crown: No Super Agent found.\n\nCreate one in Dorothy first, or use `start <agent> <task>` to start a specific agent.'
    );
    return;
  }

  // Sanitize message - replace newlines with spaces for terminal compatibility
  const sanitizedMessage = message.replace(/\r?\n/g, ' ').trim();

  try {
    // Initialize PTY if needed
    if (!superAgent.ptyId || !ptyProcesses.has(superAgent.ptyId)) {
      const ptyId = await initAgentPtyWithCallbacks(superAgent);
      superAgent.ptyId = ptyId;
    }

    const ptyProcess = ptyProcesses.get(superAgent.ptyId);
    if (!ptyProcess) {
      await say(':x: Failed to connect to Super Agent terminal.');
      return;
    }

    // If agent is running or waiting, send message to existing session
    if (superAgent.status === 'running' || superAgent.status === 'waiting') {
      superAgentSlackTask = true;
      superAgentSlackBuffer = [];

      superAgent.currentTask = sanitizedMessage.slice(0, 100);
      superAgent.lastActivity = new Date().toISOString();
      saveAgents();

      const slackMessage = `[FROM SLACK - Use send_slack MCP tool to respond!] ${sanitizedMessage}`;

      writeProgrammaticInput(ptyProcess, slackMessage, true);

      await say(':crown: Super Agent is processing...');
    } else if (
      superAgent.status === 'idle' ||
      superAgent.status === 'completed' ||
      superAgent.status === 'error'
    ) {
      // No active session, start a new one
      const workingPath = (superAgent.worktreePath || superAgent.projectPath).replace(
        /'/g,
        "'\\''",
      );

      // Build command with instructions file
      let command = 'claude';

      // Slack 양방향 응답이 메인 Opus 풀을 소모해 "HTTP 429: usage limit reached"가
      // 반복되던 문제(2026-06-12) 완화: Super Agent의 Slack 세션을 더 저렴한 Claude
      // 모델로 라우팅한다. codex(잔액0)/gemini provider 분리는 spawn 경로 대수술이라
      // 보류하고 Claude 모델로 변경(사용자 지시). ENV로 조정/되돌림 가능(빈 값이면 기본 모델).
      const slackModel = process.env.DOROTHY_SLACK_SUPER_AGENT_MODEL ?? 'sonnet';
      if (slackModel) command += ` --model '${slackModel.replace(/'/g, "'\\''")}'`;

      const mcpConfigPath = path.join(app.getPath('home'), '.claude', 'mcp.json');
      if (fs.existsSync(mcpConfigPath)) {
        command += ` --mcp-config '${mcpConfigPath}'`;
      }

      // Add system prompt from instructions (read via Node.js, not cat - asar compatibility)
      const superAgentInstructions = getSuperAgentInstructions();
      if (superAgentInstructions) {
        const escapedInstructions = superAgentInstructions.replace(/'/g, "'\\''").replace(/"/g, '\\"').replace(/\n/g, ' ');
        command += ` --append-system-prompt "${escapedInstructions}"`;
      }

      if (superAgent.permissionMode === 'auto' || superAgent.permissionMode === 'bypass' || (!superAgent.permissionMode && superAgent.skipPermissions)) command += ' --dangerously-skip-permissions';

      // Simple prompt with Slack context - the detailed instructions come from the file
      const userPrompt = `[FROM SLACK - Use send_slack MCP tool to respond!] ${sanitizedMessage}`;
      command += ` '${userPrompt.replace(/'/g, "'\\''")}'`;

      superAgent.status = 'running';
      superAgent.currentTask = sanitizedMessage.slice(0, 100);
      superAgent.lastActivity = new Date().toISOString();

      superAgentSlackTask = true;
      superAgentSlackBuffer = [];

      writeProgrammaticInput(ptyProcess, `cd '${workingPath}' && ${command}`);
      saveAgents();

      await say(':crown: Super Agent is processing your request...');
    } else {
      await say(`:crown: Super Agent is in ${superAgent.status} state. Try again in a moment.`);
    }
  } catch (err) {
    console.error('Failed to send to Super Agent:', err);
    await say(`:x: Error: ${err}`);
  }
}

// Stop Slack bot
export function stopSlackBot(): void {
  if (slackApp) {
    slackApp.stop().catch(err => console.error('Error stopping Slack app:', err));
    slackApp = null;
    console.log('Slack bot stopped');
  }
}

// Helper function to get Claude stats - provided by caller
let getClaudeStatsRef: (() => Promise<
  | {
      modelUsage?: Record<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
        }
      >;
    }
  | undefined
>) | null = null;

export function setGetClaudeStatsRef(
  fn: () => Promise<
    | {
        modelUsage?: Record<
          string,
          {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens?: number;
            cacheCreationInputTokens?: number;
          }
        >;
      }
    | undefined
  >
): void {
  getClaudeStatsRef = fn;
}

async function getClaudeStats(): Promise<
  | {
      modelUsage?: Record<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
        }
      >;
    }
  | undefined
> {
  if (!getClaudeStatsRef) {
    return undefined;
  }
  return getClaudeStatsRef();
}
