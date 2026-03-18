import { join } from "path";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import {
  updateInterpretation,
  assignEventToTask,
  insertTask,
  fetchMostRecentTaskWithLastEventTime,
  fetchRecentInterpretations,
  fetchTasks,
  updateTask,
} from "./db";
import { loadConfig, INTERPRETATION_MODEL, configDir } from "./config";
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
  task: {
    type: "new_task";
    task_title: string;
    task_description: string;
  } | {
    type: "continue_task";
    new_task_title: string | null;
    task_description: string;
  };
}

const BATCH_SIZE = 5;
const BATCH_FLUSH_MS = 4000;
const TASK_STALE_MS = 10 * 60 * 1000; // 10 minutes

let pendingBatch: QueueItem[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let isProcessing = false;
let apiKey: string | null = null;
let systemPrompt: string | null = null;

export async function configure(): Promise<void> {
  apiKey = process.env.OPENAI_API_KEY ?? loadConfig().openai_api_key ?? null;
  if (!apiKey) {
    logger.info("interpretation: no API key — configure in settings");
    return;
  }
  try {
    systemPrompt = await Bun.file(PROMPT_PATH).text();
    logger.info("interpretation: ready");
  } catch {
    logger.warn(`interpretation: could not load prompt at ${PROMPT_PATH}`);
  }
}

export function reconfigure(): void {
  apiKey = process.env.OPENAI_API_KEY ?? loadConfig().openai_api_key ?? null;
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
  if (!apiKey || !systemPrompt) return;
  pendingBatch.push(item);
  if (pendingBatch.length >= BATCH_SIZE) {
    maybeFlush();
  } else if (!batchTimer && !isProcessing) {
    batchTimer = setTimeout(scheduledFlush, BATCH_FLUSH_MS);
  }
}

async function processBatch(events: QueueItem[]): Promise<void> {
  const recentTaskData = fetchMostRecentTaskWithLastEventTime();
  let activeTask: { id: number; title: string; description: string } | null = null;

  if (recentTaskData?.lastEventTime) {
    const lastEventMs = new Date(recentTaskData.lastEventTime).getTime();
    const firstEventMs = new Date(events[0].timestamp).getTime();
    if (firstEventMs - lastEventMs <= TASK_STALE_MS) {
      activeTask = recentTaskData.task;
    }
  }

  const recentHistory = fetchRecentInterpretations(10);
  const recentTasks = fetchTasks(2);
  const results = await callOpenAI(events, activeTask, recentHistory, recentTasks);
  if (!results || results.length !== events.length) return;

  // Process results in order, maintaining running task state so mid-batch
  // task boundaries are handled correctly (e.g. new_task at event 3 of 5).
  let currentTask: { id: number; title: string; description: string } | null = activeTask;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const result = results[i];

    updateInterpretation(event.id, result.sentence);

    if (result.task.type === "new_task") {
      const taskId = insertTask({
        title: result.task.task_title,
        description: result.task.task_description,
      });
      assignEventToTask(event.id, taskId);
      currentTask = { id: taskId, title: result.task.task_title, description: result.task.task_description };
      logger.info("interpretation: created new task", { taskId, title: result.task.task_title });
    } else {
      if (currentTask) {
        const updates: { title?: string; description?: string } = {};
        if (result.task.new_task_title) updates.title = result.task.new_task_title;
        if (result.task.task_description) updates.description = result.task.task_description;
        if (Object.keys(updates).length > 0) {
          updateTask(currentTask.id, updates);
          currentTask = {
            ...currentTask,
            title: updates.title ?? currentTask.title,
            description: updates.description ?? currentTask.description,
          };
        }
        assignEventToTask(event.id, currentTask.id);
        logger.info("interpretation: continued task", { taskId: currentTask.id });
      } else {
        // No prior task — create one from the continue_task data
        const taskId = insertTask({
          title: result.task.new_task_title ?? "Untitled Task",
          description: result.task.task_description ?? "",
        });
        assignEventToTask(event.id, taskId);
        currentTask = {
          id: taskId,
          title: result.task.new_task_title ?? "Untitled Task",
          description: result.task.task_description ?? "",
        };
        logger.info("interpretation: created task (no previous)", { taskId });
      }
    }
  }
}

