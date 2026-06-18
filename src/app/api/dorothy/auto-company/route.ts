import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Read-only Auto-Company status aggregator.
// Reads companies.json `autoCompany`, parses the KEY=VALUE .auto-loop-state,
// the Dorothy wrapper runtime JSON, consensus.md (first ~40 lines), and the
// newest cycle log (last ~50 lines). All reads are guarded; missing -> null.

interface AutoCompanyMeta {
  installPath?: string;
  loopScript?: string;
  stopScript?: string;
  statusScript?: string;
  stateFile?: string;
  consensusFile?: string;
  dashboardUrl?: string;
  launchdLabel?: string;
  dorothyWrapper?: string;
  dorothyStateFile?: string;
}

function safeReadFile(file?: string | null): string | null {
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function safeReadJson<T = unknown>(file?: string | null): T | null {
  const raw = safeReadFile(file);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// Parse simple KEY=VALUE lines (ignores blanks and # comments).
function parseKeyValue(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function tail(raw: string | null, n: number): string | null {
  if (raw == null) return null;
  const lines = raw.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function head(raw: string | null, n: number): string | null {
  if (raw == null) return null;
  return raw.split(/\r?\n/).slice(0, n).join('\n');
}

// Find newest cycle log (or auto-loop.log) in <installPath>/logs.
function findNewestLog(installPath?: string): { file: string; tail: string } | null {
  if (!installPath) return null;
  const logsDir = path.join(installPath, 'logs');
  try {
    if (!fs.existsSync(logsDir)) return null;
    const candidates = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const full = path.join(logsDir, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        return { full, name: f, mtime };
      })
      // Prefer cycle logs, but fall back to any log; sort by mtime desc.
      .sort((a, b) => b.mtime - a.mtime);
    if (candidates.length === 0) return null;
    const newest = candidates[0];
    const t = tail(safeReadFile(newest.full), 50);
    return { file: newest.full, tail: t ?? '' };
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const companiesFile = path.join(os.homedir(), '.dorothy', 'companies.json');
    const companies = safeReadJson<Record<string, unknown>>(companiesFile);
    const autoCompany = (companies?.autoCompany ?? null) as AutoCompanyMeta | null;

    const state = parseKeyValue(safeReadFile(autoCompany?.stateFile));
    const runtime = safeReadJson(autoCompany?.dorothyStateFile);

    const consensusRaw = safeReadFile(autoCompany?.consensusFile);
    const consensusHead = head(consensusRaw, 40);

    const newestLog = findNewestLog(autoCompany?.installPath);

    // 실제 일시정지/프로세스 생존 (상태파일 STATUS 보완)
    let paused = false;
    let pidAlive = false;
    const installPath = autoCompany?.installPath;
    if (installPath) {
      paused = fs.existsSync(path.join(installPath, '.auto-loop-paused'));
      const pidRaw = safeReadFile(path.join(installPath, '.auto-loop.pid'));
      const pid = pidRaw ? parseInt(pidRaw.trim(), 10) : NaN;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          pidAlive = true;
        } catch {
          pidAlive = false;
        }
      }
    }

    // Dorothy busy-lock 신선도 (상호 배제 표시용)
    let dorothyBusy = false;
    try {
      const lock = path.join(os.homedir(), '.dorothy', 'runtime', 'dorothy-busy.lock');
      const lst = fs.statSync(lock);
      dorothyBusy = (Date.now() - lst.mtimeMs) / 1000 <= 300;
    } catch {
      dorothyBusy = false;
    }

    return NextResponse.json({
      meta: autoCompany,
      state,
      runtime,
      consensusHead,
      log: newestLog,
      paused,
      pidAlive,
      dorothyBusy,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
