import { useState, useEffect, useCallback } from "react";
import { fetchEvents, deleteAllEvents } from "../api";
import { DataTable, cellStyles, type Column } from "../components/DataTable";

const TYPE_COLORS: Record<string, string> = {
  CLICK: "#0a84ff",
  TYPING: "#30d158",
  SCROLL: "#98989d",
  COPY: "#ff9f0a",
  PASTE: "#ff9f0a",
  SHORTCUT: "#bf5af2",
  "APP SWITCH": "rgba(255,255,255,0.28)",
  KEY: "#32ade6",
};

interface RawEvent {
  id: number;
  timestamp: string;
  app: string;
  event_type: string;
  detail: string | null;
  interpretation: string | null;
  task_id: number | null;
}

function formatTime(iso: string) {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return iso;
  }
}

function dateRange(filter: string) {
  const now = new Date();
  const ranges: Record<string, number> = { "1h": 3600, "12h": 43200, "24h": 86400, "7d": 604800 };
  const since = new Date(now.getTime() - (ranges[filter] ?? 3600) * 1000);
  return { since: since.toISOString(), until: now.toISOString() };
}

const columns: Column<RawEvent>[] = [
  { key: "timestamp", header: "timestamp", render: (e) => formatTime(e.timestamp), style: cellStyles.text2, width: 110 },
  {
    key: "type",
    header: "type",
    width: 85,
    render: (e) => (
      <div style={typeCellStyle}>
        <div style={{ ...dotStyle, background: TYPE_COLORS[e.event_type] || "rgba(255,255,255,0.5)" }} />
        <span style={{ color: TYPE_COLORS[e.event_type] || "rgba(255,255,255,0.5)" }}>
          {e.event_type.toLowerCase()}
        </span>
      </div>
    ),
  },
  { key: "app", header: "app", render: (e) => e.app, style: cellStyles.text, width: 120 },
  { key: "task", header: "task", render: (e) => e.task_id ?? "—", style: cellStyles.text3, width: 45 },
  { key: "detail", header: "detail", render: (e) => e.detail || "—", style: cellStyles.text2, flex: true },
  { key: "interpretation", header: "interpretation", render: (e) => e.interpretation || "—", style: cellStyles.italic, flex: true },
];

const typeCellStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
};

const dotStyle: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: "50%",
  flexShrink: 0,
};

export default function Events() {
  const [events, setEvents] = useState<RawEvent[]>([]);
  const [filter, setFilter] = useState("1h");
  const [live, setLive] = useState(true);
  const [popover, setPopover] = useState<{ event: RawEvent; x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    const { since, until } = dateRange(filter);
    const data = await fetchEvents({ limit: 20000, since, until });
    setEvents(data);
  }, [filter]);

  useEffect(() => {
    load();
    if (!live) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [live, load]);

  const handleDeleteAll = async () => {
    if (!confirm("Delete all events? This cannot be undone.")) return;
    try {
      const data = await deleteAllEvents();
      if (data.ok) {
        setEvents([]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDoubleClick = (e: RawEvent, ev: React.MouseEvent) => {
    setPopover({ event: e, x: ev.clientX + 8, y: ev.clientY + 8 });
  };

  let detail = popover?.event.detail ?? "";
  try {
    detail = JSON.stringify(JSON.parse(detail), null, 2);
  } catch {}

  return (
    <>
      <DataTable
        data={events}
        columns={columns}
        onDoubleClick={handleDoubleClick}
        emptyMessage="no events in this range"
        countLabel="events"
        toolbarLeft={
          <>
            <button
              style={iconBtnStyle}
              onClick={() => setLive(!live)}
              title={live ? "Pause live updates" : "Resume live updates"}
            >
              {live ? "⏸" : "▶"}
            </button>
            <div style={segStyle}>
              {(["1h", "12h", "24h", "7d"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  style={{ ...segBtnStyle, ...(filter === f ? segBtnActiveStyle : {}) }}
                >
                  {f}
                </button>
              ))}
            </div>
          </>
        }
        toolbarRight={
          <button style={deleteBtnStyle} onClick={handleDeleteAll} title="Delete all events">
            delete all
          </button>
        }
      />

      {popover && (
        <div style={overlayStyle} onClick={() => setPopover(null)}>
          <div
            style={{
              ...popoverStyle,
              left: Math.min(popover.x, window.innerWidth - 400),
              top: Math.min(popover.y, window.innerHeight - 250),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={popoverHeaderStyle}>
              <span style={{ ...dotStyle, background: TYPE_COLORS[popover.event.event_type] || "#999" }} />
              <span style={popoverTypeStyle}>{popover.event.event_type}</span>
              <span style={popoverAppStyle}>{popover.event.app}</span>
              <button
                style={popoverCopyStyle}
                onClick={() => navigator.clipboard.writeText(popover.event.detail ?? "")}
              >
                copy
              </button>
            </div>
            <pre style={popoverDetailStyle}>{detail || "—"}</pre>
          </div>
        </div>
      )}
    </>
  );
}

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

const deleteBtnStyle: React.CSSProperties = {
  background: "var(--bg3)",
  border: "0.5px solid var(--border)",
  color: "var(--red)",
  fontFamily: "inherit",
  fontSize: 10,
  padding: "4px 10px",
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

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 100,
};

const popoverStyle: React.CSSProperties = {
  position: "fixed",
  background: "var(--bg2)",
  border: "0.5px solid var(--border)",
  borderRadius: 8,
  padding: 16,
  minWidth: 380,
  maxWidth: 540,
  zIndex: 101,
  boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
};

const popoverHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 10,
};

const popoverTypeStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600 };
const popoverAppStyle: React.CSSProperties = { color: "var(--text3)", fontSize: 10 };

const popoverCopyStyle: React.CSSProperties = {
  marginLeft: "auto",
  background: "transparent",
  border: "0.5px solid var(--border)",
  color: "var(--text2)",
  fontFamily: "inherit",
  fontSize: 10,
  padding: "3px 8px",
  borderRadius: 4,
  cursor: "pointer",
};

const popoverDetailStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "0.5px solid var(--border)",
  borderRadius: 5,
  padding: 10,
  fontSize: 10,
  color: "var(--text)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  maxHeight: 200,
  overflowY: "auto",
  margin: 0,
};
