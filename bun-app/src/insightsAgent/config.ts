import { loadConfig, resolveEnvString } from "../config";
import { resolveInterpretationApiKey, resolveInterpretationBaseUrl } from "../llm";

const DEFAULT_GROQ = "https://api.groq.com/openai/v1";
const DEFAULT_OPENAI = "https://api.openai.com/v1";
/** Default: Groq Qwen (structured tool agent). */
export const DEFAULT_INSIGHTS_LLM = "groq/qwen/qwen3-32b";

export type InsightsLlmConfig = {
  model: string;
  apiKey: string | null;
  baseURL: string;
};

export function getInsightsLlmConfig(): InsightsLlmConfig {
  const cfg = loadConfig();
  const combined =
    resolveEnvString("INSIGHTS_AGENT_LLM")?.trim() ||
    cfg.insights_agent_llm?.trim() ||
    DEFAULT_INSIGHTS_LLM;

  if (!combined.includes("/")) {
    return {
      model: combined,
      apiKey: resolveInterpretationApiKey(),
      baseURL: resolveInterpretationBaseUrl(),
    };
  }

  const slash = combined.indexOf("/");
  const prov = combined.slice(0, slash).toLowerCase().trim();
  const model = combined.slice(slash + 1).trim() || "qwen/qwen3-32b";

  if (prov === "groq") {
    const key =
      resolveEnvString("GROQ_API_KEY")?.trim() ||
      cfg.groq_api_key?.trim() ||
      resolveInterpretationApiKey();
    const base = (resolveEnvString("INSIGHTS_AGENT_BASE_URL") || DEFAULT_GROQ).replace(/\/$/, "");
    return { model, apiKey: key || null, baseURL: base };
  }

  if (prov === "openai" || prov === "oai") {
    const key =
      resolveEnvString("OPENAI_API_KEY")?.trim() ||
      cfg.openai_api_key?.trim() ||
      resolveInterpretationApiKey();
    const base = (resolveEnvString("INSIGHTS_AGENT_BASE_URL") || resolveEnvString("OPENAI_BASE_URL") || DEFAULT_OPENAI).replace(/\/$/, "");
    return { model, apiKey: key || null, baseURL: base };
  }

  return {
    model,
    apiKey: resolveInterpretationApiKey(),
    baseURL: resolveInterpretationBaseUrl(),
  };
}
