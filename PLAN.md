# Clive Desktop OSS — Architecture Simplification Plan

## What this is

A standalone, open-source desktop app that keeps the Clive chat UI and agent delegation model but rips out all the Cintra-specific infrastructure. No backend server. No Postgres or Neo4j. No bridge tokens. No SSO. No org graph. Just a desktop app a developer can download, point at their LLM of choice, and start using.

The UI is lifted line-for-line from `apps/desktop/`. The agent runtime is rewritten in-process — no Express, no Vercel AI SDK dependency, no cloud database.

---

## What problem this solves

The current Clive desktop app is built on top of a multi-tenant SaaS backend:

```
Desktop (Tauri) → bearer token → Express (apps/backend/) → Anthropic API
                                  ↓
                              Postgres + Neo4j + MCP servers + SSO
```

That stack is not open-sourceable. It carries:
- Org-specific auth (Entra SSO, bridge tokens stored in Postgres)
- Neo4j org graph for memory scoping and team resolution
- Prisma schema tied to multi-tenant user management
- MCP integration gating controlled per-org from a graph query
- The clive-bridge CLI polling `GET /api/claude-code/runs/pending` against that backend

The simplified version replaces that whole server-side dependency with:

```
Desktop (Tauri)
  ├── LLM Adapter (user-configured: Anthropic / OpenAI-compatible / local URL)
  ├── Agent Loop (in-process Rust or TS, no external server)
  ├── Sub-agent Runner (CLI sidecar or direct API calls)
  └── SQLite (local conversation + run history)
```

No server to run. No database to provision. Ships as a single `.dmg` / `.exe`.

---

## What we keep from the current desktop app (UI — verbatim copy)

All of the following are copied exactly, zero architectural changes required at the component level:

| File / folder | What it is |
|---|---|
| `src/lib/components/chat/ChatSurface.svelte` | Two-pane chat shell |
| `src/lib/components/chat/ChatMessage.svelte` | Turn renderer (text + tool parts) |
| `src/lib/components/chat/MarkdownView.svelte` | Marked + DOMPurify + highlight.js |
| `src/lib/components/chat/ChatInput.svelte` | Textarea, attach, send |
| `src/lib/components/chat/AttachmentChip.svelte` | Pending file preview |
| `src/lib/components/chat/ToolCallPart.svelte` | Tool call accordion |
| `src/lib/components/chat/ThinkingIndicator.svelte` | Animated thinking bubble |
| `src/lib/components/layout/AppTopBar.svelte` | Top bar with health pill |
| `src/lib/components/layout/Sidebar.svelte` | Sidebar shell (fleet → local conversations) |
| `src/lib/components/layout/HealthPill.svelte` | Connection status badge |
| `src/routes/+layout.svelte` | Root shell layout |
| `src/routes/+page.svelte` | Chat surface route |
| `src/routes/conversations/[id]/` | Cockpit panel (run timeline) |
| All Tailwind config + `app.css` | Styles, unchanged |
| `src-tauri/icons/` | App icons |

Wire types (`UIChatTurn`, `UIMessagePart`, `UIMessageChunk`, `ToolPart`, etc.) are also preserved exactly — they're the contract between the streaming agent loop and the UI renderer.

---

## What we replace

### 1. Backend server → In-process agent loop

The current agent loop lives in `apps/backend/src/agent/agent-loop.ts` and runs server-side. We move it into the desktop process itself.

**Options for where it runs:**

| Option | Tradeoff |
|---|---|
| TypeScript (SvelteKit frontend process) | Easiest to port, same language, uses `window.fetch` for API calls |
| Rust (Tauri commands) | Better for spawning subprocesses, lower overhead, harder to iterate |
| Worker thread / sidecar TS process | Isolation without rewrite friction |

**Recommended**: TypeScript in the SvelteKit frontend layer, using `window.fetch` to call the chosen LLM API. Tauri commands handle subprocess spawning (for CLI sidecar delegates) and file I/O. This mirrors how the current desktop calls the backend, just loopback-eliminated.

### 2. Postgres + Neo4j → SQLite

