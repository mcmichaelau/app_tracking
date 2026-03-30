import { parse } from "csv-parse/sync";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { join } from "path";

// ─── Config ───────────────────────────────────────────────────────────────────

const CSV_PATH = join(import.meta.dir, "events_with_interpretations_10h.csv");
const PROMPT_PATH = join(import.meta.dir, "..", "prompts", "classify_task.md");
const OUTPUT_DIR = import.meta.dir;

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";

type ClassifierBackend = "openai" | "gemini" | "anthropic";

/** Set before runStrategy (from CLI / env). */
let classifierModel = DEFAULT_GEMINI_MODEL;
let classifierBackend: ClassifierBackend = "gemini";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CsvEvent {
  id: string;
  timestamp: string;
  app: string;
  event_type: string;
  interpretation: string;
}

interface TaskSpan {
  taskNumber: number;
  title: string;
  description: string;
  startTime: string;
  endTime: string;
  eventCount: number;
  interpretations: string[];
  llmCalls: number;
}

interface ClassifyResult {
  action: "CONTINUE" | "NEW_TASK";
  title?: string;
  description?: string;
}

type BatchStrategy = (events: CsvEvent[]) => CsvEvent[][];

/** If consecutive events are this far apart, the span until the next event is counted as idle (no LLM). */
const IDLE_GAP_MS = 10 * 60 * 1000;

export interface IdlePeriod {
  /** Last event before the gap (end of activity). */
  afterEventTime: string;
  /** Next event after the gap (activity resumes). */
  resumeEventTime: string;
  durationMin: number;
}

export function computeIdlePeriods(events: CsvEvent[]): IdlePeriod[] {
  if (events.length < 2) return [];
  const sorted = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const out: IdlePeriod[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const t0 = new Date(sorted[i].timestamp).getTime();
    const t1 = new Date(sorted[i + 1].timestamp).getTime();
    const gap = t1 - t0;
    if (gap >= IDLE_GAP_MS) {
      out.push({
        afterEventTime: sorted[i].timestamp,
        resumeEventTime: sorted[i + 1].timestamp,
        durationMin: Math.round(gap / 60000),
      });
    }
  }
  return out;
}

/** Reiterated in every user message (aligned with `prompts/classify_task_v3a.md` critical_rules). */
const USER_CRITICAL_RULES_REMINDER = `<system_reminder>
Critical rules (apply to every response):
- NEVER create a task shorter than 5 minutes. If you're tempted to output NEW_TASK for something that looks like it will last under 5 minutes, choose CONTINUE instead. Short interruptions (checking email, glancing at Slack, looking something up) belong in the surrounding task.
- NEVER output NEW_TASK with the same or very similar title as the current task. If the activity is still aligned with the current task's purpose, that is a CONTINUE — even if the specific sub-activity has shifted slightly. Use CONTINUE with an updated title/description if the focus has evolved.
- Meetings end when the user leaves. A meeting task covers the call itself. Once the user clicks "Leave call" and spends 2+ minutes doing something else, the meeting task is over.
- Dense activity ≠ task switches. When events arrive rapidly (many clicks per minute), the user is deep in a workflow. Rapid app switching between related tools (e.g. Supabase ↔ Chrome ↔ Cursor for the same investigation) is almost always CONTINUE.
- Be specific in titles. Use names, project names, and tool names from the interpretations.
- Descriptions = what happened, not predictions.
</system_reminder>
`;

// ─── CSV Parsing ──────────────────────────────────────────────────────────────

async function loadEvents(): Promise<CsvEvent[]> {
  const raw = await Bun.file(CSV_PATH).text();
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  return records
    .filter((r) => r.interpretation && r.interpretation.trim().length > 0)
    .map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      app: r.app,
      event_type: r.event_type,
      interpretation: r.interpretation.trim(),
    }));
}

// ─── Noise filtering ──────────────────────────────────────────────────────────

const NOISE_PATTERNS = [
  /^pressed .{1,3}$/,              // "pressed ↵", "pressed ⇥"
  /^pressed .+ in .+$/,            // "pressed ↵ in Cursor"
  /^typed in .+$/,                 // "typed in Google Chrome" (no content)
  /^scrolled in .+$/,              // "scrolled in Chrome"
];

