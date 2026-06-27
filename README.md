# Clive Desktop (OSS)

Open-source orchestrator-and-agents chat desktop app. One long-running chat with an orchestrator that delegates tasks to sub-agents. Bring your own LLM — Anthropic via API key or account login, OpenAI, Ollama / LM Studio for local models, or the Claude Code CLI as a sub-agent runner.

> Note: this is a from-scratch scaffold derived from the architecture plan in [PLAN.md](./PLAN.md). `npm install` and an initial build pass are still required.

## Architecture in one breath

```
You ⟷ Orchestrator (long-running chat)
              │
              └── delegate_task ─▶ Sub-agent runner ─▶ Claude Code CLI / API / Ollama / …
                                              │
                                              └── result returned as tool_result
```

The orchestrator's conversation persists locally in SQLite. Every delegate's completion comes back as a `tool_result` message inside the orchestrator's history, so it always has the full picture.

## Quick start

```bash
npm install
npm run tauri:dev          # spawns Vite + Tauri together
```

On first run, the app sends you to **Settings → Adapters**. Add at least one adapter, then chat from the home view.

### Adapter recipes

**Anthropic with your Claude Code account** (uses your Pro/Team/Max plan, no API key needed):

1. Have Claude Code installed and logged in (`claude auth login`).
2. Settings → Add adapter → Anthropic → Auth mode: **Account**.
3. Save. Settings will read your OAuth token from `~/.claude/.credentials.json`.

**Anthropic with an API key**:

1. Settings → Add adapter → Anthropic → Auth mode: **API key**.
2. Save, then click "Set / change API key" and paste your `sk-ant-...`.

**Local model via Ollama**:

```bash
ollama pull qwen2.5-coder:32b
ollama serve
```

1. Settings → Add adapter → OpenAI-compatible.
2. Base URL: `http://localhost:11434/v1`, Model: `qwen2.5-coder:32b`.
3. Leave the API key empty.

**Claude Code CLI as the delegate runner**:

1. Have the `claude` binary on your PATH.
2. Settings → Add adapter → Claude Code CLI.
3. Click "Set as delegate" so the orchestrator routes `delegate_task` to it.



## Where things live


| Path                                    | What it is                                                             |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `src/lib/components/chat/`              | Chat surface (orchestrator) — message rendering, markdown, attachments |
| `src/lib/components/shell/`             | Sidebar with fleet view (running + recent delegate runs), top bar      |
| `src/lib/adapters/`                     | LLM adapter implementations                                            |
| `src/lib/agent/loop.ts`                 | Multi-step orchestrator loop (tool execution, delegate spawning)       |
| `src/lib/agent/delegate.ts`             | Sub-agent runner — streams output as run chunks                        |
| `src/lib/agent/prompts.ts`              | Default orchestrator + delegate system prompts                         |
| `src/lib/agent/tools.ts`                | Local tools (`delegate_task`, `remember`, `recall`, `read_file`, …)    |
| `src/lib/db/`                           | SQLite layer for conversations, runs, chunks, memories, settings       |
| `src/lib/types/`                        | Wire types (chat protocol, adapter interface, run model)               |
| `src-tauri/`                            | Rust shell: file I/O, Claude Code credential reader, SQL migrations    |
| `src-tauri/migrations/0001_initial.sql` | Initial schema                                                         |




## What's intentionally not here

- No backend server. No multi-tenant auth. No Neo4j or Postgres.
- No cloud sync. Conversations stay on this machine.
- No MCP integrations yet (the schema is forward-compatible — adding a settings tab for MCP server URLs is a follow-up).



## Licence

MIT.