import { Hono } from "hono";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../logger";
import { dbPath } from "../db";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatSession {
  sessionId: string | null;
  messages: ChatMessage[];
}

const sessions = new Map<string, ChatSession>();

export function agentRoute(): Hono {
  const app = new Hono();

  // POST /api/agent/chat — Send a message to the Claude agent
  // Supports SSE streaming for real-time responses
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
      session = { sessionId: null, messages: [] };
      sessions.set(conversationId, session);
    }

    session.messages.push({ role: "user", content: body.message });

    const stream = new ReadableStream({
      async start(controller) {
        try {
          let fullResponse = "";
          let capturedSessionId: string | null = session!.sessionId;

          const queryOptions: any = {
            model: "claude-haiku-4-5",
            mcpServers: {
              tracker: {
                command: "npx",
                args: ["-y", "mcp-server-sqlite-npx", dbPath],
              },
            },
            allowedTools: [
              "mcp__tracker__read_query",
              "mcp__tracker__list_tables",
              "mcp__tracker__describe_table",
            ],
            disallowedTools: ["Bash", "Read", "Write", "Edit", "WebSearch", "WebFetch", "Glob", "Grep"],
            debug: true,
            stderr: (data: string) => logger.info("agent:stderr", { data: data.trim() }),
          };

          if (capturedSessionId) {
            queryOptions.resume = capturedSessionId;
          }

          const systemContext = `You have access to an SQLite database (via MCP server "tracker") containing activity tracking data. Use read_query for SELECT only (writes are disabled).

IMPORTANT:
- Always use LIMIT in your queries (max 100 rows). Never query without a LIMIT clause.
- Timestamps are stored in ISO 8601 UTC format (e.g. 2026-03-17T16:11:00.000Z). For time-range filters, use strftime so the cutoff matches this format. Example for "last 10 minutes": \`WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-10 minutes'))\`. Never use datetime('now') or datetime('now', '-10 minutes') directly in comparisons—the format would be wrong.

Available table:
- raw_events: you may ONLY query the "timestamp" and "interpretation" columns. Do NOT select or reference any other columns (app, event_type, detail are off-limits).`;

          logger.info("agent:start", { conversationId, prompt: body.message.slice(0, 80) });

          // Track tool IDs from internal SDK tools to suppress their results
          const suppressedToolIds = new Set<string>();

          for await (const message of query({
            prompt: body.message,
            options: {
              ...queryOptions,
              systemPrompt: systemContext,
            },
          })) {
            // Log every message for debugging
            const msg = message as any;
            const msgType = msg.type + (msg.subtype ? `:${msg.subtype}` : "");
            const logData: Record<string, unknown> = { type: msgType };

            if (msg.type === "assistant" && msg.message?.content) {
              const blocks = msg.message.content;
              if (Array.isArray(blocks)) {
                for (const b of blocks) {
                  if (b.type === "text") logData.text = b.text.slice(0, 120);
                  if (b.type === "tool_use") logData.tool = { name: b.name, input: b.input };
                }
              }
              logData.stopReason = msg.message.stop_reason;
            } else if (msg.type === "user" && msg.message?.content) {
              const blocks = msg.message.content;
              if (Array.isArray(blocks)) {
                for (const b of blocks) {
                  if (b.type === "tool_result") logData.toolResult = { id: b.tool_use_id, content: typeof b.content === "string" ? b.content.slice(0, 200) : "(structured)" };
                }
              }
            } else if (msg.type === "result") {
              logData.subtype = msg.subtype;
              logData.result = typeof msg.result === "string" ? msg.result.slice(0, 200) : undefined;
              logData.cost = msg.total_cost_usd;
              logData.turns = msg.num_turns;
            }

            logger.info("agent:msg", logData);

            // Capture session ID from init message
            if (message.type === "system" && message.subtype === "init") {
              capturedSessionId = (message as any).session_id;
              session!.sessionId = capturedSessionId;
              const mcpStatus = (message as any).mcp_servers;
              if (mcpStatus) logger.info("agent:mcp_init", { mcp_servers: mcpStatus });
            }

            // Stream assistant content (text + tool calls)
            if (msg.type === "assistant" && msg.message?.content) {
              const blocks = msg.message.content;
              if (Array.isArray(blocks)) {
                for (const block of blocks) {
                  if (block.type === "text" && block.text) {
                    fullResponse += block.text;
                    controller.enqueue(`data: ${JSON.stringify({ 
                      type: "text", 
                      content: block.text,
                      conversationId 
                    })}\n\n`);
                  }
                  if (block.type === "tool_use") {
                    // Skip internal SDK tools and track their IDs
                    if (block.name === "ToolSearch") {
                      suppressedToolIds.add(block.id);
                      continue;
                    }
                    
                    const toolInput = typeof block.input === "object" && block.input?.query
                      ? block.input.query
                      : undefined;
                    controller.enqueue(`data: ${JSON.stringify({ 
                      type: "tool_use", 
                      tool: block.name,
                      toolInput,
                      conversationId 
                    })}\n\n`);
                  }
                }
              }
            }

            // Stream tool results back to UI
            if (msg.type === "user" && msg.message?.content) {
              const blocks = msg.message.content;
              if (Array.isArray(blocks)) {
                for (const block of blocks) {
                  if (block.type === "tool_result") {
                    // Skip results from internal SDK tools
                    if (suppressedToolIds.has(block.tool_use_id)) {
                      suppressedToolIds.delete(block.tool_use_id);
                      continue;
                    }
                    
                    let preview: string | undefined;
                    if (typeof block.content === "string") {
                      preview = block.content.slice(0, 200);
                    } else if (Array.isArray(block.content)) {
                      const textPart = block.content.find((p: any) => p.type === "text");
                      if (textPart?.text) preview = textPart.text.slice(0, 200);
                    }
                    controller.enqueue(`data: ${JSON.stringify({
                      type: "tool_result",
                      content: preview,
                      conversationId
                    })}\n\n`);
                  }
                }
              }
            }

            // Stream final result (only metadata, not content - that was already streamed in text blocks)
            if (msg.type === "result") {
              controller.enqueue(`data: ${JSON.stringify({ 
                type: "result",
                cost: msg.total_cost_usd,
                turns: msg.num_turns,
                conversationId 
              })}\n\n`);
              // If no text was streamed yet, use the result as content
              if (!fullResponse && typeof msg.result === "string") {
                fullResponse = msg.result;
                controller.enqueue(`data: ${JSON.stringify({ 
                  type: "text", 
                  content: msg.result,
                  conversationId 
                })}\n\n`);
              }
            }
          }

          logger.info("agent:done", { conversationId });

          if (fullResponse) {
            session!.messages.push({ role: "assistant", content: fullResponse });
          }

          controller.enqueue(`data: ${JSON.stringify({ type: "done", conversationId })}\n\n`);
          controller.close();
        } catch (error) {
          logger.error("Agent chat error", error);
          controller.enqueue(`data: ${JSON.stringify({ 
            type: "error", 
            content: error instanceof Error ? error.message : "Unknown error",
            conversationId 
          })}\n\n`);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });

  // GET /api/agent/conversations/:id — Get conversation history
  app.get("/conversations/:id", (c) => {
    const id = c.req.param("id");
    const session = sessions.get(id);
    if (!session) {
      return c.json({ error: "conversation not found" }, 404);
    }
    return c.json({ 
      conversationId: id, 
      messages: session.messages 
    });
  });

  // DELETE /api/agent/conversations/:id — Clear a conversation
  app.delete("/conversations/:id", (c) => {
    const id = c.req.param("id");
    sessions.delete(id);
    return c.json({ ok: true });
  });

  // GET /api/agent/conversations — List all conversations
  app.get("/conversations", (c) => {
    const conversations = Array.from(sessions.entries()).map(([id, session]) => ({
      id,
      messageCount: session.messages.length,
      lastMessage: session.messages[session.messages.length - 1]?.content?.slice(0, 100) || "",
    }));
    return c.json(conversations);
  });

  return app;
}
