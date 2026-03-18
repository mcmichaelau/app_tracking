import { useState, useEffect, useCallback } from "react";
import { fetchTasks, deleteAllTasks, type Task } from "../api";
import { DataTable, cellStyles, type Column } from "../components/DataTable";

const columns: Column<Task>[] = [
  { key: "id", header: "id", render: (t) => t.id, style: cellStyles.text3, width: 45 },
  { key: "title", header: "title", render: (t) => t.title, style: cellStyles.text, width: 200 },
  { key: "description", header: "description", render: (t) => t.description, style: cellStyles.text2, flex: true },
];

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [popover, setPopover] = useState<{ task: Task; x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    const data = await fetchTasks();
    setTasks(data);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDoubleClick = (task: Task, ev: React.MouseEvent) => {
    setPopover({ task, x: ev.clientX + 8, y: ev.clientY + 8 });
  };

  const handleDeleteAll = async () => {
    if (tasks.length === 0) return;
    if (!confirm(`Delete all ${tasks.length} visible tasks? Events will be unlinked but not deleted.`)) return;
    try {
      const data = await deleteAllTasks(tasks.map((t) => t.id));
      if (data.ok) {
        setTasks([]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <>
      <DataTable
        data={tasks}
        columns={columns}
        onDoubleClick={handleDoubleClick}
        emptyMessage="no tasks yet"
        countLabel="tasks"
        toolbarRight={
          <button
            style={deleteBtnStyle}
            onClick={handleDeleteAll}
            disabled={tasks.length === 0}
            title="Delete all visible tasks"
          >
            delete all
          </button>
        }
      />

      {popover && (
        <div style={overlayStyle} onClick={() => setPopover(null)}>
          <div
            style={{
              ...popoverStyle,
              left: Math.min(popover.x, window.innerWidth - 420),
              top: Math.min(popover.y, window.innerHeight - 300),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={popoverHeaderStyle}>
              <span style={popoverTitleStyle}>{popover.task.title}</span>
              <button
                style={popoverCopyStyle}
                onClick={() => navigator.clipboard.writeText(popover.task.description)}
              >
                copy
              </button>
            </div>
            <pre style={popoverDescStyle}>{popover.task.description || "—"}</pre>
          </div>
        </div>
      )}
    </>
  );
}

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
  minWidth: 360,
  maxWidth: 500,
  maxHeight: 400,
  zIndex: 101,
  boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const popoverHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 10,
  flexShrink: 0,
};

const popoverTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  flex: 1,
};

const popoverCopyStyle: React.CSSProperties = {
  background: "transparent",
  border: "0.5px solid var(--border)",
  color: "var(--text2)",
  fontFamily: "inherit",
  fontSize: 10,
  padding: "3px 8px",
  borderRadius: 4,
  cursor: "pointer",
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

const popoverDescStyle: React.CSSProperties = {
  margin: 0,
  flex: 1,
  overflow: "auto",
  background: "var(--bg)",
  border: "0.5px solid var(--border)",
  borderRadius: 5,
  padding: 10,
  fontSize: 10,
  lineHeight: 1.5,
  color: "var(--text)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