Replace with `@tauri-apps/plugin-sql` (already a Tauri first-party plugin, ships the `rusqlite` binding).

Schema (minimal):

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER,
  archived INTEGER DEFAULT 0
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,          -- 'user' | 'assistant'
  content_json TEXT NOT NULL,  -- JSON serialisation of UIChatTurn
  created_at INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL,        -- PENDING | RUNNING | SUCCEEDED | FAILED
  delegate_type TEXT,          -- 'claude-code' | 'codex' | 'inline' | null
  created_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE run_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- 'assistant_text' | 'tool_call' | 'tool_result' | 'stderr' | 'system'
  text TEXT,
  created_at INTEGER,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Memory scoping (currently Neo4j org graph) becomes a flat `memories` table:

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT DEFAULT 'personal',  -- just 'personal' to start
  content TEXT NOT NULL,
  created_at INTEGER
);
```

### 3. Bridge tokens + SSO → API key or account login in keychain

The `auth.svelte.ts` store currently holds `token` (bridge token) and `cliveUrl` (backend URL). Replace with:

```typescript
// stores/auth.svelte.ts (simplified)
export const auth = $state({
  activeAdapterId: null as string | null,
  hydrated: false,
});
```

Credentials stay in the system keychain via the existing `keyring` crate. Anthropic adapters support two distinct auth modes (see SDK Adapter System below); other adapters store API keys under `clive-oss:<adapter-id>:key`.

### 4. clive-bridge → Sub-agent Runner

The current bridge:
1. Polls `GET /api/claude-code/runs/pending` every few seconds
2. Claims a run, executes `claude --print ...` as a subprocess
3. Streams chunks back via `POST /api/claude-code/runs/:id/log-chunks`

The simplified runner:
1. The orchestrator agent emits a `delegate_task` intent (tool call) with a prompt + delegate type
2. The app spawns the appropriate runner in-process:
   - Claude Code CLI: `claude --print "<prompt>"` via Tauri `Command::new`
   - Codex CLI: `codex "<prompt>"`
   - Inline (direct API): spawn an LLM call with a delegate system prompt
   - Local LLM endpoint: direct HTTP to e.g. `http://localhost:11434/v1/chat/completions`
3. stdout/stderr streams back as `run_chunks` rows (same shape as the cockpit panel already expects)
4. No polling, no separate process, no backend API in the middle

---

## SDK Adapter System

Users choose how the orchestrator talks to an LLM. The adapter is a simple interface:

```typescript
interface LLMAdapter {
  id: string;
  name: string;

  streamChat(params: {
    messages: ChatMessage[];
    systemPrompt: string;
    tools?: ToolDefinition[];
    temperature?: number;
  }): AsyncIterable<UIMessageChunk>;

  probe(): Promise<{ ok: boolean; latencyMs?: number }>;
}
```

### Adapter implementations

**AnthropicAdapter** — two auth modes, same wire format

The key insight: Claude Code CLI authenticates to Anthropic via **OAuth** against your claude.ai account (Pro/Team/Max). It stores credentials in `~/.claude/` on disk. That OAuth bearer token can be used directly against `api.anthropic.com/v1/messages` — meaning the orchestrator can talk to Claude using your subscription rather than a pay-per-token API key.

| Mode | `authMode` | How it works | Who pays |
|---|---|---|---|
| **API key** | `api-key` | User pastes an `sk-ant-...` key; stored in keychain | API credits on the key's account |
| **Account (Claude Code)** | `account` | Read OAuth token from `~/.claude/` on disk; refreshed automatically | Your Claude Pro / Team / Max plan |

Implementation details for `account` mode:
- At startup: check `~/.claude/` for a credentials file (exact path varies by OS — macOS is typically `~/.claude/.credentials.json` or the platform-specific app data dir)
- Read the OAuth access token + refresh token + expiry
- If expired: either run `claude auth login` as a subprocess (re-triggers the browser OAuth flow), or silently refresh using the stored refresh token against the Anthropic OAuth endpoint
- Token is kept in-memory during the session; refresh is handled transparently before each request
- No key ever enters the user's settings UI — they see "Logged in as joe@company.com" with a Sign out button

