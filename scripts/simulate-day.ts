/**
 * simulate-day.ts
 *
 * Copies today's interpreted events into an in-memory SQLite DB, then
 * simulates the retask agent running every 30 minutes from the first event
 * to the last, exactly as it would have run live.
 *
 * Outputs:
 *   scripts/simulate-day.html   — self-contained Insights-style visualization
 *   scripts/simulate-day.json   — raw tasks + events data
 *
 * Usage:
 *   bun run scripts/simulate-day.ts [--date=YYYY-MM-DD]
 */

import Anthropic from "@anthropic-ai/sdk";
import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { writeFileSync } from "node:fs";

// ── Config ────────────────────────────────────────────────────────────────────

const MODEL = "claude-haiku-4-5-20251001";
const EVENTS_WINDOW_MINUTES = 35;
const MAX_TURNS = 20;

const DB_PATH = join(homedir(), "Library", "Application Support", "ActivityTracker", "tracker.db");

const dateArg     = process.argv.find(a => a.startsWith("--date="))?.slice(7);
const intervalArg = process.argv.find(a => a.startsWith("--interval="))?.slice(11);
const TARGET_DATE     = dateArg ?? new Date().toISOString().slice(0, 10);
const INTERVAL_MINUTES = intervalArg ? parseInt(intervalArg, 10) : 30;

// ── API key ───────────────────────────────────────────────────────────────────

async function resolveApiKey(): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const text = await Bun.file(
      join(homedir(), "Library", "Application Support", "ActivityTracker", "config.json")
    ).text();
    const cfg = JSON.parse(text);
    const key: string | undefined = cfg.anthropic_api_key ?? cfg.ANTHROPIC_API_KEY;
    if (key) return key;
  } catch { /* ignore */ }
  console.error("ANTHROPIC_API_KEY not found in env or config.json");
  process.exit(1);
}

// ── Load events from real DB ──────────────────────────────────────────────────

interface RawEventRow {
  id: number;
  timestamp: string;
  app: string;
  event_type: string;
  detail: string | null;
  interpretation: string;
}

function loadTodayEvents(): RawEventRow[] {
  const realDb = new Database(DB_PATH, { readonly: true });
  // Use UTC date boundaries that cover the local calendar day
  const since = `${TARGET_DATE}T00:00:00.000Z`;
  const until = `${TARGET_DATE}T23:59:59.999Z`;
  const rows = realDb.prepare(`
    SELECT id, timestamp, app, event_type, detail, interpretation
    FROM raw_events
    WHERE timestamp >= ? AND timestamp <= ?
      AND interpretation IS NOT NULL AND interpretation != ''
    ORDER BY id ASC
  `).all(since, until) as RawEventRow[];
  realDb.close();
  return rows;
}

// ── Build in-memory simulation DB ─────────────────────────────────────────────

function buildSimDb(events: RawEventRow[]): Database {
  const sim = new Database(":memory:");
  sim.run("PRAGMA journal_mode = WAL");
  sim.run(`
    CREATE TABLE raw_events (
      id             INTEGER PRIMARY KEY,
      timestamp      TEXT NOT NULL,
      app            TEXT NOT NULL,
      event_type     TEXT NOT NULL,
      detail         TEXT,
      interpretation TEXT,
      task_id        INTEGER
    )
  `);
  sim.run(`
    CREATE TABLE tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT NOT NULL,
      category    TEXT
    )
  `);

  const insert = sim.prepare(
    "INSERT INTO raw_events (id, timestamp, app, event_type, detail, interpretation) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertAll = sim.transaction((rows: RawEventRow[]) => {
    for (const r of rows) insert.run(r.id, r.timestamp, r.app, r.event_type, r.detail, r.interpretation);
  });
  insertAll(events);
  return sim;
}

// ── Tool handlers (same logic as retask.ts, but use sim DB + simulated time) ──

function sanitize(s: string): string {
  return s.replace(/[\uD800-\uDFFF]/g, "?").replace(/[\x00-\x08\x0B-\x1F\x7F]/g, " ");
}

