import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "node:fs";

export const configDir = join(homedir(), "Library", "Application Support", "ActivityTracker");
const configPath = join(configDir, "config.json");

/** Default model segment when `INTERPRETATION_LLM` uses the `openai` or `groq` provider slug */
export const INTERPRETATION_MODEL = "llama-3.1-8b-instant";

/** Default model when provider is `anthropic` / `claude` and no model segment is given */
export const DEFAULT_INTERPRETATION_MODEL_ANTHROPIC = "claude-3-5-haiku-20241022";

/** Default model when provider is `gemini` / `google` and no model segment is given */
export const DEFAULT_INTERPRETATION_MODEL_GEMINI = "gemini-2.0-flash";

export interface Config {
  gemini_api_key?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
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
}

export function loadConfig(): Config {
  try {
    return JSON.parse(Bun.file(configPath).toString());
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(configDir, { recursive: true });
  Bun.write(configPath, JSON.stringify(config, null, 2));
}