In the `Authorization` header:
- API key mode: `Authorization: x-api-key sk-ant-...` (standard Anthropic API)
- Account mode: `Authorization: Bearer <oauth_token>` with the additional header `anthropic-beta: claude-code-20241220` (same as the Claude Code CLI uses)

**Settings UI for Anthropic adapter:**
```
[Anthropic] 
  Auth: ○ API Key   ● Account (Claude Code)
  
  Account mode:
    Status: ✓ Logged in as joe@company.com
    [Sign out]  [Re-authenticate]
  
  Model: [claude-sonnet-4-6 ▾]
```

**OpenAICompatibleAdapter**
- Configurable base URL (`https://api.openai.com/v1` or `http://localhost:11434/v1` for Ollama etc.)
- API key (empty string for local, stored in keychain otherwise)
- Model name (string, user-supplied — `gpt-4.1`, `o3`, `qwen2.5-coder:32b`, etc.)
- Uses OpenAI chat completions SSE format
- Covers: OpenAI, Codex, Azure OpenAI, Ollama, LM Studio, vLLM, llama.cpp server

**ClaudeCodeCLIAdapter**
- Wraps the `claude` CLI binary via `@tauri-apps/plugin-shell`
- No API key or auth config needed — uses whatever `claude` has on PATH, which inherits the same `~/.claude/` account credentials
- Spawns `claude --print "<prompt>"` and streams stdout as run chunks
- Primarily used as the **delegate runner** (sub-agent), not the orchestrator
- If `claude` is not found on PATH, this adapter is disabled with a helpful message in settings

**LocalModelAdapter**
- A preset of OpenAICompatibleAdapter
- UI pre-populates base URL with `http://localhost:11434/v1` (Ollama default)
- No auth field shown (hidden, set to empty)
- Model list: attempt `GET /api/tags` (Ollama) and populate dropdown; fall back to free-text entry
- Works for: Ollama, LM Studio, llama.cpp, vLLM, anything serving the OpenAI chat completions format

### Adapter config stored in SQLite `settings` table

```json
{
  "adapters": [
    {
      "id": "anthropic-account",
      "type": "anthropic",
      "name": "Claude (my account)",
      "authMode": "account",
      "model": "claude-sonnet-4-6",
      "isOrchestratorDefault": true,
      "isDelegateDefault": false
    },
    {
      "id": "claude-code-cli",
      "type": "claude-code-cli",
      "name": "Claude Code (CLI)",
      "isOrchestratorDefault": false,
      "isDelegateDefault": true
    },
    {
      "id": "ollama-qwen",
      "type": "openai-compatible",
      "name": "Qwen Coder (Ollama)",
      "baseUrl": "http://localhost:11434/v1",
      "model": "qwen2.5-coder:32b",
      "isOrchestratorDefault": false,
      "isDelegateDefault": false
    }
  ]
}
```

Credentials stored in keychain:
- `clive-oss:anthropic-account:oauth-token` — OAuth access token (account mode)
- `clive-oss:anthropic-account:refresh-token` — OAuth refresh token (account mode)
- `clive-oss:<adapter-id>:key` — API key (api-key mode and OpenAI-compatible adapters)

---

## Agent Architecture

### Principle: one orchestrator, many delegates, full visibility

The orchestrator is not a fire-and-forget dispatcher. It is a **long-running control plane** that:
- Maintains a single persistent conversation thread across all sessions
- Delegates discrete tasks to sub-agents
- Receives each agent's completion result back into its own message history (as a `tool_result`)
- Uses that result to decide what to do next — autonomously chain further agents, report back to the user, ask a clarifying question, or park the work

This means the orchestrator accumulates genuine long-running context: it has seen every delegate outcome, every user message, every decision it has made. Over time it can reason about patterns across tasks ("the auth module keeps breaking on deploys, worth flagging") without being prompted.

The user's primary interaction surface is always the orchestrator chat. Sub-agent cockpit panels are observation windows, not separate conversations.

---

### Conversation model

There is **one orchestrator conversation** per "project context" (initially one globally — multiple project contexts is a later phase). It persists across app restarts. The orchestrator always loads its full history from SQLite at the start of each turn.

