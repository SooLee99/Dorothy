/**
 * Dorothy MVP Phase 6-M — Codex runtime hardening helpers (read-only).
 *
 *   - detectStaleProviderModelSessions(): live AgentSessions whose configured
 *     agent is `codex + <Claude-family model>` — i.e. sessions that were
 *     launched (pre-fix) with an incompatible model. Diagnosed, never killed.
 *   - getCodexRuntimeReadiness(): codex binary resolution + whether the Codex
 *     persistent config (~/.codex/config.toml) pins a model + which configured
 *     agents are incompatible.
 *
 * Pure / injectable. Never spawns, never edits agents.json or ~/.codex, never
 * logs secrets (only model names + binary paths, which are not secrets).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveClaudeBinaryPath } from '../../core/claude-binary-resolver';
import {
  checkProviderModelCompatibility,
  isClaudeModel,
} from '../../core/provider-model-compatibility';
import type { AgentSession } from '../../types/dorothy';

export interface StaleSessionFlag {
  sessionId: string;
  agentId: string;
  provider: string;
  model?: string;
  reason: 'stale_session_model_mismatch';
  summary: string;
}

export interface CodexRuntimeReadiness {
  binaryFound: boolean;
  binaryPath?: string | null;
  /** Top-level `model = "..."` found in ~/.codex/config.toml, if any. */
  configTomlModel?: string | null;
  persistentModelOpus: boolean;
  defaultCodexModel?: string | null;
  defaultCodexModelOk?: boolean;
  incompatibleConfiguredAgents: Array<{ agentId: string; name?: string; model?: string; message: string }>;
  opusBlocked: true;
  autoRewrite: false;
}

interface ConfiguredAgentLite {
  id: string;
  name?: string;
  provider?: string;
  model?: string;
}

/** Find active sessions whose configured agent is codex + a Claude-family model. */
export function detectStaleProviderModelSessions(input: {
  sessions: AgentSession[];
  configuredAgents: ConfiguredAgentLite[];
}): StaleSessionFlag[] {
  const byId = new Map(input.configuredAgents.map(a => [a.id, a] as const));
  const flags: StaleSessionFlag[] = [];
  for (const s of input.sessions) {
    if (s.exitedAt) continue; // only live/active sessions
    const agent = byId.get(s.agentId);
    if (!agent) continue;
    if ((agent.provider ?? '') !== 'codex') continue;
    if (!agent.model || !isClaudeModel(agent.model)) continue;
    flags.push({
      sessionId: s.id,
      agentId: s.agentId,
      provider: 'codex',
      model: agent.model,
      reason: 'stale_session_model_mismatch',
      summary: `Codex session launched with Claude model "${agent.model}". Not replayed on restart; Codex cannot use it. Restart this agent (it will launch without --model) or set a Codex-compatible model.`,
    });
  }
  return flags;
}

/** Parse the top-level `model = "..."` from ~/.codex/config.toml (if present). */
export function parseCodexConfigModel(tomlText: string): string | null {
  // Only top-level keys (before the first [section]) count as the global model.
  const lines = tomlText.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('[')) break; // entered a section — stop scanning top-level
    const m = line.match(/^model\s*=\s*["']?([^"'\s#]+)/);
    if (m) return m[1];
  }
  return null;
}

export function getCodexRuntimeReadiness(opts: {
  configuredAgents?: ConfiguredAgentLite[];
  configuredCodexPath?: string;
  defaultCodexModel?: string;
  homeDir?: string;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'statSync' | 'accessSync' | 'readFileSync'>;
} = {}): CodexRuntimeReadiness {
  const fsImpl = opts.fsImpl ?? fs;
  const home = opts.homeDir ?? os.homedir();

  const bin = resolveClaudeBinaryPath({
    configuredPath: opts.configuredCodexPath || undefined,
    homeDir: home,
    fsImpl,
    binaryName: 'codex',
  });

  // Persistent model in ~/.codex/config.toml
  let configTomlModel: string | null = null;
  try {
    const cfgPath = path.join(home, '.codex', 'config.toml');
    if (fsImpl.existsSync(cfgPath)) {
      configTomlModel = parseCodexConfigModel(fsImpl.readFileSync(cfgPath, 'utf-8'));
    }
  } catch {
    /* ignore */
  }
  const persistentModelOpus = !!configTomlModel && isClaudeModel(configTomlModel);

  const defaultCodexModel = opts.defaultCodexModel ?? null;
  const defaultCodexModelOk = defaultCodexModel
    ? checkProviderModelCompatibility({ provider: 'codex', model: defaultCodexModel }).ok
    : undefined;

  const incompatibleConfiguredAgents = (opts.configuredAgents ?? [])
    .filter(a => (a.provider ?? '') === 'codex' && a.model && isClaudeModel(a.model))
    .map(a => ({
      agentId: a.id,
      name: a.name,
      model: a.model,
      message: `Codex agent "${a.name ?? a.id}" has Claude model "${a.model}"; it will launch without --model.`,
    }));

  return {
    binaryFound: bin.ok,
    binaryPath: bin.path ?? null,
    configTomlModel,
    persistentModelOpus,
    defaultCodexModel,
    defaultCodexModelOk,
    incompatibleConfiguredAgents,
    opusBlocked: true,
    autoRewrite: false,
  };
}
