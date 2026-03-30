/**
 * Env / config resolution for interpretation LLMs (OpenAI-compatible, Anthropic, Gemini).
 * Primary: `INTERPRETATION_LLM` = `provider/model` (e.g. `groq/llama-3.1-8b-instant`, `anthropic/claude-3-5-haiku-20241022`).
 */
import {
  loadConfig,
  INTERPRETATION_MODEL,
  DEFAULT_INTERPRETATION_MODEL_ANTHROPIC,
  DEFAULT_INTERPRETATION_MODEL_GEMINI,
} from "../config";

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";
const DEFAULT_GROQ_BASE = "https://api.groq.com/openai/v1";

export type InterpretationProvider = "openai" | "anthropic" | "gemini";

export type InterpretationLlmResolved = {
  provider: InterpretationProvider;
  model: string;
  /**
   * When using the OpenAI-compatible client and `INTERPRETATION_BASE_URL` is unset,
   * which default host to use. `null` for Anthropic/Gemini (chat base URL unused).
   */
  openaiCompatBase: "groq" | "openai" | "heuristic" | null;
};

function defaultModel(provider: InterpretationProvider): string {
  if (provider === "anthropic") return DEFAULT_INTERPRETATION_MODEL_ANTHROPIC;
  if (provider === "gemini") return DEFAULT_INTERPRETATION_MODEL_GEMINI;
  return INTERPRETATION_MODEL;
}

function mapProviderToken(raw: string): {
  provider: InterpretationProvider;
  openaiCompatBase: "groq" | "openai" | "heuristic";
} {
  switch (raw) {
    case "groq":
      return { provider: "openai", openaiCompatBase: "groq" };
    case "openai":
    case "oai":
      return { provider: "openai", openaiCompatBase: "openai" };
    case "anthropic":
    case "claude":
      return { provider: "anthropic", openaiCompatBase: "openai" };
    case "gemini":
    case "google":
      return { provider: "gemini", openaiCompatBase: "openai" };
    default:
      return { provider: "openai", openaiCompatBase: "heuristic" };
  }
}

function legacyProviderFromEnvAndConfig(): InterpretationProvider {
  const cfg = loadConfig();
  const v = (
    process.env.INTERPRETATION_PROVIDER?.trim() ??
    cfg.interpretation_provider?.trim() ??
    ""
  ).toLowerCase();
  if (v === "anthropic" || v === "claude") return "anthropic";
  if (v === "gemini" || v === "google") return "gemini";
  return "openai";
}

/** Single source of truth for provider, model, and OpenAI-compat default base. */
export function getInterpretationLlmResolved(): InterpretationLlmResolved {
  const cfg = loadConfig();
  const combined =
    process.env.INTERPRETATION_LLM?.trim() || cfg.interpretation_llm?.trim();

  if (combined) {
    if (!combined.includes("/")) {
      return {
        provider: "openai",
        model: combined,
        openaiCompatBase: "heuristic",
      };
    }
    const slash = combined.indexOf("/");
    const rawProv = combined.slice(0, slash).toLowerCase().trim();
    const model = combined.slice(slash + 1).trim();
    const mapped = mapProviderToken(rawProv);
    if (mapped.provider === "anthropic" || mapped.provider === "gemini") {
      return {
        provider: mapped.provider,
        model: model || defaultModel(mapped.provider),
        openaiCompatBase: null,
      };
    }
    return {
      provider: "openai",
      model: model || INTERPRETATION_MODEL,
      openaiCompatBase: mapped.openaiCompatBase,
    };
  }

  const provider = legacyProviderFromEnvAndConfig();
  const explicitModel =
    process.env.INTERPRETATION_MODEL?.trim() || cfg.interpretation_model?.trim();
  const model = explicitModel || defaultModel(provider);
  return {
    provider,
    model,
    openaiCompatBase: provider === "openai" ? "heuristic" : null,
  };
}

export function getInterpretationProvider(): InterpretationProvider {
  return getInterpretationLlmResolved().provider;
}

export function getInterpretationModel(): string {
  return getInterpretationLlmResolved().model;
}

