import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Build a full PATH string that includes nvm node versions,
 * common binary locations, and the existing process PATH.
 *
 * @param extraPaths - Additional paths to prepend (e.g. user-configured CLI paths)
 * @returns Deduplicated PATH string
 */
export function buildFullPath(extraPaths: string[] = []): string {
  const homeDir = process.env.HOME || os.homedir();
  const existingPath = process.env.PATH || '';

  const additionalPaths = [
    ...extraPaths,
    path.join(homeDir, '.nvm/versions/node/v20.11.1/bin'),
    path.join(homeDir, '.nvm/versions/node/v22.0.0/bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(homeDir, '.local/bin'),
    // Phase 6-K — common global-CLI install dirs (npm -g prefix, bun) where the
    // `claude` binary frequently lives but launchd's minimal PATH omits.
    path.join(homeDir, '.npm-global/bin'),
    path.join(homeDir, '.bun/bin'),
  ];

  // Find any nvm node version directories
  const nvmDir = path.join(homeDir, '.nvm/versions/node');
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir);
      for (const version of versions) {
        additionalPaths.push(path.join(nvmDir, version, 'bin'));
      }
    } catch {
      // Ignore errors
    }
  }

  return [...new Set([...additionalPaths, ...existingPath.split(':')])].join(':');
}