function makeTools(sim: Database, simulatedNowMs: number): {
  tools: Anthropic.Tool[];
  dispatch: (name: string, input: Record<string, unknown>) => string;
} {
  const TOOLS: Anthropic.Tool[] = [
    {
      name: "query_events",
      description:
        "Read recent activity events from the database. Returns each event's id, timestamp, app, event_type, interpretation, and task_id (null = unassigned). Focus on events where task_id is null — those need grouping.",
      input_schema: {
        type: "object" as const,
        properties: {
          minutes: { type: "number", description: `How many minutes back to look (max ${EVENTS_WINDOW_MINUTES})` },
        },
        required: ["minutes"],
      },
    },
    {
      name: "query_tasks",
      description: "Read recent tasks from the database, with their event counts and time spans.",
      input_schema: {
        type: "object" as const,
        properties: { limit: { type: "number", description: "Number of most-recent tasks to return (max 20)" } },
        required: ["limit"],
      },
    },
    {
      name: "create_task",
      description: "Create a new task and assign the given events to it.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Short goal statement (6-12 words)." },
          description: { type: "string", description: "1-2 sentence description of what the user was trying to accomplish." },
          category: { type: "string", enum: ["Productivity", "Leisure", "Admin", "Learning", "Communication"] },
          event_ids: { type: "array", items: { type: "number" }, description: "IDs of the events to assign to this task." },
        },
        required: ["title", "description", "category", "event_ids"],
      },
    },
    {
      name: "assign_events",
      description: "Assign unassigned events to an EXISTING task.",
      input_schema: {
        type: "object" as const,
        properties: {
          task_id: { type: "number" },
          event_ids: { type: "array", items: { type: "number" } },
        },
        required: ["task_id", "event_ids"],
      },
    },
    {
      name: "update_task",
      description: "Update the title and/or description of any existing task.",
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

  function handleQueryEvents(minutes: number): string {
    const capped = Math.min(minutes, EVENTS_WINDOW_MINUTES);
    const since = new Date(simulatedNowMs - capped * 60 * 1000).toISOString();
    const until = new Date(simulatedNowMs).toISOString();
    const rows = sim.prepare(`
      SELECT id, timestamp, app, event_type,
             COALESCE(interpretation, '') as interpretation,
             task_id
      FROM raw_events
      WHERE timestamp >= ? AND timestamp <= ?
        AND interpretation IS NOT NULL AND interpretation != ''
      ORDER BY id ASC
    `).all(since, until) as Array<{
      id: number; timestamp: string; app: string; event_type: string;
      interpretation: string; task_id: number | null;
    }>;
    if (rows.length === 0) return "No events found in this window.";
    const lines = rows.map(r => {
      const time = r.timestamp.slice(11, 16);
      const interp = sanitize(r.interpretation).slice(0, 100);
      const assigned = r.task_id != null ? `[task:${r.task_id}]` : "[unassigned]";
      return `id=${r.id} ${time} ${assigned} ${r.app} | ${r.event_type} | ${interp}`;
    });
    const unassigned = rows.filter(r => r.task_id === null).length;
    return `${rows.length} events (${unassigned} unassigned):\n${lines.join("\n")}`;
  }

  function handleQueryTasks(limit: number): string {
    const capped = Math.min(limit, 20);
    const rows = sim.prepare(`
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
    return rows.map(r => {
      const start = r.first_event?.slice(11, 16) ?? "?";
      const end = r.last_event?.slice(11, 16) ?? "?";
      return `task_id=${r.id} [${start}–${end}] (${r.event_count} events) ${r.title}`;
    }).join("\n");
  }

  function handleCreateTask(input: {
    title: string; description: string; category: string; event_ids: number[];
  }): string {
    const validCategories = ["Productivity", "Leisure", "Admin", "Learning", "Communication"];
    const category = validCategories.includes(input.category) ? input.category : "Productivity";
    if (!input.event_ids?.length) return "Error: event_ids must be a non-empty array.";
    const result = sim.prepare(
      "INSERT INTO tasks (title, description, category) VALUES (?, ?, ?)"
    ).run(sanitize(input.title), sanitize(input.description), category);
    const taskId = Number(result.lastInsertRowid);
    const placeholders = input.event_ids.map(() => "?").join(",");
    sim.prepare(`UPDATE raw_events SET task_id = ? WHERE id IN (${placeholders})`).run(taskId, ...input.event_ids);
    return `Created task_id=${taskId} "${input.title}" — assigned ${input.event_ids.length} events.`;
  }

  function handleAssignEvents(input: { task_id: number; event_ids: number[] }): string {
    const row = sim.prepare("SELECT id, title FROM tasks WHERE id = ?").get(input.task_id) as { id: number; title: string } | undefined;
    if (!row) return `Error: task_id=${input.task_id} not found.`;
    if (!input.event_ids?.length) return "Error: event_ids must be a non-empty array.";
    const placeholders = input.event_ids.map(() => "?").join(",");
    sim.prepare(`UPDATE raw_events SET task_id = ? WHERE id IN (${placeholders})`).run(input.task_id, ...input.event_ids);
    return `Assigned ${input.event_ids.length} events to task_id=${input.task_id} "${row.title}".`;
  }

  function handleUpdateTask(input: { task_id: number; title?: string; description?: string }): string {
    const row = sim.prepare("SELECT id FROM tasks WHERE id = ?").get(input.task_id) as { id: number } | undefined;
    if (!row) return `Error: task_id=${input.task_id} not found.`;
    if (input.title) sim.prepare("UPDATE tasks SET title = ? WHERE id = ?").run(sanitize(input.title), input.task_id);
    if (input.description) sim.prepare("UPDATE tasks SET description = ? WHERE id = ?").run(sanitize(input.description), input.task_id);
    return `Updated task_id=${input.task_id}.`;
  }

  function dispatch(name: string, input: Record<string, unknown>): string {
    try {
      switch (name) {
        case "query_events":  return handleQueryEvents(Number(input.minutes ?? EVENTS_WINDOW_MINUTES));
        case "query_tasks":   return handleQueryTasks(Number(input.limit ?? 20));
        case "create_task":   return handleCreateTask(input as any);
        case "assign_events": return handleAssignEvents(input as any);
        case "update_task":   return handleUpdateTask(input as any);
        default: return `Unknown tool: ${name}`;
      }
    } catch (e) {
      return `Tool error: ${(e as Error).message}`;
    }
  }

  return { tools: TOOLS, dispatch };
}

// ── System prompt (identical to retask.ts) ────────────────────────────────────

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

// ── Run one agent window ───────────────────────────────────────────────────────

async function runWindow(
  client: Anthropic,
  sim: Database,
  simulatedNowMs: number,
  windowLabel: string
): Promise<void> {
  const since = new Date(simulatedNowMs - EVENTS_WINDOW_MINUTES * 60 * 1000).toISOString();
  const until = new Date(simulatedNowMs).toISOString();

  const unassigned = (sim.prepare(`
    SELECT COUNT(*) as n FROM raw_events
    WHERE task_id IS NULL AND interpretation IS NOT NULL AND interpretation != ''
      AND timestamp >= ? AND timestamp <= ?
  `).get(since, until) as { n: number }).n;

  if (unassigned === 0) {
    console.log(`  ${windowLabel}: no unassigned events — skip`);
    return;
  }

  console.log(`  ${windowLabel}: ${unassigned} unassigned events`);

  const { tools, dispatch } = makeTools(sim, simulatedNowMs);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "Group the unassigned activity events from the last 35 minutes into tasks." },
  ];

  let turns = 0;
  while (turns < MAX_TURNS) {
    turns++;
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") break;
    if (response.stop_reason !== "tool_use") break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const result = dispatch(block.name, block.input as Record<string, unknown>);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
    }
    if (toolResults.length === 0) break;
    messages.push({ role: "user", content: toolResults });
  }
}

// ── HTML generation ───────────────────────────────────────────────────────────

interface TaskRow {
  id: number;
  title: string;
  description: string;
  category: string | null;
}

interface EventOut {
  event_id: number;
  timestamp: string;
  app: string;
  event_type: string;
  interpretation: string | null;
  task_id: number;
  task_title: string;
  task_description: string;
  category: string | null;
}

function generateHtml(tasks: TaskRow[], events: EventOut[], date: string, intervalMin: number): string {
  const dataJson = JSON.stringify({ tasks, events, date });
  const intervalLabel = `${intervalMin}-min intervals`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Activity Simulation (${intervalLabel}) — ${date}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #1c1c1e; --bg2: #2c2c2e; --bg3: #3a3a3c;
    --border: rgba(255,255,255,0.1); --text: #f2f2f7;
    --text2: rgba(242,242,247,0.65); --text3: rgba(242,242,247,0.35);
    --accent: #0a84ff;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 24px; }
  h1 { font-size: 14px; font-weight: 600; color: var(--text2); margin-bottom: 4px; letter-spacing: 0.02em; }
  .subtitle { font-size: 10px; color: var(--text3); margin-bottom: 20px; }
  .layout { display: flex; gap: 16px; align-items: flex-start; }
  .left { flex: 1; min-width: 0; border: 0.5px solid var(--border); border-radius: 8px; background: var(--bg); padding: 16px; }
  .right { width: 340px; flex-shrink: 0; border: 0.5px solid var(--border); border-radius: 8px; background: var(--bg); padding: 16px; max-height: calc(100vh - 80px); overflow-y: auto; }
  .chart-area { display: flex; align-items: flex-end; height: 260px; gap: 2px; padding: 0 1px; }
  .bar-col { flex: 1; height: 100%; display: flex; align-items: flex-end; cursor: pointer; transition: opacity 0.15s; }
  .bar-stack { width: 100%; display: flex; flex-direction: column-reverse; transition: height 0.2s ease; }
  .seg { flex-shrink: 0; min-height: 1px; transition: opacity 0.1s, filter 0.1s; cursor: pointer; }
  .x-axis { display: flex; gap: 2px; padding: 6px 1px 0; border-top: 1px solid var(--border); margin-bottom: 16px; }
  .x-label { flex: 1; text-align: center; font-size: 9px; color: var(--text3); user-select: none; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 18px; justify-content: center; margin-top: 4px; }
  .legend-item { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--text2); }
  .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .tooltip { position: fixed; background: var(--bg2); border: 0.5px solid var(--border); border-radius: 6px; padding: 8px 12px; z-index: 200; pointer-events: none; box-shadow: 0 6px 20px rgba(0,0,0,0.5); max-width: 280px; display: none; }
  .tooltip-title { font-size: 10px; font-weight: 600; color: var(--text); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tooltip-meta { display: flex; align-items: center; gap: 5px; font-size: 9px; color: var(--text2); }
  .detail { background: var(--bg2); border: 0.5px solid var(--border); border-radius: 8px; margin-bottom: 16px; overflow: hidden; display: none; }
  .detail-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 0.5px solid var(--border); }
  .detail-title { font-size: 11px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail-cat { font-size: 9px; color: var(--text3); flex-shrink: 0; }
  .detail-close { margin-left: 4px; background: transparent; border: none; color: var(--text3); font-size: 12px; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
  .detail-desc { padding: 10px 14px; font-size: 10px; line-height: 1.5; color: var(--text2); white-space: pre-wrap; word-break: break-word; border-bottom: 0.5px solid var(--border); }
  .detail-events { max-height: 260px; overflow-y: auto; padding: 6px 14px; }
  .ev-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 9px; }
  .ev-time { color: var(--text3); width: 56px; flex-shrink: 0; }
  .ev-type { width: 55px; flex-shrink: 0; }
  .ev-app { color: var(--text2); width: 80px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ev-detail { color: var(--text3); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-list-title { font-size: 10px; font-weight: 600; color: var(--text2); margin-bottom: 10px; letter-spacing: 0.04em; text-transform: uppercase; }
  .task-item { padding: 8px 10px; border-radius: 6px; margin-bottom: 4px; cursor: pointer; border: 0.5px solid transparent; transition: border-color 0.1s; }
  .task-item:hover { border-color: var(--border); background: var(--bg2); }
  .task-item.active { border-color: var(--accent); background: var(--bg2); }
  .task-item-title { font-size: 10px; font-weight: 500; color: var(--text); margin-bottom: 3px; }
  .task-item-meta { display: flex; align-items: center; gap: 6px; font-size: 9px; color: var(--text3); }
  .stats { display: flex; gap: 24px; margin-bottom: 16px; }
  .stat { font-size: 11px; color: var(--text2); }
  .stat b { color: var(--text); font-weight: 600; }
</style>
</head>
<body>
<h1>Activity Simulation — ${date}</h1>
<p class="subtitle">${intervalLabel}</p>
<div class="layout">
  <div class="left">
    <div id="stats" class="stats"></div>
    <div id="detail" class="detail">
      <div class="detail-header">
        <div class="dot" id="detail-dot"></div>
        <span class="detail-title" id="detail-title"></span>
        <span class="detail-cat" id="detail-cat"></span>
        <button class="detail-close" onclick="closeDetail()">✕</button>
      </div>
      <div class="detail-desc" id="detail-desc"></div>
      <div class="detail-events" id="detail-events"></div>
    </div>
    <div id="chart" class="chart-area"></div>
    <div id="xaxis" class="x-axis"></div>
    <div id="legend" class="legend"></div>
  </div>
  <div class="right">
    <div class="task-list-title">Tasks</div>
    <div id="task-list"></div>
  </div>
</div>
<div class="tooltip" id="tooltip">
  <div class="tooltip-title" id="tt-title"></div>
  <div class="tooltip-meta">
    <div class="dot" id="tt-dot"></div>
    <span id="tt-cat"></span>
    <span style="margin-left:auto;color:var(--text3)" id="tt-time"></span>
  </div>
</div>

<script>
const DATA = ${dataJson};

const CATEGORY_COLORS = {
  Productivity: "#0a84ff",
  Leisure: "#30d158",
  Admin: "#ff9f0a",
  Learning: "#bf5af2",
  Communication: "#32ade6",
  Uncategorized: "rgba(255,255,255,0.12)",
};
const EVENT_TYPE_COLORS = {
  CLICK: "#0a84ff", TYPING: "#30d158", SCROLL: "#98989d",
  COPY: "#ff9f0a", PASTE: "#ff9f0a", SHORTCUT: "#bf5af2",
  "APP SWITCH": "rgba(255,255,255,0.28)", KEY: "#32ade6",
};
const CAT_ORDER = ["Productivity","Leisure","Admin","Learning","Communication","Uncategorized"];

const { tasks, events, date } = DATA;

// Build task map
const taskMap = new Map(tasks.map(t => [t.id, t]));

// Build 24 hourly buckets
function buildBuckets() {
  const buckets = Array.from({length: 24}, (_, h) => {
    const d = new Date(date + "T00:00:00.000Z");
    d.setUTCHours(h);
    return { hour: h, startMs: d.getTime(), endMs: d.getTime() + 3600000, tasks: new Map(), total: 0 };
  });
  for (const ev of events) {
    const ts = new Date(ev.timestamp).getTime();
    const h = new Date(ev.timestamp).getUTCHours();
    const b = buckets[h];
    if (!b) continue;
    const existing = b.tasks.get(ev.task_id);
    if (existing) { existing.count++; }
    else { b.tasks.set(ev.task_id, { taskId: ev.task_id, title: ev.task_title, description: ev.task_description, category: ev.category || "Uncategorized", count: 1 }); }
    b.total++;
  }
  return buckets.map(b => ({
    ...b,
    tasks: Array.from(b.tasks.values()).sort((a,z) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(z.category) || a.taskId - z.taskId)
  }));
}

const buckets = buildBuckets();
const maxTotal = Math.max(...buckets.map(b => b.total), 1);

// Sort tasks by first event for the task list
const taskFirstEvent = new Map();
for (const ev of events) {
  if (!taskFirstEvent.has(ev.task_id) || ev.timestamp < taskFirstEvent.get(ev.task_id)) {
    taskFirstEvent.set(ev.task_id, ev.timestamp);
  }
}
const sortedTasks = [...tasks].sort((a, b) => (taskFirstEvent.get(a.id) ?? "") < (taskFirstEvent.get(b.id) ?? "") ? -1 : 1);

// State
let hoveredTaskId = null;
let selectedTaskId = null;
let selectedBarIndex = null;

function formatTime(iso) {
  const d = new Date(iso);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2,"0");
  const ampm = h >= 12 ? "PM" : "AM";
  return \`\${h%12||12}:\${m} \${ampm}\`;
}

function renderChart() {
  const chart = document.getElementById("chart");
  const xaxis = document.getElementById("xaxis");
  chart.innerHTML = "";
  xaxis.innerHTML = "";

  buckets.forEach((bucket, i) => {
    const h = bucket.hour % 12 || 12;
    const ampm = bucket.hour < 12 ? "a" : "p";
    const label = bucket.hour === 0 ? "12a" : bucket.hour === 12 ? "12p" : h + ampm;

    const barHeight = (bucket.total / maxTotal) * 100;
    const barHasHovered = hoveredTaskId != null && bucket.tasks.some(t => t.taskId === hoveredTaskId);
    const isSelected = selectedBarIndex === i;

    let colOpacity = 1;
    if (selectedTaskId != null && !bucket.tasks.some(t => t.taskId === selectedTaskId)) colOpacity = 0.35;
    else if (hoveredTaskId != null && !barHasHovered) colOpacity = 0.35;

    const col = document.createElement("div");
    col.className = "bar-col";
    col.style.opacity = colOpacity;

    const stack = document.createElement("div");
    stack.className = "bar-stack";
    stack.style.height = barHeight + "%";

    bucket.tasks.forEach((task, ti) => {
      const pct = (task.count / bucket.total) * 100;
      const isLast = ti === bucket.tasks.length - 1;
      const isHov = hoveredTaskId === task.taskId;
      const isSel = selectedTaskId === task.taskId;
      const prevCat = ti > 0 ? bucket.tasks[ti-1].category : null;

      let segOpacity = 1;
      if (hoveredTaskId != null && barHasHovered && !isHov) segOpacity = 0.35;

      const seg = document.createElement("div");
      seg.className = "seg";
      seg.style.height = pct + "%";
      seg.style.background = CATEGORY_COLORS[task.category] || CATEGORY_COLORS.Uncategorized;
      if (isLast) seg.style.borderRadius = "2px 2px 0 0";
      if (prevCat === task.category) seg.style.borderTop = "0.5px solid rgba(0,0,0,0.25)";
      seg.style.opacity = segOpacity;
      if (isSel) seg.style.filter = "brightness(1.4)";

      seg.addEventListener("mouseenter", e => {
        hoveredTaskId = task.taskId;
        showTooltip(task, e.clientX, e.clientY);
        renderChart();
      });
      seg.addEventListener("mousemove", e => moveTooltip(e.clientX, e.clientY));
      seg.addEventListener("mouseleave", () => {
        hoveredTaskId = null;
        hideTooltip();
        renderChart();
      });
      seg.addEventListener("click", () => {
        if (selectedTaskId === task.taskId && selectedBarIndex === i) {
          selectedTaskId = null; selectedBarIndex = null; closeDetail();
        } else {
          selectedTaskId = task.taskId; selectedBarIndex = i;
          showDetail(task.taskId, i);
        }
        renderChart();
        updateTaskList();
      });

      stack.appendChild(seg);
    });

    col.appendChild(stack);
    chart.appendChild(col);

    const xl = document.createElement("div");
    xl.className = "x-label";
    xl.textContent = bucket.hour % 3 === 0 ? label : "";
    xaxis.appendChild(xl);
  });
}

function showTooltip(task, x, y) {
  const tt = document.getElementById("tooltip");
  document.getElementById("tt-title").textContent = task.title;
  document.getElementById("tt-dot").style.background = CATEGORY_COLORS[task.category] || CATEGORY_COLORS.Uncategorized;
  document.getElementById("tt-cat").textContent = task.category;
  // Count events for this task
  const evCount = events.filter(e => e.task_id === task.taskId).length;
  document.getElementById("tt-time").textContent = evCount + " events";
  tt.style.left = Math.min(x + 12, window.innerWidth - 240) + "px";
  tt.style.top = (y - 8) + "px";
  tt.style.display = "block";
}
function moveTooltip(x, y) {
  const tt = document.getElementById("tooltip");
  tt.style.left = Math.min(x + 12, window.innerWidth - 240) + "px";
  tt.style.top = (y - 8) + "px";
}
function hideTooltip() { document.getElementById("tooltip").style.display = "none"; }

function showDetail(taskId, barIndex) {
  const task = taskMap.get(taskId);
  if (!task) return;
  const cat = task.category || "Uncategorized";
  document.getElementById("detail").style.display = "block";
  document.getElementById("detail-dot").style.background = CATEGORY_COLORS[cat] || CATEGORY_COLORS.Uncategorized;
  document.getElementById("detail-title").textContent = task.title;
  document.getElementById("detail-cat").textContent = cat;
  document.getElementById("detail-desc").textContent = task.description || "—";

  const bucket = buckets[barIndex];
  const matching = events.filter(ev => {
    const ts = new Date(ev.timestamp).getTime();
    return ev.task_id === taskId && ts >= bucket.startMs && ts < bucket.endMs;
  });

  const container = document.getElementById("detail-events");
  container.innerHTML = "";
  for (const ev of matching) {
    const row = document.createElement("div");
    row.className = "ev-row";
    row.innerHTML = \`
      <span class="ev-time">\${formatTime(ev.timestamp)}</span>
      <span class="ev-type" style="color:\${EVENT_TYPE_COLORS[ev.event_type]||'var(--text3)'}">\${ev.event_type.toLowerCase()}</span>
      <span class="ev-app">\${ev.app}</span>
      <span class="ev-detail">\${ev.interpretation || "—"}</span>
    \`;
    container.appendChild(row);
  }
}

function closeDetail() {
  document.getElementById("detail").style.display = "none";
  selectedTaskId = null; selectedBarIndex = null;
  renderChart(); updateTaskList();
}

function renderLegend() {
  const counts = {};
  for (const ev of events) { const c = ev.category||"Uncategorized"; counts[c] = (counts[c]||0)+1; }
  const legend = document.getElementById("legend");
  legend.innerHTML = "";
  for (const cat of CAT_ORDER) {
    if (!counts[cat]) continue;
    const pct = Math.round(counts[cat] / events.length * 100);
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = \`<div class="dot" style="background:\${CATEGORY_COLORS[cat]}"></div><span>\${cat}</span><span style="color:var(--text3);margin-left:2px">\${pct}%</span>\`;
    legend.appendChild(item);
  }
}

function renderStats() {
  const assignedEvents = events.length;
  const totalEvents = DATA.events.length; // same
  document.getElementById("stats").innerHTML = \`
    <div class="stat"><b>\${tasks.length}</b> tasks</div>
    <div class="stat"><b>\${assignedEvents}</b> events assigned</div>
    <div class="stat"><b>\${date}</b></div>
  \`;
}

function updateTaskList() {
  const list = document.getElementById("task-list");
  list.innerHTML = "";
  for (const task of sortedTasks) {
    const cat = task.category || "Uncategorized";
    const evCount = events.filter(e => e.task_id === task.id).length;
    const firstTs = taskFirstEvent.get(task.id);
    const item = document.createElement("div");
    item.className = "task-item" + (selectedTaskId === task.id ? " active" : "");
    item.innerHTML = \`
      <div class="task-item-title">\${task.title}</div>
      <div class="task-item-meta">
        <div class="dot" style="background:\${CATEGORY_COLORS[cat]}"></div>
        <span>\${cat}</span>
        <span style="margin-left:auto">\${evCount} events</span>
        \${firstTs ? '<span>' + formatTime(firstTs) + '</span>' : ''}
      </div>
    \`;
    item.addEventListener("click", () => {
      if (selectedTaskId === task.id) {
        selectedTaskId = null; selectedBarIndex = null; closeDetail();
      } else {
        // Find the bar with the most events for this task
        let bestBar = 0, bestCount = 0;
        buckets.forEach((b, i) => {
          const t = b.tasks.find(t => t.taskId === task.id);
          if (t && t.count > bestCount) { bestCount = t.count; bestBar = i; }
        });
        selectedTaskId = task.id; selectedBarIndex = bestBar;
        showDetail(task.id, bestBar);
        renderChart();
        updateTaskList();
      }
    });
    list.appendChild(item);
  }
}

renderStats();
renderChart();
renderLegend();
updateTaskList();
</script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`simulate-day: loading events for ${TARGET_DATE}…`);
  const events = loadTodayEvents();
  if (events.length === 0) {
    console.error(`No interpreted events found for ${TARGET_DATE}`);
    process.exit(1);
  }
  console.log(`simulate-day: ${events.length} events loaded`);

  const sim = buildSimDb(events);

  const firstMs = Math.min(...events.map(e => new Date(e.timestamp).getTime()));
  const lastMs  = Math.max(...events.map(e => new Date(e.timestamp).getTime()));

  // Simulate windows starting at firstMs + 30min, stepping every 30min until past lastMs
  const intervalMs = INTERVAL_MINUTES * 60 * 1000;
  const windows: number[] = [];
  let t = firstMs + intervalMs;
  while (t <= lastMs + intervalMs) {
    windows.push(t);
    t += intervalMs;
  }

  console.log(`simulate-day: running ${windows.length} windows…`);
  const apiKey = await resolveApiKey();
  const client = new Anthropic({ apiKey });

  for (const windowMs of windows) {
    const label = new Date(windowMs).toISOString().slice(11, 16) + "Z";
    await runWindow(client, sim, windowMs, label);
  }

  // Extract results
  const tasks = sim.prepare(
    "SELECT id, title, description, category FROM tasks ORDER BY id ASC"
  ).all() as TaskRow[];

  const eventRows = sim.prepare(`
    SELECT e.id as event_id, e.timestamp, e.app, e.event_type, e.interpretation,
           e.task_id, t.title as task_title, t.description as task_description, t.category
    FROM raw_events e
    INNER JOIN tasks t ON t.id = e.task_id
    ORDER BY e.timestamp ASC
  `).all() as EventOut[];

  const unassigned = (sim.prepare(
    "SELECT COUNT(*) as n FROM raw_events WHERE task_id IS NULL"
  ).get() as { n: number }).n;

  console.log(`\nsimulate-day: done`);
  console.log(`  tasks created: ${tasks.length}`);
  console.log(`  events assigned: ${eventRows.length} / ${events.length}`);
  console.log(`  unassigned: ${unassigned}`);

  // Write outputs
  const outDir = join(import.meta.dir);
  const suffix = INTERVAL_MINUTES === 30 ? "" : `-${INTERVAL_MINUTES}m`;
  const jsonPath = join(outDir, `simulate-day${suffix}.json`);
  const htmlPath = join(outDir, `simulate-day${suffix}.html`);

  writeFileSync(jsonPath, JSON.stringify({ date: TARGET_DATE, tasks, events: eventRows }, null, 2));
  writeFileSync(htmlPath, generateHtml(tasks, eventRows, TARGET_DATE, INTERVAL_MINUTES));

  console.log(`\n  → ${jsonPath}`);
  console.log(`  → ${htmlPath}`);
  console.log(`\nOpen the HTML file in your browser to view the results.`);
}

main().catch(e => { console.error("simulate-day: failed", e); process.exit(1); });