```
Orchestrator conversation (persistent, grows over time)
  ├── user: "build the login page"
  ├── assistant: [thinking] → calls delegate_task({ task: "...", adapter: "claude-code-cli" })
  ├── tool_result: { runId: "run_01", status: "SUCCEEDED", summary: "Created LoginPage.tsx, wired to /auth/login route, added tests." }
  ├── assistant: "Done — I've created LoginPage.tsx and wired it up. The delegate also added tests. Want me to review the component for accessibility next?"
  ├── user: "yes, and also check the form validation"
  ├── assistant: [thinking] → calls delegate_task x2 (accessibility review, form validation)
  ├── tool_result: { runId: "run_02", status: "SUCCEEDED", summary: "3 a11y issues found, fixed label associations." }
  ├── tool_result: { runId: "run_03", status: "SUCCEEDED", summary: "Added Zod schema, inline error messages." }
  └── assistant: "Both done. The delegate fixed 3 accessibility issues (label associations) and added Zod validation with inline error messages. Here's a summary..."
```

Orchestrator context window management:
- Load up to N messages from SQLite (default: last 100 turns)
- If near the model's context limit, summarise the oldest block of turns and replace them with a compact summary message (same compaction approach as the current backend, just run locally)
- Future: vector-indexed memory lets relevant older messages (past runs on the same repo, related feature decisions) be pulled into context selectively regardless of recency (see Future Considerations)

---

### Orchestrator Agent

The main persistent chat persona. System prompt is **user-configurable** in Settings.

**Default system prompt (orchestrator):**

```
You are Clive, an AI engineering assistant and orchestrator. You help developers plan,
build, and ship software.

Your job is to hold the full picture: you remember what has been done, what is in 
progress, and what needs to happen next. You delegate implementation work to specialist
sub-agents and synthesise their results.

## Delegation
When a task requires executing code, making file changes, running tests, or any action
that touches the filesystem, delegate it using the `delegate_task` tool. Do not attempt
to make file changes directly. Be precise in the task description — include context the
sub-agent needs to do the work without needing to ask you questions.

## After delegation
When a delegate finishes, you receive its result as a tool_result. Read it carefully and:
- Summarise what was done to the user in plain language
- Decide whether the task is fully complete or whether further steps are needed
- If further work is needed, delegate again or ask the user for direction
- If the delegate failed, diagnose why from its output and either retry with a clearer
  brief or surface the problem to the user

## Context management
You are in a long-running conversation. Refer back to prior decisions and outcomes when
relevant. If you notice a pattern across multiple agent results (recurring errors, 
consistent architecture decisions, files that keep changing), flag it proactively.

## What you do not do
- Make direct filesystem changes (always delegate this)
- Lose track of in-progress work when new messages arrive
- Make assumptions about what the user wants when the brief is ambiguous — ask first
```

---

### Delegate / Sub-agent

Each delegate is a **scoped, stateless worker**. It receives a precise task brief, executes it, and reports back. It has no awareness of the broader orchestrator conversation.

