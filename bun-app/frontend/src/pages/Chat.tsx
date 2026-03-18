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

const KEYFRAMES = `
@keyframes pulse-fade {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 0.7; }
}
.chat-markdown { white-space: normal; }
.chat-markdown p { margin: 0 0 0.6em 0; }
.chat-markdown p:last-child { margin-bottom: 0; }
.chat-markdown strong { font-weight: 600; }
.chat-markdown ul { margin: 0.4em 0; padding-left: 1.2em; }
.chat-markdown li { margin: 0.2em 0; }
.chat-markdown h2, .chat-markdown h3 { font-size: 12px; font-weight: 600; margin: 0.8em 0 0.4em 0; }
.chat-markdown h2:first-child, .chat-markdown h3:first-child { margin-top: 0; }
.chat-markdown code { background: rgba(0,0,0,0.2); padding: 1px 4px; border-radius: 3px; font-size: 10px; }
.chat-markdown pre { background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 5px; overflow-x: auto; margin: 0.5em 0; font-size: 10px; max-width: 100%; }
.chat-markdown pre code { background: none; padding: 0; }
`;

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<ActivityStep[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
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
          const step: ActivityStep = {
            type: "tool_use",
            tool: msg.tool,
            toolInput: msg.toolInput,
            ts: Date.now(),
          };
          steps.push(step);
          setLiveSteps([...steps]);
        }

        if (msg.type === "tool_result") {
          const step: ActivityStep = {
            type: "tool_result",
            content: msg.content,
            ts: Date.now(),
          };
          steps.push(step);
          setLiveSteps([...steps]);
        }

        if (msg.type === "text") {
          assistantContent += msg.content || "";
          setMessages((prev) => {
            const newMessages = [...prev];
            const lastMsg = newMessages[newMessages.length - 1];
            if (lastMsg?.role === "assistant") {
              lastMsg.content = assistantContent;
              lastMsg.toolsUsed = [...toolsUsed];
              lastMsg.steps = [...steps];
              lastMsg.cost = cost;
              lastMsg.turns = turns;
            } else {
              newMessages.push({
                role: "assistant",
                content: assistantContent,
                toolsUsed: [...toolsUsed],
                steps: [...steps],
                cost,
                turns,
              });
            }
            return newMessages;
          });
        }

        if (msg.type === "result") {
          cost = msg.cost;
          turns = msg.turns;
          // Update cost/turns on final message
          setMessages((prev) => {
            const newMessages = [...prev];
            const lastMsg = newMessages[newMessages.length - 1];
            if (lastMsg?.role === "assistant") {
              lastMsg.cost = cost;
              lastMsg.turns = turns;
            }
            return newMessages;
          });
        }

        if (msg.type === "error") {
          setError(msg.content || "Unknown error");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setLoading(false);
      setLiveSteps([]);
    }
  };

  const handleClear = async () => {
    if (conversationId) {
      await clearConversation(conversationId);
    }
    setMessages([]);
    setConversationId(null);
    setError(null);
  };

  const formatToolName = (name: string) =>
    name.replace(/^mcp__\w+__/, "").replace(/_/g, " ");

  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  const toggleStep = (key: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderSteps = (steps: ActivityStep[], msgKey?: number) => {
    if (steps.length === 0) return null;
    return (
      <div style={stepsContainerStyle}>
        {steps.map((step, i) => {
          const key = msgKey !== undefined ? `msg-${msgKey}-${i}` : `live-${i}`;
          const isToolUse = step.type === "tool_use";
          const label = isToolUse ? formatToolName(step.tool || "") : "result";
          const hasExpandable = (isToolUse && step.toolInput) || (!isToolUse && step.content);
          const expanded = expandedSteps.has(key);

          return (
            <div key={key} style={stepItemStyle}>
              <button
                type="button"
                style={stepHeaderStyle}
                onClick={() => hasExpandable && toggleStep(key)}
              >
                <span style={stepIconStyle}>{isToolUse ? "→" : "←"}</span>
                <span style={stepLabelStyle}>{label}</span>
                {hasExpandable && (
                  <span style={expandIconStyle}>{expanded ? "▾" : "▸"}</span>
                )}
              </button>
              {hasExpandable && expanded && (
                <pre style={stepExpandStyle}>
                  {isToolUse ? step.toolInput : (step.content || "ok")}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={pageStyle}>
      <style>{KEYFRAMES}</style>

      <div style={headerStyle}>
        <div style={headerTopStyle}>
          <div />
          {messages.length > 0 && (
            <button style={clearBtnStyle} onClick={handleClear}>
              clear
            </button>
          )}
        </div>
      </div>

      <div style={chatContainerStyle}>
        <div style={messagesContainerStyle}>
          {messages.length === 0 && !loading && (
            <div style={emptyStateStyle}>
              <div style={emptyIconStyle}>↗</div>
              <div style={emptyTitleStyle}>start a conversation</div>
              <div style={emptySubStyle}>
                Ask the agent anything — it can query your activity data
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} style={messageRowStyle(msg.role)}>
              <div style={messageBubbleStyle(msg.role)}>
                {msg.role === "assistant" && msg.steps && msg.steps.length > 0 && (
                  renderSteps(msg.steps, i)
                )}
                <div style={messageContentStyle} className={msg.role === "assistant" ? "chat-markdown" : ""}>
                  {msg.role === "assistant" ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  ) : (
                    msg.content
                  )}
                </div>
                {msg.role === "assistant" && msg.cost !== undefined && (
                  <div style={metaStyle}>
                    ${msg.cost.toFixed(4)} · {msg.turns} turn{msg.turns !== 1 ? "s" : ""}
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div style={loadingRowStyle}>
              <div style={loadingBubbleStyle}>
                {renderSteps(liveSteps)}
                <div style={dotsContainerStyle}>
                  <span style={{ ...dotStyle, animationDelay: "0s" }} />
                  <span style={{ ...dotStyle, animationDelay: "0.2s" }} />
                  <span style={{ ...dotStyle, animationDelay: "0.4s" }} />
                </div>
              </div>
            </div>
          )}

          {error && (
            <div style={errorRowStyle}>
              <div style={errorBubbleStyle}>
                <span style={errorDotStyle} />
                <span>{error}</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={handleSubmit} style={inputFormStyle}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="ask the agent anything..."
            style={inputStyle}
            disabled={loading}
            autoFocus
          />
          <button
            type="submit"
            style={{
              ...sendBtnStyle,
              opacity: loading || !input.trim() ? 0.4 : 1,
              cursor: loading || !input.trim() ? "default" : "pointer",
            }}
            disabled={loading || !input.trim()}
          >
            send
          </button>
        </form>
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  maxWidth: 680,
  width: "100%",
  margin: "0 auto",
  padding: "24px 20px 14px",
};

const headerStyle: React.CSSProperties = { marginBottom: 14, flexShrink: 0 };

const headerTopStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const clearBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "0.5px solid var(--border)",
  color: "var(--text3)",
  fontFamily: "inherit",
  fontSize: 10,
  padding: "4px 12px",
  borderRadius: 5,
  cursor: "pointer",
  transition: "color 0.15s, border-color 0.15s",
  marginLeft: "auto",
};

const chatContainerStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  background: "var(--bg2)",
  border: "0.5px solid var(--border)",
  borderRadius: 10,
  overflow: "hidden",
  minHeight: 0,
};

const messagesContainerStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "20px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const emptyStateStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "center",
  textAlign: "center",
  padding: 40,
  gap: 8,
};

const emptyIconStyle: React.CSSProperties = {
  fontSize: 18,
  color: "var(--text3)",
  opacity: 0.5,
  marginBottom: 4,
};

const emptyTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: "var(--text2)",
};

const emptySubStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text3)",
  maxWidth: 260,
  lineHeight: 1.6,
};

const messageRowStyle = (role: "user" | "assistant"): React.CSSProperties => ({
  display: "flex",
  justifyContent: role === "user" ? "flex-end" : "flex-start",
});

const messageBubbleStyle = (role: "user" | "assistant"): React.CSSProperties => ({
  maxWidth: "85%",
  padding: "9px 13px",
  borderRadius: role === "user" ? "10px 10px 3px 10px" : "10px 10px 10px 3px",
  fontSize: 11,
  lineHeight: 1.55,
  background: role === "user" ? "var(--accent)" : "var(--bg3)",
  color: role === "user" ? "#fff" : "var(--text)",
  overflow: "hidden",
});

const messageContentStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  overflow: "hidden",
};

const stepsContainerStyle: React.CSSProperties = {
  marginBottom: 8,
  paddingBottom: 8,
  borderBottom: "0.5px solid rgba(255,255,255,0.06)",
  display: "flex",
  flexDirection: "column",
  gap: 5,
};

const stepItemStyle: React.CSSProperties = {
  border: "0.5px solid rgba(255,255,255,0.06)",
  borderRadius: 5,
  overflow: "hidden",
};

const stepHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "5px 8px",
  background: "transparent",
  border: "none",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: 9,
  textAlign: "left",
  cursor: "pointer",
};

const stepIconStyle: React.CSSProperties = {
  color: "var(--text3)",
  flexShrink: 0,
  fontSize: 8,
};

const stepLabelStyle: React.CSSProperties = {
  color: "var(--cyan)",
  fontWeight: 500,
  flex: 1,
};

const expandIconStyle: React.CSSProperties = {
  color: "var(--text3)",
  fontSize: 8,
  flexShrink: 0,
};

const stepExpandStyle: React.CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  fontSize: 9,
  lineHeight: 1.5,
  color: "var(--text3)",
  background: "rgba(0,0,0,0.15)",
  borderTop: "0.5px solid rgba(255,255,255,0.06)",
  overflow: "auto",
  maxHeight: 200,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

const metaStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 9,
  color: "var(--text3)",
  opacity: 0.7,
};

const loadingRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-start",
};

const loadingBubbleStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "10px 10px 10px 3px",
  background: "var(--bg3)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minWidth: 52,
  maxWidth: "85%",
};

const dotsContainerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  height: 14,
};

const dotStyle: React.CSSProperties = {
  width: 4,
  height: 4,
  borderRadius: "50%",
  background: "var(--text3)",
  animation: "pulse-fade 1.2s ease-in-out infinite",
};

const errorRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-start",
};

const errorBubbleStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  fontSize: 10,
  color: "var(--red)",
  padding: "8px 13px",
  background: "rgba(255, 69, 58, 0.08)",
  borderRadius: "10px 10px 10px 3px",
  border: "0.5px solid rgba(255, 69, 58, 0.15)",
  maxWidth: "80%",
};

const errorDotStyle: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: "50%",
  background: "var(--red)",
  flexShrink: 0,
};

const inputFormStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "10px 14px",
  borderTop: "0.5px solid var(--border)",
  background: "var(--bg)",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: "var(--bg2)",
  border: "0.5px solid var(--border)",
  borderRadius: 7,
  color: "var(--text)",
  fontFamily: "inherit",
  fontSize: 11,
  padding: "9px 12px",
  outline: "none",
  transition: "border-color 0.15s",
};

const sendBtnStyle: React.CSSProperties = {
  background: "var(--accent)",
  border: "none",
  color: "#fff",
  fontFamily: "inherit",
  fontSize: 10,
  fontWeight: 600,
  padding: "0 18px",
  height: 32,
  borderRadius: 7,
  flexShrink: 0,
  transition: "opacity 0.15s",
};
