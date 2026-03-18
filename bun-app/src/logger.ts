import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "path";
import { homedir } from "os";

const logDir = join(homedir(), "Library", "Logs", "ActivityTracker");
mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, "server.log");

// Recent lines buffer for new connections
const recentLines: string[] = [];
const MAX_RECENT = 500;

// SSE subscribers
const subscribers = new Set<(line: string) => void>();

function write(level: string, msg: string, data?: unknown) {
  const line = `${new Date().toISOString()} [${level}] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`;
  process.stdout.write(line + "\n");
  appendFileSync(logPath, line + "\n");

  recentLines.push(line);
  if (recentLines.length > MAX_RECENT) recentLines.shift();

  for (const fn of subscribers) fn(line);
}

export const logger = {
  info:  (msg: string, data?: unknown) => write("INFO",  msg, data),
  warn:  (msg: string, data?: unknown) => write("WARN",  msg, data),
  error: (msg: string, data?: unknown) => write("ERROR", msg, data),
  event: (msg: string, data?: unknown) => write("EVENT", msg, data),
  path:  logPath,
  recentLines,
  subscribe:   (fn: (line: string) => void) => subscribers.add(fn),
  unsubscribe: (fn: (line: string) => void) => subscribers.delete(fn),
};
