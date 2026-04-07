# Panoptic

Panoptic is a macOS activity tracker that answers a simple question: **where is my time actually going?**

It captures keyboard, mouse, and application events in the background, uses an LLM to interpret and group them into tasks, then surfaces patterns — how much time on each project, how often you context-switch, what pulls you away from deep work.

The longer-term goal is to close the loop: give an agentic system a live view of your workload so it can proactively offer to take things off your plate as it identifies areas where it can help.

## What it does today

- **Passive capture** — a native Swift process records app switches, keystrokes, and mouse clicks via the macOS Accessibility API, all locally
- **LLM interpretation** — raw events are batched and sent to a configurable LLM (`INTERPRETATION_LLM=provider/model`) which converts them into plain-English activity descriptions
- **Agent-based task grouping** — a background agent (`retask`) periodically reads recent interpreted events and assigns them to tasks, grouping related activity automatically
- **Dashboard** — a web UI to browse events, view tasks, and see time breakdowns by category
- **Insights chat** — a SQL-query agent you can ask questions like "what did I spend the most time on today?" or "how many times did I switch away from the IDE?"
- **Multi-provider LLM support** — Groq, OpenAI, Anthropic, Gemini, or any OpenAI-compatible endpoint

## Roadmap

### Context switching analysis
Surface metrics around focus and interruption: time-on-task distributions, switch frequency, the cost of context switching across projects throughout the day.

### Proactive AI coworker
Give the agent a live view of the task stream so it can identify work it could take on — drafting a response, running a search, summarizing a thread — and offer to help before you ask. The agent would operate in the background, propose actions, and wait for approval rather than acting autonomously.

### Richer pattern recognition
Weekly/monthly summaries, goal tracking ("I want to spend 4 hours on deep work per day"), and anomaly detection ("you've been in meetings 60% more than last week").

## Architecture

```
app_tracking/
├── tracker/          # Swift — captures raw events via macOS Accessibility API
│   └── Sources/
│       ├── Accessibility.swift   # event capture
│       └── DesktopApp/           # macOS app bundle wrapper (WKWebView)
├── bun-app/          # Bun/Hono API + React frontend
│   ├── src/
│   │   ├── index.ts              # entry point
│   │   ├── server.ts             # HTTP routes
│   │   ├── ingest.ts             # event ingestion from tracker
│   │   ├── interpretation.ts     # LLM interpretation pipeline
│   │   ├── retask.ts             # agent-based task segmentation
│   │   ├── insightsAgent/        # Insights chat agent
│   │   ├── llm/                  # provider routing (Anthropic, Gemini, OpenAI-compat)
│   │   ├── db.ts                 # SQLite schema + queries
│   │   ├── config.ts             # env + config file resolution
│   │   └── timezone.ts           # IANA timezone helpers
│   └── frontend/     # React + Vite
│       └── src/pages/
│           ├── Events.tsx        # event browser
│           ├── Tasks.tsx         # task list
│           ├── Settings.tsx      # API keys, model config
│           └── Insights.tsx      # chat interface
├── prompts/          # LLM prompt templates
└── scripts/          # dev utilities (simulation, chunking experiments)
```

## Prerequisites

- macOS 13.0+
- [Bun](https://bun.sh/) runtime
- Swift 5.9+
- An API key for at least one LLM provider (see `.env.example`)

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/mcmichaelau/app_tracking.git
cd app_tracking

cp .env.example .env
# Edit .env — add your API keys and set INTERPRETATION_LLM
```

### 2. Build the Swift tracker

```bash
cd tracker
swift build -c release
cd ..
```

### 3. Install dependencies and start the web app

```bash
cd bun-app
bun install
cd frontend && bun install && cd ..

bun dev   # starts API on :3001 and Vite dev server on :5173
```

### 4. Run the tracker

```bash
tracker/.build/release/ActivityTracker
```

The tracker requires **Accessibility permissions** — macOS will prompt on first run, or grant them in System Settings → Privacy & Security → Accessibility.

## Configuration

All settings can be configured via `.env` or the **Settings page** in the UI (saved to `~/Library/Application Support/ActivityTracker/config.json`).

Key options (see `.env.example` for the full list):

| Variable | Description |
|---|---|
| `INTERPRETATION_LLM` | `provider/model`, e.g. `groq/llama-3.3-70b-versatile` |
| `TASK_CLASSIFIER_LLM` | Model for the retask agent (defaults to `INTERPRETATION_LLM`) |
| `INSIGHTS_AGENT_LLM` | Model for Insights chat (defaults to `groq/qwen/qwen3-32b`) |
| `USER_TIMEZONE` | IANA timezone, e.g. `America/New_York` |

Supported providers: `groq`, `openai`, `anthropic`, `gemini` — plus any OpenAI-compatible endpoint via `INTERPRETATION_BASE_URL`.

## Privacy

All data stays on your machine. The SQLite database lives at `~/Library/Application Support/ActivityTracker/tracker.db`. The only outbound traffic is the anonymized activity text sent to whichever LLM API you configure.

## Contributing

The core areas most open to contribution:

- **`bun-app/src/retask.ts`** — task segmentation agent logic and prompting
- **`bun-app/src/insightsAgent/`** — Insights chat agent and SQL safety layer
- **`bun-app/src/interpretation.ts`** — event interpretation pipeline
- **`prompts/`** — LLM prompt templates
- **`tracker/Sources/`** — Swift event capture

Bug reports and pull requests welcome.

## License

MIT