async function callOpenAI(
  events: QueueItem[],
  activeTask: { id: number; title: string; description: string } | null,
  recentHistory: string[],
  recentTasks: { id: number; title: string; description: string }[]
): Promise<LLMResult[] | null> {
  if (!apiKey || !systemPrompt) return null;

  const eventLines = events.map((e, i) => {
    let lines = `Event ${i + 1}:\nType: ${e.event_type}\nApp: ${e.app}\nDetail: ${e.detail ?? ""}`;
    if (e.clickContext) {
      lines += `\nClick context (most recent click in ${e.clickContext.app}): ${e.clickContext.detail}`;
    }
    return lines;
  }).join("\n\n");

  let userMessage = `Events to interpret (${events.length} event${events.length > 1 ? "s" : ""}, in order):\n\n${eventLines}`;

  if (recentHistory.length > 0) {
    userMessage += `\n\nRecent activity (last ${recentHistory.length} events before this batch, oldest first):\n${recentHistory.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
  }
  // Show last 2 tasks for context, marking the active one as current
  if (recentTasks.length > 0) {
    const taskLines = recentTasks.map((t, i) => {
      const label = i === 0 ? "Current task" : "Previous task";
      const stale = activeTask === null && i === 0 ? " (stale — no active task)" : "";
      return `${label}${stale}:\nTitle: ${t.title}\nDescription: ${t.description}`;
    }).join("\n\n");
    userMessage += `\n\n${taskLines}`;
    if (activeTask === null) {
      userMessage += `\n\nNo active task (last task is stale). You must create a new task for the first event.`;
    }
  } else {
    userMessage += `\n\nNo current task exists. You must create a new task for the first event.`;
  }

  const logInput = { model: INTERPRETATION_MODEL, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }] };
  const body = {
    model: INTERPRETATION_MODEL,
    instructions: systemPrompt,
    input: userMessage,
    tools: [{
      type: "function" as const,
      name: "save_interpretations",
      description: "Saves interpretations and task assignments for a batch of user activity events.",
      parameters: {
        type: "object",
        properties: {
          events: {
            type: "array",
            description: "One interpretation per event, in the same order as the input.",
            items: {
              type: "object",
              properties: {
                sentence: {
                  type: "string",
                  description: "A specific, detailed sentence describing what the user did.",
                },
                task: {
                  type: "object",
                  description: "Task assignment for this event.",
                  properties: {
                    type: {
                      type: "string",
                      enum: ["new_task", "continue_task"],
                      description: "Whether to create a new task or continue the current one.",
                    },
                    task_title: {
                      type: "string",
                      description: "For new_task: title of the new task.",
                    },
                    task_description: {
                      type: "string",
                      description: "For new_task: goal description. For continue_task: complete replacement description reflecting the full goal.",
                    },
                    new_task_title: {
                      type: "string",
                      description: "For continue_task: refined title when intent has become clearer mid-batch (e.g. 'Opening new tab' → 'Shopping for Dickies 874 pants'). Null to keep current title.",
                    },
                  },
                  required: ["type"],
                },
              },
              required: ["sentence", "task"],
            },
          },
        },
        required: ["events"],
      },
    }],
    tool_choice: { type: "function" as const, name: "save_interpretations" },
    reasoning: { effort: "low" as const },
    text: { verbosity: "medium" as const },
    max_output_tokens: 2000,
  };

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    const rawResponse = await res.json().catch(() => null);

    if (!res.ok) {
      const errBody = typeof rawResponse === "object" ? JSON.stringify(rawResponse) : String(rawResponse);
      logger.warn(`interpretation: HTTP ${res.status} for batch [${events.map(e => e.id).join(",")}]: ${errBody}`);
      saveBatchLog(events, logInput, {
        success: false,
        raw: rawResponse,
        error: `HTTP ${res.status}: ${errBody}`,
      });
      return null;
    }

    const json = rawResponse as { output?: Array<{ type?: string; name?: string; arguments?: string }> };
    const toolCall = json?.output?.find((o) => o.type === "function_call");
    const argsStr = toolCall?.arguments;
    if (!argsStr) {
      saveBatchLog(events, logInput, {
        success: false,
        raw: json,
        error: "No tool call in response",
      });
      return null;
    }

    const args = JSON.parse(argsStr) as Record<string, unknown>;
    const rawEvents = args.events as Array<Record<string, unknown>>;
    logger.info("interpretation: llm_response", {
      eventIds: events.map(e => e.id),
      model: INTERPRETATION_MODEL,
      resultCount: rawEvents?.length,
    });

    if (!Array.isArray(rawEvents) || rawEvents.length !== events.length) {
      saveBatchLog(events, logInput, {
        success: false,
        raw: args,
        error: `Expected ${events.length} results, got ${rawEvents?.length}`,
      });
      return null;
    }

    const results: LLMResult[] = [];
    for (const item of rawEvents) {
      if (!item?.sentence || !(item.task as Record<string, unknown>)?.type) {
        saveBatchLog(events, logInput, {
          success: false,
          raw: args,
          error: "Missing sentence or task type in item",
        });
        return null;
      }

      const sentence = String(item.sentence).trim();
      const t = item.task as Record<string, unknown>;
      const taskType = t.type;

      if (taskType === "new_task") {
        results.push({
          sentence,
          task: {
            type: "new_task",
            task_title: (t.task_title as string) ?? "Untitled",
            task_description: (t.task_description as string) ?? "",
          },
        });
      } else if (taskType === "continue_task") {
        results.push({
          sentence,
          task: {
            type: "continue_task",
            new_task_title: (t.new_task_title as string | null) ?? null,
            task_description: (t.task_description as string) ?? "",
          },
        });
      } else {
        saveBatchLog(events, logInput, {
          success: false,
          raw: args,
          error: `Unknown task type: ${taskType}`,
        });
        return null;
      }
    }

    saveBatchLog(events, logInput, {
      success: true,
      results,
      raw: args,
    });
    return results;
  } catch (e: unknown) {
    const errMsg = (e as Error).message;
    logger.warn(`interpretation: request failed for batch [${events.map(ev => ev.id).join(",")}]: ${errMsg}`);
    saveBatchLog(events, logInput, {
      success: false,
      error: errMsg,
    });
    return null;
  }
}
