import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { getResolvedUserTimezone, normalizeUtcIso, utcIsoToLocalWall } from "./timezone";

const dbDir = join(homedir(), "Library", "Application Support", "ActivityTracker");
mkdirSync(dbDir, { recursive: true });
export const dbPath = join(dbDir, "tracker.db");

export const db = new Database(dbPath, { create: true });

export const TASK_CATEGORIES = [
  "Productivity",
  "Leisure",
  "Admin",
  "Learning",
  "Communication",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = NORMAL");

// Migrate: drop table if it uses the old type/target/content schema
const cols = (db.query("PRAGMA table_info(raw_events)").all() as { name: string }[]).map(r => r.name);
if (cols.length > 0 && !cols.includes("event_type")) {
  db.run("DROP TABLE raw_events");
}

db.run(`
  CREATE TABLE IF NOT EXISTS raw_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp      TEXT NOT NULL,
    app            TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    detail         TEXT,
    interpretation TEXT
  )
`);

// Column migrations for raw_events (existing DBs)
const existingCols = (db.query("PRAGMA table_info(raw_events)").all() as { name: string }[]).map(r => r.name);
if (existingCols.length > 0 && !existingCols.includes("interpretation")) {
  db.run("ALTER TABLE raw_events ADD COLUMN interpretation TEXT");
}

// Remove episode column if it still exists
if (existingCols.includes("episode_id")) {
  db.run("DROP INDEX IF EXISTS idx_raw_events_episode");
  db.run("ALTER TABLE raw_events DROP COLUMN episode_id");
}
const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name);
if (tables.includes("tasks")) {
  const taskCols = (db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map(r => r.name);
  if (!taskCols.includes("title") || taskCols.includes("episode_id")) {
    db.run("DROP TABLE tasks");
  }
}
if (tables.includes("episodes")) {
  db.run("DROP INDEX IF EXISTS idx_episodes_start");
  db.run("DROP INDEX IF EXISTS idx_episodes_end");
  db.run("DROP TABLE episodes");
}
if (tables.includes("events")) {
  db.run("DROP TABLE events");
}

db.run("CREATE INDEX IF NOT EXISTS idx_raw_events_timestamp ON raw_events(timestamp)");
db.run("CREATE INDEX IF NOT EXISTS idx_raw_events_type ON raw_events(event_type)");

db.run(`
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    category    TEXT CHECK(category IN ('Productivity','Leisure','Admin','Learning','Communication'))
  )
`);

const existingTaskCols = (db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map(r => r.name);
if (!existingTaskCols.includes("category")) {
  db.run("ALTER TABLE tasks ADD COLUMN category TEXT CHECK(category IN ('Productivity','Leisure','Admin','Learning','Communication'))");
}

// Add task_id FK to raw_events (must run after tasks exists)
if (existingCols.length > 0 && !existingCols.includes("task_id")) {
  db.run("ALTER TABLE raw_events ADD COLUMN task_id INTEGER REFERENCES tasks(id)");
}
db.run("CREATE INDEX IF NOT EXISTS idx_raw_events_task ON raw_events(task_id)");

{
  const colNames = (db.query("PRAGMA table_info(raw_events)").all() as { name: string }[]).map((r) => r.name);
  if (!colNames.includes("timestamp_local")) {
    db.run("ALTER TABLE raw_events ADD COLUMN timestamp_local TEXT");
  }
  const tz = getResolvedUserTimezone();
  const rows = db.prepare(
    "SELECT id, timestamp FROM raw_events WHERE timestamp_local IS NULL OR timestamp_local = ''",
  ).all() as { id: number; timestamp: string }[];
  const upd = db.prepare("UPDATE raw_events SET timestamp_local = ? WHERE id = ?");
  for (const r of rows) {
    try {
      const utc = normalizeUtcIso(r.timestamp);
      upd.run(utcIsoToLocalWall(utc, tz), r.id);
    } catch {
      /* ignore */
    }
  }
}

export interface Task {
  id: number;
  title: string;
  description: string;
  category: TaskCategory | null;
}

export interface RawEvent {
  id: number;
  /** Canonical instant, ISO 8601 UTC (e.g. …Z). */
  timestamp: string;
  /** Wall-clock in the configured user timezone (YYYY-MM-DDTHH:MM:SS.mmm). */
  timestamp_local: string;
  app: string;
  event_type: string;
  detail: string | null;
  interpretation: string | null;
  task_id: number | null;
}

const insertStmt = db.prepare(
  "INSERT INTO raw_events (timestamp, timestamp_local, app, event_type, detail) VALUES (?, ?, ?, ?, ?)"
);

export function insertEvent(event: {
  timestamp: string;
  app: string;
  event_type: string;
  detail?: string | null;
}): number {
  const utc = normalizeUtcIso(event.timestamp);
  const tz = getResolvedUserTimezone();
  const local = utcIsoToLocalWall(utc, tz);
  const result = insertStmt.run(utc, local, event.app, event.event_type, event.detail ?? null);
  return Number(result.lastInsertRowid);
}

const updateInterpStmt = db.prepare(
  "UPDATE raw_events SET interpretation = ? WHERE id = ?"
);

export function updateInterpretation(id: number, interpretation: string): void {
  updateInterpStmt.run(interpretation, id);
}

/** Call after changing USER_TIMEZONE / config timezone so wall-clock column matches. */
export function recomputeTimestampLocalForAll(): void {
  const tz = getResolvedUserTimezone();
  const rows = db.prepare("SELECT id, timestamp FROM raw_events").all() as { id: number; timestamp: string }[];
  const upd = db.prepare("UPDATE raw_events SET timestamp_local = ? WHERE id = ?");
  for (const r of rows) {
    try {
      upd.run(utcIsoToLocalWall(normalizeUtcIso(r.timestamp), tz), r.id);
    } catch {
      /* ignore */
    }
  }
}

export function deleteAllEvents(): number {
  const result = db.prepare("DELETE FROM raw_events").run();
  return result.changes;
}

export function fetchEvents(options: {
  limit?: number;
  since?: string;
  until?: string;
  event_type?: string;
  app?: string;
}): RawEvent[] {
  const { limit = 500, since, until, event_type, app } = options;
  let sql = "SELECT id, timestamp, timestamp_local, app, event_type, detail, interpretation, task_id FROM raw_events";
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (since)      { conditions.push("timestamp >= ?");  params.push(since); }
  if (until)      { conditions.push("timestamp <= ?");  params.push(until); }
  if (event_type) { conditions.push("event_type = ?");  params.push(event_type); }
  if (app)        { conditions.push("app = ?");         params.push(app); }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY id DESC LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params) as RawEvent[];
}

export function fetchRecentInterpretations(limit = 10, excludeEventId?: number): string[] {
  const sql = excludeEventId != null
    ? "SELECT interpretation FROM raw_events WHERE interpretation IS NOT NULL AND id != ? ORDER BY id DESC LIMIT ?"
    : "SELECT interpretation FROM raw_events WHERE interpretation IS NOT NULL ORDER BY id DESC LIMIT ?";
  const rows = excludeEventId != null
    ? (db.prepare(sql).all(excludeEventId, limit) as { interpretation: string }[])
    : (db.prepare(sql).all(limit) as { interpretation: string }[]);
  return rows.map(r => r.interpretation).reverse();
}

export function fetchEventsForHour(since: string, until: string): { timestamp: string; interpretation: string | null }[] {
  return db.prepare(
    "SELECT timestamp, interpretation FROM raw_events WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC"
  ).all(since, until) as { timestamp: string; interpretation: string | null }[];
}

export function fetchTasks(limit = 500): Task[] {
  return db.prepare("SELECT id, title, description, category FROM tasks ORDER BY id DESC LIMIT ?").all(limit) as Task[];
}

export function fetchMostRecentTask(): Task | null {
  return db.prepare("SELECT id, title, description, category FROM tasks ORDER BY id DESC LIMIT 1").get() as Task | undefined ?? null;
}

export function fetchMostRecentTaskWithLastEventTime(): { task: Task; lastEventTime: string | null } | null {
  const task = fetchMostRecentTask();
  if (!task) return null;
  const row = db.prepare("SELECT MAX(timestamp) as lastEventTime FROM raw_events WHERE task_id = ?").get(task.id) as { lastEventTime: string | null } | undefined;
  return { task, lastEventTime: row?.lastEventTime ?? null };
}

export function appendToTaskDescription(taskId: number, addendum: string): void {
  const task = db.prepare("SELECT description FROM tasks WHERE id = ?").get(taskId) as { description: string } | undefined;
  if (task) {
    const newDesc = task.description + "\n" + addendum;
    db.prepare("UPDATE tasks SET description = ? WHERE id = ?").run(newDesc, taskId);
  }
}

export function insertTask(task: { title: string; description: string; category?: TaskCategory | null }): number {
  const result = db.prepare("INSERT INTO tasks (title, description, category) VALUES (?, ?, ?)").run(
    task.title,
    task.description,
    task.category ?? null
  );
  return Number(result.lastInsertRowid);
}

export function updateTask(id: number, task: { title?: string; description?: string; category?: TaskCategory | null }): void {
  if (task.title !== undefined) db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run(task.title, id);
  if (task.description !== undefined) db.prepare("UPDATE tasks SET description = ? WHERE id = ?").run(task.description, id);
  if (task.category !== undefined && task.category !== null) {
    const row = db.prepare("SELECT category FROM tasks WHERE id = ?").get(id) as { category: TaskCategory | null } | undefined;
    if (!row) return;
    if (row.category && row.category !== task.category) {
      throw new Error("task category cannot be changed once set");
    }
    if (!row.category) {
      db.prepare("UPDATE tasks SET category = ? WHERE id = ?").run(task.category, id);
    }
  }
}

export function deleteTask(id: number): void {
  db.prepare("UPDATE raw_events SET task_id = NULL WHERE task_id = ?").run(id);
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

export function deleteTasks(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE raw_events SET task_id = NULL WHERE task_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...ids);
}

export interface TaskTimelineEntry {
  id: number;
  title: string;
  description: string;
  category: TaskCategory | null;
  event_count: number;
  first_event: string | null;
  last_event: string | null;
}

export function fetchTaskTimeline(since?: string, until?: string): TaskTimelineEntry[] {
  let sql = `
    SELECT
      t.id, t.title, t.description, t.category,
      COUNT(e.id) as event_count,
      MIN(e.timestamp) as first_event,
      MAX(e.timestamp) as last_event
    FROM tasks t
    INNER JOIN raw_events e ON e.task_id = t.id
  `;
  const conditions: string[] = [];
  const params: string[] = [];
  if (since) { conditions.push("e.timestamp >= ?"); params.push(since); }
  if (until) { conditions.push("e.timestamp <= ?"); params.push(until); }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " GROUP BY t.id ORDER BY first_event ASC";
  return db.prepare(sql).all(...params) as TaskTimelineEntry[];
}

export interface CategorizedEventRow {
  event_id: number;
  timestamp: string;
  timestamp_local: string;
  app: string;
  event_type: string;
  detail: string | null;
  interpretation: string | null;
  task_id: number;
  task_title: string;
  task_description: string;
  category: TaskCategory | null;
}

export function fetchEventCategories(since?: string, until?: string): CategorizedEventRow[] {
  let sql = `
    SELECT e.id as event_id, e.timestamp, e.timestamp_local, e.app, e.event_type, e.detail, e.interpretation,
           e.task_id, t.title as task_title, t.description as task_description, t.category
    FROM raw_events e
    INNER JOIN tasks t ON t.id = e.task_id
  `;
  const conditions: string[] = [];
  const params: string[] = [];
  if (since) { conditions.push("e.timestamp >= ?"); params.push(since); }
  if (until) { conditions.push("e.timestamp <= ?"); params.push(until); }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY e.timestamp ASC";
  return db.prepare(sql).all(...params) as CategorizedEventRow[];
}

export function assignEventToTask(eventId: number, taskId: number | null): void {
  db.prepare("UPDATE raw_events SET task_id = ? WHERE id = ?").run(taskId, eventId);
}

// ── API usage tracking ────────────────────────────────────────────────────────

db.run(`
  CREATE TABLE IF NOT EXISTS api_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT NOT NULL,
    model         TEXT NOT NULL,
    operation     TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL NOT NULL DEFAULT 0
  )
`);
db.run("CREATE INDEX IF NOT EXISTS idx_api_usage_timestamp ON api_usage(timestamp)");

// Prices in USD per 1M tokens
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "gpt-5-mini":                    { input: 0.40,  output: 1.60  },
  "gpt-4.1":                       { input: 2.00,  output: 8.00  },
  "gpt-4.1-mini":                  { input: 0.40,  output: 1.60  },
  "gpt-4.1-nano":                  { input: 0.10,  output: 0.40  },
  "o4-mini":                       { input: 1.10,  output: 4.40  },
  "claude-haiku-4-5-20251001":     { input: 0.80,  output: 4.00  },
  "claude-haiku-4-5":              { input: 0.80,  output: 4.00  },
  "claude-3-5-haiku-20241022":     { input: 0.80,  output: 4.00  },
  "claude-sonnet-4-5":             { input: 3.00,  output: 15.00 },
  "claude-sonnet-4-6":             { input: 3.00,  output: 15.00 },
  "claude-opus-4-5":               { input: 15.00, output: 75.00 },
  "gemini-2.0-flash":              { input: 0.10,  output: 0.40  },
  "gemini-2.5-pro-preview-03-25":  { input: 1.25,  output: 10.00 },
  "llama-3.3-70b-versatile":       { input: 0.59,  output: 0.79  },
  "llama-3.1-8b-instant":          { input: 0.05,  output: 0.08  },
  "qwen-qwq-32b":                  { input: 0.29,  output: 0.39  },
  "qwen/qwen3-32b":                { input: 0.29,  output: 0.59  },
};