function isNoise(interp: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(interp));
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// ─── Batching strategies ──────────────────────────────────────────────────────

/**
 * Strategy A: Fixed-size batches of N non-noise events.
 * Noise events are grouped with their batch but don't count toward the trigger.
 */
function fixedBatchStrategy(batchSize: number): BatchStrategy {
  return (events: CsvEvent[]) => {
    const batches: CsvEvent[][] = [];
    let current: CsvEvent[] = [];
    let signalCount = 0;

    for (const e of events) {
      current.push(e);
      if (!isNoise(e.interpretation)) signalCount++;
      if (signalCount >= batchSize) {
        batches.push(current);
        current = [];
        signalCount = 0;
      }
    }
    if (current.length > 0) batches.push(current);
    return batches;
  };
}

/**
 * Strategy B: Time-gap based. Cut a new batch whenever there's a gap > gapMs
 * between consecutive events, or when the batch duration exceeds maxWindowMs.
 */
function timeGapStrategy(gapMs: number, maxWindowMs: number): BatchStrategy {
  return (events: CsvEvent[]) => {
    const batches: CsvEvent[][] = [];
    let current: CsvEvent[] = [];
    let windowStart: number | null = null;

    for (let i = 0; i < events.length; i++) {
      const t = new Date(events[i].timestamp).getTime();
      if (windowStart === null) windowStart = t;

      if (current.length > 0) {
        const prev = new Date(events[i - 1].timestamp).getTime();
        const gap = t - prev;
        const windowDuration = t - windowStart;

        if (gap > gapMs || windowDuration > maxWindowMs) {
          batches.push(current);
          current = [];
          windowStart = t;
        }
      }
      current.push(events[i]);
    }
    if (current.length > 0) batches.push(current);
    return batches;
  };
}

/**
 * Strategy C: Hybrid — cut on time gap > gapMs, or max batch size, or sustained app switch.
 */
function hybridStrategy(gapMs: number, maxBatch: number, maxWindowMs: number): BatchStrategy {
  return (events: CsvEvent[]) => {
    const batches: CsvEvent[][] = [];
    let current: CsvEvent[] = [];
    let signalCount = 0;
    let windowStart: number | null = null;

    for (let i = 0; i < events.length; i++) {
      const t = new Date(events[i].timestamp).getTime();
      if (windowStart === null) windowStart = t;

      if (current.length > 0) {
        const prev = new Date(events[i - 1].timestamp).getTime();
        const gap = t - prev;
        const windowDuration = t - windowStart;

        if (gap > gapMs || signalCount >= maxBatch || windowDuration > maxWindowMs) {
          batches.push(current);
          current = [];
          signalCount = 0;
          windowStart = t;
        }
      }

      current.push(events[i]);
      if (!isNoise(events[i].interpretation)) signalCount++;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  };
}

// ─── LLM ──────────────────────────────────────────────────────────────────────

function applyClassifierModel(model: string): void {
  classifierModel = model.trim();
  if (classifierModel.startsWith("gpt-")) classifierBackend = "openai";
  else if (classifierModel.startsWith("claude-")) classifierBackend = "anthropic";
  else classifierBackend = "gemini";
}

async function classifyOpenAI(sysPrompt: string, userMsg: string, counters: RunCounters): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for OpenAI models (e.g. gpt-5.4-mini)");

  const payload: Record<string, unknown> = {
    model: classifierModel,
    messages: [
      { role: "system", content: sysPrompt },
      { role: "user", content: userMsg },
    ],
    max_completion_tokens: 512,
  };
  // GPT-5 family only allows default temperature (omit param).
  if (!/^gpt-5/i.test(classifierModel)) {
    payload.temperature = 0.2;
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number };
  };
  const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (data.usage?.prompt_tokens) counters.inputTokens += data.usage.prompt_tokens;
  return raw;
}

async function classifyAnthropic(sysPrompt: string, userMsg: string, counters: RunCounters): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for Claude models");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: classifierModel,
      max_tokens: 1024,
      system: sysPrompt,
      messages: [{ role: "user", content: userMsg }],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number };
  };
  let raw = "";
  for (const block of data.content ?? []) {
    if (block.type === "text" && block.text) raw += block.text;
  }
  raw = raw.trim();
  if (data.usage?.input_tokens) counters.inputTokens += data.usage.input_tokens;
  return raw;
}

