/**
 * Dorothy MVP Phase 6-K — Claude binary resolver.
 *
 * Under launchd / Electron / PTY the inherited PATH is minimal and frequently
 * omits the directory where the `claude` CLI actually lives (e.g.
 * `~/.npm-global/bin`), producing `bash: claude: command not found`. This
 * resolver finds an ABSOLUTE, executable path to the binary so the launch
 * command never depends on PATH.
 *
 * Pure + injectable (fs / env / homeDir) so it is unit-testable and never
 * touches the network. Never logs the resolved value beyond the path itself
 * (a binary path is not a secret, but we still avoid dumping env).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type ClaudeBinarySource =
  | 'configured'
  | 'path'
  | 'homebrew'
  | 'usr_local'
  | 'npm_global'
  | 'local_bin'
  | 'bun_bin';

export interface ResolveClaudeBinaryResult {
  ok: boolean;
  path?: string;
  source?: ClaudeBinarySource;
  checkedPaths: string[];
  error?: string;
}

export interface ResolveClaudeBinaryOptions {
  /** appSettings.cliPaths.claude or appSettings.claudeBinaryPath. */
  configuredPath?: string;
  /** PATH string to scan (defaults to process.env.PATH). */
  envPath?: string;
  homeDir?: string;
  /** Injected fs for tests. */
  fsImpl?: Pick<typeof fs, 'existsSync' | 'statSync' | 'accessSync'>;
  /** Binary base name; defaults to 'claude'. */
  binaryName?: string;
}

/** True when `p` exists and is a regular file or symlink we can execute. */
function isExecutableFile(
  p: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'statSync' | 'accessSync'>,
): boolean {
  try {
    if (!fsImpl.existsSync(p)) return false;
    const st = fsImpl.statSync(p);
    // Allow files and symlinks (statSync follows symlinks); reject dirs.
    if (st.isDirectory()) return false;
    try {
      fsImpl.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      // Some filesystems / mocked stats don't carry exec bits reliably; if the
      // path exists and isn't a directory, accept it (the shell will surface a
      // real perms error, which we'd then catch at launch).
      return true;
    }
  } catch {
    return false;
  }
}

export function resolveClaudeBinaryPath(
  options: ResolveClaudeBinaryOptions = {},
): ResolveClaudeBinaryResult {
  const fsImpl = options.fsImpl ?? fs;
  const home = options.homeDir ?? os.homedir();
  const binaryName = options.binaryName ?? 'claude';
  const checkedPaths: string[] = [];

  const tryPath = (p: string, source: ClaudeBinarySource): ResolveClaudeBinaryResult | null => {
    checkedPaths.push(p);
    return isExecutableFile(p, fsImpl) ? { ok: true, path: p, source, checkedPaths } : null;
  };

  // 1) explicitly configured path (highest priority)
  if (options.configuredPath && options.configuredPath.trim()) {
    const cfg = options.configuredPath.trim();
    // If it's an absolute path, check it directly; otherwise treat as a bare
    // name and let the PATH scan below handle it.
    if (path.isAbsolute(cfg)) {
      const hit = tryPath(cfg, 'configured');
      if (hit) return hit;
    }
  }

  // 2) scan PATH entries for an executable `claude`
  const envPath = options.envPath ?? process.env.PATH ?? '';
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binaryName);
    const hit = tryPath(candidate, 'path');
    if (hit) return hit;
  }

  // 3) well-known install locations, in priority order
  const wellKnown: Array<{ p: string; source: ClaudeBinarySource }> = [
    { p: `/opt/homebrew/bin/${binaryName}`, source: 'homebrew' },
    { p: `/usr/local/bin/${binaryName}`, source: 'usr_local' },
    { p: path.join(home, '.npm-global/bin', binaryName), source: 'npm_global' },
    { p: path.join(home, '.local/bin', binaryName), source: 'local_bin' },
    { p: path.join(home, '.bun/bin', binaryName), source: 'bun_bin' },
  ];
  for (const { p, source } of wellKnown) {
    const hit = tryPath(p, source);
    if (hit) return hit;
  }

  return {
    ok: false,
    checkedPaths,
    error: `Could not find an executable "${binaryName}" binary. Checked ${checkedPaths.length} location(s).`,
  };
}
