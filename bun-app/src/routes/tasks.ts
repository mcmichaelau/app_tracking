import { Hono } from "hono";
import { fetchTasks, insertTask, updateTask, deleteTask, deleteTasks } from "../db";

export function tasksRoute(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "") || 500;
    return c.json(fetchTasks(limit));
  });

  app.post("/", async (c) => {
    const body = await c.req.json() as { title: string; description: string };
    const id = insertTask({ title: body.title ?? "", description: body.description ?? "" });
    return c.json({ id });
  });

  app.put("/:id", async (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json() as { title?: string; description?: string };
    updateTask(id, body);
    return c.json({ ok: true });
  });

  app.delete("/:id", (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
    deleteTask(id);
    return c.json({ ok: true });
  });

  app.delete("/", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { ids?: number[] };
    const ids = Array.isArray(body?.ids) ? body.ids.filter((n): n is number => typeof n === "number") : [];
    deleteTasks(ids);
    return c.json({ ok: true, deleted: ids.length });
  });

  return app;
}
