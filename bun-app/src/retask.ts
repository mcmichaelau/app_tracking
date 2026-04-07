/**
 * Agent-based task segmentation.
 *
 * Runs on an interval. Uses the same model as task classification
 * (`TASK_CLASSIFIER_LLM` / Settings → task classifier), defaulting to Groq
 * Llama — not a separate hard-coded Claude Haiku call.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { db, insertTask, insertApiUsage, computeApiCost } from "./db";
import {
  getClassificationLlmResolved,
  resolveAnthropicApiKey,
  resolveApiKeyForClassifier,
} from "./llm/resolve";
import { getInterpretationClient } from "./llm/client";
import { logger } from "./logger";

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const EVENTS_WINDOW_MINUTES = 35;

const USER_KICKOFF =
  "Group the unassigned activity events from the last 35 minutes into tasks.";

function anthropicToolsToOpenAI(tools: Anthropic.Tool[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema as OpenAI.Chat.ChatCompletionFunction["parameters"],
    },
  }));
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "query_events",
    description:
      "Read recent activity events from the database. Returns each event's id, timestamp, app, event_type, interpretation, and task_id (null = unassigned). Focus on events where task_id is null — those need grouping.",
    input_schema: {
      type: "object" as const,
      properties: {
        minutes: {
          type: "number",
          description: `How many minutes back to look (max ${EVENTS_WINDOW_MINUTES})`,
        },
      },
      required: ["minutes"],
    },
  },
  {
    name: "query_tasks",
    description:
      "Read recent tasks from the database, with their event counts and time spans. Use this for context about what was already grouped before the current window.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Number of most-recent tasks to return (max 20)",
        },
      },
      required: ["limit"],
    },
  },
  {
    name: "create_task",
    description:
      "Create a new task and assign the given events to it. All provided event_ids will have their task_id set to the new task.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Short goal statement (6-12 words). Use specific names — files, URLs, people — when visible in the events.",
        },
        description: {
          type: "string",
          description: "1-2 sentence description of what the user was trying to accomplish (not what they did step by step).",
        },
        category: {
          type: "string",
          enum: ["Productivity", "Leisure", "Admin", "Learning", "Communication"],
        },
        event_ids: {
          type: "array",
          items: { type: "number" },
          description: "IDs of the events to assign to this task.",
        },
      },
      required: ["title", "description", "category", "event_ids"],
    },
  },
  {
    name: "assign_events",
    description:
      "Assign unassigned events to an EXISTING task. Use this when the events clearly belong to work the user was already doing — e.g. they switched away briefly and came back, or they're interleaving two ongoing tasks. Prefer this over create_task when a matching task already exists.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "number", description: "The existing task to assign events to." },
        event_ids: {
          type: "array",
          items: { type: "number" },
          description: "IDs of unassigned events to add to this task.",
        },
      },
      required: ["task_id", "event_ids"],
    },
  },
  {
    name: "update_task",
    description:
      "Update the title and/or description of any existing task. Use this to broaden a task's scope when new events extend its goal, or to improve an existing title.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "number" },
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["task_id"],
    },
  },
];

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a background task segmentation agent. Your job is to look at a user's recent computer activity and assign unassigned events to tasks — either existing ones or new ones.

## Your process
1. Call query_events(35) to see all events from the last 35 minutes
2. Call query_tasks(20) to see recent existing tasks — read them carefully
3. For each block of unassigned events, decide: does this fit an existing task, or is it genuinely new work?
   - If it fits an existing task → call assign_events(task_id, event_ids)
   - If it's new work → call create_task(...)
4. Optionally call update_task to broaden a task's title/description if its scope grew
5. Stop when all unassigned events are covered — do not output explanatory text

## The user works on multiple things in parallel

The user frequently switches between several ongoing tasks — debugging one thing, checking a browser, answering a message, switching back. This is normal. Do NOT force everything into one giant task just because it happened in the same time window.

Instead, match each group of unassigned events to the BEST FITTING existing task if one exists. Only create a new task when the work is genuinely new and doesn't match anything in recent tasks.

## Task grouping rules

**A task = what the user was TRYING TO ACCOMPLISH, not each individual step.**

1. MATCH EXISTING TASKS FIRST: Before creating a new task, check if the unassigned events continue an existing one. Same app, same goal, same file or page = same task.
2. APP SWITCHES ARE NOT SPLITS: browser ↔ IDE ↔ terminal while working toward the same goal = ONE task. Brief checks of another app before returning = same task.
3. MULTI-STEP WORKFLOWS = ONE TASK: git init + gh auth + OAuth flow = one task. Don't split a workflow into its steps.
4. MINIMUM SIZE: A task should span at least 3 minutes, unless it's the only activity or genuinely brief.
5. MERGE DOUBT: when unsure, prefer assigning to an existing task over creating a new one.
6. GENUINE NEW TASK only when: the goal is clearly different from all recent tasks, OR there's a 10+ minute idle gap before it.

## What to avoid
- Do NOT create a new task when an existing task already covers that goal
- Do NOT split on app switches
- Do NOT over-explain — just make the tool calls`;

// ─── Tool handlers ────────────────────────────────────────────────────────────

function sanitize(s: string): string {
  return s.replace(/[\uD800-\uDFFF]/g, "?").replace(/[\x00-\x08\x0B-\x1F\x7F]/g, " ");
}

function handleQueryEvents(minutes: number): string {
  const capped = Math.min(minutes, EVENTS_WINDOW_MINUTES);
  const since = new Date(Date.now() - capped * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT id, timestamp, app, event_type,
           COALESCE(interpretation, '') as interpretation,
           task_id
    FROM raw_events
    WHERE timestamp >= ?
      AND interpretation IS NOT NULL AND interpretation != ''
    ORDER BY id ASC
  `).all(since) as Array<{
    id: number; timestamp: string; app: string; event_type: string;
    interpretation: string; task_id: number | null;
  }>;

  if (rows.length === 0) return "No events found in this window.";

  const lines = rows.map(r => {
    const time = r.timestamp.slice(11, 16);
    const interp = sanitize(r.interpretation).slice(0, 60);
    const assigned = r.task_id != null ? `[task:${r.task_id}]` : "[unassigned]";
    return `id=${r.id} ${time} ${assigned} ${r.app} | ${r.event_type} | ${interp}`;
  });

  const unassigned = rows.filter(r => r.task_id === null).length;
  return `${rows.length} events (${unassigned} unassigned):\n${lines.join("\n")}`;
}

function handleQueryTasks(limit: number): string {
  const capped = Math.min(limit, 20);
  const rows = db.prepare(`
    SELECT t.id, t.title, t.category,
           COUNT(e.id) as event_count,
           MIN(e.timestamp) as first_event,
           MAX(e.timestamp) as last_event
    FROM tasks t
    LEFT JOIN raw_events e ON e.task_id = t.id
    GROUP BY t.id
    ORDER BY t.id DESC
    LIMIT ?
  `).all(capped) as Array<{
    id: number; title: string; category: string | null;
    event_count: number; first_event: string | null; last_event: string | null;
  }>;

  if (rows.length === 0) return "No tasks found.";

  const lines = rows.map(r => {
    const start = r.first_event?.slice(11, 16) ?? "?";
    const end = r.last_event?.slice(11, 16) ?? "?";
    return `task_id=${r.id} [${start}–${end}] (${r.event_count} events) ${r.title}`;
  });
  return lines.join("\n");
}

function handleCreateTask(input: {
  title: string;
  description: string;
  category: string;
  event_ids: number[];
}): string {
  const validCategories = ["Productivity", "Leisure", "Admin", "Learning", "Communication"];
  const category = validCategories.includes(input.category)
    ? (input.category as any)
    : "Productivity";

  if (!input.event_ids || input.event_ids.length === 0) {
    return "Error: event_ids must be a non-empty array.";
  }

  const taskId = insertTask({
    title: sanitize(input.title),
    description: sanitize(input.description),
    category,
  });

  const placeholders = input.event_ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE raw_events SET task_id = ? WHERE id IN (${placeholders})`
  ).run(taskId, ...input.event_ids);

  return `Created task_id=${taskId} "${input.title}" — assigned ${input.event_ids.length} events.`;
}

function handleAssignEvents(input: { task_id: number; event_ids: number[] }): string {
  const row = db.prepare("SELECT id, title FROM tasks WHERE id = ?").get(input.task_id) as
    | { id: number; title: string }
    | undefined;
  if (!row) return `Error: task_id=${input.task_id} not found.`;
  if (!input.event_ids?.length) return "Error: event_ids must be a non-empty array.";

  const placeholders = input.event_ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE raw_events SET task_id = ? WHERE id IN (${placeholders})`
  ).run(input.task_id, ...input.event_ids);

  return `Assigned ${input.event_ids.length} events to task_id=${input.task_id} "${row.title}".`;
}

function handleUpdateTask(input: {
  task_id: number;
  title?: string;
  description?: string;
}): string {
  const row = db.prepare("SELECT id, title FROM tasks WHERE id = ?").get(input.task_id) as
    | { id: number; title: string }
    | undefined;
  if (!row) return `Error: task_id=${input.task_id} not found.`;

  if (input.title) {
    db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run(
      sanitize(input.title), input.task_id
    );
  }
  if (input.description) {
    db.prepare("UPDATE tasks SET description = ? WHERE id = ?").run(
      sanitize(input.description), input.task_id
    );
  }
  return `Updated task_id=${input.task_id}.`;
}

function dispatchTool(name: string, input: Record<string, unknown>): string {
  try {
    switch (name) {
      case "query_events":
        return handleQueryEvents(Number(input.minutes ?? EVENTS_WINDOW_MINUTES));
      case "query_tasks":
        return handleQueryTasks(Number(input.limit ?? 20));
      case "create_task":
        return handleCreateTask(input as any);
      case "assign_events":
        return handleAssignEvents(input as any);
      case "update_task":
        return handleUpdateTask(input as any);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Tool error: ${(e as Error).message}`;
  }
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────

export async function runRetaskAgent(): Promise<void> {
  const unassigned = db.prepare(`
    SELECT COUNT(*) as n FROM raw_events
    WHERE task_id IS NULL AND interpretation IS NOT NULL AND interpretation != ''
      AND timestamp >= ?
  `).get(new Date(Date.now() - EVENTS_WINDOW_MINUTES * 60 * 1000).toISOString()) as { n: number };

  if (unassigned.n === 0) {
    logger.info("retask-agent: no unassigned events — nothing to do");
    return;
  }

  const { provider, model } = getClassificationLlmResolved();

  if (provider === "gemini") {
    logger.warn(
      "retask-agent: task classifier is Gemini — retask only supports OpenAI-compatible (e.g. Groq) or Anthropic; skipping",
    );
    return;
  }

  if (!resolveApiKeyForClassifier()) {
    logger.warn("retask-agent: no API key for task classifier — skipping");
    return;
  }

  logger.info(`retask-agent: starting (${unassigned.n} unassigned) model=${model} provider=${provider}`);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const MAX_TURNS = 20;

  if (provider === "anthropic") {
    const apiKey = resolveAnthropicApiKey();
    if (!apiKey) {
      logger.warn("retask-agent: classifier is Anthropic but ANTHROPIC_API_KEY is missing — skipping");
      return;
    }

    const client = new Anthropic({ apiKey });
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: USER_KICKOFF }];

    let turns = 0;
    while (turns < MAX_TURNS) {
      turns++;
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "end_turn") {
        logger.info(`retask-agent: done after ${turns} turn(s)`);
        break;
      }

      if (response.stop_reason !== "tool_use") {
        logger.warn(`retask-agent: unexpected stop_reason=${response.stop_reason}`);
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const result = dispatchTool(block.name, block.input as Record<string, unknown>);
        logger.info(`retask-agent: tool ${block.name}`, { result: result.slice(0, 120) });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }

      if (toolResults.length === 0) break;
      messages.push({ role: "user", content: toolResults });
    }

    if (turns >= MAX_TURNS) {
      logger.warn(`retask-agent: hit MAX_TURNS=${MAX_TURNS}`);
    }
  } else {
    const client = getInterpretationClient();
    if (!client) {
      logger.warn(
        "retask-agent: OpenAI-compatible client unavailable — check GROQ_API_KEY / interpretation routing",
      );
      return;
    }

    const openAiTools = anthropicToolsToOpenAI(TOOLS);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: USER_KICKOFF },
    ];

    let turns = 0;
    while (turns < MAX_TURNS) {
      turns++;
      const completion = await client.chat.completions.create({
        model,
        messages,
        tools: openAiTools,
        tool_choice: "auto",
        max_tokens: 4096,
        temperature: 0.3,
      });

      const u = completion.usage;
      if (u) {
        totalInputTokens += u.prompt_tokens ?? 0;
        totalOutputTokens += u.completion_tokens ?? 0;
      }

      const msg = completion.choices[0]?.message;
      if (!msg) break;

      messages.push(msg);

      if (!msg.tool_calls?.length) {
        logger.info(`retask-agent: done after ${turns} turn(s)`);
        break;
      }

      for (const tc of msg.tool_calls) {
        if (tc.type !== "function") continue;
        const name = tc.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        const result = dispatchTool(name, args);
        logger.info(`retask-agent: tool ${name}`, { result: result.slice(0, 120) });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }
    }

    if (turns >= MAX_TURNS) {
      logger.warn(`retask-agent: hit MAX_TURNS=${MAX_TURNS}`);
    }
  }

  if (totalInputTokens > 0 || totalOutputTokens > 0) {
    insertApiUsage({
      model,
      operation: "retask",
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: computeApiCost(model, totalInputTokens, totalOutputTokens),
    });
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startRetaskScheduler(): void {
  if (schedulerInterval) return;

  // Run once shortly after startup, then every 30 minutes
  setTimeout(() => {
    runRetaskAgent().catch(e =>
      logger.warn(`retask-agent: run failed — ${(e as Error).message}`)
    );
  }, 30_000); // 30 seconds after startup

  schedulerInterval = setInterval(() => {
    runRetaskAgent().catch(e =>
      logger.warn(`retask-agent: run failed — ${(e as Error).message}`)
    );
  }, INTERVAL_MS);

  logger.info("retask-agent: scheduler started (5-minute interval)");
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (import.meta.main) {
  console.log("retask-agent: running now…");
  runRetaskAgent()
    .then(() => { console.log("retask-agent: done"); process.exit(0); })
    .catch(e => { console.error("retask-agent: failed", e); process.exit(1); });
}
