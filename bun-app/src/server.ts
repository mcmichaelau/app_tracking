import { Hono } from "hono";
import { join } from "path";
import { eventsRoute } from "./routes/events";
import { agentRoute } from "./routes/agent";
import { tasksRoute } from "./routes/tasks";
import { settingsRoute } from "./routes/settings";
import { logsRoute } from "./routes/logs";
import { logger } from "./logger";

const DIST_DIR = join(import.meta.dir, "..", "dist");
const PORT   = Number(process.env.PORT ?? 3001);

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js:   "text/javascript",
  css:  "text/css",
  ico:  "image/x-icon",
  svg:  "image/svg+xml",
};

export async function startServer() {
  const api = new Hono();
  api.route("/events", eventsRoute());
  api.route("/agent", agentRoute());
  api.route("/tasks", tasksRoute());
  api.route("/settings", settingsRoute());
  api.route("/logs", logsRoute());

  const root = new Hono();
  root.route("/api", api);

  root.get("*", async (c) => {
    const path = new URL(c.req.url).pathname;
    const assetPath = path.replace(/^\//, "");
    const filePath = join(DIST_DIR, assetPath || "index.html");
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const ext = filePath.split(".").pop() ?? "";
      return new Response(file, {
        headers: { "Content-Type": MIME[ext] ?? "text/plain" },
      });
    }
    // SPA fallback for client-side routes
    const indexFile = Bun.file(join(DIST_DIR, "index.html"));
    if (await indexFile.exists()) {
      return new Response(indexFile, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return c.text("Not found", 404);
  });

  Bun.serve({ port: PORT, reusePort: true, fetch: root.fetch, idleTimeout: 255 });
  logger.info(`server started on http://localhost:${PORT}`);
  logger.info(`logs at ${logger.path}`);
}

// ── Tracker child process ─────────────────────────────────────────────────────

const TRACKER_BINARY = join(import.meta.dir, "..", "..", "tracker", ".build", "release", "ActivityTracker");

export async function startTracker() {
  if (!(await Bun.file(TRACKER_BINARY).exists())) {
    logger.warn(`tracker binary not found at ${TRACKER_BINARY} — run 'swift build -c release' in tracker/`);
    return;
  }

  const proc = Bun.spawn([TRACKER_BINARY], {
    stdout: "pipe",
    stderr: "pipe",
    stdin:  null,
  });

  async function pipe(stream: ReadableStream<Uint8Array>, prefix: string) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      process.stdout.write(prefix + decoder.decode(value));
    }
  }

  pipe(proc.stdout, "[tracker] ");
  pipe(proc.stderr, "[tracker:err] ");

  proc.exited.then((code) => {
    logger.warn(`tracker exited with code ${code}`);
  });

  // Kill tracker whenever bun exits (Ctrl+C, SIGTERM, crash, etc.)
  process.on("exit", () => {
    try { proc.kill("SIGKILL"); } catch {}
  });

  logger.info(`tracker started (pid ${proc.pid})`);
}