export function computeApiCost(model: string, inputTokens: number, outputTokens: number): number {
  const key = model.includes("/") ? model.split("/").slice(1).join("/") : model;
  const prices = MODEL_PRICES[key] ?? MODEL_PRICES[model];
  if (!prices) return 0;
  return (inputTokens / 1_000_000) * prices.input + (outputTokens / 1_000_000) * prices.output;
}

export function insertApiUsage(entry: {
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}): void {
  db.prepare(
    "INSERT INTO api_usage (timestamp, model, operation, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(new Date().toISOString(), entry.model, entry.operation, entry.inputTokens, entry.outputTokens, entry.costUsd);
}

export interface ApiUsagePeriod {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface ApiUsageByModel {
  model: string;
  operation: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export function fetchApiUsageSummary(): {
  today: ApiUsagePeriod;
  week: ApiUsagePeriod;
  month: ApiUsagePeriod;
  allTime: ApiUsagePeriod;
  byModel: ApiUsageByModel[];
} {
  function periodTotal(since: string): ApiUsagePeriod {
    return db.prepare(`
      SELECT COALESCE(SUM(input_tokens),0) as input_tokens,
             COALESCE(SUM(output_tokens),0) as output_tokens,
             COALESCE(SUM(cost_usd),0) as cost_usd
      FROM api_usage WHERE timestamp >= ?
    `).get(since) as ApiUsagePeriod;
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart  = new Date(now.getTime() - 7  * 86400000).toISOString();
  const monthStart = new Date(now.getTime() - 30 * 86400000).toISOString();

  const byModel = db.prepare(`
    SELECT model, operation,
           SUM(input_tokens)  as input_tokens,
           SUM(output_tokens) as output_tokens,
           SUM(cost_usd)      as cost_usd
    FROM api_usage
    GROUP BY model, operation
    ORDER BY cost_usd DESC
  `).all() as ApiUsageByModel[];

  return {
    today:   periodTotal(todayStart),
    week:    periodTotal(weekStart),
    month:   periodTotal(monthStart),
    allTime: periodTotal("1970-01-01"),
    byModel,
  };
}
