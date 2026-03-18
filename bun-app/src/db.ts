import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";

const dbDir = join(homedir(), "Library", "Application Support", "ActivityTracker");
mkdirSync(dbDir, { recursive: true });
export const dbPath = join(dbDir, "tracker.db");

export const db = new Database(dbPath, { create: true });

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
    description TEXT NOT NULL
  )
`);

// Add task_id FK to raw_events (must run after tasks exists)
if (existingCols.length > 0 && !existingCols.includes("task_id")) {
  db.run("ALTER TABLE raw_events ADD COLUMN task_id INTEGER REFERENCES tasks(id)");
}
db.run("CREATE INDEX IF NOT EXISTS idx_raw_events_task ON raw_events(task_id)");

export interface Task {
  id: number;
  title: string;
  description: string;
}

export interface RawEvent {
  id: number;
  timestamp: string;
  app: string;
  event_type: string;
  detail: string | null;
  interpretation: string | null;
  task_id: number | null;
}

const insertStmt = db.prepare(
  "INSERT INTO raw_events (timestamp, app, event_type, detail) VALUES (?, ?, ?, ?)"
);

export function insertEvent(event: {
  timestamp: string;
  app: string;
  event_type: string;
  detail?: string | null;
}): number {
  const result = insertStmt.run(
    event.timestamp,
    event.app,
    event.event_type,
    event.detail ?? null
  );
  return Number(result.lastInsertRowid);
}

const updateInterpStmt = db.prepare(
  "UPDATE raw_events SET interpretation = ? WHERE id = ?"
);

export function updateInterpretation(id: number, interpretation: string): void {
  updateInterpStmt.run(interpretation, id);
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
  let sql = "SELECT id, timestamp, app, event_type, detail, interpretation, task_id FROM raw_events";
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

export function fetchRecentInterpretations(limit = 10): string[] {
  const rows = db.prepare(
    "SELECT interpretation FROM raw_events WHERE interpretation IS NOT NULL ORDER BY id DESC LIMIT ?"
  ).all(limit) as { interpretation: string }[];
  return rows.map(r => r.interpretation).reverse();
}

export function fetchEventsForHour(since: string, until: string): { timestamp: string; interpretation: string | null }[] {
  return db.prepare(
    "SELECT timestamp, interpretation FROM raw_events WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC"
  ).all(since, until) as { timestamp: string; interpretation: string | null }[];
}

export function fetchTasks(limit = 500): Task[] {
  return db.prepare("SELECT id, title, description FROM tasks ORDER BY id DESC LIMIT ?").all(limit) as Task[];
}

export function fetchMostRecentTask(): Task | null {
  return db.prepare("SELECT id, title, description FROM tasks ORDER BY id DESC LIMIT 1").get() as Task | undefined ?? null;
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

export function insertTask(task: { title: string; description: string }): number {
  const result = db.prepare("INSERT INTO tasks (title, description) VALUES (?, ?)").run(task.title, task.description);
  return Number(result.lastInsertRowid);
}

export function updateTask(id: number, task: { title?: string; description?: string }): void {
  if (task.title !== undefined) db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run(task.title, id);
  if (task.description !== undefined) db.prepare("UPDATE tasks SET description = ? WHERE id = ?").run(task.description, id);
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

export function assignEventToTask(eventId: number, taskId: number | null): void {
  db.prepare("UPDATE raw_events SET task_id = ? WHERE id = ?").run(taskId, eventId);
}
