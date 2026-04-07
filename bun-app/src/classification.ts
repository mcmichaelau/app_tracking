/**
 * Task classification module.
 *
 * ## Overview
 * Events are interpreted one-by-one in interpretation.ts, which writes a plain-
 * English sentence per event to the DB. This module sits downstream: after each
 * interpretation is written, the event is handed off here via `enqueueForClassification`.
 * Once enough events accumulate (see "Batching" below), they are sent to an LLM
 * that decides whether the user is still on the same task (CONTINUE) or has started
 * a new one (NEW_TASK). Results are persisted via the tasks table and raw_events.task_id.
 *
 * ## Batching strategy (hybrid — mirrors test_task_classification.ts)
 * A flush is triggered when ANY of these conditions is met:
 *  1. Signal count in buffer >= MAX_BATCH_SIGNALS (50)      — too much to wait longer
 *  2. Window duration (first → last timestamp) >= MAX_WINDOW_MS (5 min) — wall-clock cap
 *  3. Gap between this event and the previous >= GAP_MS (5 min)         — inactivity cut
 *  4. Idle timer fires: no new event arrived for IDLE_FLUSH_MS (2 min)  — catches slow sessions
 *
 * "Signal" events are those whose interpretation is not noise (see NOISE_PATTERNS).
 * Noise events are buffered (so their timestamps affect the window/gap checks) but
 * are excluded from the LLM user message to reduce token waste.
 *
 * ## LLM input per call
 *  - Current task: title, description, start time, elapsed minutes
 *  - Last ≤50 interpreted signal events from current task (oldest-first, with timestamps)
 *  - New batch of signal events (oldest-first, with timestamps)
 *  - Critical rules reminder appended verbatim (mirrors test_task_classification.ts)
 *
 * ## LLM output (classify_task_v3a.md prompt)
 *  {"action":"CONTINUE"}
 *  {"action":"CONTINUE","title":"Updated title","description":"Updated description"}
 *  {"action":"NEW_TASK","title":"Short title","description":"1-2 sentence summary"}
 *
 * ## DB mutations
 *  - NEW_TASK  → insertTask() + assignEventToTask() for every event in the batch
 *  - CONTINUE  → optionally updateTask() if title/description changed
 *                + assignEventToTask() for every event in the batch
 *
 * ## State (in-memory, rebuilt on startup)
 *  - currentTaskId / currentTaskTitle / currentTaskDescription / currentTaskStartTime
 *    Loaded from DB at configure() time via fetchMostRecentTaskWithLastEventTime().
 *  - taskInterps: last ≤50 formatted signal interpretations for the current task.
 *    Lost on restart — configure() seeds it from fetchRecentInterpretations().
 *  - pendingBuffer: events waiting to be classified in the next flush.
 *
 * ## Edge cases
 *  - No task exists yet (fresh install or empty DB):
 *    First flush always creates a task. On CONTINUE the title defaults to "Untitled"
 *    if the LLM doesn't provide one (rare — v3a almost always provides titles).
 *  - LLM call fails (network error, API key missing):
 *    Events are still assigned to the current task (or a synthetic "Untitled" task if
 *    there is none). Classification silently skips rather than crashing.
 *  - flush() is re-entrant safe: a second flush() call while one is in progress is a
 *    no-op; the idle timer at the end of flush() picks up any events that arrived during.
 *  - TYPING events never reach this module (interpretation.ts skips them upstream).
 *  - App restart mid-task: currentTask is reloaded from DB; taskInterps is re-seeded
 *    from the most recent DB interpretations so context is approximately restored.
 */

import { join } from "path";
import {
  fetchMostRecentTaskWithLastEventTime,
  fetchRecentInterpretations,
  insertTask,
  updateTask,
  assignEventToTask,
  insertApiUsage,
  computeApiCost,
} from "./db";
import {
  getClassificationLlmResolved,
  resolveApiKeyForClassifier,
  completeClassification,
  type InterpretationProvider,
} from "./llm";
import { logger } from "./logger";

// ─── Prompt ───────────────────────────────────────────────────────────────────

const PROMPT_PATH =
  process.env.TASK_CLASSIFIER_PROMPT_PATH ??
  join(import.meta.dir, "..", "..", "prompts", "classify_task_v3a.md");

// ─── Batching parameters ──────────────────────────────────────────────────────