export function resolveInterpretationApiKey(): string | null {
  const cfg = loadConfig();
  return (
    process.env.INTERPRETATION_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.GROQ_API_KEY?.trim() ||
    cfg.interpretation_api_key?.trim() ||
    cfg.openai_api_key?.trim() ||
    cfg.groq_api_key?.trim() ||
    null
  );
}

export function resolveAnthropicApiKey(): string | null {
  const cfg = loadConfig();
  return process.env.ANTHROPIC_API_KEY?.trim() ?? cfg.anthropic_api_key?.trim() ?? null;
}

export function resolveGeminiApiKey(): string | null {
  const cfg = loadConfig();
  return (
    process.env.GEMINI_API_KEY?.trim() ??
    process.env.GOOGLE_API_KEY?.trim() ??
    cfg.gemini_api_key?.trim() ??
    null
  );
}

// ─── Task classifier LLM resolution ──────────────────────────────────────────
// Configure via TASK_CLASSIFIER_LLM=provider/model (e.g. anthropic/claude-haiku-4-5-20251001).
// Defaults to anthropic/claude-haiku-4-5-20251001 — cheap, fast, good at structured JSON output.

const DEFAULT_CLASSIFIER_PROVIDER: InterpretationProvider = "anthropic";
const DEFAULT_CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";

export type ClassificationLlmResolved = {
  provider: InterpretationProvider;
  model: string;
};

export function getClassificationLlmResolved(): ClassificationLlmResolved {
  const cfg = loadConfig();
  const combined =
    process.env.TASK_CLASSIFIER_LLM?.trim() || cfg.task_classifier_llm?.trim();
  if (combined) {
    if (!combined.includes("/")) {
      return { provider: DEFAULT_CLASSIFIER_PROVIDER, model: combined };
    }
    const slash = combined.indexOf("/");
    const rawProv = combined.slice(0, slash).toLowerCase().trim();
    const model = combined.slice(slash + 1).trim();
    const mapped = mapProviderToken(rawProv);
    return { provider: mapped.provider, model: model || DEFAULT_CLASSIFIER_MODEL };
  }
  return { provider: DEFAULT_CLASSIFIER_PROVIDER, model: DEFAULT_CLASSIFIER_MODEL };
}

export function getClassificationProvider(): InterpretationProvider {
  return getClassificationLlmResolved().provider;
}

/** API key for the active classification provider. */
export function resolveApiKeyForClassifier(): string | null {
  return resolveApiKeyForProvider(getClassificationProvider());
}

/** API key for the active interpretation provider. */
export function resolveApiKeyForProvider(provider: InterpretationProvider): string | null {
  if (provider === "anthropic") return resolveAnthropicApiKey();
  if (provider === "gemini") return resolveGeminiApiKey();
  return resolveInterpretationApiKey();
}

export function resolveInterpretationBaseUrl(): string {
  const cfg = loadConfig();
  const explicit =
    process.env.INTERPRETATION_BASE_URL?.trim() ??
    process.env.OPENAI_BASE_URL?.trim() ??
    cfg.interpretation_base_url?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const resolved = getInterpretationLlmResolved();
  if (resolved.provider !== "openai" || resolved.openaiCompatBase === null) {
    return DEFAULT_OPENAI_BASE;
  }

  if (resolved.openaiCompatBase === "groq") return DEFAULT_GROQ_BASE;
  if (resolved.openaiCompatBase === "openai") return DEFAULT_OPENAI_BASE;

  const hasGroq = !!(process.env.GROQ_API_KEY?.trim() || cfg.groq_api_key?.trim());
  const hasOpenAI = !!(process.env.OPENAI_API_KEY?.trim() || cfg.openai_api_key?.trim());
  const hasInterp = !!(process.env.INTERPRETATION_API_KEY?.trim() || cfg.interpretation_api_key?.trim());
  if (hasInterp) return DEFAULT_OPENAI_BASE;
  if (hasGroq && !hasOpenAI) return DEFAULT_GROQ_BASE;
  return DEFAULT_OPENAI_BASE;
}
