/**
 * Chunking strategy experiment.
 *
 * Pulls a real window of interpreted events from the DB and runs
 * three different segmentation strategies against the same data,
 * then prints a comparison table.
 *
 * Usage:
 *   bun run scripts/experiment-chunking.ts [--since=ISO] [--until=ISO] [--events=N]
 *
 * Defaults to the last 300 interpreted events.
 */

import Anthropic from "@anthropic-ai/sdk";
import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";

// ── config ────────────────────────────────────────────────────────────────────

const DB_PATH = join(homedir(), "Library", "Application Support", "ActivityTracker", "tracker.db");

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

// ── DB ────────────────────────────────────────────────────────────────────────

interface EventRow {
  id: number;
  timestamp: string;
  app: string;
  interpretation: string;
  task_id: number | null;
}

function loadEvents(since?: string, until?: string, limit = 300): EventRow[] {
  const db = new Database(DB_PATH, { readonly: true });
  let sql = `
    SELECT id, timestamp, app, interpretation, task_id
    FROM raw_events
    WHERE interpretation IS NOT NULL AND interpretation != ''
  `;
  const params: string[] = [];
  if (since) { sql += " AND timestamp >= ?"; params.push(since); }
  if (until) { sql += " AND timestamp <= ?"; params.push(until); }
  sql += ` ORDER BY id DESC LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...params) as EventRow[];
  db.close();
  return rows.reverse();
}

// ── helpers ───────────────────────────────────────────────────────────────────

function hhmm(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

function durationMins(events: EventRow[]): number {
  if (events.length < 2) return 0;
  return (
    (new Date(events[events.length - 1].timestamp).getTime() -
      new Date(events[0].timestamp).getTime()) /
    60000
  );
}

interface Segment {
  start: number;
  end: number;
  title: string;
  category: string;
}

function sanitize(s: string): string {
  // Remove lone surrogates and other characters that break JSON encoding
  return s.replace(/[\uD800-\uDFFF]/g, "?").replace(/[\x00-\x1F\x7F]/g, " ");
}

function formatLine(e: EventRow, i: number): string {
  const raw = sanitize(e.interpretation);
  const sentence = raw.length > 110 ? raw.slice(0, 110) + "…" : raw;
  return `[${i}] ${hhmm(e.timestamp)} | ${sanitize(e.app)} | ${sentence}`;
}

async function callLlm(
  client: Anthropic,
  events: EventRow[],
  systemPrompt: string
): Promise<Segment[]> {
  const lines = events.map(formatLine).join("\n");
  const userMsg = `Segment these ${events.length} events into tasks:\n\n${lines}`;

  const resp = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const match =
    text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
  const jsonStr = match ? match[1].trim() : text.trim();
  const parsed = JSON.parse(jsonStr) as { tasks: Array<Record<string, unknown>> };
  return parsed.tasks.map((t) => ({
    start: Number(t.start),
    end: Number(t.end),
    title: String(t.title ?? "Untitled"),
    category: String(t.category ?? "Productivity"),
  }));
}

// ── prompts ───────────────────────────────────────────────────────────────────

// Strategy A – minimal prompt, small windows (rough baseline)
const PROMPT_A = `You are segmenting a chronological sequence of user activity events into coherent tasks.

A TASK is a coherent unit of work with a single clear goal. Return a JSON object with a "tasks" array. Each task:
- "start": index of first event (0-based, inclusive)
- "end": index of last event (0-based, inclusive)
- "title": short goal statement (5-10 words)
- "category": one of Productivity | Leisure | Admin | Learning | Communication

All events must be covered. Return ONLY valid JSON.`;

// Strategy B – current retask.ts prompt verbatim
const PROMPT_B = `You are segmenting a chronological sequence of user activity events into coherent tasks.

A TASK is a coherent unit of work with a single clear goal — like a Jira ticket. Examples:
- "Debugging why the ingest pipeline fires duplicate APP SWITCH events"
- "Replying to Nicole's email about Checkwriters login issues"
- "Shopping for Dickies 874 work pants on Amazon"

RULES for task boundaries:
- A new task starts when the user's GOAL clearly changes — not just when they switch apps
- Brief app-switches (IDE ↔ browser, IDE ↔ terminal, checking Slack) while working toward the same goal = SAME task
- Brief interruptions (< 5 min) before returning to same work = SAME task
- OS-level dialogs, system notifications, lock screen = NOT a new task
- Reviewing/testing the app you're coding = SAME task

PREFER BROADER TASKS. When in doubt, keep events together. A task should usually span several minutes of related activity. Never create a task for a single click or a 30-second action that is clearly part of a larger workflow.

Return a JSON object with a "tasks" array. Each task:
- "start": index of first event (0-based, inclusive)
- "end": index of last event (0-based, inclusive)
- "title": short goal statement (5-10 words, specific names when known)
- "category": one of Productivity | Leisure | Admin | Learning | Communication

All events must be covered. Return ONLY valid JSON.`;

// Strategy C – goal-persistence + hard minimum-duration rules, larger windows
const PROMPT_C = `You are segmenting a chronological sequence of user activity events into coherent WORK SESSIONS.

## What is a task?
A task represents what the user was TRYING TO ACCOMPLISH over a sustained period — not each individual action.
Think of it like a time-tracking entry: "I spent 15 minutes debugging the insights page."

## Hard rules
1. MINIMUM DURATION: A task must span at least 3 minutes of wall-clock time unless it is the only task in the window.
2. APP SWITCHES DON'T SPLIT TASKS: Switching browser ↔ IDE ↔ terminal while pursuing the same goal = same task. This is the #1 cause of false splits.
3. GOAL PERSISTENCE: If the user returns to the same goal within 5 minutes, merge the digression in.
4. MERGE DOUBT: When uncertain whether two adjacent groups belong to the same task, merge them.

## What genuinely splits a task
- The user's underlying goal completely changes (e.g., done coding → now checking email)
- A gap of 10+ minutes with no events (user was idle/away)
- The user explicitly starts something unrelated and does not return to the prior goal

## Output format
Return a JSON object with a "tasks" array. Each task:
- "start": 0-based index of first event (inclusive)
- "end": 0-based index of last event (inclusive)
- "title": 6-12 word goal statement describing the user's intent, using specific names (files, URLs, people) when visible
- "category": one of Productivity | Leisure | Admin | Learning | Communication

All events must be covered. No gaps, no overlaps. Return ONLY valid JSON.`;

// ── windowing ─────────────────────────────────────────────────────────────────

function splitWindows(
  events: EventRow[],
  windowSize: number,
  overlap: number,
  gapMins: number
): EventRow[][] {
  if (events.length === 0) return [];
  const gapSegments: EventRow[][] = [];
  let current: EventRow[] = [events[0]];
  for (let i = 1; i < events.length; i++) {
    const gap =
      (new Date(events[i].timestamp).getTime() -
        new Date(events[i - 1].timestamp).getTime()) /
      60000;
    if (gap >= gapMins) {
      gapSegments.push(current);
      current = [];
    }
    current.push(events[i]);
  }
  gapSegments.push(current);

  const windows: EventRow[][] = [];
  for (const seg of gapSegments) {
    if (seg.length <= windowSize) {
      windows.push(seg);
      continue;
    }
    let start = 0;
    while (start < seg.length) {
      const end = Math.min(start + windowSize, seg.length);
      windows.push(seg.slice(start, end));
      if (end === seg.length) break;
      start = end - overlap;
    }
  }
  return windows;
}

// ── run one strategy ──────────────────────────────────────────────────────────

async function runStrategy(
  client: Anthropic,
  allEvents: EventRow[],
  prompt: string,
  windowSize: number,
  overlap: number,
  gapMins: number
): Promise<Segment[]> {
  const windows = splitWindows(allEvents, windowSize, overlap, gapMins);
  const result: Segment[] = [];
  let offset = 0;
  for (const win of windows) {
    const segs = await callLlm(client, win, prompt);
    for (const s of segs) {
      result.push({ ...s, start: s.start + offset, end: s.end + offset });
    }
    offset += win.length;
  }
  return result;
}

// ── stats & printing ──────────────────────────────────────────────────────────

interface StrategyResult {
  name: string;
  segments: Array<{
    title: string;
    category: string;
    events: EventRow[];
    durationMins: number;
  }>;
  totalTasks: number;
  avgDurationMins: number;
  medianDurationMins: number;
  pctUnder1Min: number;
  pctOver3Min: number;
}

function computeStats(
  name: string,
  allEvents: EventRow[],
  rawSegs: Segment[]
): StrategyResult {
  const segments = rawSegs.map((s) => {
    const evs = allEvents.slice(s.start, s.end + 1);
    return {
      title: s.title,
      category: s.category,
      events: evs,
      durationMins: durationMins(evs),
    };
  });
  const durations = segments.map((s) => s.durationMins).sort((a, b) => a - b);
  const n = durations.length || 1;
  const avg = durations.reduce((a, b) => a + b, 0) / n;
  const median = durations[Math.floor(n / 2)] ?? 0;
  return {
    name,
    segments,
    totalTasks: segments.length,
    avgDurationMins: avg,
    medianDurationMins: median,
    pctUnder1Min: (durations.filter((d) => d < 1).length / n) * 100,
    pctOver3Min: (durations.filter((d) => d >= 3).length / n) * 100,
  };
}

function printResult(r: StrategyResult) {
  console.log(`\n${"─".repeat(90)}`);
  console.log(`STRATEGY: ${r.name}`);
  console.log(`${"─".repeat(90)}`);
  console.log(
    `Tasks: ${r.totalTasks}  |  Avg: ${r.avgDurationMins.toFixed(1)}min  |  Median: ${r.medianDurationMins.toFixed(1)}min  |  <1min: ${r.pctUnder1Min.toFixed(0)}%  |  ≥3min: ${r.pctOver3Min.toFixed(0)}%`
  );
  console.log();
  for (const seg of r.segments) {
    const first = seg.events[0];
    const last = seg.events[seg.events.length - 1];
    if (!first || !last) continue;
    const timeRange = `${hhmm(first.timestamp)}–${hhmm(last.timestamp)}`;
    const dur =
      seg.durationMins < 1
        ? `${(seg.durationMins * 60).toFixed(0)}s`
        : `${seg.durationMins.toFixed(1)}min`;
    const flag = seg.durationMins < 1 ? " ⚠" : seg.durationMins >= 3 ? " ✓" : "";
    console.log(
      `  [${timeRange}] (${dur}, ${seg.events.length}ev)${flag}  ${seg.title}`
    );
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = await resolveApiKey();
  const client = new Anthropic({ apiKey });

  const args = process.argv.slice(2);
  const sinceArg = args.find((a) => a.startsWith("--since="))?.split("=")[1];
  const untilArg = args.find((a) => a.startsWith("--until="))?.split("=")[1];
  const limitArg = Number(
    args.find((a) => a.startsWith("--events="))?.split("=")[1] ?? 300
  );

  const events = loadEvents(sinceArg, untilArg, limitArg);
  if (events.length === 0) { console.error("No events found"); process.exit(1); }

  console.log(
    `Loaded ${events.length} events  ${hhmm(events[0].timestamp)}–${hhmm(events[events.length - 1].timestamp)}  (${durationMins(events).toFixed(1)} min span)`
  );

  // ── A: small windows (50), minimal prompt ────────────────────────────────
  process.stdout.write("\n[A] Running: small windows (50 ev), minimal prompt… ");
  const segsA = await runStrategy(client, events, PROMPT_A, 50, 8, 30);
  process.stdout.write(`done (${segsA.length} segments)\n`);
  const resultA = computeStats("A – small windows (50ev), minimal prompt", events, segsA);

  // ── B: small windows (50), current retask prompt ─────────────────────────
  process.stdout.write("[B] Running: small windows (50 ev), current prompt… ");
  const segsB = await runStrategy(client, events, PROMPT_B, 50, 8, 30);
  process.stdout.write(`done (${segsB.length} segments)\n`);
  const resultB = computeStats("B – small windows (50ev), current retask prompt", events, segsB);

  // ── C: large windows (150), goal-persistence prompt, 10min gap ───────────
  process.stdout.write("[C] Running: large windows (150 ev), goal-persistence prompt… ");
  const segsC = await runStrategy(client, events, PROMPT_C, 150, 15, 10);
  process.stdout.write(`done (${segsC.length} segments)\n`);
  const resultC = computeStats(
    "C – large windows (150ev), goal-persistence prompt",
    events,
    segsC
  );

  printResult(resultA);
  printResult(resultB);
  printResult(resultC);

  // Summary
  console.log(`\n${"═".repeat(90)}`);
  console.log("SUMMARY");
  console.log("═".repeat(90));
  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);
  console.log(
    `${pad("Strategy", 52)} ${"Tasks".padStart(6)} ${"Avg".padStart(7)} ${"Median".padStart(8)} ${"<1min".padStart(7)} ${"≥3min".padStart(7)}`
  );
  console.log("─".repeat(90));
  for (const r of [resultA, resultB, resultC]) {
    console.log(
      `${pad(r.name, 52)} ${r.totalTasks.toString().padStart(6)} ${r.avgDurationMins.toFixed(1).padStart(6)}m ${r.medianDurationMins.toFixed(1).padStart(6)}m ${r.pctUnder1Min.toFixed(0).padStart(5)}% ${r.pctOver3Min.toFixed(0).padStart(5)}%`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