When the orchestrator calls `delegate_task`:
- The runner is chosen from the `isDelegateDefault` adapter, or an adapter explicitly named in the tool input
- The delegate runs against its own adapter (can differ from the orchestrator's — e.g. orchestrator on Claude via account, delegate on Claude Code CLI or Ollama)
- Its full output (assistant text, tool calls, tool results, stderr) is streamed as `run_chunks` rows into SQLite
- On completion, a structured `DelegateResult` is assembled and returned as the `tool_result` to the orchestrator

**Default system prompt (delegate — coding agent):**

```
You are a specialist coding sub-agent. You have been given a single scoped task by an
orchestrator. Complete it precisely and report back.

## Rules
- Work only within the scope of the delegated task description
- Prefer small, targeted edits over large rewrites
- Do not introduce changes outside the stated scope
- If you are uncertain about scope, make the conservative choice and note it in your report

## Output
When done, write a concise completion report:
- What you changed and why
- Any assumptions you made
- Any problems you encountered and how you resolved them (or why you couldn't)
- Files changed (list)

If you cannot complete the task safely, stop and explain clearly why.
```

Both prompts are editable in the Settings > Prompts tab with "Reset to default" buttons.

---

### Agent loop (in-process TypeScript)

The orchestrator loop is a **multi-step** loop — each turn keeps going until the model emits a `stop` finish reason with no pending tool calls:

```
user sends message (or delegate result arrives)
  ↓
loadHistory(orchestratorConversationId, limit=100)     -- SQLite
  ↓
maybeCompact(history)                                  -- summarise if near token limit
  ↓
adapter.streamChat({ messages, systemPrompt, tools })
  ↓
loop:
  for each UIMessageChunk:
    - stream text delta → update chat.messages in UI
    - if tool_call received:
        if tool is delegate_task:
          runDelegate(task) → streams to cockpit, eventually returns DelegateResult
          inject tool_result into messages
          continue loop (orchestrator processes result, may call more tools)
        else:
          execute local tool (read_file, remember, recall, etc.)
          inject tool_result
          continue loop
    - if finish (stop, no more tool calls):
        persist full turn to SQLite
        render final assistant bubble
```

This mirrors the current backend's `MAX_STEPS=50` multi-step loop — the orchestrator can chain multiple delegate calls in a single "turn" from the user's perspective, with the UI showing each in-flight operation as it happens.

---

### Fleet view — orchestrator visibility over all agents

The sidebar shows a live **fleet** of all running and recently completed delegates, mirroring the current cockpit/fleet concept:

```
Sidebar
├── [Chat with Clive]         ← always at top, active orchestrator thread
├── ─── Running ──────────────
├── 🔄 Add auth middleware    ← in-flight, shows elapsed time
├── ─── Recent ───────────────
├── ✅ Create LoginPage.tsx   ← succeeded
├── ✅ Fix form validation    ← succeeded
└── ❌ Run test suite         ← failed (red)
```

Clicking any fleet item opens the cockpit panel for that run — the full merged chunk timeline (assistant text, tool calls, tool results, stderr) exactly as the current cockpit renders it.

The orchestrator also has awareness of fleet state through its conversation history: each `tool_result` carries the run status and summary, so the orchestrator can reference prior delegate work when making decisions.

---

### Delegate result shape

When a delegate run completes, this is what the orchestrator receives as a `tool_result`:

```typescript
interface DelegateResult {
  runId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';
  summary: string;           // the delegate's own completion report (last assistant message)
  filesChanged: string[];    // extracted from output where possible
  exitCode?: number;         // for CLI delegates
  durationMs: number;
}
```

The orchestrator sees this as a first-class message in its conversation, not a side channel.

---

### Built-in local tools

| Tool | What it does |
|---|---|
| `delegate_task` | Spawn sub-agent runner; blocks until complete; returns `DelegateResult` |
| `read_file` | Read file via Tauri `fs` plugin |
| `write_file` | Write file via Tauri `fs` plugin (orchestrator rarely uses this directly) |
| `list_files` | List directory contents |
| `remember` | Insert row into `memories` SQLite table |
| `recall` | Full-text search `memories` table |
| `list_runs` | Return recent delegate run statuses (orchestrator can query its own fleet) |

MCP tool support (optional, later phase): user can add MCP server URLs in settings, tools fetched dynamically at session start.

---

### Future consideration: vector-indexed memory

The current design uses recency-windowed history (last N messages) + SQLite full-text search for memories. This works well but loses relevant older context (a conversation about the auth module from 3 weeks ago is invisible when working on auth today).

Later phase: add a local vector store (e.g. `sqlite-vec` extension, or a lightweight embedded store like `usearch`) to index:
- Past orchestrator turns
- Delegate completion summaries
- Per-repo notes
- Epic / feature thread summaries

At each orchestrator turn, retrieve the top-K most semantically relevant chunks from history and inject them into the system prompt context block alongside the recency window. This gives the orchestrator genuine long-term memory without needing to fit every message in the context window.

This is explicitly a future phase — not in scope for the initial simplification. The SQLite schema above (`memories` table, `run_chunks` table) is forward-compatible with this addition.

---

## Settings UI Changes

**Current settings page:**
- Bridge token (paste from Clive backend)
- Clive server URL
- Health status (backend + token)

**New settings page:**

- **Adapters** tab — add/edit/delete adapter configs; set orchestrator and delegate defaults
  - For each Anthropic adapter: toggle between "API Key" and "Account (Claude Code)"
    - API key mode: paste `sk-ant-...` key into a password input → stored in keychain
    - Account mode: shows current login status (email) read from `~/.claude/`; "Sign out" and "Re-authenticate" buttons; re-auth opens the OAuth browser flow via `claude auth login` subprocess
  - For each OpenAI-compatible adapter: base URL + API key (hidden if local/empty)
  - For Claude Code CLI: shows whether `claude` binary is detected on PATH; no credentials to configure
  - For local model: base URL, auto-detected model list from Ollama `GET /api/tags`

- **Prompts** tab — plain textarea editors for orchestrator system prompt and delegate system prompt; "Reset to default" button per prompt

- **Storage** tab — conversation count, clear all history, clear memories

- **About** tab — version, repo link

Health pill changes:
- Instead of pinging `GET /` (backend), call `adapter.probe()` on the default orchestrator adapter
- Green = adapter responds + credentials valid, red = network error or bad credentials, yellow = not configured, grey = account mode + not logged in

---

## What the new project structure looks like

```
clive-desktop-oss/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── src/
│   │   ├── main.rs           -- Tauri setup, plugin registration
│   │   ├── commands/
│   │   │   ├── files.rs      -- read_file, write_file, list_files Tauri commands
│   │   │   ├── keychain.rs   -- get/set/delete keychain entries
│   │   │   └── subprocess.rs -- spawn CLI sidecar (claude, codex), stream stdout
│   │   └── ...
│   └── icons/
│
├── src/
│   ├── app.css               -- (copied verbatim)
│   ├── app.html
│   ├── lib/
│   │   ├── adapters/
│   │   │   ├── types.ts            -- LLMAdapter interface, AdapterConfig
│   │   │   ├── anthropic.ts        -- AnthropicAdapter
│   │   │   ├── openai-compatible.ts-- OpenAICompatibleAdapter
│   │   │   └── claude-code-cli.ts  -- ClaudeCodeCLIAdapter
│   │   ├── agent/
│   │   │   ├── loop.ts             -- streamAgentTurn()
│   │   │   ├── tools.ts            -- local tool registry + execution
│   │   │   ├── delegate.ts         -- runDelegate() — spawn sub-agent
│   │   │   └── prompts.ts          -- default system prompts, loadSystemPrompt()
│   │   ├── components/
│   │   │   ├── chat/               -- (copied verbatim from apps/desktop)
│   │   │   ├── layout/             -- (copied verbatim from apps/desktop)
│   │   │   └── settings/           -- new: AdapterCard, PromptEditor, KeyEntry
│   │   ├── stores/
│   │   │   ├── auth.svelte.ts      -- simplified: activeAdapterId, hydrated
│   │   │   ├── chat.svelte.ts      -- (mostly unchanged, calls local loop)
│   │   │   ├── conversations.svelte.ts -- reads from SQLite
│   │   │   ├── adapters.svelte.ts  -- loaded adapter configs + active adapter
│   │   │   ├── health.svelte.ts    -- probes active adapter instead of server
│   │   │   └── ui.svelte.ts        -- (copied verbatim)
│   │   ├── db/
│   │   │   ├── client.ts           -- init SQLite, run migrations
│   │   │   ├── conversations.ts    -- CRUD for conversations + messages
│   │   │   ├── runs.ts             -- CRUD for runs + chunks
│   │   │   └── memories.ts         -- save/recall memories
│   │   └── types/
│   │       └── chat.ts             -- copied from @cintra-payroll-hr/shared-types
│   ├── routes/
│   │   ├── +layout.svelte          -- (mostly copied, no requireAuth() call)
│   │   ├── +layout.ts              -- simplified: load adapter config, init DB
│   │   ├── +page.svelte            -- (copied verbatim)
│   │   ├── settings/
│   │   │   └── +page.svelte        -- new settings page
│   │   └── conversations/
│   │       └── [id]/
│   │           └── +page.svelte    -- (copied verbatim where possible)
│   └── ...
│
├── package.json
├── svelte.config.js
├── vite.config.ts
├── tsconfig.json
└── README.md
```

---

## Removed dependencies

| Current dep | Why removed | Replacement |
|---|---|---|
| `@ai-sdk/anthropic` (Vercel AI SDK) | Server-only, not needed in browser context | Direct fetch to Anthropic API |
| `express`, `cors`, `body-parser` | No server | — |
| `@prisma/client` | Postgres ORM | `@tauri-apps/plugin-sql` (SQLite) |
| `neo4j-driver` | Graph DB | SQLite `memories` table |
| `@cintra-payroll-hr/shared-types` | Internal monorepo package | Copy types inline |
| `@tauri-apps/plugin-http` | Only needed to call internal backend | `window.fetch` (direct API calls) |
| Bridge token auth middleware | No server, no tokens | API key in keychain |
| Entra SSO / OIDC | No multi-tenant auth | Not applicable |

---

## Dependencies we keep or add

| Dep | Why |
|---|---|
| `@tauri-apps/api` | Core Tauri JS bindings |
| `@tauri-apps/plugin-store` | Settings persistence (adapter config, preferences) |
| `@tauri-apps/plugin-sql` | SQLite via rusqlite |
| `@tauri-apps/plugin-shell` | Spawn CLI subprocess (claude, codex) |
| `svelte`, `@sveltejs/kit` | UI framework — unchanged |
| `tailwindcss` | Styles — unchanged |
| `marked`, `dompurify`, `highlight.js` | Markdown rendering — unchanged |
| `keyring` (Rust crate) | API key storage in system keychain — unchanged |

---

## Open source considerations

**What makes this actually open-sourceable:**
- Zero Cintra infra required (no backend URL, no bridge token, no org graph)
- Works fully offline (when using Ollama/local models)
- No telemetry or usage tracking by default
- Config stays entirely local (SQLite + system keychain)
- Users bring their own API keys — nothing is baked in

**Licence**: MIT (or Apache-2.0)

**What to document in README:**
- Quick start: install → open settings → add adapter → start chatting
- How to connect Ollama for local usage (Qwen Coder, etc.)
- How to configure Claude Code CLI as the sub-agent runner
- How to write/customise system prompts

**What to NOT include:**
- Any Cintra branding beyond attribution ("built with inspiration from Cintra's Clive")
- Any hardcoded keys, org IDs, or endpoint URLs
- The org graph / memory scoping model (too complex; personal memory only)
- The multi-tenant user/auth model
- Teams / Jira integration hooks

---

## Implementation phases

### Phase 0 — Project scaffold (new folder, no git)
1. Create `/Users/localadmin/Documents/clive-desktop-oss/`
2. `npm create tauri-app` with SvelteKit + TypeScript template
3. Copy Tailwind config, `app.css`, `app.html` from `apps/desktop/`
4. Add `@tauri-apps/plugin-sql`, `@tauri-apps/plugin-store`, `@tauri-apps/plugin-shell`
5. Init SQLite with migrations from schema above
6. Get a blank SvelteKit page loading in Tauri — confirm app launches

### Phase 1 — Copy UI verbatim
1. Copy all chat components (`chat/`, `layout/`) into `src/lib/components/`
2. Copy wire types from `@cintra-payroll-hr/shared-types` into `src/lib/types/chat.ts`
3. Copy `ui.svelte.ts`, `chat.svelte.ts` stores (referencing local types)
4. Stub `auth.svelte.ts` (no token, no URL — just `hydrated: true`)
5. Wire `+page.svelte` → `ChatSurface` → confirm it renders (with hardcoded empty messages)

### Phase 2 — SQLite storage
1. Implement `src/lib/db/` layer (conversations, messages, runs, chunks, memories)
2. Wire `conversations.svelte.ts` to SQLite reads/writes
3. Implement `chat.svelte.ts` history load from SQLite (replacing `GET /api/chat/history`)
4. Confirm conversations persist and reload on restart

### Phase 3 — Anthropic adapter + agent loop
1. Implement `AnthropicAdapter` (direct fetch, streaming SSE parse, tool call parsing)
2. Implement minimal `streamAgentTurn()` in `src/lib/agent/loop.ts`
3. Wire `chat.send()` to call the loop instead of `POST /api/chat`
4. Confirm end-to-end: type message → response streams → renders in ChatMessage
5. Add `remember` / `recall` local tools

### Phase 4 — OpenAI-compatible adapter + local LLM
1. Implement `OpenAICompatibleAdapter` (same interface, different wire format)
2. Add adapter settings UI (AdapterCard, base URL, model, key)
3. Test against Ollama running Qwen Coder
4. Confirm switching adapter in settings routes chat to different LLM

### Phase 5 — Sub-agent delegation
1. Implement `delegate_task` tool in tool registry
2. Implement `runDelegate()` — spawns CLI sidecar or inline LLM call
3. Stream subprocess stdout as `run_chunks` rows
4. Render chunks in cockpit panel (already exists in UI)
5. Test: orchestrator on Anthropic, delegate on Ollama (or Claude Code CLI if installed)

### Phase 6 — Settings UI + system prompt editor
1. Build new settings page (adapter management, key entry, prompt editor)
2. Migrate health pill to call `adapter.probe()` instead of server URL probe
3. Add "reset to default" on system prompts
4. Test full flow: configure adapter → chat → delegate task → cockpit shows chunks

### Phase 7 — Polish + README
1. App icon, window title
2. First-run onboarding screen (no adapter configured → prompt to add one)
3. README with quick start for Anthropic and Ollama
4. Test on macOS, attempt Windows build

---

## Non-goals (explicitly out of scope for this simplification)

- Multi-user / multi-tenant auth
- Org graph or team-scoped memory
- MCP server management (deferred to later, user can add manually if needed)
- Jira / Teams / Confluence integrations
- Usage quotas / token budget enforcement
- Cloud sync of conversations
- CI/CD (no git to start)
- Windows/Linux packaging (macOS first, others later)

---

## Open questions to resolve before coding

1. **Exact path of `~/.claude/` credentials on each OS**: The Claude Code CLI stores OAuth credentials somewhere platform-specific. On macOS it's likely `~/.claude/.credentials.json` or in `$HOME/Library/Application Support/claude-code/`. Need to confirm by inspecting an actual installation before implementing the account auth reader. Tauri's `$HOME` is accessible via the `path` plugin — just need the exact filename.

2. **OAuth refresh strategy for account mode**: If the stored access token has expired, the app needs to either (a) silently call the Anthropic OAuth refresh endpoint with the stored refresh token, or (b) prompt the user to re-authenticate via `claude auth login`. Option (a) is better UX but needs the OAuth refresh endpoint URL. Check whether the Claude Code SDK exposes a `refreshToken()` helper or whether it's documented. If not, fall back to (b) — run `claude auth login` as a subprocess on demand.

3. **Tauri sidecar vs `@tauri-apps/plugin-shell`**: Sidecar bundles the binary with the app (good for shipping Claude Code with the app). Shell plugin uses whatever is on PATH (good for user-managed installs). Recommendation: shell plugin first (simpler), sidecar opt-in later.

4. **Should the agent loop run in a Tauri command (Rust) or directly in TypeScript?** The TypeScript approach is faster to iterate but means API calls go through the browser fetch (fine for external APIs, blocked for `localhost` on some OS configs). Tauri command approach avoids CORS issues for local LLM endpoints. Recommendation: Tauri `Command`-based fetch for local URLs, window.fetch for cloud APIs — same adapter interface, branching internally.

5. **Inline delegate vs CLI delegate**: For users without Claude Code or Codex installed, the inline delegate (direct LLM call with the delegate system prompt) should be the fallback default. Make it explicit in settings rather than silent.

6. **App name**: "Clive" carries Cintra branding. Needs a neutral name for OSS. Working name: **Clive** with a note that it's the open-source version — decide before first public release.
