import { Hono } from "hono";
import { loadConfig, saveConfig } from "../config";
import { getInterpretationProvider, resolveApiKeyForProvider } from "../llm";
import { reconfigure } from "../interpretation";

export function settingsRoute(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const key = resolveApiKeyForProvider(getInterpretationProvider());
    const masked = key ? key.slice(0, 7) + "••••••••" : "";
    return c.json({ groq_api_key: masked, has_key: !!key });
  });

  app.put("/", async (c) => {
    const body = await c.req.json() as {
      groq_api_key?: string;
      interpretation_api_key?: string;
      interpretation_base_url?: string;
      interpretation_provider?: string;
      interpretation_llm?: string;
      anthropic_api_key?: string;
      gemini_api_key?: string;
    };
    const current = loadConfig();
    if (body.groq_api_key !== undefined) current.groq_api_key = body.groq_api_key;
    if (body.interpretation_api_key !== undefined) current.interpretation_api_key = body.interpretation_api_key;
    if (body.interpretation_base_url !== undefined) current.interpretation_base_url = body.interpretation_base_url;
    if (body.interpretation_llm !== undefined) current.interpretation_llm = body.interpretation_llm;
    if (body.interpretation_provider !== undefined) current.interpretation_provider = body.interpretation_provider;
    if (body.anthropic_api_key !== undefined) current.anthropic_api_key = body.anthropic_api_key;
    if (body.gemini_api_key !== undefined) current.gemini_api_key = body.gemini_api_key;
    saveConfig(current);
    reconfigure();
    return c.json({ ok: true });
  });

  return app;
}
