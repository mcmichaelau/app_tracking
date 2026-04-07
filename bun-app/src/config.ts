import { join } from "path";
import { homedir } from "os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const configDir = join(homedir(), "Library", "Application Support", "ActivityTracker");
const configPath = join(configDir, "config.json");

/** Default model segment when `INTERPRETATION_LLM` uses the `openai` or `groq` provider slug */
export const INTERPRETATION_MODEL = "llama-3.3-70b-versatile";

/** Default model when provider is `anthropic` / `claude` and no model segment is given */
export const DEFAULT_INTERPRETATION_MODEL_ANTHROPIC = "claude-3-5-haiku-20241022";

/** Default model when provider is `gemini` / `google` and no model segment is given */
export const DEFAULT_INTERPRETATION_MODEL_GEMINI = "gemini-2.0-flash";

export interface Config {
  openai_api_key?: string;
  anthropic_api_key?: string;
  gemini_api_key?: string;
  groq_api_key?: string;
  /** Preferred storage for interpretation LLM key (OpenAI-compatible). Falls back to `groq_api_key`. */
  interpretation_api_key?: string;
  /** OpenAI-compatible API base, e.g. https://api.openai.com/v1 or https://api.groq.com/openai/v1 */
  interpretation_base_url?: string;
  interpretation_model?: string;
  /** Legacy; prefer `interpretation_llm` */
  interpretation_provider?: string;
  /** `provider/model` — same as env `INTERPRETATION_LLM` */
  interpretation_llm?: string;
  /** `provider/model` for task classification — same as env `TASK_CLASSIFIER_LLM`. Defaults to anthropic/claude-haiku-4-5-20251001. */
  task_classifier_llm?: string;
  /** IANA timezone (e.g. America/New_York) for stored local wall-clock times. Env: USER_TIMEZONE. */
  timezone?: string;
  /** Insights chat agent: `provider/model`, e.g. groq/qwen/qwen3-32b. Env: INSIGHTS_AGENT_LLM. */
  insights_agent_llm?: string;
}

export type ApiKeyProvider = "openai" | "anthropic" | "gemini";
export type ApiKeySource = "env" | "config" | "none";

export interface ResolvedApiKey {
  value: string | null;
  source: ApiKeySource;
}

const DOTENV_PATHS = [
  join(process.cwd(), ".env"),
  join(import.meta.dir, "..", "..", ".env"),
];

export function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

function normalizeKey(value: string | undefined): string | null {
  const key = value?.trim();
  return key ? key : null;
}

function readDotEnvValue(key: string): string | undefined {
  for (const path of DOTENV_PATHS) {
    try {
      const text = readFileSync(path, "utf8");
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const idx = line.indexOf("=");
        if (idx === -1) continue;
        const k = line.slice(0, idx).trim();
        if (k !== key) continue;
        const v = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
        return v;
      }
    } catch {
      // ignore missing/invalid dotenv file paths
    }
  }
  return undefined;
}

/** process.env first, then `.env` in cwd and repo root (same as API key lookup). */
export function resolveEnvString(key: string): string | undefined {
  const v = process.env[key]?.trim();
  if (v) return v;
  return readDotEnvValue(key);
}

export function resolveApiKey(provider: ApiKeyProvider, config = loadConfig()): ResolvedApiKey {
  const envNames: Record<ApiKeyProvider, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    gemini: "GEMINI_API_KEY",
  };
  const envKeys: Record<ApiKeyProvider, string | undefined> = {
    openai: process.env.OPENAI_API_KEY ?? readDotEnvValue(envNames.openai),
    anthropic: process.env.ANTHROPIC_API_KEY ?? readDotEnvValue(envNames.anthropic),
    gemini: process.env.GEMINI_API_KEY ?? readDotEnvValue(envNames.gemini),
  };
  const configKeys: Record<ApiKeyProvider, string | undefined> = {
    openai: config.openai_api_key,
    anthropic: config.anthropic_api_key,
    gemini: config.gemini_api_key,
  };

  const envValue = normalizeKey(envKeys[provider]);
  if (envValue) return { value: envValue, source: "env" };
  const configValue = normalizeKey(configKeys[provider]);
  if (configValue) return { value: configValue, source: "config" };
  return { value: null, source: "none" };
}