/** Max signal events in the buffer before triggering an immediate flush. */
const MAX_BATCH_SIGNALS = 50;
/** Max elapsed time (first → last event in buffer) before triggering a flush. */
const MAX_WINDOW_MS = 5 * 60_000;
/** Inter-event gap that also triggers an immediate flush (inactivity cut). */
const GAP_MS = 5 * 60_000;
/** If no new event arrives within this period, flush whatever is buffered. */
const IDLE_FLUSH_MS = 2 * 60_000;

// ─── Noise filtering ──────────────────────────────────────────────────────────
// Mirrors test_task_classification.ts. Noise events consume buffer slots and
// affect time-window checks but are stripped from the LLM user message.

const NOISE_PATTERNS = [
  /^pressed .{1,3}$/,       // "pressed ↵", "pressed ⇥"
  /^pressed .+ in .+$/,     // "pressed ↵ in Cursor"
  /^typed in .+$/,          // "typed in Google Chrome"
  /^scrolled in .+$/,       // "scrolled in Chrome"
];

function isNoise(interp: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(interp));
}

// ─── LLM types ────────────────────────────────────────────────────────────────

interface ClassifyResult {
  action: "CONTINUE" | "NEW_TASK";
  title?: string;
  description?: string;
}

// ─── Critical rules reminder (verbatim from test script) ─────────────────────

const USER_CRITICAL_RULES_REMINDER = `<system_reminder>
Critical rules (apply to every response):
- NEVER create a task shorter than 5 minutes. If you're tempted to output NEW_TASK for something that looks like it will last under 5 minutes, choose CONTINUE instead. Short interruptions (checking email, glancing at Slack, looking something up) belong in the surrounding task.
- NEVER output NEW_TASK with the same or very similar title as the current task. If the activity is still aligned with the current task's purpose, that is a CONTINUE — even if the specific sub-activity has shifted slightly. Use CONTINUE with an updated title/description if the focus has evolved.
- Meetings end when the user leaves. A meeting task covers the call itself. Once the user clicks "Leave call" and spends 2+ minutes doing something else, the meeting task is over.
- Dense activity ≠ task switches. When events arrive rapidly (many clicks per minute), the user is deep in a workflow. Rapid app switching between related tools (e.g. Supabase ↔ Chrome ↔ Cursor for the same investigation) is almost always CONTINUE.
- Be specific in titles. Use names, project names, and tool names from the interpretations.
- Descriptions = what happened, not predictions.
</system_reminder>`;

/** Max prior-task interpretation lines passed as context per LLM call. */
const TASK_HISTORY_LIMIT = 50;

// ─── Module state ─────────────────────────────────────────────────────────────

interface BufferedEvent {
  id: number;
  timestamp: string;
  interpretation: string;
}

let systemPrompt: string | null = null;

let currentTaskId: number | null = null;
let currentTaskTitle = "";
let currentTaskDescription = "";
let currentTaskStartTime = "";
/** Formatted "[HH:MM] sentence" lines for the running task, newest at the end. */
let taskInterps: string[] = [];

