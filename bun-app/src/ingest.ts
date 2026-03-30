import { insertEvent, updateInterpretation } from "./db";
import { enqueue } from "./interpretation";

// Track the most recent CLICK detail per app so non-click events get surrounding context
let lastClickContext: { app: string; detail: string; timestamp: string } | null = null;

function quickInterpretation(event_type: string, app: string, detail: string | null): string {
  switch (event_type) {
    case "COPY":
      return detail ? `copied "${detail.slice(0, 80)}" to clipboard` : "copied to clipboard";
    case "PASTE":
      return detail ? `pasted "${detail.slice(0, 80)}" from clipboard` : "pasted from clipboard";
    case "SHORTCUT":
      return detail ? `used ${detail} in ${app}` : "used shortcut";
    case "KEY":
      return detail ? `pressed ${detail} in ${app}` : "pressed key";
    case "APP SWITCH":
      return `switched to ${app}`;
    case "SCROLL":
      return `scrolled in ${app}`;
    default:
      return `${event_type.toLowerCase()} in ${app}`;
  }
}

// Generic dedup: tracks last-seen timestamp per key, drops events within the window
const lastSeen: Map<string, number> = new Map();

function isDuplicate(key: string, now: number, windowMs: number): boolean {
  const last = lastSeen.get(key);
  if (last && now - last < windowMs) return true;
  lastSeen.set(key, now);
  return false;
}

function clickDedupKey(app: string, timestamp: string, detail: string | null): string | null {
  if (!detail) return null;
  let targetLabel = "";
  try {
    const parsed = JSON.parse(detail) as { target?: { label?: string; title?: string; description?: string } };
    targetLabel = parsed.target?.label ?? parsed.target?.title ?? parsed.target?.description ?? "";
  } catch {
    return null;
  }
  const ts = new Date(timestamp).getTime();
  const tsSec = Math.floor(ts / 1000);
  return `CLICK::${app}::${tsSec}::${targetLabel}`;
}

export function ingest(events: Record<string, unknown>[]): void {
  for (const raw of events) {
    const event_type = (raw.event_type ?? raw.type ?? "unknown") as string;
    const e = { ...raw, event_type };
    const app = (e.app as string) ?? "unknown";
    const detail = (e.detail as string | null) ?? null;
    const now = new Date((e.timestamp as string) ?? Date.now()).getTime();

    if (event_type === "CLICK") {
      // CLICK dedup: same app + timestamp (to second) + target label within 5s
      // Uses target label instead of full detail so we catch duplicates even when
      // AX returns slightly different JSON (e.g. with/without siblings, subrole)
      const key = clickDedupKey(app, e.timestamp as string, detail);
      if (key && isDuplicate(key, now, 5000)) continue;
    } else if (event_type === "APP SWITCH") {
      // APP SWITCH dedup: same app within 2s
      if (isDuplicate(`APP_SWITCH::${app}`, now, 2000)) continue;
    } else if (event_type === "TYPING") {
      // TYPING dedup: same content + app within 2s
      if (isDuplicate(`TYPING::${app}::${detail ?? ""}`, now, 2000)) continue;
    } else if (event_type === "KEY") {
      // KEY dedup: same key + app within 200ms
      if (isDuplicate(`KEY::${app}::${detail ?? ""}`, now, 200)) continue;
    } else if (event_type === "SHORTCUT") {
      // SHORTCUT dedup: same shortcut + app within 500ms
      if (isDuplicate(`SHORTCUT::${app}::${detail ?? ""}`, now, 500)) continue;
    } else if (event_type === "COPY") {
      // COPY dedup: same content + app within 2s
      if (isDuplicate(`COPY::${app}::${detail ?? ""}`, now, 2000)) continue;
    } else if (event_type === "PASTE") {
      // PASTE dedup: same content + app within 2s
      if (isDuplicate(`PASTE::${app}::${detail ?? ""}`, now, 2000)) continue;
    } else if (event_type === "SCROLL") {
      // SCROLL: one AX snapshot per idle; drop duplicate detail+app within 400ms
      if (isDuplicate(`SCROLL::${app}::${detail ?? ""}`, now, 400)) continue;
    }

    const id = insertEvent({
      timestamp: (e.timestamp as string) ?? new Date().toISOString(),
      app,
      event_type,
      detail,
    });

    const ts = (e.timestamp as string) ?? new Date().toISOString();

    // TYPING: store raw text as interpretation (no LLM). Others: placeholder until LLM overwrites.
    const interpretation =
      event_type === "TYPING" ? (detail ?? "") : quickInterpretation(event_type, app, detail);
    updateInterpretation(id, interpretation);

    if (event_type === "CLICK" && detail) {
      lastClickContext = { app, detail, timestamp: ts };
    }

    // LLM interpretation for non-TYPING events (TYPING is final above)
    if (event_type === "TYPING") continue;
    const clickContext = event_type !== "CLICK" ? lastClickContext : null;
    enqueue({ id, timestamp: ts, event_type, app, detail, clickContext });
  }
}
