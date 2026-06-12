export interface WorktreeConfig {
  enabled: boolean;
  branchName: string;
}

export type AgentCharacter = 'robot' | 'ninja' | 'wizard' | 'astronaut' | 'knight' | 'pirate' | 'alien' | 'viking';

export type AgentProvider = 'claude' | 'codex' | 'gemini' | 'opencode' | 'pi' | 'local';

/** Permission mode for agent tool use:
 * - normal: Claude asks for confirmation on each tool use
 * - auto: agent runs fully autonomously (--dangerously-skip-permissions)
 * - bypass: same as auto, explicit intent to bypass all checks
 */
export type AgentPermissionMode = 'normal' | 'auto' | 'bypass';

/** Effort level for agent reasoning:
 * - low: fast, minimal thinking
 * - medium: default balanced mode
 * - high: extended thinking (--think flag)
 */
export type AgentEffort = 'low' | 'medium' | 'high';

export interface AgentStatus {
  id: string;
  status: 'idle' | 'running' | 'completed' | 'error' | 'waiting';
  projectPath: string;
  secondaryProjectPath?: string;
  worktreePath?: string;
  branchName?: string;
  skills: string[];
  currentTask?: string;
  output: string[];
  lastActivity: string;
  error?: string;
  ptyId?: string;
  /** 순서3 — 살아있는 PTY 프로세스 pid(spawn 시 기록, 종료 시 비움). 리컨실러가
   *  레지스트리↔실제 프로세스를 매핑해 '미추적 스폰'을 식별하게 한다("11 vs 20" 수리). */
  pid?: number;
  character?: AgentCharacter;
  name?: string;
  pathMissing?: boolean;
  /** @deprecated use permissionMode instead */
  skipPermissions?: boolean;
  permissionMode?: AgentPermissionMode;
  effort?: AgentEffort;
  currentSessionId?: string;
  kanbanTaskId?: string;  // For kanban task completion tracking
  // MVP Run linkage — optional, populated lazily by the new dorothy-db layer.
  // Older `agents.json` files without these fields keep loading unchanged.
  currentRunId?: string;
  currentRunStepId?: string;
  currentAgentSessionId?: string;
  statusLine?: string;       // ANSI-stripped last meaningful output line
  lastCleanOutput?: string;  // Clean text output captured from transcript by hooks
  provider?: AgentProvider;   // 'claude' (default) or 'local' (Tasmania)
  model?: string;              // Model name (e.g. 'sonnet', 'opus', 'haiku') — persisted across restarts
  localModel?: string;        // Tasmania model name when provider is 'local'
  savedPrompt?: string;       // Saved task/prompt for re-launching the agent
  obsidianVaultPaths?: string[]; // Obsidian vault paths to mount via --add-dir (read-only)
  createdAt?: string;         // ISO timestamp when the agent was created
}

export interface CLIPaths {
  claude: string;
  codex: string;
  gemini: string;
  opencode: string;
  pi: string;
  gws: string;
  gcloud: string;
  gh: string;
  node: string;
  additionalPaths: string[];
}

export interface AppSettings {
  notificationsEnabled: boolean;
  notifyOnWaiting: boolean;
  notifyOnComplete: boolean;
  notifyOnStop: boolean;
  notifyOnError: boolean;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string; // Legacy - kept for backwards compatibility
  telegramAuthToken: string; // Secret token for authentication
  telegramAuthorizedChatIds: string[]; // List of authorized chat IDs
  telegramRequireMention: boolean; // Only respond when bot is @mentioned in groups
  slackEnabled: boolean;
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  slackChannelId: string;
  jiraEnabled: boolean;
  jiraDomain: string;
  jiraEmail: string;
  jiraApiToken: string;
  socialDataEnabled: boolean;
  socialDataApiKey: string;
  xPostingEnabled: boolean;
  xApiKey: string;
  xApiSecret: string;
  xAccessToken: string;
  xAccessTokenSecret: string;
  tasmaniaEnabled: boolean;
  tasmaniaServerPath: string;
  gwsEnabled: boolean;
  gwsSkillsInstalled: boolean;
  verboseModeEnabled: boolean;
  chromeEnabled: boolean;
  autoCheckUpdates: boolean;
  cliPaths: CLIPaths;
  /** Phase 6-K — optional explicit absolute path to the `claude` binary.
   *  Highest-priority source for ClaudeProvider.resolveBinaryPath; falls back
   *  to PATH + well-known install dirs when unset/invalid. */
  claudeBinaryPath?: string;
  /** Phase 6-M — optional provider default models. Used at launch only when
   *  the agent's own model is unset or incompatible; never rewrites agents.json. */
  defaultCodexModel?: string;
  defaultClaudeModel?: string;
  opencodeEnabled: boolean;
  opencodeDefaultModel: string;
  defaultProvider?: AgentProvider;
  obsidianVaultPaths?: string[];
  notificationSounds?: {
    waiting?: string;
    complete?: string;
    stop?: string;
    error?: string;
  };
  terminalFontSize?: number;
  terminalTheme?: 'dark' | 'light';
  statusLineEnabled?: boolean;
  favoriteProjects?: string[];
  hiddenProjects?: string[];
  defaultProjectPath?: string;
  // MVP Phase 4.5 — feature flag for the new orchestrator-driven dispatch.
  // When false (default), the orchestrator only *selects* the next worker;
  // the existing kanban auto-spawn / `/api/agents/:id/start` path actually
  // spawns the PTY. When true, the orchestrator calls the start endpoint
  // itself with a Run-context prompt. Failures fall back to the legacy path,
  // so flipping this on is reversible.
  dorothyOrchestratorAutoSpawn?: boolean;
  // Phase 5A — GitHub webhook receiver.
  //   `githubWebhookSecret`: HMAC-SHA256 shared secret with GitHub. When
  //     empty, the receiver rejects everything unless
  //     `dorothyDevAllowUnsignedWebhook=true` (developer mode for curl).
  //   `dorothyPrCiAutoTransition`: when true, a merged PR or a failed CI run
  //     may move a linked Run between MVP states (reporting→completed,
  //     reporting→needs_fix). Default off so the receiver mirrors data only.
  githubWebhookSecret?: string;
  dorothyDevAllowUnsignedWebhook?: boolean;
  dorothyPrCiAutoTransition?: boolean;
  /**
   * Phase 5C-B — Auto Resume Scheduler mode. Accepts:
   *   - `'dry-run'` (default): record candidates, never call startAgent
   *   - `true` / `'live'` / `'on'`: dispatch the worker after resumeAt
   *   - `false` / `'off'`: scheduler runs but produces no UI/state changes
   * Manual user-initiated `resumeNow` works regardless of this flag.
   */
  dorothyAutoResumeRateLimitedSessions?: boolean | 'dry-run' | 'live' | 'on' | 'off' | 'true' | 'false';
}
