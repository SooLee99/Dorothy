import { contextBridge, ipcRenderer } from 'electron';

// Agent event types
type AgentEventCallback = (event: {
  type: string;
  agentId: string;
  ptyId?: string;
  data: string;
  timestamp: string;
  exitCode?: number;
}) => void;

// PTY event types
type PtyDataCallback = (event: { id: string; data: string }) => void;
type PtyExitCallback = (event: { id: string; exitCode: number }) => void;

// Expose protected APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // PTY terminal management
  pty: {
    create: (params: { cwd?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('pty:create', params),
    write: (params: { id: string; data: string }) =>
      ipcRenderer.invoke('pty:write', params),
    resize: (params: { id: string; cols: number; rows: number }) =>
      ipcRenderer.invoke('pty:resize', params),
    kill: (params: { id: string }) =>
      ipcRenderer.invoke('pty:kill', params),

    // Event listeners
    onData: (callback: PtyDataCallback) => {
      const listener = (_: unknown, event: { id: string; data: string }) => callback(event);
      ipcRenderer.on('pty:data', listener);
      return () => ipcRenderer.removeListener('pty:data', listener);
    },
    onExit: (callback: PtyExitCallback) => {
      const listener = (_: unknown, event: { id: string; exitCode: number }) => callback(event);
      ipcRenderer.on('pty:exit', listener);
      return () => ipcRenderer.removeListener('pty:exit', listener);
    },
  },

  // Agent management
  agent: {
    create: (config: {
      projectPath: string;
      skills: string[];
      worktree?: { enabled: boolean; branchName: string };
      character?: string;
      name?: string;
      secondaryProjectPath?: string;
      permissionMode?: 'normal' | 'auto' | 'bypass';
      effort?: 'low' | 'medium' | 'high';
      provider?: string;
      model?: string;
      localModel?: string;
      obsidianVaultPaths?: string[];
    }) => ipcRenderer.invoke('agent:create', config),
    update: (params: {
      id: string;
      skills?: string[];
      secondaryProjectPath?: string | null;
      permissionMode?: 'normal' | 'auto' | 'bypass';
      effort?: 'low' | 'medium' | 'high' | null;
      name?: string;
      character?: string;
      model?: string | null;
      provider?: string;
      localModel?: string | null;
      savedPrompt?: string | null;
      obsidianVaultPaths?: string[];
      worktree?: { enabled: boolean; branchName: string };
    }) => ipcRenderer.invoke('agent:update', params),
    start: (params: { id: string; prompt: string; options?: { model?: string; resume?: boolean; provider?: string; localModel?: string } }) =>
      ipcRenderer.invoke('agent:start', params),
    get: (id: string) =>
      ipcRenderer.invoke('agent:get', id),
    list: () =>
      ipcRenderer.invoke('agent:list'),
    stop: (id: string) =>
      ipcRenderer.invoke('agent:stop', id),
    remove: (id: string) =>
      ipcRenderer.invoke('agent:remove', id),
    sendInput: (params: { id: string; input: string }) =>
      ipcRenderer.invoke('agent:input', params),
    resize: (params: { id: string; cols: number; rows: number }) =>
      ipcRenderer.invoke('agent:resize', params),
    setSecondaryProject: (params: { id: string; secondaryProjectPath: string | null }) =>
      ipcRenderer.invoke('agent:setSecondaryProject', params),

    // Event listeners
    onOutput: (callback: AgentEventCallback) => {
      const listener = (_: unknown, event: Parameters<AgentEventCallback>[0]) => callback(event);
      ipcRenderer.on('agent:output', listener);
      return () => ipcRenderer.removeListener('agent:output', listener);
    },
    onError: (callback: AgentEventCallback) => {
      const listener = (_: unknown, event: Parameters<AgentEventCallback>[0]) => callback(event);
      ipcRenderer.on('agent:error', listener);
      return () => ipcRenderer.removeListener('agent:error', listener);
    },
    onComplete: (callback: AgentEventCallback) => {
      const listener = (_: unknown, event: Parameters<AgentEventCallback>[0]) => callback(event);
      ipcRenderer.on('agent:complete', listener);
      return () => ipcRenderer.removeListener('agent:complete', listener);
    },
    onToolUse: (callback: AgentEventCallback) => {
      const listener = (_: unknown, event: Parameters<AgentEventCallback>[0]) => callback(event);
      ipcRenderer.on('agent:tool_use', listener);
      return () => ipcRenderer.removeListener('agent:tool_use', listener);
    },
    onStatus: (callback: (event: { type: string; agentId: string; status: string; timestamp: string }) => void) => {
      const listener = (_: unknown, event: { type: string; agentId: string; status: string; timestamp: string }) => callback(event);
      ipcRenderer.on('agent:status', listener);
      return () => ipcRenderer.removeListener('agent:status', listener);
    },
    onTick: (callback: (agents: Array<{
      id: string; name: string; character: string;
      status: string; displayStatus: string; statusLine: string;
      currentTask: string; projectName: string; lastActivity: string; provider: string;
    }>) => void) => {
      const listener = (_: unknown, data: unknown) => callback(data as Parameters<typeof callback>[0]);
      ipcRenderer.on('agents:tick', listener);
      return () => ipcRenderer.removeListener('agents:tick', listener);
    },
  },

  // Skills management
  skill: {
    install: (repo: string) =>
      ipcRenderer.invoke('skill:install', repo),
    installStart: (params: { repo: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('skill:install-start', params),
    installWrite: (params: { id: string; data: string }) =>
      ipcRenderer.invoke('skill:install-write', params),
    installResize: (params: { id: string; cols: number; rows: number }) =>
      ipcRenderer.invoke('skill:install-resize', params),
    installKill: (params: { id: string }) =>
      ipcRenderer.invoke('skill:install-kill', params),
    listInstalled: () =>
      ipcRenderer.invoke('skill:list-installed'),
    listInstalledAll: () =>
      ipcRenderer.invoke('skill:list-installed-all'),
    linkToProvider: (params: { skillName: string; providerId: string }) =>
      ipcRenderer.invoke('skill:link-to-provider', params),
    fetchMarketplace: () =>
      ipcRenderer.invoke('skill:fetch-marketplace') as Promise<{ skills: Array<{ rank: number; name: string; repo: string; installs: string; installsNum: number }> | null }>,
    onPtyData: (callback: (event: { id: string; data: string }) => void) => {
      const listener = (_: unknown, event: { id: string; data: string }) => callback(event);
      ipcRenderer.on('skill:pty-data', listener);
      return () => ipcRenderer.removeListener('skill:pty-data', listener);
    },
    onPtyExit: (callback: (event: { id: string; exitCode: number }) => void) => {
      const listener = (_: unknown, event: { id: string; exitCode: number }) => callback(event);
      ipcRenderer.on('skill:pty-exit', listener);
      return () => ipcRenderer.removeListener('skill:pty-exit', listener);
    },
    onInstallOutput: (callback: (event: { repo: string; data: string }) => void) => {
      const listener = (_: unknown, event: { repo: string; data: string }) => callback(event);
      ipcRenderer.on('skill:install-output', listener);
      return () => ipcRenderer.removeListener('skill:install-output', listener);
    },
  },

  // Plugin management (with in-app terminal)
  plugin: {
    installStart: (params: { command: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('plugin:install-start', params),
    installWrite: (params: { id: string; data: string }) =>
      ipcRenderer.invoke('plugin:install-write', params),
    installResize: (params: { id: string; cols: number; rows: number }) =>
      ipcRenderer.invoke('plugin:install-resize', params),
    installKill: (params: { id: string }) =>
      ipcRenderer.invoke('plugin:install-kill', params),
    onPtyData: (callback: (event: { id: string; data: string }) => void) => {
      const listener = (_: unknown, event: { id: string; data: string }) => callback(event);
      ipcRenderer.on('plugin:pty-data', listener);
      return () => ipcRenderer.removeListener('plugin:pty-data', listener);
    },
    onPtyExit: (callback: (event: { id: string; exitCode: number }) => void) => {
      const listener = (_: unknown, event: { id: string; exitCode: number }) => callback(event);
      ipcRenderer.on('plugin:pty-exit', listener);
      return () => ipcRenderer.removeListener('plugin:pty-exit', listener);
    },
  },

  // File system
  fs: {
    listProjects: () =>
      ipcRenderer.invoke('fs:list-projects'),
  },

  // Claude data
  claude: {
    getData: () =>
      ipcRenderer.invoke('claude:getData'),
  },

  // Settings
  settings: {
    get: () =>
      ipcRenderer.invoke('settings:get'),
    save: (settings: {
      enabledPlugins?: Record<string, boolean>;
      env?: Record<string, string>;
      hooks?: Record<string, unknown>;
      includeCoAuthoredBy?: boolean;
      permissions?: { allow: string[]; deny: string[] };
    }) =>
      ipcRenderer.invoke('settings:save', settings),
    getInfo: () =>
      ipcRenderer.invoke('settings:getInfo'),
  },

  // App settings (notifications, etc.)
  appSettings: {
    get: () =>
      ipcRenderer.invoke('app:getSettings'),
    save: (settings: Record<string, unknown>) =>
      ipcRenderer.invoke('app:saveSettings', settings),
    onUpdated: (callback: (settings: unknown) => void) => {
      const listener = (_: unknown, settings: unknown) => callback(settings);
      ipcRenderer.on('settings:updated', listener);
      return () => ipcRenderer.removeListener('settings:updated', listener);
    },
  },

  // Telegram bot
  telegram: {
    test: () =>
      ipcRenderer.invoke('telegram:test'),
    sendTest: () =>
      ipcRenderer.invoke('telegram:sendTest'),
    generateAuthToken: () =>
      ipcRenderer.invoke('telegram:generateAuthToken'),
    removeAuthorizedChatId: (chatId: string) =>
      ipcRenderer.invoke('telegram:removeAuthorizedChatId', chatId),
  },

  // Slack bot
  slack: {
    test: () =>
      ipcRenderer.invoke('slack:test'),
    sendTest: () =>
      ipcRenderer.invoke('slack:sendTest'),
  },

  // JIRA
  jira: {
    test: () =>
      ipcRenderer.invoke('jira:test'),
  },

  // SocialData (Twitter/X)
  socialData: {
    test: () =>
      ipcRenderer.invoke('socialdata:test'),
  },

  // X API (posting)
  xApi: {
    test: () =>
      ipcRenderer.invoke('xapi:test') as Promise<{ success: boolean; username?: string; error?: string }>,
  },

  // Google Workspace (gws CLI)
  gws: {
    detect: () =>
      ipcRenderer.invoke('gws:detect'),
    detectGcloud: () =>
      ipcRenderer.invoke('gws:detectGcloud'),
    authStatus: () =>
      ipcRenderer.invoke('gws:authStatus'),
    setup: () =>
      ipcRenderer.invoke('gws:setup'),
    remove: () =>
      ipcRenderer.invoke('gws:remove'),
    getMcpStatus: () =>
      ipcRenderer.invoke('gws:getMcpStatus'),
    listSkills: () =>
      ipcRenderer.invoke('gws:listSkills') as Promise<string[]>,
  },

  // Tasmania (Local LLM)
  tasmania: {
    test: () =>
      ipcRenderer.invoke('tasmania:test'),
    getStatus: () =>
      ipcRenderer.invoke('tasmania:getStatus'),
    getModels: () =>
      ipcRenderer.invoke('tasmania:getModels'),
    loadModel: (modelPath: string) =>
      ipcRenderer.invoke('tasmania:loadModel', modelPath),
    stopModel: () =>
      ipcRenderer.invoke('tasmania:stopModel'),
    getMcpStatus: () =>
      ipcRenderer.invoke('tasmania:getMcpStatus'),
    setup: () =>
      ipcRenderer.invoke('tasmania:setup'),
    remove: () =>
      ipcRenderer.invoke('tasmania:remove'),
  },

  // Dialogs
  dialog: {
    openFolder: () =>
      ipcRenderer.invoke('dialog:open-folder'),
    openFiles: () =>
      ipcRenderer.invoke('dialog:open-files') as Promise<string[]>,
    openAudio: () =>
      ipcRenderer.invoke('dialog:open-audio') as Promise<string | null>,
  },

  // Shell operations
  shell: {
    openTerminal: (params: { cwd: string; command?: string }) =>
      ipcRenderer.invoke('shell:open-terminal', params),
    exec: (params: { command: string; cwd?: string }) =>
      ipcRenderer.invoke('shell:exec', params),
    // Quick terminal PTY
    startPty: (params: { cwd?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('shell:startPty', params),
    writePty: (params: { ptyId: string; data: string }) =>
      ipcRenderer.invoke('shell:writePty', params),
    resizePty: (params: { ptyId: string; cols: number; rows: number }) =>
      ipcRenderer.invoke('shell:resizePty', params),
    killPty: (params: { ptyId: string }) =>
      ipcRenderer.invoke('shell:killPty', params),
    // Event listeners for quick terminal
    onPtyOutput: (callback: (event: { ptyId: string; data: string }) => void) => {
      const listener = (_: unknown, event: { ptyId: string; data: string }) => callback(event);
      ipcRenderer.on('shell:ptyOutput', listener);
      return () => ipcRenderer.removeListener('shell:ptyOutput', listener);
    },
    onPtyExit: (callback: (event: { ptyId: string; exitCode: number }) => void) => {
      const listener = (_: unknown, event: { ptyId: string; exitCode: number }) => callback(event);
      ipcRenderer.on('shell:ptyExit', listener);
      return () => ipcRenderer.removeListener('shell:ptyExit', listener);
    },
  },

  // Orchestrator (Super Agent) management
  orchestrator: {
    getStatus: () =>
      ipcRenderer.invoke('orchestrator:getStatus'),
    setup: () =>
      ipcRenderer.invoke('orchestrator:setup'),
    remove: () =>
      ipcRenderer.invoke('orchestrator:remove'),
  },

  // Scheduler (native implementation)
  scheduler: {
    listTasks: () =>
      ipcRenderer.invoke('scheduler:listTasks'),
    createTask: (params: {
      agentId?: string;
      prompt: string;
      schedule: string;
      projectPath: string;
      autonomous: boolean;
      useWorktree?: boolean;
      notifications?: { telegram: boolean; slack: boolean };
    }) =>
      ipcRenderer.invoke('scheduler:createTask', params),
    deleteTask: (taskId: string) =>
      ipcRenderer.invoke('scheduler:deleteTask', taskId),
    updateTask: (taskId: string, updates: {
      prompt?: string;
      schedule?: string;
      projectPath?: string;
      autonomous?: boolean;
      notifications?: { telegram: boolean; slack: boolean };
    }) =>
      ipcRenderer.invoke('scheduler:updateTask', taskId, updates),
    runTask: (taskId: string) =>
      ipcRenderer.invoke('scheduler:runTask', taskId),
    getLogs: (taskId: string) =>
      ipcRenderer.invoke('scheduler:getLogs', taskId),
    fixMcpPaths: () =>
      ipcRenderer.invoke('scheduler:fixMcpPaths'),
    watchLogs: (taskId: string) =>
      ipcRenderer.invoke('scheduler:watchLogs', taskId),
    unwatchLogs: (taskId: string) =>
      ipcRenderer.invoke('scheduler:unwatchLogs', taskId),
    onLogData: (callback: (event: { taskId: string; data: string }) => void) => {
      const listener = (_: unknown, event: { taskId: string; data: string }) => callback(event);
      ipcRenderer.on('scheduler:log-data', listener);
      return () => ipcRenderer.removeListener('scheduler:log-data', listener);
    },
    onTaskStatus: (callback: (event: { taskId: string; status: string; summary?: string }) => void) => {
      const listener = (_: unknown, event: { taskId: string; status: string; summary?: string }) => callback(event);
      ipcRenderer.on('scheduler:task-status', listener);
      return () => ipcRenderer.removeListener('scheduler:task-status', listener);
    },
  },

  // Automations
  automation: {
    list: () =>
      ipcRenderer.invoke('automation:list'),
    create: (params: {
      name: string;
      description?: string;
      sourceType: string;
      sourceConfig: string;
      scheduleMinutes?: number;
      scheduleCron?: string;
      eventTypes?: string[];
      onNewItem?: boolean;
      agentEnabled?: boolean;
      agentPrompt?: string;
      agentProjectPath?: string;
      outputTelegram?: boolean;
      outputSlack?: boolean;
      outputGitHubComment?: boolean;
      outputJiraComment?: boolean;
      outputJiraTransition?: string;
      outputTemplate?: string;
    } | Record<string, unknown>) =>
      ipcRenderer.invoke('automation:create', params),
    update: (id: string, params: { enabled?: boolean; name?: string }) =>
      ipcRenderer.invoke('automation:update', id, params),
    delete: (id: string) =>
      ipcRenderer.invoke('automation:delete', id),
    run: (id: string) =>
      ipcRenderer.invoke('automation:run', id),
    getLogs: (id: string) =>
      ipcRenderer.invoke('automation:getLogs', id),
  },

  // Kanban Board
  kanban: {
    list: () =>
      ipcRenderer.invoke('kanban:list'),
    get: (id: string) =>
      ipcRenderer.invoke('kanban:get', id),
    create: (params: {
      title: string;
      description: string;
      projectId: string;
      projectPath: string;
      requiredSkills?: string[];
      priority?: 'low' | 'medium' | 'high';
      labels?: string[];
    }) =>
      ipcRenderer.invoke('kanban:create', params),
    update: (params: {
      id: string;
      title?: string;
      description?: string;
      requiredSkills?: string[];
      priority?: 'low' | 'medium' | 'high';
      labels?: string[];
      progress?: number;
      assignedAgentId?: string | null;
    }) =>
      ipcRenderer.invoke('kanban:update', params),
    move: (params: { id: string; column: 'backlog' | 'planned' | 'ongoing' | 'done'; order?: number }) =>
      ipcRenderer.invoke('kanban:move', params),
    delete: (id: string) =>
      ipcRenderer.invoke('kanban:delete', id),
    reorder: (params: { taskIds: string[]; column: 'backlog' | 'planned' | 'ongoing' | 'done' }) =>
      ipcRenderer.invoke('kanban:reorder', params),
    generate: (params: { prompt: string; availableProjects: Array<{ path: string; name: string }> }) =>
      ipcRenderer.invoke('kanban:generate', params),
    // Event listeners
    onTaskCreated: (callback: (task: unknown) => void) => {
      const listener = (_: unknown, task: unknown) => callback(task);
      ipcRenderer.on('kanban:task-created', listener);
      return () => ipcRenderer.removeListener('kanban:task-created', listener);
    },
    onTaskUpdated: (callback: (task: unknown) => void) => {
      const listener = (_: unknown, task: unknown) => callback(task);
      ipcRenderer.on('kanban:task-updated', listener);
      return () => ipcRenderer.removeListener('kanban:task-updated', listener);
    },
    onTaskDeleted: (callback: (event: { id: string }) => void) => {
      const listener = (_: unknown, event: { id: string }) => callback(event);
      ipcRenderer.on('kanban:task-deleted', listener);
      return () => ipcRenderer.removeListener('kanban:task-deleted', listener);
    },
  },

  // Agent templates
  template: {
    list: () =>
      ipcRenderer.invoke('template:list'),
    get: (id: string) =>
      ipcRenderer.invoke('template:get', id),
    create: (input: Record<string, unknown>) =>
      ipcRenderer.invoke('template:create', input),
    update: (patch: Record<string, unknown>) =>
      ipcRenderer.invoke('template:update', patch),
    delete: (id: string) =>
      ipcRenderer.invoke('template:delete', id),
    duplicate: (id: string) =>
      ipcRenderer.invoke('template:duplicate', id),
    export: (ids: string[]) =>
      ipcRenderer.invoke('template:export', ids),
    import: (payload: unknown) =>
      ipcRenderer.invoke('template:import', payload),
  },

  // Vault
  vault: {
    listDocuments: (params?: { folder_id?: string; tags?: string[] }) =>
      ipcRenderer.invoke('vault:listDocuments', params),
    getDocument: (id: string) =>
      ipcRenderer.invoke('vault:getDocument', id),
    createDocument: (params: {
      title: string;
      content: string;
      folder_id?: string;
      author: string;
      agent_id?: string;
      tags?: string[];
    }) =>
      ipcRenderer.invoke('vault:createDocument', params),
    updateDocument: (params: {
      id: string;
      title?: string;
      content?: string;
      tags?: string[];
      folder_id?: string | null;
    }) =>
      ipcRenderer.invoke('vault:updateDocument', params),
    deleteDocument: (id: string) =>
      ipcRenderer.invoke('vault:deleteDocument', id),
    search: (params: { query: string; limit?: number }) =>
      ipcRenderer.invoke('vault:search', params),
    listFolders: () =>
      ipcRenderer.invoke('vault:listFolders'),
    createFolder: (params: { name: string; parent_id?: string }) =>
      ipcRenderer.invoke('vault:createFolder', params),
    deleteFolder: (params: { id: string; recursive?: boolean }) =>
      ipcRenderer.invoke('vault:deleteFolder', params),
    attachFile: (params: { document_id: string; file_path: string }) =>
      ipcRenderer.invoke('vault:attachFile', params),
    // Event listeners
    onDocumentCreated: (callback: (doc: unknown) => void) => {
      const listener = (_: unknown, doc: unknown) => callback(doc);
      ipcRenderer.on('vault:document-created', listener);
      return () => ipcRenderer.removeListener('vault:document-created', listener);
    },
    onDocumentUpdated: (callback: (doc: unknown) => void) => {
      const listener = (_: unknown, doc: unknown) => callback(doc);
      ipcRenderer.on('vault:document-updated', listener);
      return () => ipcRenderer.removeListener('vault:document-updated', listener);
    },
    onDocumentDeleted: (callback: (event: { id: string }) => void) => {
      const listener = (_: unknown, event: { id: string }) => callback(event);
      ipcRenderer.on('vault:document-deleted', listener);
      return () => ipcRenderer.removeListener('vault:document-deleted', listener);
    },
  },

  // World (generative zones)
  world: {
    listZones: () =>
      ipcRenderer.invoke('world:listZones'),
    getZone: (zoneId: string) =>
      ipcRenderer.invoke('world:getZone', zoneId),
    exportZone: (params: { zoneId: string; screenshot: string }) =>
      ipcRenderer.invoke('world:exportZone', params),
    importZone: () =>
      ipcRenderer.invoke('world:importZone'),
    confirmImport: (zone: unknown) =>
      ipcRenderer.invoke('world:confirmImport', zone),
    deleteZone: (zoneId: string) =>
      ipcRenderer.invoke('world:deleteZone', zoneId),
    onZoneUpdated: (callback: (zone: unknown) => void) => {
      const listener = (_: unknown, zone: unknown) => callback(zone);
      ipcRenderer.on('world:zoneUpdated', listener);
      return () => ipcRenderer.removeListener('world:zoneUpdated', listener);
    },
    onZoneDeleted: (callback: (event: { id: string }) => void) => {
      const listener = (_: unknown, event: { id: string }) => callback(event);
      ipcRenderer.on('world:zoneDeleted', listener);
      return () => ipcRenderer.removeListener('world:zoneDeleted', listener);
    },
  },

  // Custom MCP server config
  mcp: {
    list: (params: { provider: string }) =>
      ipcRenderer.invoke('mcp:list', params),
    update: (params: { provider: string; name: string; command: string; args: string[]; env: Record<string, string> }) =>
      ipcRenderer.invoke('mcp:update', params),
    delete: (params: { provider: string; name: string }) =>
      ipcRenderer.invoke('mcp:delete', params),
  },

  // CLI Paths management
  cliPaths: {
    detect: () =>
      ipcRenderer.invoke('cliPaths:detect'),
    get: () =>
      ipcRenderer.invoke('cliPaths:get'),
    save: (paths: { claude: string; gh: string; node: string; additionalPaths: string[] }) =>
      ipcRenderer.invoke('cliPaths:save', paths),
  },

  // Updates
  updates: {
    check: () => ipcRenderer.invoke('app:checkForUpdates'),
    download: () => ipcRenderer.invoke('app:downloadUpdate'),
    quitAndInstall: () => ipcRenderer.invoke('app:quitAndInstall'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    onUpdateAvailable: (callback: (info: { currentVersion: string; latestVersion: string; releaseNotes: string; hasUpdate: boolean }) => void) => {
      const listener = (_: unknown, info: Parameters<typeof callback>[0]) => callback(info);
      ipcRenderer.on('app:update-available', listener);
      return () => ipcRenderer.removeListener('app:update-available', listener);
    },
    onUpdateNotAvailable: (callback: (info: { currentVersion: string; latestVersion: string }) => void) => {
      const listener = (_: unknown, info: Parameters<typeof callback>[0]) => callback(info);
      ipcRenderer.on('app:update-not-available', listener);
      return () => ipcRenderer.removeListener('app:update-not-available', listener);
    },
    onDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => {
      const listener = (_: unknown, progress: Parameters<typeof callback>[0]) => callback(progress);
      ipcRenderer.on('app:update-progress', listener);
      return () => ipcRenderer.removeListener('app:update-progress', listener);
    },
    onUpdateDownloaded: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('app:update-downloaded', listener);
      return () => ipcRenderer.removeListener('app:update-downloaded', listener);
    },
    onUpdateError: (callback: (error: string) => void) => {
      const listener = (_: unknown, error: string) => callback(error);
      ipcRenderer.on('app:update-error', listener);
      return () => ipcRenderer.removeListener('app:update-error', listener);
    },
  },

  // Native Claude memory (reads ~/.claude/projects/*/memory/)
  memory: {
    listProjects: () =>
      ipcRenderer.invoke('memory:list-projects'),
    readFile: (filePath: string) =>
      ipcRenderer.invoke('memory:read-file', filePath),
    writeFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('memory:write-file', filePath, content),
    createFile: (memoryDir: string, fileName: string, content?: string) =>
      ipcRenderer.invoke('memory:create-file', memoryDir, fileName, content ?? ''),
    deleteFile: (filePath: string) =>
      ipcRenderer.invoke('memory:delete-file', filePath),
  },

  // Obsidian vault (read-only browsing, multi-vault)
  obsidian: {
    scan: () => ipcRenderer.invoke('obsidian:scan'),
    readFile: (filePath: string, vaultPath: string) => ipcRenderer.invoke('obsidian:readFile', filePath, vaultPath),
    writeFile: (filePath: string, content: string, vaultPath: string) => ipcRenderer.invoke('obsidian:writeFile', filePath, content, vaultPath),
    getVaultInfo: () => ipcRenderer.invoke('obsidian:getVaultInfo'),
    detectVault: (projectPath: string) => ipcRenderer.invoke('obsidian:detectVault', projectPath),
    addVault: (vaultPath: string) => ipcRenderer.invoke('obsidian:addVault', vaultPath),
    removeVault: (vaultPath: string) => ipcRenderer.invoke('obsidian:removeVault', vaultPath),
  },

  // API
  api: {
    getToken: () => ipcRenderer.invoke('api:getToken') as Promise<string>,
  },

  // Dorothy 멀티회사/오토컴퍼니/하네스/승인 (packaged static-export 에서 API 라우트 대체)
  dorothy: {
    companies: {
      get: () => ipcRenderer.invoke('dorothy:companies:get'),
      select: (companyId: string) =>
        ipcRenderer.invoke('dorothy:companies:mutate', { action: 'select', companyId }),
      add: (company: { id: string; name: string; description?: string }) =>
        ipcRenderer.invoke('dorothy:companies:mutate', { action: 'add', company }),
      update: (
        companyId: string,
        company: { name?: string; description?: string; defaultEngineProfileId?: string },
      ) => ipcRenderer.invoke('dorothy:companies:mutate', { action: 'update', companyId, company }),
      mapAgent: (agentId: string, companyId: string, name?: string | null) =>
        ipcRenderer.invoke('dorothy:companies:mutate', { action: 'mapAgent', agentId, companyId, name }),
    },
    autoCompany: {
      get: () => ipcRenderer.invoke('dorothy:autoCompany:get'),
      control: (action: string) => ipcRenderer.invoke('dorothy:autoCompany:control', { action }),
    },
    teamLoop: { get: () => ipcRenderer.invoke('dorothy:teamLoop:get') },
    agentActivity: { get: () => ipcRenderer.invoke('dorothy:agentActivity:get') },
    doc: { read: (path: string) => ipcRenderer.invoke('dorothy:doc:read', { path }) },
    approvals: { get: () => ipcRenderer.invoke('dorothy:approvals:get') },
    harness: { get: () => ipcRenderer.invoke('dorothy:harness:get') },
    skill: {
      link: (slug: string) => ipcRenderer.invoke('dorothy:skill:link', { action: 'link', slug }),
      unlink: (slug: string) => ipcRenderer.invoke('dorothy:skill:link', { action: 'unlink', slug }),
    },
    // MVP Phase 1 — Run-centric model. Returns { ok, data?, error?, dbUnavailable? }
    // on every call. UI should treat dbUnavailable=true as a graceful-degrade
    // signal (no Run Board yet, fall back to legacy views).
    runs: {
      list: (options?: {
        state?: string | string[];
        source?: string;
        kanbanTaskId?: string;
        limit?: number;
        offset?: number;
      }) => ipcRenderer.invoke('dorothy:runs:list', options ?? {}),
      get: (id: string) => ipcRenderer.invoke('dorothy:runs:get', id),
      create: (input: {
        title: string;
        source: 'user' | 'kanban' | 'pm_tick' | 'automation' | 'schedule';
        sourceRefId?: string | null;
        priority?: 'low' | 'medium' | 'high' | 'critical';
        state?: string;
        kanbanTaskId?: string | null;
        planId?: string | null;
        comment?: string | null;
      }) => ipcRenderer.invoke('dorothy:runs:create', input),
      updateState: (params: {
        id: string;
        state: string;
        blockedReason?: string;
        errorReason?: string;
        comment?: string;
      }) => ipcRenderer.invoke('dorothy:runs:updateState', params),
      // Phase 5E — operator-driven RunMode change.
      updateMode: (params: {
        id: string;
        mode: string;
        reason?: string;
        source?: string;
      }) => ipcRenderer.invoke('dorothy:runs:updateMode', params),
    },
    sessions: {
      list: (options?: {
        agentId?: string;
        runId?: string;
        runStepId?: string;
        active?: boolean;
        limit?: number;
      }) => ipcRenderer.invoke('dorothy:sessions:list', options ?? {}),
    },
    // Phase 6-AE — read-only, masked live agent terminal output snapshots.
    agentTerminal: {
      listSnapshots: (options?: { lines?: number }) =>
        ipcRenderer.invoke('dorothy:agentTerminal:listSnapshots', options ?? {}),
      getSnapshot: (agentId: string, options?: { lines?: number }) =>
        ipcRenderer.invoke('dorothy:agentTerminal:getSnapshot', { agentId, ...(options ?? {}) }),
    },
    artifacts: {
      list: (options?: {
        runId?: string;
        runStepId?: string;
        type?: string;
        producedByAgentId?: string;
        limit?: number;
      }) => ipcRenderer.invoke('dorothy:artifacts:list', options ?? {}),
      // Phase 5C-C — single + bulk lookups for the ImprovementSignal evidence preview.
      get: (id: string) => ipcRenderer.invoke('dorothy:artifacts:get', id),
      listByIds: (ids: string[]) => ipcRenderer.invoke('dorothy:artifacts:listByIds', ids),
    },
    handoffs: {
      list: (params: { runId: string }) =>
        ipcRenderer.invoke('dorothy:handoffs:list', params),
    },
    plans: {
      list: (options?: { runId?: string; state?: string; limit?: number }) =>
        ipcRenderer.invoke('dorothy:plans:list', options ?? {}),
      get: (id: string) => ipcRenderer.invoke('dorothy:plans:get', id),
      // Phase 4 — validate runs the 5-check policy and may immediately mark
      // the plan approved/pending/rejected. Returns { verdict, ... }.
      validate: (planId: string) => ipcRenderer.invoke('dorothy:plans:validate', planId),
    },
    // Phase 3 — push the orchestrator forward. `advance` works on one Run;
    // `advanceAll` walks every advanceable Run (used by the periodic tick).
    orchestrator: {
      advance: (runId: string) => ipcRenderer.invoke('dorothy:runs:advance', runId),
      advanceAll: () => ipcRenderer.invoke('dorothy:runs:advanceAll'),
    },
    // Phase 4 — rate-limit ↔ Run bridge.
    rateLimit: {
      list: (options?: { engine?: string; active?: boolean; limit?: number }) =>
        ipcRenderer.invoke('dorothy:rateLimit:list', options ?? {}),
      record: (input: {
        engine: string;
        source: string;
        detectedAt?: string;
        resetAt?: string | null;
        message?: string | null;
        rawRef?: string | null;
        affectedRunIds?: string[];
      }) => ipcRenderer.invoke('dorothy:rateLimit:record', input),
      resume: (params: { eventId: string; engine?: string }) =>
        ipcRenderer.invoke('dorothy:rateLimit:resume', params),
      // Phase 5C-B
      listScheduled: (options?: { limit?: number }) =>
        ipcRenderer.invoke('dorothy:rateLimit:listScheduled', options ?? {}),
      resumeNow: (eventId: string) =>
        ipcRenderer.invoke('dorothy:rateLimit:resumeNow', eventId),
      schedulerStatus: () => ipcRenderer.invoke('dorothy:rateLimit:schedulerStatus'),
    },
    // Phase 5D — Run Mode policy + router.
    runModes: {
      policies: () => ipcRenderer.invoke('dorothy:runModes:policies'),
      decide: (text: string) => ipcRenderer.invoke('dorothy:runModes:decide', text),
    },
    // Phase 5C-B — ImprovementSignal.
    improvements: {
      list: (options?: { status?: string | string[]; source?: string; runId?: string; severity?: string; limit?: number; offset?: number }) =>
        ipcRenderer.invoke('dorothy:improvements:list', options ?? {}),
      listByRun: (runId: string) =>
        ipcRenderer.invoke('dorothy:improvements:listByRun', runId),
      updateStatus: (params: { id: string; status: string; note?: string }) =>
        ipcRenderer.invoke('dorothy:improvements:updateStatus', params),
      // Phase 5E — operator-driven conversion to a KanbanTask.
      convertToTask: (params: {
        id: string;
        column?: string;
        projectId?: string;
        projectPath?: string;
      }) => ipcRenderer.invoke('dorothy:improvements:convertToTask', params),
    },
    // Phase 5A — PR / CI tracking. Read-only from the renderer; writes happen
    // through the GitHub webhook receiver (POST /api/github/webhook).
    pr: {
      list: (options?: {
        state?: string | string[];
        runId?: string;
        owner?: string;
        repo?: string;
        limit?: number;
        offset?: number;
      }) => ipcRenderer.invoke('dorothy:pr:list', options ?? {}),
      get: (id: string) => ipcRenderer.invoke('dorothy:pr:get', id),
      listByRun: (runId: string) => ipcRenderer.invoke('dorothy:pr:listByRun', runId),
    },
    ci: {
      list: (options?: {
        state?: string | string[];
        runId?: string;
        pullRequestId?: string;
        workflow?: string;
        limit?: number;
        offset?: number;
      }) => ipcRenderer.invoke('dorothy:ci:list', options ?? {}),
      get: (id: string) => ipcRenderer.invoke('dorothy:ci:get', id),
      listByRun: (runId: string) => ipcRenderer.invoke('dorothy:ci:listByRun', runId),
      listByPullRequest: (pullRequestId: string) =>
        ipcRenderer.invoke('dorothy:ci:listByPullRequest', pullRequestId),
    },
    // Phase 5F — Hook Event Bus reads.
    hookEvents: {
      list: (options?: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:hookEvents:list', options ?? {}),
      listByRun: (runId: string, options?: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:hookEvents:listByRun', runId, options ?? {}),
      listBySession: (agentSessionId: string, options?: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:hookEvents:listBySession', agentSessionId, options ?? {}),
      listRecent: (options?: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:hookEvents:listRecent', options ?? {}),
    },
    // Phase 6-A — Diagnostic reads + write surface.
    diagnostics: {
      list: (options?: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:diagnostics:list', options ?? {}),
      listByRun: (runId: string, options?: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:diagnostics:listByRun', runId, options ?? {}),
      get: (id: string) =>
        ipcRenderer.invoke('dorothy:diagnostics:get', id),
      updateStatus: (params: { id: string; status: string; note?: string }) =>
        ipcRenderer.invoke('dorothy:diagnostics:updateStatus', params),
      convertToImprovement: (params: { id: string }) =>
        ipcRenderer.invoke('dorothy:diagnostics:convertToImprovement', params),
      counts: () => ipcRenderer.invoke('dorothy:diagnostics:counts'),
    },
    // Phase 6-B — AgentWorkflowProgress reads.
    workflowProgress: {
      list: (options?: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:workflowProgress:list', options ?? {}),
      listByRun: (runId: string, options?: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:workflowProgress:listByRun', runId, options ?? {}),
      listBySession: (agentSessionId: string, options?: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:workflowProgress:listBySession', agentSessionId, options ?? {}),
      get: (id: string) =>
        ipcRenderer.invoke('dorothy:workflowProgress:get', id),
      recomputeByRun: (runId: string) =>
        ipcRenderer.invoke('dorothy:workflowProgress:recomputeByRun', runId),
      counts: () => ipcRenderer.invoke('dorothy:workflowProgress:counts'),
    },
    // Phase 6-D — SkillCandidate reads + light write surface.
    skillCandidates: {
      list: (options?: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:skillCandidates:list', options ?? {}),
      listByRun: (runId: string, options?: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:skillCandidates:listByRun', runId, options ?? {}),
      get: (id: string) => ipcRenderer.invoke('dorothy:skillCandidates:get', id),
      updateStatus: (params: { id: string; status: string; note?: string }) =>
        ipcRenderer.invoke('dorothy:skillCandidates:updateStatus', params),
      fromImprovementSignal: (params: { id: string }) =>
        ipcRenderer.invoke('dorothy:skillCandidates:fromImprovementSignal', params),
      fromDiagnostic: (params: { id: string }) =>
        ipcRenderer.invoke('dorothy:skillCandidates:fromDiagnostic', params),
      convertToTask: (params: { id: string; column?: string }) =>
        ipcRenderer.invoke('dorothy:skillCandidates:convertToTask', params),
      counts: () => ipcRenderer.invoke('dorothy:skillCandidates:counts'),
    },
    // Phase 6-W — App Factory (planning-only; preview never creates Kanban/code).
    appFactory: {
      listCandidates: (options?: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:appFactory:listCandidates', options ?? {}),
      getCandidate: (id: string) => ipcRenderer.invoke('dorothy:appFactory:getCandidate', id),
      createCandidate: (input: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:appFactory:createCandidate', input),
      updateCandidateStatus: (params: { id: string; status: string }) =>
        ipcRenderer.invoke('dorothy:appFactory:updateCandidateStatus', params),
      generatePlanPreview: (params: { appCandidateId: string }) =>
        ipcRenderer.invoke('dorothy:appFactory:generatePlanPreview', params),
      createPlan: (params: { appCandidateId: string; status?: string }) =>
        ipcRenderer.invoke('dorothy:appFactory:createPlan', params),
      listPlans: (options?: Record<string, unknown>) =>
        ipcRenderer.invoke('dorothy:appFactory:listPlans', options ?? {}),
      getPlan: (id: string) => ipcRenderer.invoke('dorothy:appFactory:getPlan', id),
      counts: () => ipcRenderer.invoke('dorothy:appFactory:counts'),
    },
    // Phase 6-E — Agent Definition Registry / Idle Reason / Communication.
    agentDefinitions: {
      list: (options?: { extraProjectPaths?: string[]; includeUserDir?: boolean }) =>
        ipcRenderer.invoke('dorothy:agentDefinitions:list', options ?? {}),
      get: (agentId: string) => ipcRenderer.invoke('dorothy:agentDefinitions:get', agentId),
      rescan: (options?: { extraProjectPaths?: string[]; includeUserDir?: boolean }) =>
        ipcRenderer.invoke('dorothy:agentDefinitions:rescan', options ?? {}),
      // Phase 6-H — reload agents.json into the live agent manager (no restart).
      reloadLiveAgents: (params?: { reason?: string }) =>
        ipcRenderer.invoke('dorothy:agentDefinitions:reloadLiveAgents', params ?? {}),
    },
    agentIdle: {
      list: (options?: { agentIds?: string[] }) =>
        ipcRenderer.invoke('dorothy:agentIdle:list', options ?? {}),
      get: (agentId: string) => ipcRenderer.invoke('dorothy:agentIdle:get', agentId),
    },
    agentCommunication: {
      listByRun: (runId: string, options?: { limit?: number }) =>
        ipcRenderer.invoke('dorothy:agentCommunication:listByRun', runId, options ?? {}),
      listByAgent: (agentId: string, options?: { limit?: number; runIds?: string[] }) =>
        ipcRenderer.invoke('dorothy:agentCommunication:listByAgent', agentId, options ?? {}),
      listRecent: (options?: { limit?: number }) =>
        ipcRenderer.invoke('dorothy:agentCommunication:listRecent', options ?? {}),
    },
    // Phase 6-G — Agent Definition manual registration.
    agentRegistration: {
      listCandidates: () =>
        ipcRenderer.invoke('dorothy:agentRegistration:listCandidates'),
      preview: (params: { agentDefinitionId: string; options?: Record<string, unknown> }) =>
        ipcRenderer.invoke('dorothy:agentRegistration:preview', params),
      register: (params: { agentDefinitionId: string; options?: Record<string, unknown>; confirm?: boolean }) =>
        ipcRenderer.invoke('dorothy:agentRegistration:register', params),
    },
    // Phase 6-J — dispatch readiness (dry-run diagnosis).
    agentDispatch: {
      listReadiness: (options?: { agentIds?: string[] }) =>
        ipcRenderer.invoke('dorothy:agentDispatch:listReadiness', options ?? {}),
      listReadinessByRun: (runId: string) =>
        ipcRenderer.invoke('dorothy:agentDispatch:listReadinessByRun', runId),
    },
    // Phase 6-K — Claude launch readiness (binary + path validation).
    claude: {
      launchReadiness: () => ipcRenderer.invoke('dorothy:claude:launchReadiness'),
    },
    // Phase 6-M — Codex runtime readiness + stale session detection.
    codex: {
      runtimeReadiness: () => ipcRenderer.invoke('dorothy:codex:runtimeReadiness'),
    },
    staleSessions: {
      list: () => ipcRenderer.invoke('dorothy:sessions:staleModelMismatch'),
    },
    // Phase 6-Q — batch warm-up + Codex model normalization.
    warmup: {
      targets: (options?: { agentIds?: string[] }) =>
        ipcRenderer.invoke('dorothy:agents:warmupTargets', options ?? {}),
      all: (params: { agentIds?: string[]; confirm?: boolean }) =>
        ipcRenderer.invoke('dorothy:agents:warmupAll', params),
    },
    codexNormalize: {
      preview: () => ipcRenderer.invoke('dorothy:agents:normalizeCodexModelsPreview'),
      apply: (params: { confirm?: boolean }) =>
        ipcRenderer.invoke('dorothy:agents:normalizeCodexModels', params),
    },
  },

  // Tray menu events
  tray: {
    onFocusAgent: (callback: (agentId: string) => void) => {
      const listener = (_: unknown, agentId: string) => callback(agentId);
      ipcRenderer.on('tray:focus-agent', listener);
      return () => ipcRenderer.removeListener('tray:focus-agent', listener);
    },
    showMainWindow: () => ipcRenderer.invoke('tray:showMainWindow'),
    quit: () => ipcRenderer.invoke('tray:quit'),
  },

  // Platform info
  platform: process.platform,
});
