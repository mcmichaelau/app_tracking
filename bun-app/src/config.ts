import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "node:fs";

export const configDir = join(homedir(), "Library", "Application Support", "ActivityTracker");
const configPath = join(configDir, "config.json");

export const INTERPRETATION_MODEL = "gpt-5-mini";

export interface Config {
  gemini_api_key?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
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
