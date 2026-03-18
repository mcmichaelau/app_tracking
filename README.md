# Activity Tracker

A macOS activity tracking application that monitors keyboard, mouse, and application usage, then uses AI to interpret and categorize your activities into tasks.

## Architecture

- **tracker/** - Swift-based macOS activity tracker that captures keyboard, mouse, and app events
- **bun-app/** - Bun/Hono backend server with React frontend
- **prompts/** - LLM prompts for event interpretation

## Features

- Native macOS activity tracking (keyboard, mouse, application switches)
- AI-powered activity interpretation using OpenAI/Anthropic/Gemini
- Task extraction and categorization
- Web-based dashboard for viewing events and tasks
- Chat interface for querying your activity history

## Prerequisites

- macOS 13.0+
- [Bun](https://bun.sh/) runtime
- Swift 5.9+
- API keys for at least one of: OpenAI, Anthropic, or Google Gemini

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

```bash
cd bun-app
bun install
cd frontend
bun install
cd ..
bun run src/index.ts
```

The web UI will be available at http://localhost:3001

### 4. Run the tracker

```bash
cd tracker
.build/release/Tracker
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
