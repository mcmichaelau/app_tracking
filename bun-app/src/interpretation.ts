import { join } from "path";
import { updateInterpretation, fetchRecentInterpretations } from "./db";
import {
  completeInterpretation,
  getInterpretationProvider,
  invalidateInterpretationClient,
  resolveApiKeyForProvider,
} from "./llm";
import { enqueueForClassification } from "./classification";

const PROMPT_PATH =
  process.env.PROMPT_PATH ??
  join(import.meta.dir, "..", "..", "prompts", "interpret_event.md");

/** Appended to the system prompt only for CLICK events whose `detail.target` has no usable label-like fields (see `hasGoodClickTarget`). */
const WEAK_TARGET_PROMPT_PATH =
  process.env.WEAK_TARGET_PROMPT_PATH ??
  join(import.meta.dir, "..", "..", "prompts", "click_weak_target.md");

/** Appended for SCROLL events — how to phrase scroll + AX snapshot. */
const SCROLL_INTERPRET_PROMPT_PATH =
  process.env.SCROLL_INTERPRET_PROMPT_PATH ??
  join(import.meta.dir, "..", "..", "prompts", "scroll_interpret.md");

const TARGET_INFORMATIVE_KEYS = [
  "label",
  "title",
  "description",
  "value",
  "url",
  "document",
  "help",
  "identifier",
] as const;

function isMeaningfulString(s: string): boolean {
  return s.trim().length > 0;
}

/** True when CLICK JSON `target` has at least one informative field (aligned with the Swift tracker). */
export function hasGoodClickTarget(detail: string | null): boolean {
  if (!detail) return false;
  const trimmed = detail.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const o = JSON.parse(trimmed) as { target?: Record<string, string> };
    const t = o.target;
    if (!t || typeof t !== "object") return false;
    for (const k of TARGET_INFORMATIVE_KEYS) {
      const v = t[k];
      if (typeof v === "string" && isMeaningfulString(v)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

interface QueueItem {
  id: number;
  timestamp: string;
  event_type: string;
  app: string;
  detail: string | null;
  clickContext?: { app: string; detail: string; timestamp: string } | null;
}

const RECENT_INTERP_LIMIT = 10;

/** Llama 3.1 on Groq often emits non-OpenAI tool syntax; use JSON in message content instead of tool calls. */
const JSON_OUTPUT_SUFFIX = `

Respond with only a single JSON object and no other text. Shape: {"sentence":"<one interpretation sentence>"}.
The sentence must follow all interpretation rules above.`;

function parseSentenceFromAssistantContent(content: string | null | undefined): string | null {
  if (!content) return null;
  const trimmed = content.trim();
  const tryParse = (s: string): string | null => {
    try {
      const o = JSON.parse(s) as { sentence?: unknown };
      if (typeof o.sentence === "string") {
        const t = o.sentence.trim();
        return t.length > 0 ? t : null;
      }
    } catch {
      /* ignore */
    }
    return null;
  };
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = tryParse(fenced[1].trim());
    if (inner) return inner;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const inner = tryParse(trimmed.slice(start, end + 1));
    if (inner) return inner;
  }
  return null;
}

let queue: QueueItem[] = [];
let draining = false;
let systemPrompt: string | null = null;
let weakTargetPrompt = "";
let scrollInterpretPrompt = "";

export async function configure(): Promise<void> {
  const provider = getInterpretationProvider();
  if (!resolveApiKeyForProvider(provider)) {
    return;
  }
  try {
    systemPrompt = await Bun.file(PROMPT_PATH).text();
  } catch {
    systemPrompt = null;
  }
  try {
    weakTargetPrompt = (await Bun.file(WEAK_TARGET_PROMPT_PATH).text()).trim();
  } catch {
    weakTargetPrompt = "";
  }
  try {
    scrollInterpretPrompt = (await Bun.file(SCROLL_INTERPRET_PROMPT_PATH).text()).trim();
  } catch {
    scrollInterpretPrompt = "";
  }
}

export function reconfigure(): void {
  invalidateInterpretationClient();
}

function formatEventBlock(e: QueueItem): string {
  let lines = `Type: ${e.event_type}\nApp: ${e.app}\nDetail: ${e.detail ?? ""}`;
  if (e.clickContext) {
    lines += `\nClick context (most recent click in ${e.clickContext.app}): ${e.clickContext.detail}`;
  }
  return lines;
}

async function callInterpretationModel(event: QueueItem, recentHistory: string[]): Promise<string | null> {
  const provider = getInterpretationProvider();
  if (!resolveApiKeyForProvider(provider) || !systemPrompt) return null;

  const scrollBlock =
    event.event_type === "SCROLL" && scrollInterpretPrompt.length > 0
      ? `\n\n${scrollInterpretPrompt}`
      : "";

  const weakBlock =
    (event.event_type === "CLICK" || event.event_type === "SCROLL") &&
    !hasGoodClickTarget(event.detail) &&
    weakTargetPrompt.length > 0
      ? `\n\n${weakTargetPrompt}`
      : "";

  let userMessage = `Interpret this single event:\n\n${formatEventBlock(event)}`;
  if (recentHistory.length > 0) {
    userMessage += `\n\nRecent interpreted activity before this event (oldest first):\n${recentHistory.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
  }

  const system = systemPrompt + scrollBlock + weakBlock + JSON_OUTPUT_SUFFIX;

  try {
    const result = await completeInterpretation({
      provider,
      system,
      user: userMessage,
    });

    const sentence = parseSentenceFromAssistantContent(result.content);
    if (!sentence) {
      return null;
    }
    return sentence;
  } catch (_e: unknown) {
    return null;
  }
}

async function processOne(item: QueueItem): Promise<void> {
  const recentHistory = fetchRecentInterpretations(RECENT_INTERP_LIMIT, item.id);
  const sentence = await callInterpretationModel(item, recentHistory);
  if (sentence) {
    updateInterpretation(item.id, sentence);
    enqueueForClassification({ id: item.id, timestamp: item.timestamp, interpretation: sentence });
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await processOne(item);
    }
  } finally {
    draining = false;
    if (queue.length > 0) void drain();
  }
}

export function enqueue(item: QueueItem): void {
  if (item.event_type === "TYPING") return;
  if (!resolveApiKeyForProvider(getInterpretationProvider()) || !systemPrompt) return;
  queue.push(item);
  void drain();
}
