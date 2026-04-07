import { Hono } from "hono";
import { join } from "path";
import { eventsRoute } from "./routes/events";
import { agentRoute } from "./routes/agent";
import { logger } from "./logger";
import { loadConfig, resolveApiKey, saveConfig } from "./config";
import { reconfigure } from "./interpretation";
import { fetchTasks, insertTask, updateTask, deleteTask, deleteTasks, fetchTaskTimeline, fetchEventCategories, fetchApiUsageSummary, recomputeTimestampLocalForAll } from "./db";
import { runRetaskAgent } from "./retask";

const UI_DIR = join(import.meta.dir, "..", "ui");
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
  const useReact = await Bun.file(join(DIST_DIR, "index.html")).exists();
  const api = new Hono();
  api.route("/events", eventsRoute());
  api.route("/agent", agentRoute());

  // GET /api/tasks
  api.get("/tasks", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "") || 500;
    return c.json(fetchTasks(limit));
  });

  // POST /api/tasks
  api.post("/tasks", async (c) => {
    const body = await c.req.json() as { title: string; description: string; category?: "Productivity" | "Leisure" | "Admin" | "Learning" | "Communication" };
    const id = insertTask({ title: body.title ?? "", description: body.description ?? "", category: body.category ?? null });
    return c.json({ id });
  });

  // PUT /api/tasks/:id
  api.put("/tasks/:id", async (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json() as {
      title?: string;
      description?: string;
      category?: "Productivity" | "Leisure" | "Admin" | "Learning" | "Communication";
    };
    try {
      updateTask(id, body);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    return c.json({ ok: true });
  });

  // DELETE /api/tasks/:id
  api.delete("/tasks/:id", (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
    deleteTask(id);
    return c.json({ ok: true });
  });

  // GET /api/tasks/timeline
  api.get("/tasks/timeline", (c) => {
    const since = c.req.query("since");
    const until = c.req.query("until");
    return c.json(fetchTaskTimeline(since || undefined, until || undefined));
  });

  // GET /api/events/categorized
  api.get("/events/categorized", (c) => {
    const since = c.req.query("since");
    const until = c.req.query("until");
    return c.json(fetchEventCategories(since || undefined, until || undefined));
  });

  // DELETE /api/tasks (body: { ids: number[] }) — delete visible tasks, clear task_id on raw_events
  api.delete("/tasks", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { ids?: number[] };
    const ids = Array.isArray(body?.ids) ? body.ids.filter((n): n is number => typeof n === "number") : [];
    deleteTasks(ids);
    return c.json({ ok: true, deleted: ids.length });
  });

  // GET /api/usage — API cost summary
  api.get("/usage", (c) => {
    return c.json(fetchApiUsageSummary());
  });

  // POST /api/retask — trigger the agent-based task segmentation immediately
  api.post("/retask", async (c) => {
    try {
      await runRetaskAgent();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // GET /api/settings
  api.get("/settings", (c) => {
    const config = loadConfig();
    const mask = (value?: string) => (value?.trim() ? value.slice(0, 7) + "••••••••" : "");
    const openai = resolveApiKey("openai", config);
    const anthropic = resolveApiKey("anthropic", config);
    const gemini = resolveApiKey("gemini", config);
    return c.json({
      openai_api_key: mask(config.openai_api_key),
      anthropic_api_key: mask(config.anthropic_api_key),
      gemini_api_key: mask(config.gemini_api_key),
      interpretation_api_key: mask(config.interpretation_api_key),
      groq_api_key: mask(config.groq_api_key),
      interpretation_base_url: config.interpretation_base_url ?? "",
      interpretation_llm: config.interpretation_llm ?? "",
      task_classifier_llm: config.task_classifier_llm ?? "",
      timezone: config.timezone ?? "",
      openai: { has_key: !!openai.value, source: openai.source },
      anthropic: { has_key: !!anthropic.value, source: anthropic.source },
      gemini: { has_key: !!gemini.value, source: gemini.source },
    });
  });

  // PUT /api/settings
  api.put("/settings", async (c) => {
    const body = await c.req.json() as {
      openai_api_key?: string;
      anthropic_api_key?: string;
      gemini_api_key?: string;
      interpretation_api_key?: string;
      groq_api_key?: string;
      interpretation_base_url?: string;
      interpretation_llm?: string;
      task_classifier_llm?: string;
      timezone?: string;
    };
    const current = loadConfig();
    if (body.openai_api_key !== undefined) current.openai_api_key = body.openai_api_key;
    if (body.anthropic_api_key !== undefined) current.anthropic_api_key = body.anthropic_api_key;
    if (body.gemini_api_key !== undefined) current.gemini_api_key = body.gemini_api_key;
    if (body.interpretation_api_key !== undefined) current.interpretation_api_key = body.interpretation_api_key;
    if (body.groq_api_key !== undefined) current.groq_api_key = body.groq_api_key;
    if (body.interpretation_base_url !== undefined) current.interpretation_base_url = body.interpretation_base_url;
    if (body.interpretation_llm !== undefined) current.interpretation_llm = body.interpretation_llm;
    if (body.task_classifier_llm !== undefined) current.task_classifier_llm = body.task_classifier_llm;
    if (body.timezone !== undefined) current.timezone = body.timezone;
    saveConfig(current);
    if (body.timezone !== undefined) recomputeTimestampLocalForAll();
    reconfigure();
    return c.json({ ok: true });
  });

  // GET /api/logs — recent lines (optional ?since=ISO timestamp)
  api.get("/logs", (c) => {
    const since = c.req.query("since");
    let lines = logger.recentLines;
    if (since) {
      lines = lines.filter((line) => {
        const m = line.match(/^(\S+)/);
        return m && m[1] >= since;
      });
    }
    return c.json(lines);
  });

  // GET /api/logs/stream — SSE stream (optional ?since=ISO timestamp)
  api.get("/logs/stream", (c) => {
    const since = c.req.query("since");
    const stream = new ReadableStream({
      start(controller) {
        // Send recent history (filtered by since if provided)
        let lines = logger.recentLines;
        if (since) {
          lines = lines.filter((line) => {
            const m = line.match(/^(\S+)/);
            return m && m[1] >= since;
          });
        }
        for (const line of lines) {
          controller.enqueue(`data: ${JSON.stringify(line)}\n\n`);
        }

        const push = (line: string) => {
          try { controller.enqueue(`data: ${JSON.stringify(line)}\n\n`); }
          catch { logger.unsubscribe(push); }
        };

        logger.subscribe(push);

        c.req.raw.signal.addEventListener("abort", () => {
          logger.unsubscribe(push);
          controller.close();
        });
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });

  const root = new Hono();
  root.route("/api", api);

  // Static UI: prefer built React app (dist/), fallback to legacy ui/
  root.get("*", async (c) => {
    const path = new URL(c.req.url).pathname;
    const useReact = await Bun.file(join(DIST_DIR, "index.html")).exists();
    if (useReact) {
      // SPA: serve index.html for routes, or static assets
      const assetPath = path.replace(/^\//, "");
      const filePath = join(DIST_DIR, assetPath || "index.html");
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const ext = filePath.split(".").pop() ?? "";
        return new Response(file, {
          headers: { "Content-Type": MIME[ext] ?? "text/plain" },
        });
      }
      // Fallback for client-side routes
      const indexFile = Bun.file(join(DIST_DIR, "index.html"));
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return c.text("Not found", 404);
    }

    // Legacy static HTML
    let filePath: string;
    if (path === "/" || path === "/events") {
      filePath = join(UI_DIR, "index.html");
    } else if (path === "/settings") {
      filePath = join(UI_DIR, "settings.html");
    } else if (path === "/logs") {
      filePath = join(UI_DIR, "logs.html");
    } else {
      filePath = join(UI_DIR, path.replace(/^\//, ""));
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) return c.text("Not found", 404);
    const ext = filePath.split(".").pop() ?? "";
    return new Response(file, {
      headers: { "Content-Type": MIME[ext] ?? "text/plain" },
    });
  });

  Bun.serve({ port: PORT, reusePort: true, fetch: root.fetch, idleTimeout: 255 });
  logger.info(`server started on http://localhost:${PORT}`);
  logger.info(`logs at ${logger.path}`);
}

// ── Tracker child process ─────────────────────────────────────────────────────

const TRACKER_BINARY =
  process.env.TRACKER_BINARY ??
  join(import.meta.dir, "..", "..", "tracker", ".build", "release", "ActivityTracker");

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
