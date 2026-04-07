import { join } from "path";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import {
  updateInterpretation,
  fetchRecentInterpretations,
  insertApiUsage,
  computeApiCost,
} from "./db";
import { configDir } from "./config";
import {
  resolveInterpretationApiKey,
  getInterpretationModel,
  getInterpretationClient,
} from "./llm";
import { enqueueForClassification } from "./classification";
import { logger } from "./logger";

const LOGS_DIR = join(configDir, "interpretation_logs");
const MAX_LOG_FILES = 100;
const PROMPT_PATH =
  process.env.PROMPT_PATH ??
  join(import.meta.dir, "..", "..", "prompts", "interpret_events.md");

interface QueueItem {
  id: number;
  timestamp: string;
  event_type: string;
  app: string;
  detail: string | null;
  clickContext?: { app: string; detail: string; timestamp: string } | null;
}

interface LLMResult {
  sentence: string;
}

const BATCH_SIZE = 20;
const BATCH_FLUSH_MS = 4000;
const MAX_DETAIL_CHARS = 1200;
const MAX_CTX_CHARS = 400;
const MAX_OUTPUT_TOKENS = 2000;
const STUCK_THRESHOLD_MS = 90_000;

let pendingBatch: QueueItem[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let isProcessing = false;
let apiKey: string | null = null;
let systemPrompt: string | null = null;
let warnedNoKey = false;
let warnedNoPrompt = false;

// Tracks every event enqueued for LLM interpretation until it resolves.
const inflight = new Map<number, { event_type: string; app: string; enqueuedAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [id, info] of inflight) {
    const elapsedS = Math.round((now - info.enqueuedAt) / 1000);
    if (elapsedS >= STUCK_THRESHOLD_MS / 1000) {
      logger.warn(`[interp] STUCK    #${id} ${info.event_type} in ${info.app} (${elapsedS}s, no interpretation)`);
    }
  }
}, 30_000).unref();

export async function configure(): Promise<void> {
  apiKey = resolveInterpretationApiKey();
  if (!apiKey) {
    logger.info("interpretation: no API key — configure in settings");
    warnedNoKey = false;
    return;
  }
  logger.info(`interpretation: using key for model ${getInterpretationModel()}`);
  try {
    systemPrompt = await Bun.file(PROMPT_PATH).text();
    logger.info("interpretation: ready");
    warnedNoPrompt = false;
  } catch {
    systemPrompt = null;
    logger.warn(`interpretation: could not load prompt at ${PROMPT_PATH}`);
  }
}

export function reconfigure(): void {
  apiKey = resolveInterpretationApiKey();
  warnedNoKey = false;
  warnedNoPrompt = false;
  logger.info(`interpretation: reconfigured hasKey=${!!apiKey} model=${getInterpretationModel()}`);
}

function saveBatchLog(
  events: QueueItem[],
  input: { model: string; messages: { role: string; content: string }[] },
  output: { success: boolean; results?: LLMResult[] | null; raw?: unknown; error?: string }
): void {
  try {
    const timestamp = new Date().toISOString().replace(/:/g, "-");
    const ids = events.map(e => e.id).join("_");
    const filename = `${timestamp}_events${ids}.json`;
    const filepath = join(LOGS_DIR, filename);
    const payload = {
      timestamp: new Date().toISOString(),
      event_ids: events.map(e => e.id),
      events,
      input,
      output,
    };
    mkdirSync(LOGS_DIR, { recursive: true });
    Bun.write(filepath, JSON.stringify(payload, null, 2));

    const files = readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    if (files.length > MAX_LOG_FILES) {
      for (let i = 0; i < files.length - MAX_LOG_FILES; i++) {
        unlinkSync(join(LOGS_DIR, files[i]));
      }
    }
  } catch (e) {
    logger.warn(`interpretation: failed to save log: ${(e as Error).message}`);
  }
}

function scheduledFlush(): void {
  batchTimer = null;
  maybeFlush();
}

function maybeFlush(): void {
  if (isProcessing || pendingBatch.length === 0) return;
  isProcessing = true;
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }

  const batch = pendingBatch.splice(0, BATCH_SIZE);
  processBatch(batch).finally(() => {
    isProcessing = false;
    if (pendingBatch.length >= BATCH_SIZE) {
      maybeFlush();
    } else if (pendingBatch.length > 0 && !batchTimer) {
      batchTimer = setTimeout(scheduledFlush, BATCH_FLUSH_MS);
    }
  });
}

export function enqueue(item: QueueItem): void {
  if (!apiKey) {
    if (!warnedNoKey) {
      logger.warn("interpretation: skipping enqueue because no API key is configured");
      warnedNoKey = true;
    }
    return;
  }
  if (!systemPrompt) {
    if (!warnedNoPrompt) {
      logger.warn("interpretation: skipping enqueue because prompt is not loaded");
      warnedNoPrompt = true;
    }
    return;
  }
  inflight.set(item.id, { event_type: item.event_type, app: item.app, enqueuedAt: Date.now() });
  logger.info(`[interp] queue    #${item.id} ${item.event_type} in ${item.app}`);
  pendingBatch.push(item);
  if (pendingBatch.length >= BATCH_SIZE) {
    maybeFlush();
  } else if (!batchTimer && !isProcessing) {
    batchTimer = setTimeout(scheduledFlush, BATCH_FLUSH_MS);
  }
}

