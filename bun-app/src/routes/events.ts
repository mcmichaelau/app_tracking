import { Hono } from "hono";
import { ingest } from "../ingest";
import { fetchEvents, deleteAllEvents, assignEventToTask } from "../db";
import { logger } from "../logger";

export function eventsRoute(): Hono {
  const app = new Hono();

  // POST /api/events — Swift tracker posts batches here
  app.post("/", async (c) => {
    const body = await c.req.json();
    const events = Array.isArray(body) ? body : [body];
    // logger.event(`received ${events.length} event(s)`, events);
    ingest(events);
    return c.json({ ok: true });
  });

  // DELETE /api/events — delete all events
  app.delete("/", (c) => {
    const deleted = deleteAllEvents();
    logger.info("events: deleted all", { count: deleted });
    return c.json({ ok: true, deleted });
  });

  // PUT /api/events/:id — assign event to task
  app.put("/:id", async (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json() as { task_id?: number | null };
    assignEventToTask(id, body.task_id ?? null);
    return c.json({ ok: true });
  });

  // GET /api/events
  app.get("/", (c) => {
    const limit      = parseInt(c.req.query("limit") ?? "") || 500;
    const since      = c.req.query("since")      ?? undefined;
    const until      = c.req.query("until")      ?? undefined;
    const event_type = c.req.query("event_type") ?? undefined;
    const app_       = c.req.query("app")        ?? undefined;
    return c.json(fetchEvents({ limit, since, until, event_type, app: app_ }));
  });

  return app;
}