async function classifyGemini(sysPrompt: string, userMsg: string, counters: RunCounters): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is required for Gemini models");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: classifierModel,
    systemInstruction: sysPrompt,
  });

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: userMsg }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
  });

  const raw = result.response.text().trim();
  const usage = result.response.usageMetadata;
  if (usage?.promptTokenCount) counters.inputTokens += usage.promptTokenCount;
  return raw;
}

const TASK_HISTORY_LIMIT = 50;

async function classify(
  sysPrompt: string,
  batchInterps: { time: string; text: string }[],
  currentTask: { title: string; description: string; startTime: string } | null,
  batchStartIso: string,
  recentTaskInterps: string[],
  counters: RunCounters
): Promise<ClassifyResult> {
  let userMsg = "";
  if (currentTask) {
    const startedAt = formatTime(currentTask.startTime);
    const durMs = new Date(batchStartIso).getTime() - new Date(currentTask.startTime).getTime();
    const durMin = Math.max(1, Math.round(durMs / 60000));
    userMsg += `Current task: "${currentTask.title}" (started ${startedAt}, running for ~${durMin} min) — ${currentTask.description}\n\n`;
    const tail = recentTaskInterps.slice(-TASK_HISTORY_LIMIT);
    if (tail.length > 0) {
      userMsg += `Last ${tail.length} interpreted events from current task:\n`;
      for (const line of tail) {
        userMsg += `${line}\n`;
      }
      userMsg += "\n";
    }
  } else {
    userMsg += "No current task.\n\n";
  }
  userMsg += "New activity to classify (chronological):\n";
  for (const item of batchInterps) {
    userMsg += `[${item.time}] ${item.text}\n`;
  }
  userMsg += "\n" + USER_CRITICAL_RULES_REMINDER;

  counters.llmCalls++;

  const raw =
    classifierBackend === "openai"
      ? await classifyOpenAI(sysPrompt, userMsg, counters)
      : classifierBackend === "anthropic"
        ? await classifyAnthropic(sysPrompt, userMsg, counters)
        : await classifyGemini(sysPrompt, userMsg, counters);

  const parsed = parseJson(raw);
  if (!parsed || !parsed.action) {
    return { action: "CONTINUE" };
  }
  return parsed as ClassifyResult;
}

function parseJson(raw: string): Record<string, unknown> | null {
  const tryParse = (s: string) => {
    try { return JSON.parse(s); } catch { return null; }
  };

  let result = tryParse(raw);
  if (result) return result;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    result = tryParse(fenced[1].trim());
    if (result) return result;
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    result = tryParse(raw.slice(start, end + 1));
    if (result) return result;
  }
  return null;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

interface RunCounters {
  llmCalls: number;
  inputTokens: number;
}

