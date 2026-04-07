import { useState, useEffect, useCallback, useMemo } from "react";
import { fetchEventCategories, type CategorizedEvent } from "../api";
import ChatPanel from "../components/ChatPanel";

const CATEGORIES = ["Productivity", "Leisure", "Admin", "Learning", "Communication"] as const;
const RENDER_ORDER = [...CATEGORIES, "Uncategorized"] as const;

const CATEGORY_COLORS: Record<string, string> = {
  Productivity: "#0a84ff",
  Leisure: "#30d158",
  Admin: "#ff9f0a",
  Learning: "#bf5af2",
  Communication: "#32ade6",
  Uncategorized: "rgba(255,255,255,0.12)",
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  CLICK: "#0a84ff",
  TYPING: "#30d158",
  SCROLL: "#98989d",
  COPY: "#ff9f0a",
  PASTE: "#ff9f0a",
  SHORTCUT: "#bf5af2",
  "APP SWITCH": "rgba(255,255,255,0.28)",
  KEY: "#32ade6",
};

interface BucketBase { label: string; startMs: number; endMs: number }
interface BucketTask { taskId: number; title: string; category: string; count: number }
interface Bucket extends BucketBase {
  tasks: BucketTask[];
  total: number;
}

function formatHour(d: Date): string {
  const h = d.getHours();
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

function formatEventTime(iso: string) {
  const d = new Date(iso);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${m} ${ampm}`;
}

function generateBuckets(filter: string): BucketBase[] {
  const now = new Date();
  const buckets: BucketBase[] = [];
  let intervalMs: number, count: number, labelFn: (d: Date) => string;

  switch (filter) {
    case "1h":
      intervalMs = 5 * 60 * 1000; count = 12;
      labelFn = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
      break;
    case "12h":
      intervalMs = 60 * 60 * 1000; count = 12; labelFn = formatHour; break;
    case "24h":
      intervalMs = 60 * 60 * 1000; count = 24; labelFn = formatHour; break;
    case "7d":
      intervalMs = 24 * 60 * 60 * 1000; count = 7;
      labelFn = (d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
      break;
    case "30d":
      intervalMs = 24 * 60 * 60 * 1000; count = 30;
      labelFn = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
      break;
    default:
      intervalMs = 60 * 60 * 1000; count = 24; labelFn = formatHour;
  }

  const start = new Date(now.getTime() - count * intervalMs);
  for (let i = 0; i < count; i++) {
    const s = new Date(start.getTime() + i * intervalMs);
    buckets.push({ label: labelFn(s), startMs: s.getTime(), endMs: s.getTime() + intervalMs });
  }
  return buckets;
}

function shouldShowLabel(i: number, total: number): boolean {
  if (total <= 12) return true;
  if (total <= 24) return i % 2 === 0;
  return i % 5 === 0;
}

/** Wall-clock span from first to last event for this task in the bucket; at least 1 min if any events. */
function taskMinutesInBucket(
  events: CategorizedEvent[],
  taskId: number,
  startMs: number,
  endMs: number
): number {
  const times: number[] = [];
  for (const ev of events) {
    if (ev.task_id !== taskId) continue;
    const ts = new Date(ev.timestamp).getTime();
    if (ts < startMs || ts >= endMs) continue;
    times.push(ts);
  }
  if (times.length === 0) return 0;
  if (times.length === 1) return 1;
  times.sort((a, b) => a - b);
  const spanMs = times[times.length - 1] - times[0];
  return Math.max(1, Math.round(spanMs / 60000));
}

function dateRange(filter: string) {
  const now = new Date();
  const s: Record<string, number> = { "1h": 3600, "12h": 43200, "24h": 86400, "7d": 604800, "30d": 2592000 };
  const since = new Date(now.getTime() - (s[filter] ?? 86400) * 1000);
  return { since: since.toISOString(), until: now.toISOString() };
}

const catOrder = new Map(RENDER_ORDER.map((c, i) => [c, i]));

export default function Insights() {
  const [events, setEvents] = useState<CategorizedEvent[]>([]);
  const [filter, setFilter] = useState("24h");
  const [hovered, setHovered] = useState<{ barIndex: number; taskId: number; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<{ barIndex: number; taskId: number } | null>(null);

  const load = useCallback(async () => {
    const { since, until } = dateRange(filter);
    setEvents(await fetchEventCategories({ since, until }));
  }, [filter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setSelected(null);
    setHovered(null);
  }, [filter]);

  const rawBuckets = useMemo(() => generateBuckets(filter), [filter]);

  const bucketData: Bucket[] = useMemo(() => {
    return rawBuckets.map((b) => {
      const taskMap = new Map<number, BucketTask>();
      for (const ev of events) {
        const ts = new Date(ev.timestamp).getTime();
        if (ts < b.startMs || ts >= b.endMs) continue;
        const cat = ev.category ?? "Uncategorized";
        const existing = taskMap.get(ev.task_id);
        if (existing) {
          existing.count++;
        } else {
          taskMap.set(ev.task_id, { taskId: ev.task_id, title: ev.task_title, category: cat, count: 1 });
        }
      }
      const tasks = Array.from(taskMap.values())
        .sort((a, b) => (catOrder.get(a.category) ?? 99) - (catOrder.get(b.category) ?? 99) || a.taskId - b.taskId);
      const total = tasks.reduce((s, t) => s + t.count, 0);
      return { ...b, tasks, total };
    });
  }, [rawBuckets, events]);

  const maxTotal = useMemo(() => Math.max(...bucketData.map((b) => b.total), 1), [bucketData]);

  const categorySummary = useMemo(() => {
    const t: Record<string, number> = {};
    for (const c of RENDER_ORDER) t[c] = 0;
    for (const b of bucketData) for (const task of b.tasks) t[task.category] = (t[task.category] ?? 0) + task.count;
    return t;
  }, [bucketData]);

  const totalEvents = events.length;

  const hoveredTask = useMemo(() => {
    if (!hovered) return null;
    const bucket = bucketData[hovered.barIndex];
    if (!bucket) return null;
    return bucket.tasks.find((t) => t.taskId === hovered.taskId) ?? null;
  }, [hovered, bucketData]);

  const hoveredTaskMinutes = useMemo(() => {
    if (!hovered || !hoveredTask) return null;
    const bucket = bucketData[hovered.barIndex];
    if (!bucket) return null;
    return taskMinutesInBucket(events, hovered.taskId, bucket.startMs, bucket.endMs);
  }, [hovered, hoveredTask, bucketData, events]);

  const selectedData = useMemo(() => {
    if (!selected) return null;
    const bucket = bucketData[selected.barIndex];
    if (!bucket) return null;
    const task = bucket.tasks.find((t) => t.taskId === selected.taskId);
    if (!task) return null;
    const matching = events.filter((ev) => {
      const ts = new Date(ev.timestamp).getTime();
      return ts >= bucket.startMs && ts < bucket.endMs && ev.task_id === selected.taskId;
    });
    const taskDescription = matching[0]?.task_description ?? "";
    const minutes = taskMinutesInBucket(events, selected.taskId, bucket.startMs, bucket.endMs);
    return { bucket, task, taskDescription, events: matching, minutes };
  }, [selected, bucketData, events]);

  const handleSegmentClick = (barIndex: number, taskId: number) => {
    if (selected?.barIndex === barIndex && selected?.taskId === taskId) {
      setSelected(null);
    } else {
      setSelected({ barIndex, taskId });
    }
  };

  return (
    <div style={scrollWrap}>
      <div style={pageStyle}>
        <div style={mainLayout}>
          <div style={leftPane}>
            {/* Toolbar */}
            <div style={toolbarStyle}>
              <div style={segStyle}>
                {(["1h", "12h", "24h", "7d", "30d"] as const).map((f) => (
                  <button key={f} onClick={() => setFilter(f)}
                    style={{ ...segBtnStyle, ...(filter === f ? segBtnActiveStyle : {}) }}>{f}</button>
                ))}
              </div>
            </div>

            {totalEvents === 0 ? (
              <div style={emptyStyle}>
                <div style={{ fontSize: 22, marginBottom: 4 }}>⬚</div>
                <div>no categorized activity in this period</div>
              </div>
            ) : (
              <>
                {/* Chart */}
                <div style={chartContainer}>
                  <div style={chartArea}>
                    {bucketData.map((bucket, i) => {
                      const barHeight = (bucket.total / maxTotal) * 100;
                      const isBarSelected = selected?.barIndex === i;

                      const barHasHoveredTask = hovered ? bucket.tasks.some((t) => t.taskId === hovered.taskId) : false;
                      const barColOpacity = selected && !isBarSelected ? 0.35
                        : hovered && !barHasHoveredTask ? 0.35
                        : 1;

                      return (
                        <div key={i} style={{ ...barCol, opacity: barColOpacity }}>
                          <div style={{ ...barStack, height: `${barHeight}%` }}>
                            {bucket.tasks.map((task, ti) => {
                              const pct = (task.count / bucket.total) * 100;
                              const isLast = ti === bucket.tasks.length - 1;
                              const isHovered = hovered?.taskId === task.taskId;
                              const isSegSelected = selected?.taskId === task.taskId;
                              const prevTask = ti > 0 ? bucket.tasks[ti - 1] : null;
                              const sameAsPrev = prevTask?.category === task.category;
                              const segOpacity = isSegSelected ? 1
                                : hovered && barHasHoveredTask && !isHovered ? 0.35
                                : 1;

                              return (
                                <div
                                  key={`${task.taskId}-${ti}`}
                                  onMouseEnter={(e) => setHovered({ barIndex: i, taskId: task.taskId, x: e.clientX, y: e.clientY })}
                                  onMouseMove={(e) => setHovered((p) => p ? { ...p, x: e.clientX, y: e.clientY } : null)}
                                  onMouseLeave={() => setHovered(null)}
                                  onClick={() => handleSegmentClick(i, task.taskId)}
                                  style={{
                                    height: `${pct}%`,
                                    background: CATEGORY_COLORS[task.category],
                                    borderRadius: isLast ? "2px 2px 0 0" : undefined,
                                    borderTop: sameAsPrev ? "0.5px solid rgba(0,0,0,0.25)" : undefined,
                                    flexShrink: 0,
                                    minHeight: 1,
                                    cursor: "pointer",
                                    opacity: segOpacity,
                                    filter: isSegSelected ? "brightness(1.4)" : undefined,
                                    transition: "opacity 0.1s, filter 0.1s",
                                  }}
                                />
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={xAxis}>
                    {bucketData.map((b, i) => (
                      <div key={i} style={xLabelStyle}>
                        {shouldShowLabel(i, bucketData.length) ? b.label : ""}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Detail panel */}
                {selectedData && selected && (
                  <div style={detailPanel}>
                    <div style={detailHeader}>
                      <div style={{ ...detailDot, background: CATEGORY_COLORS[selectedData.task.category] }} />
                      <span style={detailTitle}>{selectedData.task.title}</span>
                      <span style={detailCat}>{selectedData.task.category}</span>
                      <span style={detailTime}>
                        {selectedData.minutes > 0 ? `${selectedData.minutes} min` : selectedData.bucket.label}
                      </span>
                      <button style={detailClose} onClick={() => setSelected(null)}>✕</button>
                    </div>
                    <div style={detailDescriptionBlock}>
                      {selectedData.taskDescription.trim() ? (
                        selectedData.taskDescription
                      ) : (
                        <span style={{ color: "var(--text3)" }}>—</span>
                      )}
                    </div>
                    <div style={detailBody}>
                      {selectedData.events.map((ev) => (
                        <div key={ev.event_id} style={detailEventRow}>
                          <span style={detailEventTime}>{formatEventTime(ev.timestamp_local ?? ev.timestamp)}</span>
                          <span style={{ ...detailEventType, color: EVENT_TYPE_COLORS[ev.event_type] ?? "var(--text3)" }}>
                            {ev.event_type.toLowerCase()}
                          </span>
                          <span style={detailEventApp}>{ev.app}</span>
                          <span style={detailEventDetail}>
                            {ev.interpretation || ev.detail || "—"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Legend */}
                <div style={legendRow}>
                  {RENDER_ORDER.map((cat) => {
                    const count = categorySummary[cat];
                    if (!count) return null;
                    const pct = totalEvents > 0 ? Math.round((count / totalEvents) * 100) : 0;
                    return (
                      <div key={cat} style={legendItem}>
                        <div style={{ ...legendDot, background: CATEGORY_COLORS[cat] }} />
                        <span style={legendName}>{cat}</span>
                        <span style={legendPct}>{pct}%</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div style={rightPane}>
            <ChatPanel />
          </div>
        </div>

        {/* Tooltip */}
        {hovered && hoveredTask && (
          <div style={{
            ...tooltipStyle,
            left: Math.min(hovered.x + 12, window.innerWidth - 220),
            top: hovered.y - 8,
          }}>
            <div style={tooltipTaskTitle}>{hoveredTask.title}</div>
            <div style={tooltipMeta}>
              <div style={{ ...tooltipDot, background: CATEGORY_COLORS[hoveredTask.category] }} />
              <span style={tooltipCat}>{hoveredTask.category}</span>
              <span style={tooltipTime}>
                {hoveredTaskMinutes != null && hoveredTaskMinutes > 0
                  ? `${hoveredTaskMinutes} min`
                  : (bucketData[hovered.barIndex]?.label ?? "")}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const scrollWrap: React.CSSProperties = { flex: 1, overflowY: "auto", display: "flex", justifyContent: "center" };
const pageStyle: React.CSSProperties = { width: "100%", maxWidth: 1300, padding: "16px 24px 24px", position: "relative" };
const mainLayout: React.CSSProperties = { display: "flex", gap: 16, alignItems: "stretch", minHeight: "calc(100vh - 96px)" };
const leftPane: React.CSSProperties = { flex: 1, minWidth: 0, border: "0.5px solid var(--border)", borderRadius: 8, background: "var(--bg)", padding: "0 16px 16px" };
const rightPane: React.CSSProperties = { width: 380, minWidth: 320, maxWidth: 420, overflow: "hidden", borderRadius: 8, border: "0.5px solid var(--border)" };

const toolbarStyle: React.CSSProperties = { display: "flex", alignItems: "center", padding: "14px 0 20px" };
const segStyle: React.CSSProperties = { display: "flex", border: "0.5px solid var(--border)", borderRadius: 6, overflow: "hidden" };
const segBtnStyle: React.CSSProperties = { background: "var(--bg-subtle)", border: "none", color: "var(--text2)", fontFamily: "inherit", fontSize: 10, padding: "4px 10px", cursor: "pointer" };
const segBtnActiveStyle: React.CSSProperties = { background: "var(--accent)", color: "#fff" };

const emptyStyle: React.CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text3)", padding: "100px 0", fontSize: 11 };

const chartContainer: React.CSSProperties = { marginBottom: 16 };
const chartArea: React.CSSProperties = { display: "flex", alignItems: "flex-end", height: 260, gap: 2, padding: "0 1px" };
const barCol: React.CSSProperties = { flex: 1, height: "100%", display: "flex", alignItems: "flex-end", transition: "opacity 0.2s" };
const barStack: React.CSSProperties = { width: "100%", display: "flex", flexDirection: "column-reverse", transition: "height 0.25s ease" };
const xAxis: React.CSSProperties = { display: "flex", gap: 2, padding: "6px 1px 0", borderTop: "1px solid var(--border)" };
const xLabelStyle: React.CSSProperties = { flex: 1, textAlign: "center", fontSize: 9, color: "var(--text3)", userSelect: "none" };

const legendRow: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: "6px 18px", justifyContent: "center", marginTop: 8 };
const legendItem: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5 };
const legendDot: React.CSSProperties = { width: 6, height: 6, borderRadius: "50%", flexShrink: 0 };
const legendName: React.CSSProperties = { fontSize: 10, color: "var(--text2)" };
const legendPct: React.CSSProperties = { fontSize: 10, color: "var(--text3)" };

// Tooltip
const tooltipStyle: React.CSSProperties = { position: "fixed", background: "var(--bg2)", border: "0.5px solid var(--border)", borderRadius: 6, padding: "8px 12px", zIndex: 200, pointerEvents: "none", boxShadow: "0 6px 20px rgba(0,0,0,0.5)", maxWidth: 280 };
const tooltipTaskTitle: React.CSSProperties = { fontSize: 10, fontWeight: 600, color: "var(--text)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const tooltipMeta: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5 };
const tooltipDot: React.CSSProperties = { width: 5, height: 5, borderRadius: "50%", flexShrink: 0 };
const tooltipCat: React.CSSProperties = { fontSize: 9, color: "var(--text2)" };
const tooltipTime: React.CSSProperties = { fontSize: 9, color: "var(--text3)", marginLeft: "auto" };

// Detail panel
const detailPanel: React.CSSProperties = { background: "var(--bg2)", border: "0.5px solid var(--border)", borderRadius: 8, marginBottom: 16, overflow: "hidden" };
const detailHeader: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "0.5px solid var(--border)" };
const detailDot: React.CSSProperties = { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 };
const detailTitle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 };
const detailCat: React.CSSProperties = { fontSize: 9, color: "var(--text3)", flexShrink: 0 };
const detailTime: React.CSSProperties = { fontSize: 10, color: "var(--text3)", flexShrink: 0 };
const detailClose: React.CSSProperties = { marginLeft: 4, background: "transparent", border: "none", color: "var(--text3)", fontFamily: "inherit", fontSize: 12, cursor: "pointer", padding: "2px 6px", borderRadius: 4, flexShrink: 0 };
const detailDescriptionBlock: React.CSSProperties = {
  padding: "10px 14px",
  fontSize: 10,
  lineHeight: 1.5,
  color: "var(--text2)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  borderBottom: "0.5px solid var(--border)",
};
const detailBody: React.CSSProperties = { maxHeight: 280, overflowY: "auto", padding: "6px 14px" };
const detailEventRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "2px 0", fontSize: 9 };
const detailEventTime: React.CSSProperties = { color: "var(--text3)", width: 62, flexShrink: 0 };
const detailEventType: React.CSSProperties = { width: 55, flexShrink: 0, fontSize: 9 };
const detailEventApp: React.CSSProperties = { color: "var(--text2)", width: 80, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const detailEventDetail: React.CSSProperties = { color: "var(--text3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
