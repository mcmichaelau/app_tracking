import { Hono } from "hono";
import type { ChatCompletionMessageParam } from "openai";
import { logger } from "../logger";
import { getResolvedUserTimezone, localCalendarDateInZone } from "../timezone";
import { runInsightsAgent } from "../insightsAgent/runner";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatSession {
  openaiMessages: ChatCompletionMessageParam[];
  messages: ChatMessage[];
}

const sessions = new Map<string, ChatSession>();

const MAX_HISTORY_MESSAGES = 48;

function buildSystemPrompt(): string {
  const tz = getResolvedUserTimezone();
  const todayLocal = localCalendarDateInZone(new Date().toISOString(), tz);

  return `You are an activity-insights assistant. The user's activity is stored in SQLite. Use the read_query tool only for SELECT queries — writes are blocked by the app.

IMPORTANT:
- Always use LIMIT in read_query (max 100 rows).
- The user's timezone is ${tz}. Today's local calendar date is ${todayLocal} (same zone).
- Column "timestamp_local" is wall-clock time in that timezone (format YYYY-MM-DDTHH:MM:SS.mmm, no suffix). Use it for "today", "this morning", afternoon, and human-facing clock times.
- Column "timestamp" is ISO 8601 UTC (…Z). Use it for instant ordering or rolling windows, e.g. last 10 minutes: WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', '-10 minutes'))
- For local calendar filters, use "timestamp_local":
  - today: WHERE date(timestamp_local) = '${todayLocal}'
  - this morning: WHERE date(timestamp_local) = '${todayLocal}' AND time(timestamp_local) >= '05:00:00' AND time(timestamp_local) < '12:00:00' (adjust if the user specifies different bounds)
- When describing times to the user, use clock times from "timestamp_local", not raw UTC from "timestamp".

Allowed columns on raw_events only: timestamp_local, timestamp, interpretation. Do not select id, app, event_type, or detail.

Answer in concise markdown. Avoid extra blank lines between list items or short paragraphs.`;
}

export function agentRoute(): Hono {
  const app = new Hono();

  app.post("/chat", async (c) => {
    const body = await c.req.json() as {
      message: string;
      conversationId?: string;
    };

    if (!body.message?.trim()) {
      return c.json({ error: "message is required" }, 400);
    }

    const conversationId = body.conversationId || crypto.randomUUID();
    let session = sessions.get(conversationId);

    if (!session) {
      session = { openaiMessages: [], messages: [] };
      sessions.set(conversationId, session);
    }

    session.messages.push({ role: "user", content: body.message });

    const stream = new ReadableStream({
      async start(controller) {
        const sse = (payload: object) =>
          controller.enqueue(
            `data: ${JSON.stringify({ ...payload, conversationId })}\n\n`,
          );

        try {
          const history = session!.openaiMessages.slice(-MAX_HISTORY_MESSAGES);

          const { assistantText, appendMessages } = await runInsightsAgent({
            systemPrompt: buildSystemPrompt(),
            userMessage: body.message,
            history,
            emit: (ev) => {
              if (ev.type === "text") {
                sse({ type: "text", content: ev.content });
              } else if (ev.type === "tool_use") {
                sse({ type: "tool_use", tool: ev.tool, toolInput: ev.toolInput });
              } else if (ev.type === "tool_result") {
                sse({ type: "tool_result", content: ev.content });
              } else if (ev.type === "result") {
                sse({ type: "result", turns: ev.turns });
              }
            },
          });

          session!.openaiMessages.push(...appendMessages);
          session!.openaiMessages = session!.openaiMessages.slice(-MAX_HISTORY_MESSAGES);

          const text = assistantText.trim();
          if (text) {
            const last = session!.messages[session!.messages.length - 1];
            if (last?.role === "user") {
              session!.messages.push({ role: "assistant", content: text });
            }
          }

          logger.info("agent:done", { conversationId, turns: appendMessages.length });
        } catch (error) {
          logger.error("Agent chat error", error);
          const last = session!.messages[session!.messages.length - 1];
          if (last?.role === "user" && last.content === body.message) {
            session!.messages.pop();
          }
          sse({
            type: "error",
            content: error instanceof Error ? error.message : "Unknown error",
          });
          controller.close();
          return;
        }

        sse({ type: "done" });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  app.get("/conversations/:id", (c) => {
    const id = c.req.param("id");
    const sess = sessions.get(id);
    if (!sess) {
      return c.json({ error: "conversation not found" }, 404);
    }
    return c.json({
      conversationId: id,
      messages: sess.messages,
    });
  });

  app.delete("/conversations/:id", (c) => {
    const id = c.req.param("id");
    sessions.delete(id);
    return c.json({ ok: true });
  });

  app.get("/conversations", (c) => {
    const conversations = Array.from(sessions.entries()).map(([id, sess]) => ({
      id,
      messageCount: sess.messages.length,
      lastMessage: sess.messages[sess.messages.length - 1]?.content?.slice(0, 100) || "",
    }));
    return c.json(conversations);
  });

  return app;
}
