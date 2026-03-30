import { Hono } from "hono";
import { logger } from "../logger";

export function logsRoute(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
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

  app.get("/stream", (c) => {
    const since = c.req.query("since");
    const stream = new ReadableStream({
      start(controller) {
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

  return app;
}
