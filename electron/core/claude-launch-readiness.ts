/**
 * Dorothy MVP Phase 6-K — Claude launch readiness (pre-flight, read-only).
 *
 * Validates everything an agent needs BEFORE a PTY is opened, so we never
 * leave an empty shell with `bash: claude: command not found`:
 *   - the `claude` binary resolves to an executable absolute path
 *   - the agent's projectPath exists
 *   - the optional MCP config exists (informational)
 *   - the Dorothy --add-dir (~/.dorothy) exists
 *
 * It NEVER spawns anything, never edits paths, and never consumes a token.
 * Obvious path typos (e.g. `/sers/soo` → `/Users/soo`, `sourc-code` →
 * `source-code`) are surfaced as *suggestions only* — never auto-applied.
 */

import * as fs from 'fs';
import * as os from 'os';
import {
  resolveClaudeBinaryPath,
  type ClaudeBinarySource,
} from './claude-binary-resolver';

export type LaunchBlockReason =
  | 'claude_binary_missing'
  | 'project_path_missing'
  | 'mcp_config_missing'
  | 'add_dir_missing'
  | 'launch_command_invalid';

export interface PathCheck {
  path?: string;
  ok: boolean;
  /** A corrected-path suggestion when an obvious typo is detected. */
  suggestion?: string;
}

export interface ClaudeLaunchReadiness {
  agentId?: string;
  claudeBinary: { found: boolean; path?: string; source?: ClaudeBinarySource };
  projectPath: PathCheck;
  mcpConfig: PathCheck & { required: boolean };
  addDir: PathCheck;
  ready: boolean;
  launchBlockReason?: LaunchBlockReason;
  /** Human one-liner for the dashboard. */
  summary: string;
}

export interface CheckLaunchReadinessOptions {
  agentId?: string;
  projectPath?: string;
  mcpConfigPath?: string;
  /** Whether an MCP config is required for this provider/agent. Default false
   *  (claude attaches --mcp-config only when the file exists). */
  mcpRequired?: boolean;
  configuredClaudePath?: string;
  homeDir?: string;
  envPath?: string;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'statSync' | 'accessSync'>;
}

/** Detect obvious filesystem typos and suggest a corrected path that exists. */
export function suggestPathCorrection(
  p: string | undefined,
  fsImpl: Pick<typeof fs, 'existsSync'>,
): string | undefined {
  if (!p) return undefined;
  const candidates = [
    p.replace('/sers/', '/Users/'),
    p.replace('sourc-code', 'source-code'),
    p.replace('/sers/', '/Users/').replace('sourc-code', 'source-code'),
  ].filter(c => c !== p);
  for (const c of candidates) {
    try {
      if (fsImpl.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export function checkClaudeLaunchReadiness(
  opts: CheckLaunchReadinessOptions = {},
): ClaudeLaunchReadiness {
  const fsImpl = opts.fsImpl ?? fs;
  const home = opts.homeDir ?? os.homedir();

  // 1) binary
  const bin = resolveClaudeBinaryPath({
    configuredPath: opts.configuredClaudePath || undefined,
    envPath: opts.envPath,
    homeDir: home,
    fsImpl,
  });

  // 2) project path
  const projectOk = !!opts.projectPath && safeExists(opts.projectPath, fsImpl);
  const projectPath: PathCheck = {
    path: opts.projectPath,
    ok: projectOk,
    suggestion: projectOk ? undefined : suggestPathCorrection(opts.projectPath, fsImpl),
  };

  // 3) MCP config (informational unless required)
  const mcpProvided = !!opts.mcpConfigPath;
  const mcpOk = mcpProvided ? safeExists(opts.mcpConfigPath!, fsImpl) : !opts.mcpRequired;
  const mcpConfig: PathCheck & { required: boolean } = {
    path: opts.mcpConfigPath,
    ok: mcpOk,
    required: !!opts.mcpRequired,
    suggestion: mcpProvided && !mcpOk ? suggestPathCorrection(opts.mcpConfigPath, fsImpl) : undefined,
  };

  // 4) add-dir (~/.dorothy is always attached by the command builder)
  const addDirPath = `${home}/.dorothy`;
  const addDir: PathCheck = { path: addDirPath, ok: safeExists(addDirPath, fsImpl) };

  // Block-reason priority: binary → project → add-dir → mcp(only if required)
  let launchBlockReason: LaunchBlockReason | undefined;
  if (!bin.ok) launchBlockReason = 'claude_binary_missing';
  else if (!projectPath.ok) launchBlockReason = 'project_path_missing';
  else if (!addDir.ok) launchBlockReason = 'add_dir_missing';
  else if (opts.mcpRequired && !mcpConfig.ok) launchBlockReason = 'mcp_config_missing';

  const ready = !launchBlockReason;

  const summary = ready
    ? `Ready to launch (claude: ${bin.source}).`
    : launchBlockReason === 'claude_binary_missing'
      ? 'Claude binary was not found in the dashboard PATH or well-known install dirs.'
      : launchBlockReason === 'project_path_missing'
        ? `Project path does not exist: ${opts.projectPath ?? '(unset)'}${projectPath.suggestion ? ` — did you mean ${projectPath.suggestion}?` : ''}`
        : launchBlockReason === 'add_dir_missing'
          ? `Add-dir missing: ${addDirPath}`
          : `MCP config missing: ${opts.mcpConfigPath ?? '(unset)'}`;

  return {
    agentId: opts.agentId,
    claudeBinary: { found: bin.ok, path: bin.path, source: bin.source },
    projectPath,
    mcpConfig,
    addDir,
    ready,
    launchBlockReason,
    summary,
  };
}

function safeExists(p: string, fsImpl: Pick<typeof fs, 'existsSync'>): boolean {
  try {
    return fsImpl.existsSync(p);
  } catch {
    return false;
  }
}