async function runStrategy(
  name: string,
  events: CsvEvent[],
  strategy: BatchStrategy,
  sysPrompt: string,
  counters: RunCounters
): Promise<TaskSpan[]> {
  const batches = strategy(events);
  const tasks: TaskSpan[] = [];
  let currentTask: { title: string; description: string } | null = null;
  let taskStart: string | null = null;
  let taskEventCount = 0;
  let taskInterps: string[] = [];
  let taskNumber = 0;
  let taskLlmCalls = 0;

  console.log(`\n▸ Running "${name}" — ${batches.length} batches from ${events.length} events`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (batch.length === 0) continue;

    const meaningful = batch
      .filter((e) => !isNoise(e.interpretation))
      .map((e) => ({ time: formatTime(e.timestamp), text: e.interpretation }));

    if (meaningful.length === 0) {
      taskEventCount += batch.length;
      continue;
    }

    const currentTaskCtx = currentTask && taskStart
      ? { ...currentTask, startTime: taskStart }
      : null;
    const result = await classify(sysPrompt, meaningful, currentTaskCtx, batch[0].timestamp, taskInterps, counters);
    taskLlmCalls++;

    if (result.action === "NEW_TASK" && result.title) {
      if (currentTask && taskStart) {
        tasks.push({
          taskNumber,
          title: currentTask.title,
          description: currentTask.description,
          startTime: taskStart,
          endTime: batch[0].timestamp,
          eventCount: taskEventCount,
          interpretations: taskInterps,
          llmCalls: taskLlmCalls,
        });
      }
      taskNumber++;
      currentTask = { title: result.title, description: result.description ?? "" };
      taskStart = batch[0].timestamp;
      taskEventCount = batch.length;
      taskInterps = meaningful.map((m) => `[${m.time}] ${m.text}`);
      taskLlmCalls = 1;
    } else {
      if (!currentTask) {
        taskNumber++;
        currentTask = {
          title: result.title ?? "Untitled",
          description: result.description ?? "",
        };
        taskStart = batch[0].timestamp;
        taskEventCount = batch.length;
        taskInterps = meaningful.map((m) => `[${m.time}] ${m.text}`);
        taskLlmCalls = 1;
      } else {
        taskEventCount += batch.length;
        taskInterps.push(...meaningful.map((m) => `[${m.time}] ${m.text}`));
        if (result.title) currentTask.title = result.title;
        if (result.description) currentTask.description = result.description;
      }
    }

    if ((i + 1) % 20 === 0) {
      console.log(`  batch ${i + 1}/${batches.length}  |  tasks so far: ${taskNumber}  |  LLM calls: ${counters.llmCalls}`);
    }
  }

  if (currentTask && taskStart) {
    const lastEvent = events[events.length - 1];
    tasks.push({
      taskNumber,
      title: currentTask.title,
      description: currentTask.description,
      startTime: taskStart,
      endTime: lastEvent.timestamp,
      eventCount: taskEventCount,
      interpretations: taskInterps,
      llmCalls: taskLlmCalls,
    });
  }

  return tasks;
}

// ─── Output ───────────────────────────────────────────────────────────────────

