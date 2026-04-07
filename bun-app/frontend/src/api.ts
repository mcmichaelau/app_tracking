const API = "/api";

export async function fetchEvents(params: { limit?: number; since?: string; until?: string }) {
  const q = new URLSearchParams();
  if (params.limit) q.set("limit", String(params.limit));
  if (params.since) q.set("since", params.since);
  if (params.until) q.set("until", params.until);
  const res = await fetch(`${API}/events?${q}`);
  return res.json();
}

export async function deleteAllEvents(): Promise<{ ok: boolean; deleted: number }> {
  const res = await fetch(`${API}/events`, { method: "DELETE" });
  return res.json();
}

export async function assignEventToTask(eventId: number, taskId: number | null): Promise<{ ok: boolean }> {
  const res = await fetch(`${API}/events/${eventId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task_id: taskId }),
  });
  return res.json();
}

export interface Task {
  id: number;
  title: string;
  description: string;
  category: "Productivity" | "Leisure" | "Admin" | "Learning" | "Communication" | null;
}

export async function fetchTasks(limit?: number): Promise<Task[]> {
  const q = limit ? `?limit=${limit}` : "";
  const res = await fetch(`${API}/tasks${q}`);
  return res.json();
}

export async function createTask(task: { title: string; description: string }): Promise<{ id: number }> {
  const res = await fetch(`${API}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(task),
  });
  return res.json();
}

export async function updateTask(id: number, task: { title?: string; description?: string }): Promise<{ ok: boolean }> {
  const res = await fetch(`${API}/tasks/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(task),
  });
  return res.json();
}

export async function deleteTask(id: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${API}/tasks/${id}`, { method: "DELETE" });
  return res.json();
}

export async function deleteAllTasks(ids: number[]): Promise<{ ok: boolean; deleted: number }> {
  const res = await fetch(`${API}/tasks`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  return res.json();
}

export interface TaskTimelineEntry {
  id: number;
  title: string;
  description: string;
  category: "Productivity" | "Leisure" | "Admin" | "Learning" | "Communication" | null;
  event_count: number;
  first_event: string | null;
  last_event: string | null;
}

export async function fetchTaskTimeline(params: { since?: string; until?: string }): Promise<TaskTimelineEntry[]> {
  const q = new URLSearchParams();
  if (params.since) q.set("since", params.since);
  if (params.until) q.set("until", params.until);
  const res = await fetch(`${API}/tasks/timeline?${q}`);
  return res.json();
}

export interface CategorizedEvent {
  event_id: number;
  timestamp: string;
  /** Wall-clock in configured timezone (YYYY-MM-DDTHH:MM:SS.mmm). */
  timestamp_local?: string;
  app: string;
  event_type: string;
  detail: string | null;
  interpretation: string | null;
  task_id: number;
  task_title: string;
  task_description: string;
  category: "Productivity" | "Leisure" | "Admin" | "Learning" | "Communication" | null;
}

export async function fetchEventCategories(params: { since?: string; until?: string }): Promise<CategorizedEvent[]> {
  const q = new URLSearchParams();
  if (params.since) q.set("since", params.since);
  if (params.until) q.set("until", params.until);
  const res = await fetch(`${API}/events/categorized?${q}`);
  return res.json();
}

export interface SettingsResponse {
  openai_api_key: string;
  anthropic_api_key: string;
  gemini_api_key: string;
  interpretation_api_key: string;
  groq_api_key: string;
  interpretation_base_url: string;
  interpretation_llm: string;
  task_classifier_llm: string;
  /** IANA timezone; empty = server default (usually system zone). */
  timezone: string;
  openai: { has_key: boolean; source: "env" | "config" | "none" };
  anthropic: { has_key: boolean; source: "env" | "config" | "none" };
  gemini: { has_key: boolean; source: "env" | "config" | "none" };
}

export interface ApiUsagePeriod {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface ApiUsageSummary {
  today: ApiUsagePeriod;
  week: ApiUsagePeriod;
  month: ApiUsagePeriod;
  allTime: ApiUsagePeriod;
  byModel: Array<{
    model: string;
    operation: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }>;
}

export async function fetchUsage(): Promise<ApiUsageSummary> {
  const res = await fetch(`${API}/usage`);
  return res.json();
}

export async function fetchSettings(): Promise<SettingsResponse> {
  const res = await fetch(`${API}/settings`);
  return res.json();
}

export async function saveSettings(settings: {
  openai_api_key?: string;
  anthropic_api_key?: string;
  gemini_api_key?: string;
  interpretation_api_key?: string;
  groq_api_key?: string;
  interpretation_base_url?: string;
  interpretation_llm?: string;
  task_classifier_llm?: string;
  timezone?: string;
}) {
  const res = await fetch(`${API}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  return res.json();
}

export interface AgentMessage {
  type: "text" | "result" | "tool_use" | "tool_result" | "error" | "done";
  content?: string;
  tool?: string;
  toolInput?: string;
  cost?: number;
  turns?: number;
  conversationId: string;
}

export async function* sendAgentMessage(
  message: string,
  conversationId?: string
): AsyncGenerator<AgentMessage> {
  const res = await fetch(`${API}/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, conversationId }),
  });

  if (!res.ok) {
    throw new Error(`Agent request failed: ${res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data.trim()) {
          yield JSON.parse(data) as AgentMessage;
        }
      }
    }
  }
}

export async function getConversation(conversationId: string) {
  const res = await fetch(`${API}/agent/conversations/${conversationId}`);
  return res.json();
}

export async function clearConversation(conversationId: string) {
  const res = await fetch(`${API}/agent/conversations/${conversationId}`, {
    method: "DELETE",
  });
  return res.json();
}

export async function listConversations() {
  const res = await fetch(`${API}/agent/conversations`);
  return res.json();
}
