import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sendAgentMessage, clearConversation } from "../api";

interface ActivityStep {
  type: "tool_use" | "tool_result";
  tool?: string;
  toolInput?: string;
  content?: string;
  ts: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  toolsUsed?: string[];
  steps?: ActivityStep[];
  cost?: number;
  turns?: number;
}

// Module-level state persists across component mounts (e.g. navigating away and back)
const _state = {
  messages: [] as Message[],
  conversationId: null as string | null,
};

const KEYFRAMES = `
@keyframes cp-pulse {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 0.7; }
}
.cp-md { white-space: normal; line-height: 1.45; }
.cp-md p { margin: 0.2em 0; }
.cp-md p:first-child { margin-top: 0; }
.cp-md p:last-child { margin-bottom: 0; }
.cp-md p:empty { display: none; }
.cp-md strong { font-weight: 600; }
.cp-md ul, .cp-md ol { margin: 0.2em 0; padding-left: 1.1em; }
.cp-md li { margin: 0.04em 0; }
.cp-md li > p { margin: 0; }
.cp-md h2, .cp-md h3 { font-size: 11px; font-weight: 600; margin: 0.35em 0 0.15em 0; }
.cp-md h2:first-child, .cp-md h3:first-child { margin-top: 0; }
.cp-md br + br { display: none; }
.cp-md code { background: rgba(0,0,0,0.2); padding: 1px 4px; border-radius: 3px; font-size: 9.5px; }
.cp-md pre { background: rgba(0,0,0,0.2); padding: 6px 8px; border-radius: 4px; overflow-x: auto; margin: 0.35em 0; font-size: 9.5px; }
.cp-md pre code { background: none; padding: 0; }
`;

