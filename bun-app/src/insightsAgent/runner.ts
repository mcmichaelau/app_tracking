import OpenAI from "openai";
import { z } from "zod";
import { computeApiCost, insertApiUsage } from "../db";
import { runInsightsReadQuery } from "./sql";
import { getInsightsLlmConfig } from "./config";

const readQuerySchema = z.object({
  query: z.string().min(1),
});

const READ_QUERY_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "read_query",
    description:
      "Run a read-only SQL SELECT on the activity database. Must include LIMIT ≤ 100. Returns JSON rows.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Single SELECT statement with LIMIT." },
      },
      required: ["query"],
    },
  },
};

export type InsightsStreamEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; toolInput: string }
  | { type: "tool_result"; content: string }
  | { type: "result"; turns: number };

function recordUsage(model: string, completion: OpenAI.Chat.ChatCompletion) {
  const u = completion.usage;
  if (!u) return;
  const inputTokens = u.prompt_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return;
  insertApiUsage({
    model,
    operation: "insights_chat",
    inputTokens,
    outputTokens,
    costUsd: computeApiCost(model, inputTokens, outputTokens),
  });
}

export async function runInsightsAgent(params: {
  systemPrompt: string;
  userMessage: string;
  history: OpenAI.Chat.ChatCompletionMessageParam[];
  emit: (e: InsightsStreamEvent) => void;
}): Promise<{ assistantText: string; appendMessages: OpenAI.Chat.ChatCompletionMessageParam[] }> {
  const { model, apiKey, baseURL } = getInsightsLlmConfig();
  if (!apiKey) {
    throw new Error("No API key for insights agent. Set GROQ_API_KEY (for Qwen on Groq) or configure interpretation keys.");
  }

  const client = new OpenAI({ apiKey, baseURL, timeout: 120_000 });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: params.systemPrompt },
    ...params.history,
    { role: "user", content: params.userMessage },
  ];

  const userMessageIndex = 1 + params.history.length;
  let assistantText = "";
  const MAX_AGENT_STEPS = 14;
  let steps = 0;

  while (steps < MAX_AGENT_STEPS) {
    steps++;
    const completion = await client.chat.completions.create({
      model,
      messages,
      tools: [READ_QUERY_TOOL],
      tool_choice: "auto",
      temperature: 0.25,
      max_tokens: 4096,
    });

    recordUsage(model, completion);

    const choice = completion.choices[0];
    const msg = choice?.message;
    if (!msg) break;

    messages.push(msg);

    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        if (tc.type !== "function") continue;
        const fn = tc.function;
        if (fn.name !== "read_query") {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `Unknown tool: ${fn.name}`,
          });
          continue;
        }

        let parsed: z.infer<typeof readQuerySchema>;
        try {
          parsed = readQuerySchema.parse(JSON.parse(fn.arguments || "{}"));
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          params.emit({ type: "tool_use", tool: "read_query", toolInput: fn.arguments || "" });
          params.emit({ type: "tool_result", content: `Invalid args: ${err.slice(0, 200)}` });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `Invalid arguments: ${err}`,
          });
          continue;
        }

        params.emit({ type: "tool_use", tool: "read_query", toolInput: parsed.query });
        let result: string;
        try {
          result = runInsightsReadQuery(parsed.query);
        } catch (e) {
          result = (e as Error).message;
        }
        const preview = result.length > 240 ? `${result.slice(0, 240)}…` : result;
        params.emit({ type: "tool_result", content: preview });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }
      continue;
    }

    if (msg.content) {
      assistantText += msg.content;
      params.emit({ type: "text", content: msg.content });
    }

    params.emit({ type: "result", turns: steps });
    break;
  }

  const appendMessages = messages.slice(userMessageIndex);
  return { assistantText, appendMessages };
}