async function processBatch(events: QueueItem[]): Promise<void> {
  const ids = events.map(e => e.id);
  const idStr = ids.length === 1 ? `#${ids[0]}` : `#${ids[0]}..#${ids[ids.length - 1]}`;
  const recentHistory = fetchRecentInterpretations(10);
  const results = await callOpenAI(events, recentHistory);

  if (!results || results.length < events.length) {
    if (events.length > 1) {
      const mid = Math.ceil(events.length / 2);
      logger.warn(`[interp] retry    ${idStr} → splitting into ${mid}+${events.length - mid}`);
      await processBatch(events.slice(0, mid));
      await processBatch(events.slice(mid));
    } else {
      logger.warn(`[interp] FAIL     ${idStr} ${events[0].event_type} in ${events[0].app} → stuck on placeholder`);
      inflight.delete(ids[0]);
    }
    return;
  }

  for (let i = 0; i < events.length; i++) {
    updateInterpretation(events[i].id, results[i].sentence);
    inflight.delete(events[i].id);
    logger.info(`[interp] done     #${events[i].id} → "${results[i].sentence}"`);
    enqueueForClassification({
      id: events[i].id,
      timestamp: events[i].timestamp,
      interpretation: results[i].sentence,
    });
  }
}

async function callOpenAI(
  events: QueueItem[],
  recentHistory: string[],
): Promise<LLMResult[] | null> {
  if (!apiKey || !systemPrompt) return null;

  const trimForPrompt = (value: string | null | undefined, maxChars: number): string => {
    const s = (value ?? "").replace(/\s+/g, " ").trim();
    if (s.length <= maxChars) return s;
    return `${s.slice(0, maxChars)}…`;
  };

  const eventLines = events.map((e, i) => {
    let line = `${i + 1}. ${e.event_type} | ${e.app} | ${trimForPrompt(e.detail, MAX_DETAIL_CHARS)}`;
    if (e.clickContext) {
      line += ` [ctx: ${e.clickContext.app} | ${trimForPrompt(e.clickContext.detail, MAX_CTX_CHARS)}]`;
    }
    return line;
  }).join("\n");

  let userMessage = eventLines;
  if (recentHistory.length > 0) {
    userMessage += `\nRecent: ${recentHistory.join(" | ")}`;
  }

  const model = getInterpretationModel();
  const ids = events.map(e => e.id);
  const idStr = ids.length === 1 ? `#${ids[0]}` : `#${ids[0]}..#${ids[ids.length - 1]}`;

  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userMessage },
  ];
  const tools = [{
    type: "function" as const,
    function: {
      name: "save_interpretations",
      description: "One sentence per event, same order as input.",
      parameters: {
        type: "object",
        properties: {
          events: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sentence: { type: "string", description: "What the user did (max 12 words)." },
              },
              required: ["sentence"],
            },
          },
        },
        required: ["events"],
      },
    },
  }];

  const logInput = { model, messages };

  const client = getInterpretationClient();
  if (!client) {
    logger.warn(`[interp] no-client ${idStr} → no LLM client configured`);
    return null;
  }

  logger.info(`[interp] send     ${idStr} (${events.length}) → ${model}`);

  try {
    const completion = await client.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: { type: "function" as const, function: { name: "save_interpretations" } },
      temperature: 0.3,
      max_tokens: MAX_OUTPUT_TOKENS,
    }, { signal: AbortSignal.timeout(120000) });

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
    const argsStr = toolCall?.function?.arguments;
    if (!argsStr) {
      logger.warn(`[interp] no-args  ${idStr} → LLM returned no tool call`);
      saveBatchLog(events, logInput, { success: false, raw: completion, error: "No tool call in response" });
      return null;
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsStr) as Record<string, unknown>;
    } catch {
      logger.warn(`[interp] bad-json ${idStr} → malformed tool call arguments`);
      saveBatchLog(events, logInput, { success: false, raw: completion, error: "Malformed tool call JSON" });
      return null;
    }

    const rawEvents = args.events as Array<Record<string, unknown>>;
    const got = rawEvents?.length ?? 0;

    if (!Array.isArray(rawEvents) || got < events.length) {
      logger.warn(`[interp] short    ${idStr} → expected ${events.length}, got ${got}`);
      saveBatchLog(events, logInput, { success: false, raw: args, error: `Expected ${events.length} results, got ${got}` });
      return null;
    }

    const results: LLMResult[] = [];
    for (let i = 0; i < events.length; i++) {
      const item = rawEvents[i];
      if (!item?.sentence) {
        logger.warn(`[interp] bad-item ${idStr} → missing sentence at index ${i}`);
        saveBatchLog(events, logInput, { success: false, raw: args, error: "Missing sentence in item" });
        return null;
      }
      results.push({ sentence: String(item.sentence).trim() });
    }

    saveBatchLog(events, logInput, { success: true, results, raw: args });

    const inputTokens  = completion.usage?.prompt_tokens     ?? 0;
    const outputTokens = completion.usage?.completion_tokens ?? 0;
    if (inputTokens > 0 || outputTokens > 0) {
      insertApiUsage({ model, operation: "interpretation", inputTokens, outputTokens, costUsd: computeApiCost(model, inputTokens, outputTokens) });
    }

    return results;
  } catch (e: unknown) {
    const errMsg = (e as Error).message;
    logger.warn(`[interp] error    ${idStr} → ${errMsg}`);
    saveBatchLog(events, logInput, { success: false, error: errMsg });
    return null;
  }
}