function compactAssistantMarkdown(raw: string): string {
  return raw
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export default function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>(() => _state.messages);
  const [conversationId, setConversationId] = useState<string | null>(() => _state.conversationId);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<ActivityStep[]>([]);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Keep module state in sync
  useEffect(() => { _state.messages = messages; }, [messages]);
  useEffect(() => { _state.conversationId = conversationId; }, [conversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, liveSteps]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput("");
    setError(null);
    setLiveSteps([]);
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setLoading(true);

    try {
      let assistantContent = "";
      const toolsUsed: string[] = [];
      const steps: ActivityStep[] = [];
      let newConversationId = conversationId;
      let cost: number | undefined;
      let turns: number | undefined;

      for await (const msg of sendAgentMessage(userMessage, conversationId || undefined)) {
        if (!newConversationId && msg.conversationId) {
          newConversationId = msg.conversationId;
          setConversationId(msg.conversationId);
        }

        if (msg.type === "tool_use" && msg.tool) {
          toolsUsed.push(msg.tool);
          steps.push({ type: "tool_use", tool: msg.tool, toolInput: msg.toolInput, ts: Date.now() });
          setLiveSteps([...steps]);
        }

        if (msg.type === "tool_result") {
          steps.push({ type: "tool_result", content: msg.content, ts: Date.now() });
          setLiveSteps([...steps]);
        }

        if (msg.type === "text") {
          assistantContent += msg.content || "";
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              last.content = assistantContent;
              last.toolsUsed = [...toolsUsed];
              last.steps = [...steps];
              last.cost = cost;
              last.turns = turns;
            } else {
              next.push({ role: "assistant", content: assistantContent, toolsUsed: [...toolsUsed], steps: [...steps], cost, turns });
            }
            return next;
          });
        }

        if (msg.type === "result") {
          cost = msg.cost;
          turns = msg.turns;
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") { last.cost = cost; last.turns = turns; }
            return next;
          });
        }

        if (msg.type === "error") setError(msg.content || "Unknown error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setLoading(false);
      setLiveSteps([]);
    }
  };

  const handleReset = async () => {
    if (conversationId) await clearConversation(conversationId);
    setMessages([]);
    setConversationId(null);
    setError(null);
    _state.messages = [];
    _state.conversationId = null;
  };

  const formatToolName = (name: string) => name.replace(/^mcp__\w+__/, "").replace(/_/g, " ");

  const toggleStep = (key: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const renderSteps = (steps: ActivityStep[], msgKey?: number) => {
    if (steps.length === 0) return null;
    return (
      <div style={stepsContainer}>
        {steps.map((step, i) => {
          const key = msgKey !== undefined ? `msg-${msgKey}-${i}` : `live-${i}`;
          const isToolUse = step.type === "tool_use";
          const label = isToolUse ? formatToolName(step.tool || "") : "result";
          const hasExpandable = (isToolUse && step.toolInput) || (!isToolUse && step.content);
          const expanded = expandedSteps.has(key);
          return (
            <div key={key} style={stepItem}>
              <button type="button" style={stepHeader} onClick={() => hasExpandable && toggleStep(key)}>
                <span style={stepIcon}>{isToolUse ? "→" : "←"}</span>
                <span style={stepLabel}>{label}</span>
                {hasExpandable && <span style={expandIcon}>{expanded ? "▾" : "▸"}</span>}
              </button>
              {hasExpandable && expanded && (
                <pre style={stepExpand}>{isToolUse ? step.toolInput : (step.content || "ok")}</pre>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={panelWrap}>
      <style>{KEYFRAMES}</style>

      {/* Header */}
      <div style={panelHeader}>
        <span style={panelTitle}>insights</span>
        <button
          style={{ ...resetBtn, opacity: messages.length > 0 ? 1 : 0.35, cursor: messages.length > 0 ? "pointer" : "default" }}
          onClick={handleReset}
          disabled={messages.length === 0}
        >reset</button>
      </div>

      {/* Messages */}
      <div style={messagesArea}>
        {messages.length === 0 && !loading && (
          <div style={emptyState}>
            <div style={emptyIcon}>↗</div>
            <div style={emptyTitle}>ask about your activity</div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={msgRow(msg.role)}>
            <div style={msgBubble(msg.role)}>
              {msg.role === "assistant" && msg.steps && msg.steps.length > 0 && renderSteps(msg.steps, i)}
              <div
                style={msg.role === "assistant" ? msgContentAssistant : msgContent}
                className={msg.role === "assistant" ? "cp-md" : ""}
              >
                {msg.role === "assistant" ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {compactAssistantMarkdown(msg.content)}
                  </ReactMarkdown>
                ) : (
                  msg.content
                )}
              </div>
              {msg.role === "assistant" && msg.cost !== undefined && (
                <div style={metaRow}>${msg.cost.toFixed(4)} · {msg.turns} turn{msg.turns !== 1 ? "s" : ""}</div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={loadingBubble}>
              {renderSteps(liveSteps)}
              <div style={dotsRow}>
                <span style={{ ...dot, animationDelay: "0s" }} />
                <span style={{ ...dot, animationDelay: "0.2s" }} />
                <span style={{ ...dot, animationDelay: "0.4s" }} />
              </div>
            </div>
          </div>
        )}

        {error && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={errorBubble}>
              <span style={errorDot} />
              <span>{error}</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} style={inputForm}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="ask anything..."
          style={inputField}
          disabled={loading}
        />
        <button
          type="submit"
          style={{ ...sendBtn, opacity: loading || !input.trim() ? 0.4 : 1, cursor: loading || !input.trim() ? "default" : "pointer" }}
          disabled={loading || !input.trim()}
        >
          ↑
        </button>
      </form>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const panelWrap: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  background: "var(--bg)",
};

const panelHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 14px",
  borderBottom: "0.5px solid var(--border)",
  flexShrink: 0,
};

const panelTitle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--text3)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const resetBtn: React.CSSProperties = {
  background: "transparent",
  border: "0.5px solid var(--border)",
  color: "var(--text3)",
  fontFamily: "inherit",
  fontSize: 9,
  padding: "3px 9px",
  borderRadius: 4,
  cursor: "pointer",
};

const messagesArea: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "14px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const emptyState: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "center",
  gap: 6,
  padding: 24,
  textAlign: "center",
};

const emptyIcon: React.CSSProperties = { fontSize: 16, color: "var(--text3)", opacity: 0.4 };
const emptyTitle: React.CSSProperties = { fontSize: 10, color: "var(--text3)" };

const msgRow = (role: "user" | "assistant"): React.CSSProperties => ({
  display: "flex",
  justifyContent: role === "user" ? "flex-end" : "flex-start",
});

const msgBubble = (role: "user" | "assistant"): React.CSSProperties => ({
  maxWidth: "90%",
  padding: "8px 11px",
  borderRadius: role === "user" ? "10px 10px 3px 10px" : "10px 10px 10px 3px",
  fontSize: 10.5,
  lineHeight: 1.55,
  background: role === "user" ? "var(--accent)" : "var(--bg2)",
  color: role === "user" ? "#fff" : "var(--text)",
  overflow: "hidden",
});

const msgContent: React.CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word", overflow: "hidden" };
const msgContentAssistant: React.CSSProperties = {
  whiteSpace: "normal",
  wordBreak: "break-word",
  overflow: "hidden",
};
const metaRow: React.CSSProperties = { marginTop: 5, fontSize: 9, color: "var(--text3)", opacity: 0.7 };

const stepsContainer: React.CSSProperties = {
  marginBottom: 7,
  paddingBottom: 7,
  borderBottom: "0.5px solid rgba(255,255,255,0.06)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const stepItem: React.CSSProperties = { border: "0.5px solid rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden" };

const stepHeader: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 5, width: "100%",
  padding: "4px 7px", background: "transparent", border: "none",
  color: "inherit", fontFamily: "inherit", fontSize: 9, textAlign: "left", cursor: "pointer",
};

const stepIcon: React.CSSProperties = { color: "var(--text3)", flexShrink: 0, fontSize: 8 };
const stepLabel: React.CSSProperties = { color: "var(--cyan)", fontWeight: 500, flex: 1 };
const expandIcon: React.CSSProperties = { color: "var(--text3)", fontSize: 8, flexShrink: 0 };

const stepExpand: React.CSSProperties = {
  margin: 0, padding: "6px 8px", fontSize: 9, lineHeight: 1.5,
  color: "var(--text3)", background: "rgba(0,0,0,0.15)",
  borderTop: "0.5px solid rgba(255,255,255,0.06)",
  overflow: "auto", maxHeight: 160, whiteSpace: "pre-wrap", wordBreak: "break-all",
};

const loadingBubble: React.CSSProperties = {
  padding: "9px 12px", borderRadius: "10px 10px 10px 3px",
  background: "var(--bg2)", display: "flex", flexDirection: "column", gap: 6, maxWidth: "90%",
};

const dotsRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, height: 12 };

const dot: React.CSSProperties = {
  width: 3.5, height: 3.5, borderRadius: "50%",
  background: "var(--text3)", animation: "cp-pulse 1.2s ease-in-out infinite",
};

const errorBubble: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, fontSize: 9.5,
  color: "var(--red)", padding: "7px 11px",
  background: "rgba(255, 69, 58, 0.08)", borderRadius: "10px 10px 10px 3px",
  border: "0.5px solid rgba(255, 69, 58, 0.15)", maxWidth: "90%",
};

const errorDot: React.CSSProperties = { width: 4, height: 4, borderRadius: "50%", background: "var(--red)", flexShrink: 0 };

const inputForm: React.CSSProperties = {
  display: "flex", gap: 6, padding: "10px 12px",
  borderTop: "0.5px solid var(--border)", flexShrink: 0,
};

const inputField: React.CSSProperties = {
  flex: 1, background: "var(--bg2)", border: "0.5px solid var(--border)",
  borderRadius: 6, color: "var(--text)", fontFamily: "inherit", fontSize: 10.5,
  padding: "7px 10px", outline: "none",
};

const sendBtn: React.CSSProperties = {
  background: "var(--accent)", border: "none", color: "#fff",
  fontFamily: "inherit", fontSize: 13, fontWeight: 600,
  width: 30, height: 30, borderRadius: 6, flexShrink: 0,
  display: "flex", alignItems: "center", justifyContent: "center",
  transition: "opacity 0.15s",
};