let pendingBuffer: BufferedEvent[] = [];
let signalCount = 0;
let flushing = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function configureClassification(): Promise<void> {
  try {
    systemPrompt = await Bun.file(PROMPT_PATH).text();
  } catch {
    systemPrompt = null;
    logger.warn("[classification] Could not load classify_task_v3a.md — task classification disabled");
    return;
  }

  // Restore current-task state from DB so we don't lose context across restarts.
  const recent = fetchMostRecentTaskWithLastEventTime();
  if (recent) {
    currentTaskId = recent.task.id;
    currentTaskTitle = recent.task.title;
    currentTaskDescription = recent.task.description;
    currentTaskStartTime = recent.lastEventTime ?? new Date().toISOString();
    // Seed in-memory history from DB (lost on restart, approximate re-seed).
    taskInterps = fetchRecentInterpretations(TASK_HISTORY_LIMIT).map(
      (s) => `[?] ${s}`
    );
    logger.info(`[classification] Resumed task #${currentTaskId}: "${currentTaskTitle}"`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function parseClassifyResult(raw: string): ClassifyResult | null {
  const tryParse = (s: string): ClassifyResult | null => {
    try {
      const o = JSON.parse(s) as { action?: string; title?: string; description?: string };
      if (o.action === "CONTINUE" || o.action === "NEW_TASK") {
        return { action: o.action, title: o.title, description: o.description };
      }
    } catch { /* ignore */ }
    return null;
  };

  const direct = tryParse(raw.trim());
  if (direct) return direct;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = tryParse(fenced[1].trim());
    if (inner) return inner;
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const inner = tryParse(raw.slice(start, end + 1));
    if (inner) return inner;
  }
  return null;
}

// ─── LLM call ─────────────────────────────────────────────────────────────────

function recordClassificationApiUsage(
  provider: InterpretationProvider,
  model: string,
  raw: unknown,
): void {
  let inputTokens = 0;
  let outputTokens = 0;
  if (provider === "openai") {
    const c = raw as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
    inputTokens = c.usage?.prompt_tokens ?? 0;
    outputTokens = c.usage?.completion_tokens ?? 0;
  } else if (provider === "anthropic") {
    const m = raw as { usage?: { input_tokens?: number; output_tokens?: number } };
    inputTokens = m.usage?.input_tokens ?? 0;
    outputTokens = m.usage?.output_tokens ?? 0;
  } else {
    const r = raw as {
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const u = r.usageMetadata;
    if (u) {
      inputTokens = u.promptTokenCount ?? 0;
      outputTokens = u.candidatesTokenCount ?? 0;
    }
  }
  if (inputTokens === 0 && outputTokens === 0) return;
  insertApiUsage({
    model,
    operation: "task_classification",
    inputTokens,
    outputTokens,
    costUsd: computeApiCost(model, inputTokens, outputTokens),
  });
}

async function callClassifier(
  signalBatch: { time: string; text: string }[],
  batchStartTimestamp: string
): Promise<ClassifyResult | null> {
  if (!systemPrompt) return null;
  const { provider, model } = getClassificationLlmResolved();
  if (!resolveApiKeyForClassifier()) return null;

  let userMsg = "";
  if (currentTaskId !== null && currentTaskTitle) {
    const startMs = new Date(currentTaskStartTime).getTime();
    const batchMs = new Date(batchStartTimestamp).getTime();
    const durMin = Math.max(1, Math.round((batchMs - startMs) / 60_000));
    userMsg += `Current task: "${currentTaskTitle}" (started ${formatTime(currentTaskStartTime)}, running for ~${durMin} min) — ${currentTaskDescription}\n\n`;
    const tail = taskInterps.slice(-TASK_HISTORY_LIMIT);
    if (tail.length > 0) {
      userMsg += `Last ${tail.length} interpreted events from current task:\n`;
      for (const line of tail) userMsg += `${line}\n`;
      userMsg += "\n";
    }
  } else {
    userMsg += "No current task.\n\n";
  }

  userMsg += "New activity to classify (chronological):\n";
  for (const item of signalBatch) {
    userMsg += `[${item.time}] ${item.text}\n`;
  }
  userMsg += "\n" + USER_CRITICAL_RULES_REMINDER;

  try {
    const result = await completeClassification({ provider, model, system: systemPrompt, user: userMsg });
    recordClassificationApiUsage(provider, model, result.raw);
    return parseClassifyResult(result.content);
  } catch (e) {
    logger.error("[classification] LLM error", String(e));
    return null;
  }
}

// ─── Flush ────────────────────────────────────────────────────────────────────

async function flush(): Promise<void> {
  if (flushing || pendingBuffer.length === 0) return;

  clearIdleTimer();
  flushing = true;

  // Drain the buffer atomically — new events arriving during an async flush go
  // into a fresh pendingBuffer and are handled after this flush completes.
  const batch = pendingBuffer.splice(0);
  signalCount = 0;

  const signalEvents = batch.filter((e) => !isNoise(e.interpretation));

  if (signalEvents.length === 0) {
    // All noise — still assign to current task if one exists, no LLM call needed.
    if (currentTaskId !== null) {
      for (const e of batch) assignEventToTask(e.id, currentTaskId);
    }
    flushing = false;
    if (pendingBuffer.length > 0) scheduleIdleFlush();
    return;
  }

  const signalBatch = signalEvents.map((e) => ({ time: formatTime(e.timestamp), text: e.interpretation }));

  try {
    const result = await callClassifier(signalBatch, batch[0].timestamp);

    if (!result) {
      // LLM unavailable — assign to current task; bootstrap one if needed.
      if (currentTaskId === null) {
        const taskId = insertTask({ title: "Untitled", description: "" });
        currentTaskId = taskId;
        currentTaskTitle = "Untitled";
        currentTaskDescription = "";
        currentTaskStartTime = batch[0].timestamp;
        logger.warn(`[classification] LLM unavailable; bootstrapped task #${taskId}`);
      }
      for (const e of batch) assignEventToTask(e.id, currentTaskId!);
      appendTaskInterps(signalEvents);
      return;
    }

    if (result.action === "NEW_TASK" && result.title) {
      const taskId = insertTask({ title: result.title, description: result.description ?? "" });
      currentTaskId = taskId;
      currentTaskTitle = result.title;
      currentTaskDescription = result.description ?? "";
      currentTaskStartTime = batch[0].timestamp;
      // Reset history — we're on a new task.
      taskInterps = signalEvents.map((e) => `[${formatTime(e.timestamp)}] ${e.interpretation}`);
      logger.info(`[classification] NEW_TASK #${taskId}: "${result.title}"`);
    } else {
      // CONTINUE
      if (currentTaskId === null) {
        // No task yet — bootstrap from first CONTINUE response.
        const title = result.title ?? "Untitled";
        const taskId = insertTask({ title, description: result.description ?? "" });
        currentTaskId = taskId;
        currentTaskTitle = title;
        currentTaskDescription = result.description ?? "";
        currentTaskStartTime = batch[0].timestamp;
        taskInterps = signalEvents.map((e) => `[${formatTime(e.timestamp)}] ${e.interpretation}`);
        logger.info(`[classification] Bootstrapped task #${taskId}: "${title}"`);
      } else {
        // Update title/description if the LLM refined them.
        if (result.title || result.description) {
          const updates: { title?: string; description?: string } = {};
          if (result.title) { updates.title = result.title; currentTaskTitle = result.title; }
          if (result.description) { updates.description = result.description; currentTaskDescription = result.description; }
          updateTask(currentTaskId, updates);
        }
        appendTaskInterps(signalEvents);
      }
    }

    for (const e of batch) assignEventToTask(e.id, currentTaskId!);
  } finally {
    flushing = false;
    if (pendingBuffer.length === 0) return;
    // Check if buffered events already meet a flush threshold; otherwise wait.
    const windowMs =
      pendingBuffer.length > 1
        ? new Date(pendingBuffer[pendingBuffer.length - 1].timestamp).getTime() -
          new Date(pendingBuffer[0].timestamp).getTime()
        : 0;
    if (signalCount >= MAX_BATCH_SIGNALS || windowMs >= MAX_WINDOW_MS) {
      void flush();
    } else {
      scheduleIdleFlush();
    }
  }
}

function appendTaskInterps(events: BufferedEvent[]): void {
  for (const e of events) {
    taskInterps.push(`[${formatTime(e.timestamp)}] ${e.interpretation}`);
  }
  if (taskInterps.length > TASK_HISTORY_LIMIT) {
    taskInterps = taskInterps.slice(-TASK_HISTORY_LIMIT);
  }
}

// ─── Idle timer ───────────────────────────────────────────────────────────────

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleFlush(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void flush();
  }, IDLE_FLUSH_MS);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueue an already-interpreted event for task classification.
 * Called by interpretation.ts immediately after processOne writes the sentence to DB.
 */
export function enqueueForClassification(item: {
  id: number;
  timestamp: string;
  interpretation: string;
}): void {
  if (!systemPrompt || !resolveApiKeyForClassifier()) return;

  const prevTimestamp =
    pendingBuffer.length > 0 ? pendingBuffer[pendingBuffer.length - 1].timestamp : null;

  pendingBuffer.push(item);
  if (!isNoise(item.interpretation)) signalCount++;

  const windowMs =
    pendingBuffer.length > 1
      ? new Date(item.timestamp).getTime() - new Date(pendingBuffer[0].timestamp).getTime()
      : 0;

  const gapExceeded =
    prevTimestamp !== null &&
    new Date(item.timestamp).getTime() - new Date(prevTimestamp).getTime() >= GAP_MS;

  if (signalCount >= MAX_BATCH_SIGNALS || windowMs >= MAX_WINDOW_MS || gapExceeded) {
    void flush();
  } else {
    scheduleIdleFlush();
  }
}
