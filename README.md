# Activity Tracker

A macOS activity tracking application that monitors keyboard, mouse, and application usage, then uses AI to interpret and categorize your activities into tasks.

## Architecture

- **tracker/** - Swift-based macOS activity tracker that captures keyboard, mouse, and app events
- **bun-app/** - Bun/Hono backend server with React frontend
- **bun-app/src/llm/** - interpretation backends; set **`INTERPRETATION_LLM`** to `provider/model` (e.g. `groq/llama-3.1-8b-instant`, `anthropic/claude-3-5-haiku-20241022`) plus the matching API key (import from `./llm`)
- **prompts/** - LLM prompts for event interpretation

## Features

- Native macOS activity tracking (keyboard, mouse, application switches)
- AI-powered activity interpretation via **`INTERPRETATION_LLM=provider/model`**: OpenAI-compatible hosts (**`groq`**, **`openai`**, or any custom `INTERPRETATION_BASE_URL`), **`anthropic`**, or **`gemini`**. See `.env.example`.
- Tasks: group events manually in the UI (the interpreter no longer assigns tasks automatically)
- Web-based dashboard for viewing events and tasks
- Chat interface for querying your activity history

## Prerequisites

- macOS 13.0+
- [Bun](https://bun.sh/) runtime (if `bun` is not found, install via the [official installer](https://bun.sh/docs/installation); it adds `~/.bun/bin` to your `PATH` in `~/.zshrc` — open a new terminal or run `source ~/.zshrc`)
- Swift 5.9+
- An API key for interpretations (optional at first): e.g. `GROQ_API_KEY` with `INTERPRETATION_LLM=groq/llama-3.1-8b-instant`, or `OPENAI_API_KEY` with `INTERPRETATION_LLM=openai/gpt-4o-mini` — see `.env.example`

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/YOUR_USERNAME/app_tracking.git
cd app_tracking

# Copy environment template and add your API keys
cp .env.example .env
# Edit .env with your API keys
```

### 2. Build the Swift tracker

```bash
cd tracker
swift build -c release
cd ..
```

### 3. Install and run the web app

Install dependencies for the Bun server **and** the React frontend (the frontend needs its own `node_modules` so Vite is available):

```bash
cd bun-app
bun install
cd frontend
bun install
cd ..
```

**Development (recommended)** — API plus Vite dev server with hot reload:

```bash
bun dev
```

- API: http://localhost:3001  
- Dev UI (Vite, proxies `/api` to the API): http://localhost:5173 (default; check the `[ui]` lines in the terminal if the port differs)

**API only** (no Vite process):

```bash
bun run src/index.ts
# or: bun start
```

If you see `vite: command not found`, run `bun install` in `bun-app/frontend` so the Vite binary exists.

Until the Swift tracker is built (step 2), the server may warn that the tracker binary is missing — the web app still runs; full tracking needs a release build at `tracker/.build/release/ActivityTracker`.

### 4. Run the tracker

```bash
cd tracker
.build/release/ActivityTracker
```

**Note:** The tracker requires Accessibility permissions in macOS System Settings.

## Configuration

API keys can be configured either via:
- Environment variables in `.env`
- The Settings page in the web UI (stored in `~/Library/Application Support/ActivityTracker/config.json`)

## Privacy

This application tracks your keyboard and mouse activity locally. All data stays on your machine in a local SQLite database. API keys are only used to send anonymized activity summaries to AI services for interpretation.

## License

MIT
