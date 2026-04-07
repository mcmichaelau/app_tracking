import { db } from "../db";

const MAX_RESULT_CHARS = 120_000;

/** Reject anything that is not a single benign SELECT. */
export function assertReadOnlySelect(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error("Empty query");
  const oneStmt = trimmed.replace(/;+\s*$/u, "").trim();
  if (oneStmt.includes(";")) throw new Error("Only one SQL statement allowed");
  const head = oneStmt.replace(/^[\s(]+/, "").slice(0, 20).toLowerCase();
  if (!head.startsWith("select") && !head.startsWith("with")) {
    throw new Error("Only SELECT or WITH … SELECT queries are allowed");
  }
  const blocked = /\b(insert|update|delete|drop|attach|pragma|vacuum|replace|create|alter|truncate)\b/i;
  if (blocked.test(trimmed)) throw new Error("Query contains forbidden keywords");
  if (!/\blimit\s+\d+/i.test(trimmed)) throw new Error("Query must include a numeric LIMIT (max 100)");
  const lim = trimmed.match(/\blimit\s+(\d+)/i);
  if (lim && parseInt(lim[1], 10) > 100) throw new Error("LIMIT must be at most 100");
}

export function runInsightsReadQuery(sql: string): string {
  assertReadOnlySelect(sql);
  try {
    const rows = db.query(sql.trim()).all() as Record<string, unknown>[];
    let text = JSON.stringify(rows, null, 2);
    if (text.length > MAX_RESULT_CHARS) {
      text = text.slice(0, MAX_RESULT_CHARS) + "\n…[truncated]";
    }
    return text;
  } catch (e) {
    return `SQL error: ${(e as Error).message}`;
  }
}
