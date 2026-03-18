import { useState, useEffect, useRef } from "react";

const LEVEL_CLASS: Record<string, string> = {
  INFO: "INFO",
  WARN: "WARN",
  ERROR: "ERROR",
  EVENT: "EVENT",
};

function parseTimestamp(line: string) {
  const m = line.match(/^(\S+)/);
  return m ? m[1] : "";
}


export default function Logs() {
  const [lines, setLines] = useState<string[]>([]);
  const [trailing, setTrailing] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastTsRef = useRef("");
  const [reconnectKey, setReconnectKey] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!trailing) {
      esRef.current?.close();
      esRef.current = null;
      return;
    }

    const url = lastTsRef.current
      ? `/api/logs/stream?since=${encodeURIComponent(lastTsRef.current)}`
      : "/api/logs/stream";
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      const line = JSON.parse(e.data);
      setLines((prev) => [...prev, line]);
      const ts = parseTimestamp(line);
      if (ts) lastTsRef.current = ts;
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      if (trailing) setTimeout(() => setReconnectKey((k) => k + 1), 2000);
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [trailing, reconnectKey]);

  useEffect(() => {
    if (autoScroll && wrapRef.current) {
      wrapRef.current.scrollTop = wrapRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const handleScroll = () => {
    if (wrapRef.current) {
      const { scrollTop, clientHeight, scrollHeight } = wrapRef.current;
      setAutoScroll(scrollTop + clientHeight >= scrollHeight - 20);
    }
  };

  const scrollToBottom = () => {
    setAutoScroll(true);
    wrapRef.current?.scrollTo({ top: wrapRef.current.scrollHeight });
  };

  const clear = () => setLines([]);

  const handleTrailClick = (live: boolean) => {
    setTrailing(live);
    if (live) {
      setAutoScroll(true);
    } else {
      esRef.current?.close();
      esRef.current = null;
    }
  };

  return (
    <>
      <div style={toolbarStyle}>
        <div style={segStyle}>
          <button
            onClick={() => handleTrailClick(true)}
            style={{ ...segBtnStyle, ...(trailing ? segBtnActiveStyle : {}) }}
          >
            live
          </button>
          <button
            onClick={() => handleTrailClick(false)}
            style={{ ...segBtnStyle, ...(!trailing ? segBtnActiveStyle : {}) }}
          >
            stopped
          </button>
        </div>
        <div style={{ ...dotStyle, background: trailing ? "var(--green)" : "var(--text3)" }} />
        <div style={toolbarRightStyle}>
          <button style={btnStyle} onClick={clear}>
            clear
          </button>
          <button style={iconBtnStyle} onClick={scrollToBottom} title="Scroll to bottom">
            ↓
          </button>
        </div>
      </div>
      <div
        ref={wrapRef}
        style={logWrapStyle}
        onScroll={handleScroll}
      >
        {lines.map((line, i) => {
          const m = line.match(/^(\S+) \[(\w+)\] (.*)$/s);
          const cls = m ? (LEVEL_CLASS[m[2]] || "INFO") : "INFO";
          return (
            <div key={i} style={logLineStyle}>
              {m ? (
                <>
                  <span style={tsStyle}>{m[1]}</span>{" "}
                  <span style={levelStyle[cls]}>[{m[2]}]</span> {m[3]}
                </>
              ) : (
                line
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "7px 16px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg)",
  flexShrink: 0,
};

const segStyle: React.CSSProperties = {
  display: "flex",
  border: "0.5px solid var(--border)",
  borderRadius: 6,
  overflow: "hidden",
};

const segBtnStyle: React.CSSProperties = {
  background: "var(--bg-subtle)",
  border: "none",
  color: "var(--text2)",
  fontFamily: "inherit",
  fontSize: 10,
  padding: "4px 10px",
  cursor: "pointer",
};

const segBtnActiveStyle: React.CSSProperties = {
  background: "var(--accent)",
  color: "#fff",
};

const dotStyle: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: "50%",
  flexShrink: 0,
};

const toolbarRightStyle: React.CSSProperties = {
  marginLeft: "auto",
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const btnStyle: React.CSSProperties = {
  background: "var(--bg3)",
  border: "0.5px solid var(--border)",
  color: "var(--text)",
  fontFamily: "inherit",
  fontSize: 10,
  fontWeight: 600,
  padding: "0 10px",
  height: 26,
  borderRadius: 5,
  cursor: "pointer",
};

const iconBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text2)",
  fontFamily: "inherit",
  fontSize: 14,
  width: 26,
  height: 26,
  borderRadius: 5,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const logWrapStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "10px 16px",
};

const logLineStyle: React.CSSProperties = {
  fontSize: 10,
  lineHeight: 1.7,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

const tsStyle: React.CSSProperties = { color: "var(--text3)" };

const levelStyle: Record<string, React.CSSProperties> = {
  INFO: { color: "var(--text2)" },
  WARN: { color: "var(--orange)" },
  ERROR: { color: "var(--red)" },
  EVENT: { color: "var(--cyan)" },
};