function writeResults(
  name: string,
  tasks: TaskSpan[],
  totalEvents: number,
  modelLabel: string,
  promptLabel: string,
  counters: RunCounters,
  idlePeriods: IdlePeriod[]
): string {
  const lines: string[] = [];
  lines.push(`# Task Classification Results: ${name}`);
  lines.push(`Model: \`${modelLabel}\`  |  Prompt: \`${promptLabel}\``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  const totalIdleMin = idlePeriods.reduce((s, p) => s + p.durationMin, 0);
  lines.push(`Total events: ${totalEvents}  |  Tasks identified: ${tasks.length}  |  LLM calls: ${counters.llmCalls}`);
  lines.push(
    `Idle periods (≥${IDLE_GAP_MS / 60000} min gap between events): ${idlePeriods.length}  |  Total idle: ~${totalIdleMin} min`
  );
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("| # | Title | Start | End | Duration | Events |");
  lines.push("|---|-------|-------|-----|----------|--------|");

  for (const t of tasks) {
    const start = formatTime(t.startTime);
    const end = formatTime(t.endTime);
    const durMs = new Date(t.endTime).getTime() - new Date(t.startTime).getTime();
    const durMin = Math.round(durMs / 60000);
    lines.push(`| ${t.taskNumber} | ${t.title} | ${start} | ${end} | ${durMin}m | ${t.eventCount} |`);
  }

  lines.push("");
  lines.push("## Idle time (hard-coded, not sent to LLM)");
  lines.push("");
  lines.push(
    `Gaps of **≥${IDLE_GAP_MS / 60000} minutes** between consecutive events (by timestamp). Idle runs from after the last event until the next event.`
  );
  lines.push("");
  if (idlePeriods.length === 0) {
    lines.push("*No idle periods in this range.*");
    lines.push("");
  } else {
    lines.push("| # | After last event | Next event | Idle (min) |");
    lines.push("|---|------------------|------------|------------|");
    idlePeriods.forEach((p, i) => {
      lines.push(
        `| ${i + 1} | ${formatTime(p.afterEventTime)} | ${formatTime(p.resumeEventTime)} | ${p.durationMin} |`
      );
    });
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## Detail");
  lines.push("");

  for (const t of tasks) {
    const durMs = new Date(t.endTime).getTime() - new Date(t.startTime).getTime();
    const durMin = Math.round(durMs / 60000);

    lines.push(`### Task ${t.taskNumber}: ${t.title}`);
    lines.push(`**${formatTime(t.startTime)} – ${formatTime(t.endTime)}** (${durMin} min, ${t.eventCount} events)`);
    lines.push("");
    lines.push(`> ${t.description}`);
    lines.push("");

    // Show a sample of interpretations (first 10 + last 5 if large)
    const sample = t.interpretations.length <= 20
      ? t.interpretations
      : [...t.interpretations.slice(0, 10), `  ... ${t.interpretations.length - 15} more ...`, ...t.interpretations.slice(-5)];

    for (const s of sample) {
      lines.push(`- ${s}`);
    }
    lines.push("");
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const modelSlug = modelLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const promptSlug = promptLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const outPath = join(OUTPUT_DIR, `task_results_${promptSlug}_${modelSlug}.md`);
  Bun.write(outPath, lines.join("\n"));
  console.log(`  → wrote ${outPath}`);
  return outPath;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const ALL_PROMPTS = [
  "classify_task_v1",
  "classify_task_v2",
  "classify_task_v3",
  "classify_task_v3a",
  "classify_task_v3b",
  "classify_task_v3c",
];

const events = await loadEvents();
console.log(`Loaded ${events.length} events from CSV`);
console.log(`Time range: ${events[0]?.timestamp} → ${events[events.length - 1]?.timestamp}`);

const defaultStrategy: { name: string; fn: BatchStrategy } = {
  name: "Hybrid-5min-50ev-5min",
  fn: hybridStrategy(5 * 60_000, 50, 5 * 60_000),
};

// CLI: bun run testing/test_task_classification.ts [--limit N] [--model MODEL] [--prompt v1|v2|v3|all]
let eventLimit: number | undefined;
let modelArg: string | undefined;
let promptArg: string | undefined;

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--limit" && process.argv[i + 1]) {
    eventLimit = parseInt(process.argv[++i], 10);
  } else if (a === "--model" && process.argv[i + 1]) {
    modelArg = process.argv[++i];
  } else if (a === "--prompt" && process.argv[i + 1]) {
    promptArg = process.argv[++i];
  }
}

const resolvedModel =
  modelArg?.trim() ||
  process.env.TASK_CLASSIFIER_MODEL?.trim() ||
  DEFAULT_GEMINI_MODEL;
applyClassifierModel(resolvedModel);
console.log(`Classifier: ${classifierModel} (${classifierBackend})`);

const sliced = eventLimit ? events.slice(0, eventLimit) : events;
if (eventLimit) console.log(`Using first ${sliced.length} events (--limit ${eventLimit})`);

// Resolve which prompts to run (comma-separated, e.g. --prompt v3a,v3b,v3c)
const promptNames: string[] = [];
if (!promptArg || promptArg === "all") {
  promptNames.push(...ALL_PROMPTS);
} else {
  const tokens = promptArg.split(",").map((t) => t.trim());
  for (const token of tokens) {
    const matches = ALL_PROMPTS.filter((p) => p.endsWith(token) || p.includes(token));
    if (matches.length === 0) {
      console.error(`No prompt matching "${token}". Available: ${ALL_PROMPTS.join(", ")}`);
      process.exit(1);
    }
    for (const m of matches) {
      if (!promptNames.includes(m)) promptNames.push(m);
    }
  }
}

async function runOnePrompt(promptName: string): Promise<void> {
  const promptPath = join(PROMPTS_DIR, `${promptName}.md`);
  const sysPrompt = await Bun.file(promptPath).text();
  const counters: RunCounters = { llmCalls: 0, inputTokens: 0 };
  const label = `${defaultStrategy.name} · ${promptName}`;
  const idlePeriods = computeIdlePeriods(sliced);
  const tasks = await runStrategy(label, sliced, defaultStrategy.fn, sysPrompt, counters);
  writeResults(label, tasks, sliced.length, classifierModel, promptName, counters, idlePeriods);
  console.log(
    `  [${promptName}] LLM calls: ${counters.llmCalls}  |  Input tokens: ~${counters.inputTokens.toLocaleString()}  |  idle periods: ${idlePeriods.length}`
  );
}

console.log(`\nRunning ${promptNames.length} prompt(s) in parallel: ${promptNames.join(", ")}`);
await Promise.all(promptNames.map(runOnePrompt));
