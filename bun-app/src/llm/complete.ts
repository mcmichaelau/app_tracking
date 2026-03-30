/**
 * Provider-specific completion calls for interpretation and task classification.
 *
 * Both `completeInterpretation` and `completeClassification` delegate to the
 * internal `completeLlmCall` helper, which accepts an explicit model string.
 * The only difference between the two public functions is how the model is
 * resolved: interpretation reads from `getInterpretationModel()`, while
 * classification receives provider+model from the caller.
 */
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getInterpretationClient, interpretationChatCompletionsUrl } from "./client";
import type { InterpretationProvider } from "./resolve";
import {
  getInterpretationModel,
  resolveAnthropicApiKey,
  resolveGeminiApiKey,
} from "./resolve";

export type InterpretationCompletionResult = {
  content: string;
  raw: unknown;
  requestPayload: Record<string, unknown>;
  endpointLabel: string;
};

function anthropicTextFromMessage(msg: { content: Array<{ type: string; text?: string }> }): string {
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text" && block.text) parts.push(block.text);
  }
  return parts.join("");
}

/** Internal primitive used by both completeInterpretation and completeClassification. */
async function completeLlmCall(args: {
  provider: InterpretationProvider;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<InterpretationCompletionResult> {
  const { provider, model, system, user, maxTokens = 512 } = args;

  if (provider === "openai") {
    const client = getInterpretationClient();
    if (!client) throw new Error("OpenAI-compatible client not configured");
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ];
    const requestPayload = { model, messages, temperature: 0.3, max_tokens: maxTokens };
    const completion = await client.chat.completions.create(requestPayload);
    const content = completion.choices[0]?.message?.content ?? "";
    return {
      content,
      raw: completion,
      requestPayload: { ...requestPayload, url: interpretationChatCompletionsUrl() },
      endpointLabel: interpretationChatCompletionsUrl(),
    };
  }

  if (provider === "anthropic") {
    const apiKey = resolveAnthropicApiKey();
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    const client = new Anthropic({ apiKey });
    const requestPayload = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user" as const, content: user }],
      temperature: 0.3,
    };
    const msg = await client.messages.create(requestPayload);
    const content = anthropicTextFromMessage(msg);
    return {
      content,
      raw: msg,
      requestPayload: { ...requestPayload, url: "https://api.anthropic.com/v1/messages" },
      endpointLabel: "https://api.anthropic.com/v1/messages",
    };
  }

  // gemini
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY not set");
  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({ model, systemInstruction: system });
  const requestPayload = {
    model,
    user,
    generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens },
  };
  const result = await genModel.generateContent({
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens },
  });
  const content = result.response.text();
  return {
    content,
    raw: result.response,
    requestPayload: { ...requestPayload, url: "gemini:generateContent" },
    endpointLabel: "Gemini generateContent",
  };
}

export async function completeInterpretation(args: {
  provider: InterpretationProvider;
  system: string;
  user: string;
}): Promise<InterpretationCompletionResult> {
  return completeLlmCall({
    provider: args.provider,
    model: getInterpretationModel(),
    system: args.system,
    user: args.user,
    maxTokens: 512,
  });
}

/** Used by classification.ts with an explicit provider+model from getClassificationLlmResolved(). */
export async function completeClassification(args: {
  provider: InterpretationProvider;
  model: string;
  system: string;
  user: string;
}): Promise<InterpretationCompletionResult> {
  return completeLlmCall({
    provider: args.provider,
    model: args.model,
    system: args.system,
    user: args.user,
    maxTokens: 512,
  });
}
