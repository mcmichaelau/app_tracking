/**
 * Cached OpenAI SDK client for interpretation (any OpenAI-compatible `baseURL`).
 */
import OpenAI from "openai";
import {
  resolveInterpretationApiKey,
  resolveInterpretationBaseUrl,
} from "./resolve";

let client: OpenAI | null = null;
let cachedKey = "";
let cachedBase = "";

export function getInterpretationClient(): OpenAI | null {
  const key = resolveInterpretationApiKey();
  const base = resolveInterpretationBaseUrl();
  if (!key) return null;
  if (!client || cachedKey !== key || cachedBase !== base) {
    cachedKey = key;
    cachedBase = base;
    client = new OpenAI({
      apiKey: key,
      baseURL: base,
      timeout: 120_000,
    });
  }
  return client;
}

export function invalidateInterpretationClient(): void {
  client = null;
  cachedKey = "";
  cachedBase = "";
}

/** Matches the SDK request path for logging. */
export function interpretationChatCompletionsUrl(): string {
  return `${resolveInterpretationBaseUrl()}/chat/completions`;
}
