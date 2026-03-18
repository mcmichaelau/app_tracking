import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  style?: React.CSSProperties;
  width?: number | string;
  flex?: boolean;
}

interface DataTableProps<T extends { id: number }> {
  data: T[];
  columns: Column<T>[];
  onDoubleClick?: (row: T, ev: React.MouseEvent) => void;
  emptyMessage?: string;
  countLabel?: string;
  toolbarLeft?: ReactNode;
  toolbarRight?: ReactNode;
}

export function DataTable<T extends { id: number }>({
  data,
  columns,
  onDoubleClick,
  emptyMessage = "no data",
  countLabel = "rows",
  toolbarLeft,
  toolbarRight,
}: DataTableProps<T>) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const lastSelectedIndex = useRef<number | null>(null);

  const handleRowClick = (row: T, index: number, ev: React.MouseEvent) => {
    if (ev.shiftKey) {
      const from = lastSelectedIndex.current ?? index;
      const [lo, hi] = [Math.min(from, index), Math.max(from, index)];
      const ids = new Set(data.slice(lo, hi + 1).map((x) => x.id));
      setSelectedIds(ids);
    } else {
      lastSelectedIndex.current = index;
      setSelectedIds(new Set([row.id]));
    }
  };

  const copySelected = useCallback(() => {
    if (selectedIds.size === 0) return;
    const rows = data.filter((r) => selectedIds.has(r.id));
    navigator.clipboard.writeText(JSON.stringify(rows, null, 2));
  }, [data, selectedIds]);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "c") {
        copySelected();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copySelected]);

  const copyAll = () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
  };

  return (
    <>
      <div style={toolbarStyle}>
        {toolbarLeft}
        <div style={toolbarRightStyle}>
          <span style={countStyle}>{data.length} {countLabel}</span>
          {toolbarRight}
          <button style={iconBtnStyle} onClick={copyAll} title="Copy all to clipboard">
            ⧉
          </button>
        </div>
      </div>

      <div style={mainStyle}>
        {data.length === 0 ? (
          <div style={emptyStyle}>
            <div style={emptyIconStyle}>⬚</div>
            <div>{emptyMessage}</div>
          </div>
        ) : (
          <div
            style={tableWrapStyle}
            onClick={(ev) => { if (!(ev.target as HTMLElement).closest("tr")) setSelectedIds(new Set()); }}
          >
            <table style={tableStyle}>
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      style={{
                        ...thStyle,
                        width: col.width,
                        maxWidth: col.flex ? MAX_COLUMN_WIDTH : col.width,
                      }}
                    >
                      {col.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((row, i) => (
                  <tr
                    key={row.id}
                    style={{ ...trStyle, ...(selectedIds.has(row.id) ? trSelectedStyle : {}) }}
                    onClick={(ev) => handleRowClick(row, i, ev)}
                    onDoubleClick={onDoubleClick ? (ev) => onDoubleClick(row, ev) : undefined}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        style={{
                          ...tdBaseStyle,
                          ...col.style,
                          width: col.width,
                          maxWidth: col.flex ? MAX_COLUMN_WIDTH : col.width,
                        }}
                      >
                        {col.render(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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

const toolbarRightStyle: React.CSSProperties = {
  marginLeft: "auto",
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const countStyle: React.CSSProperties = { color: "var(--text3)", fontSize: 10 };

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

const mainStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const emptyStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  color: "var(--text3)",
};

const emptyIconStyle: React.CSSProperties = { fontSize: 22 };

const tableWrapStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  overflowX: "auto",
  userSelect: "none",
};

const MAX_COLUMN_WIDTH = 320;

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "auto",
};

const thStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: "var(--bg)",
  color: "var(--text3)",
  fontSize: 10,
  fontWeight: 500,
  textAlign: "left",
  padding: "6px 12px",
  borderBottom: "1px solid var(--border)",
  zIndex: 1,
};

const trStyle: React.CSSProperties = {
  borderBottom: "0.5px solid rgba(255,255,255,0.04)",
  cursor: "default",
};

const trSelectedStyle: React.CSSProperties = {
  background: "rgba(10, 132, 255, 0.15)",
};

const tdBaseStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: 10,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export const cellStyles = {
  text: { color: "var(--text)" } as React.CSSProperties,
  text2: { color: "var(--text2)" } as React.CSSProperties,
  text3: { color: "var(--text3)" } as React.CSSProperties,
  italic: { color: "var(--text3)", fontStyle: "italic" } as React.CSSProperties,
};
