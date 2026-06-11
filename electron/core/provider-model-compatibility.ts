/**
 * Dorothy MVP Phase 6-L — provider/model compatibility guard.
 *
 * Codex agents were being launched with `--model 'opus'` (a Claude-family
 * model), producing `The 'opus' model is not supported when using Codex`.
 * This guard validates a (provider, model) pair BEFORE launch and lets the
 * command builder omit an incompatible model flag (falling back to the
 * provider default) — it NEVER rewrites the stored model in agents.json.
 *
 * We deliberately do NOT hardcode the exact, latest Codex model list. We only
 * recognise *Claude-family* model names (which are unambiguously wrong for
 * Codex/Gemini) and treat everything else as "let the provider decide".
 */

export type AgentProvider = 'claude' | 'codex' | 'gemini' | 'opencode' | 'local' | 'pi';

export type CompatibilityReason =
  | 'ok'
  | 'model_not_supported'
  | 'model_missing'
  | 'provider_unknown';

export interface ProviderModelCompatibilityResult {
  ok: boolean;
  provider: AgentProvider | string;
  model?: string;
  normalizedModel?: string;
  reason: CompatibilityReason;
  message: string;
  suggestedModel?: string;
}

const KNOWN_PROVIDERS = new Set<string>(['claude', 'codex', 'gemini', 'opencode', 'local', 'pi']);

/** A model name that clearly belongs to the Claude family. */
export function isClaudeModel(model: string): boolean {
  const m = model.toLowerCase().trim();
  if (!m) return false;
  return (
    /^claude/.test(m) ||
    /\bopus\b/.test(m) ||
    /\bsonnet\b/.test(m) ||
    /\bhaiku\b/.test(m) ||
    /^opusplan/.test(m) ||
    m.startsWith('opus') ||
    m.startsWith('sonnet') ||
    m.startsWith('haiku')
  );
}

/** A model name that clearly belongs to the Codex / GPT family. */
export function isCodexModel(model: string): boolean {
  const m = model.toLowerCase().trim();
  if (!m) return false;
  return /codex/.test(m) || /^gpt[-_.]/.test(m) || /^o[0-9]/.test(m);
}

/** A model name that clearly belongs to the Gemini family. */
export function isGeminiModel(model: string): boolean {
  return /^gemini/.test(model.toLowerCase().trim());
}

/** Treat empty / 'default' as "no explicit model" (use provider default). */
function isUnsetModel(model: string | undefined | null): boolean {
  if (!model) return true;
  const m = model.toLowerCase().trim();
  return m === '' || m === 'default';
}

export function checkProviderModelCompatibility(input: {
  provider: string | undefined | null;
  model?: string | null;
}): ProviderModelCompatibilityResult {
  const provider = (input.provider ?? '').toLowerCase().trim();
  const model = input.model ?? undefined;
  const normalizedModel = model ? model.trim() : undefined;

  if (!provider || !KNOWN_PROVIDERS.has(provider)) {
    return {
      ok: false,
      provider: provider || '(unset)',
      model,
      normalizedModel,
      reason: 'provider_unknown',
      message: `Unknown provider "${provider || '(unset)'}".`,
    };
  }

  // No explicit model → always fine; the provider picks its default.
  if (isUnsetModel(model)) {
    return {
      ok: true,
      provider,
      model,
      normalizedModel,
      reason: 'ok',
      message: `${provider} will use its default model.`,
    };
  }

  const m = normalizedModel as string;

  if (provider === 'claude') {
    if (isCodexModel(m) || isGeminiModel(m)) {
      return {
        ok: false, provider, model, normalizedModel, reason: 'model_not_supported',
        message: `Claude provider cannot use "${m}". Use a Claude model (opus / sonnet / haiku) or change provider.`,
        suggestedModel: 'opus',
      };
    }
    return { ok: true, provider, model, normalizedModel, reason: 'ok', message: `Claude + ${m} is compatible.` };
  }

  if (provider === 'codex') {
    if (isClaudeModel(m)) {
      return {
        ok: false, provider, model, normalizedModel, reason: 'model_not_supported',
        message: `Codex cannot use Claude model "${m}". Change provider to claude, choose a Codex model, or leave the model unset.`,
        // No hardcoded "latest" Codex model — suggest unsetting so Codex uses its default.
        suggestedModel: undefined,
      };
    }
    return { ok: true, provider, model, normalizedModel, reason: 'ok', message: `Codex + ${m}.` };
  }

  if (provider === 'gemini') {
    if (isClaudeModel(m) || isCodexModel(m)) {
      return {
        ok: false, provider, model, normalizedModel, reason: 'model_not_supported',
        message: `Gemini cannot use "${m}". Use a Gemini model or leave it unset.`,
      };
    }
    return { ok: true, provider, model, normalizedModel, reason: 'ok', message: `Gemini + ${m}.` };
  }

  // opencode / local / pi — accept any model (or none).
  return { ok: true, provider, model, normalizedModel, reason: 'ok', message: `${provider} + ${m}.` };
}

/**
 * Returns the model string the launch command should actually pass. When the
 * stored model is incompatible with the provider, returns `undefined` so the
 * command builder OMITS the flag (provider default) — this never mutates the
 * stored agents.json model.
 */
export function resolveLaunchModel(
  provider: string | undefined | null,
  model?: string | null,
  defaultModel?: string | null,
): string | undefined {
  // 1) explicit model, if compatible, wins.
  if (!isUnsetModel(model)) {
    const check = checkProviderModelCompatibility({ provider, model });
    if (check.ok) return model ?? undefined;
    // incompatible explicit model → fall through to the provider default below
    // (never pass the incompatible model; never rewrite agents.json).
  }
  // 2) provider default (e.g. defaultCodexModel), only if compatible.
  if (!isUnsetModel(defaultModel)) {
    const check = checkProviderModelCompatibility({ provider, model: defaultModel });
    if (check.ok) return defaultModel ?? undefined;
  }
  // 3) nothing safe → omit the flag, let the provider pick its own default.
  return undefined;
}
