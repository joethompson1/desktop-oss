# Agent rules — clive-desktop-oss

> This file is the canonical source. `CLAUDE.md`, `.cursorrules`,
> `.cursor/rules/main.mdc`, and `.github/copilot-instructions.md` are
> symlinks (or copies) of it so Claude Code, Cursor, Codex, OpenCode, and
> GitHub Copilot all see the same rules. Edit this file; the others
> follow.

## What this repo is

`clive-desktop-oss` is a Tauri v2 desktop app — a single user-facing
window chatting with a long-running **orchestrator agent** that can
**delegate** scoped tasks to one or more sub-agents. Bring-your-own
LLM via one of these adapters: **Anthropic** (direct API key or
Claude Code OAuth), **OpenAI-compatible** (OpenAI, Ollama, LM Studio,
vLLM, OpenRouter, Tailscale-hosted models), **Claude Code**
(Anthropic's coding agent via the bundled
`@anthropic-ai/claude-agent-sdk`), or **Codex** (OpenAI's coding agent
via `codex mcp-server`, can route to local models via your codex
config).

It is **local-first**: no backend server, no Postgres, no Neo4j. State
lives in SQLite inside the app data dir; credentials live in the macOS
keychain (or the per-OS equivalent). Outbound HTTP to LLM providers
goes through a custom Rust command, not the webview's `fetch`.

## Ubiquitous Language

The canonical vocabulary used in code, comments, prompts, and docs.
Regenerate this section with `/ubiquitous-language` after material
changes to terminology — the skill scans source files and module-level
docs to keep it current.

- **Orchestrator** — the long-running, user-facing chat agent. Holds
  the conversation, plans work, calls `delegate_task` when work needs
  to happen out of the main chat.
- **Delegate** — a scoped sub-agent spawned for one task. No memory of
  the orchestrator's conversation; receives a structured brief.
- **Adapter** — the LLM backend implementation that an orchestrator or
  delegate talks to. One adapter = one configured connection (model +
  credentials + provider). Types: `anthropic`, `claude-code`,
  `openai-compatible`, `codex`.
- **Run** — one delegate execution. Persisted as a row in `runs` plus
  N rows in `run_chunks`. Status is one of `PENDING`, `RUNNING`,
  `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`.
- **Run chunk** — one streamed event from an adapter (text-delta,
  tool-call, tool-result, error). Persisted so a run's history can be
  reconstructed without re-running.
- **Session / thread** — provider-side conversation state. The Claude
  Code SDK calls it a `session_id`; Codex calls it a `threadId`. Both
  map to `adapter_session_id` on the run row, which we replay on
  continuations to skip resending the full history.
- **Continuation** — a follow-up turn within an existing delegate run,
  triggered by the `message_delegate` tool. Uses the persisted
  session/thread ID if the adapter supports resume.
- **Profile** — a named bundle of model + provider + flags in a
  vendor's config (e.g. a Codex profile in `~/.codex/config.toml`).
  Distinct from our adapter config, which is at the app level.
- **Brief** — the structured markdown task description the orchestrator
  hands a fresh delegate at spawn time.
- **Cockpit** — the in-chat tool-entry style: italic verb +
  monospace detail chip + chevron, no card/border. The mandatory style
  for tool parts.

## Quick start

```bash
npm install
npm run tauri:dev      # full app — Tauri shell + Vite
npm run check          # svelte-check; must exit 0
cd src-tauri && cargo check   # Rust-side check
```

The app's first launch redirects to `/settings` to configure at least
one adapter. UI changes are picked up by Vite HMR live in the running
window. Rust changes need a `tauri:dev` restart.

## Stack

| Layer | Pinned |
|---|---|
| Shell | Tauri 2.x (Rust + WKWebView) |
| Frontend | SvelteKit 2.x, **Svelte 5 runes**, TypeScript strict |
| Bundler | Vite 8.x via `@sveltejs/kit` |
| Storage | `@tauri-apps/plugin-sql` (SQLite, schema in `src-tauri/migrations/`) |
| Credentials | `@tauri-apps/plugin-store` (per-user JSON) + macOS keychain (read-only for Claude Code OAuth) |
| HTTP to LLMs | Custom Rust `http_stream` command using `reqwest` (rustls), streamed back to JS via Tauri Channel |
| Markdown | `marked` + `dompurify` + `highlight.js` (atom-one themes) |

## Architecture in one paragraph

The **orchestrator** is the user-facing chat persona. It talks to one
configured LLM adapter — any of: Anthropic, OpenAI-compatible,
Claude Code, or Codex. When it needs to do work that touches the
filesystem, runs code,
or just wants to offload a focused task, it calls the `delegate_task`
tool with an optional `adapter` field naming a specific delegate.
`runDelegate` spawns the chosen sub-agent against its own adapter,
streams the response back as run-chunk rows, and hands the orchestrator
a structured `DelegateResult` carrying summary + adapter identity. The
run-detail page (`/conversations/[id]`) renders any past run as a
chat surface — same components as the orchestrator chat — so the user
can also talk to a delegate directly after the orchestrator's initial
spawn.

```
User
 │
 ▼  orchestrator chat (ChatStore)
Orchestrator adapter ── delegate_task ──▶ runDelegate
                                          │
                                          ▼
                                       Delegate adapter
                                          │
                                          ▼
                                       run_chunks (SQLite)
                                          │
                                          ▼
                                       Run-detail surface (ChatStore)
```

## File layout

```
src/
  app.html, app.css         — global theme; CSS vars in :root, light/dark via prefers-color-scheme
  lib/
    adapters/
      anthropic.ts          — Anthropic /v1/messages, two auth modes
      anthropic-ai-sdk.ts   — Anthropic LanguageModelV3 wrapper for the orchestrator loop
      openai-compatible.ts  — OpenAI/Ollama/LM Studio/OpenRouter/etc.
      claude-code-sdk.ts    — Claude Code via @anthropic-ai/claude-agent-sdk (bundled Bun sidecar)
      codex-mcp.ts          — Codex via `codex mcp-server` (JSON-RPC over stdio)
      mcp-stdio-client.ts   — generic JSON-RPC-over-stdio MCP client (used by codex-mcp)
      native-fetch.ts       — fetch-shaped wrapper around the Rust http_stream command (USE THIS, not window.fetch)
      sse.ts                — minimal SSE parser
      claude-code-auth.ts   — reads OAuth credentials from macOS keychain
      presets.ts            — model presets + provider URL presets for the settings UI
      index.ts              — createAdapter() factory + per-adapter keychain helpers
sidecar/
  claude-agent/             — Node/Bun sidecar that runs @anthropic-ai/claude-agent-sdk's query() and relays SDKMessage events as NDJSON
    agent/
      loop.ts               — orchestrator turn (multi-step, max 50 steps, tool execution)
      delegate.ts           — runDelegate (one-shot) + streamDelegateContinue (multi-turn generator)
      tools.ts              — local tool registry: delegate_task, remember, recall, read_file, list_files, list_runs
      prompts.ts            — default orchestrator + delegate system prompts, editable in Settings → Prompts
      run-chunks-to-turns.ts — adapter: ChunkRow[] → UIChatTurn[] (coalesces adjacent text chunks)
    components/
      chat/                 — ChatSurface, ChatMessage, ChatInput, ToolPartView, ToolCodeBlock, ToolOutputDisclosure, MarkdownView, AttachmentChip, tool-summary, tool-body-helpers
      shell/                — Sidebar, SidebarToggle, AppTopBar, HealthPill, ConversationRow, NewAgentModal
      shared/               — PromptBar, ConversationScroll, TitleBar
    db/
      client.ts             — lazy SQLite handle (sqlite:clive-oss.db)
      conversations.ts      — orchestrator messages
      runs.ts               — delegate runs + chunks
      memories.ts           — orchestrator memory entries
      settings.ts           — JSON key/value (adapter configs, prompts)
    markdown/index.ts       — renderMarkdown + highlightCode (highlight.js)
    rust/attachments.ts     — Tauri-command wrappers for file picking & base64
    stores/
      chat-store.svelte.ts  — generic ChatStore class (reactive state + send + hydrate)
      chat.svelte.ts        — orchestrator-bound ChatStore instance
      adapters.svelte.ts    — configured adapters + resolveOrchestrator / resolveDelegate / resolveByNameOrId
      auth.svelte.ts, ui.svelte.ts, conversations.svelte.ts, health.svelte.ts
    types/
      chat.ts               — UIChatTurn / UIMessagePart / UIMessageChunk (wire shape)
      adapter.ts            — LLMAdapter interface, AdapterConfig
      run.ts                — RunSummary, ChunkRow, DelegateResult
  routes/
    +layout.{svelte,ts}     — shell hydration + Sidebar + AppTopBar
    +page.{svelte,ts}       — orchestrator chat surface
    settings/+page.svelte   — adapter management, prompts editor, about
    conversations/[id]/+page.svelte  — per-run chat surface (delegate continuations)
src-tauri/
  src/lib.rs                — Rust commands: read_file_base64, read_text_file, write_text_file, list_directory, home_dir, read_claude_code_credentials, http_stream
  migrations/0001_initial.sql
  capabilities/default.json
  Cargo.toml, tauri.conf.json
```

## Conventions

### Svelte 5 runes
- `$state`, `$derived`, `$effect`, `$props` only work in files Svelte's
  preprocessor recognises: **`.svelte`**, **`.svelte.ts`**,
  **`.svelte.js`**. If you put runes in a plain `.ts`, the file will
  import fine but execute `$state` as a normal function call at runtime
  and the module will throw — the entire app goes blank with no error
  in the terminal. Class-based stores live in `*.svelte.ts`.
- Use the class pattern for shared stores (see `chat-store.svelte.ts`).
  Field-level `$state` in a class is the cleanest reactive primitive.

### TypeScript
- Strict mode. `npm run check` must exit with 0 errors.
- Types live in `src/lib/types/`. Wire types (the contracts between the
  agent loop and the UI) are in `chat.ts`, `run.ts`, `adapter.ts`.
- Avoid `any`. Use `unknown` + narrowing if a JSON-decoded blob is
  genuinely shape-unknown.

### Comments
- **Default to no comments.** Well-named functions, variables, and
  small functions should make intent obvious. Don't restate what the
  code says.
- **Do** comment WHY for non-obvious workarounds, hidden invariants,
  external-bug references, or surprising design choices (e.g. the
  Anthropic OAuth fingerprint requirement).
- Don't reference the current task / PR / fix in code comments —
  that's the commit message's job.

### Styling
- No Tailwind. CSS variables defined in `src/app.html`'s `:root`,
  light-mode overrides in `@media (prefers-color-scheme: light)`.
- Reuse `--bg`, `--text`, `--text-muted`, `--text-faint`, `--border`,
  `--border-strong`, `--accent`, `--success`, `--warn`, `--danger`,
  `--code-bg`, `--code-inline-bg`, `--code-mono`, `--text-body`,
  `--text-meta`, `--text-caption`.
- Tool entries in chat **must** match the cockpit's inline style:
  `display: block`, no border, no card background, italic verb +
  monospace detail chip + chevron. See
  `src/lib/components/chat/ToolPartView.svelte` — don't wrap in cards.

### HTTP — never use `window.fetch` for LLM endpoints
The webview's fetch forwards an `Origin: tauri://localhost` header.
Anthropic and some other providers classify this as a CORS request and
either reject it outright or apply anti-abuse rate limits. **Always**
import:

```ts
import { nativeFetch as fetch } from "$lib/adapters/native-fetch";
```

This routes through the Rust `http_stream` Tauri command (reqwest with
rustls, no Origin header) and exposes the same `fetch`-shaped Response
surface (`ok`, `status`, `text()`, `body.getReader()`). SSE streaming
works exactly the same way.

The Rust side prints `[http_stream] → POST <url>` and the response
status to stderr, so you can verify wire-level behaviour by tailing
the terminal where you ran `tauri:dev`.

### Reuse over duplication
The whole point of `ChatStore` and the props-driven components is so
that a new chat-like surface is a 10-line file. **Never** re-implement:

- Chat message rendering → `<ChatMessage>` handles text + tool parts +
  attachments + streaming pacing + thinking-dot.
- Chat input → `<ChatInput onSend={...} sending={...} placeholder={...}
  allowAttachments={...} />` — same component for orchestrator and
  delegate. Falls back to the orchestrator store when no `onSend` is
  given.
- Whole surface → `<ChatSurface store={myStore} … />` takes any
  `ChatStore`.
- Chunk → turn conversion → `chunksToChatTurns(chunks)` already
  coalesces adjacent text chunks and threads tool calls with their
  results.

### Adapter conventions

**One brand = one implementation.** When a vendor offers their coding
agent through multiple transports (CLI, npm SDK, MCP server, HTTP API),
pick the best one and remove the others. Don't carry parallel
implementations ("claude-code-cli" *and* "claude-code-sdk") — users see
only the brand and shouldn't have to reason about transport. Internal
type IDs match the brand: `anthropic`, `claude-code`,
`openai-compatible`, `codex`.

**Prefer programmatic over subprocess scraping.** In order of preference:
1. A vendor-provided programmatic SDK that emits typed events (e.g.
   `@anthropic-ai/claude-agent-sdk`).
2. An MCP / ACP server the vendor ships, driven via JSON-RPC over stdio
   (e.g. `codex mcp-server`).
3. A vendor CLI invoked as a subprocess with a structured `--json` /
   `--format json` mode and an NDJSON parser.
4. Subprocess + plain-text stdout scraping. Avoid; this is the path that
   broke OpenCode for us — no structure, fragile to vendor changes.

**Before adding a new adapter**, check whether an existing one can be
extended. A new adapter type is justified only when the brand is new
(no existing entry surfaces this vendor's agent) and a transport from
the preference list above is available. Half-finished placeholders are
worse than no adapter — delete experiments that don't reach parity.

**Delegate-only adapters return `null` from `buildOrchestratorModel`.**
Agentic adapters (Claude Code, Codex) run their own internal loops and
can't be driven by the Vercel AI SDK's `streamText` — they're
delegate-only. Only the raw-LLM adapters (`anthropic`,
`openai-compatible`) build a `LanguageModelV3` for the orchestrator.

## Common tasks

### Add a new LLM adapter
0. **Decide first.** Does an existing adapter already cover this vendor?
   If yes, extend it or replace its transport — don't add a parallel
   adapter. See "Adapter conventions" above.
1. Pick the transport per the preference order (SDK > MCP > JSON-mode
   CLI > plain-text CLI). Document the choice in the adapter file's
   header comment.
2. Implement the `LLMAdapter` interface (`src/lib/types/adapter.ts`).
   Required: `id`, `name`, `type`, `config`, `streamChat()` (async
   iterable of `ChatStreamPart`), `probe()` (`{ ok, latencyMs?,
   message? }`).
3. Add a new case to `createAdapter()` in
   `src/lib/adapters/index.ts`. If the adapter is delegate-only,
   return `null` from `buildOrchestratorModel()`.
4. Add an `AdapterType` literal to `src/lib/types/adapter.ts` — use
   the brand name (e.g. `codex`), not the transport (e.g. `codex-mcp`).
5. Add model + provider presets to `src/lib/adapters/presets.ts` if
   you want them in the New Adapter form.
6. Use `nativeFetch` for HTTP (never `window.fetch`). Use
   `parseSSEStream(response)` for SSE bodies.
7. For MCP/ACP-style adapters that hold a long-lived subprocess:
   lazy-spawn on first `streamChat()` call, reuse across runs, clean
   up on adapter delete. See `mcp-stdio-client.ts` for the established
   pattern.

### Add a new orchestrator tool
1. `registerTool({ definition, handler })` in
   `src/lib/agent/tools.ts`. The schema is JSON Schema. The handler
   receives `(input: unknown, ctx)`.
2. For tools that need access the orchestrator can't give them
   directly (like the delegate adapter), intercept the call in
   `src/lib/agent/loop.ts` next to the existing `delegate_task`
   handling and throw from the registered handler as a safety net.
3. Add a verb/detail mapping in `src/lib/components/chat/tool-summary.ts`
   so the in-chat header reads cleanly.
4. Add a specialised renderer branch in
   `src/lib/components/chat/ToolPartView.svelte` if the default JSON
   dump is wrong.

### Add a new chat-like surface
1. `import { ChatStore } from "$lib/stores/chat-store.svelte";`
2. Instantiate per-mount with `{ loadHistory, send, onTurnFinalized? }`.
3. Render `<ChatSurface store={store} … />`.
4. That's it. No bespoke chunk-walking, no custom composer, no
   streaming logic.

### Anthropic OAuth (account-mode) requests
The official `claude` CLI's OAuth tokens are accepted by
`api.anthropic.com` only when the request matches an expected
fingerprint. If you touch
`src/lib/adapters/anthropic.ts#buildHeaders` or
`buildBillingHeaderLine`, keep all of these:

- `Authorization: Bearer <oauth_token>` from
  `read_claude_code_credentials` (macOS keychain).
- `x-app: cli` (the gate).
- `User-Agent: claude-cli/<version> (...)` — `claude-cli/` prefix
  matters.
- `X-Claude-Code-Session-Id: <uuid>` (one per app run, stable).
- `anthropic-beta: claude-code-20250219,oauth-2025-04-20` (plus
  `,context-1m-2025-08-07` if 1M context is enabled).
- A line **prepended to the system prompt** (NOT an HTTP header):
  `x-anthropic-billing-header: cc_version=<version>.<3-char fingerprint>; cc_entrypoint=cli;`
  where the fingerprint is `sha256(SALT + msg[4]+msg[7]+msg[20] + version).slice(0,3)`.

If you drop any of these, Anthropic returns `429 rate_limit_error
{"message":"Error"}` *even when the account has plenty of quota*. The
canonical reference is `claude-code/src/services/api/client.ts` +
`utils/http.ts` + `utils/betas.ts` + `utils/fingerprint.ts` in the
upstream repo.

## Critical pitfalls

1. **Runes in `.ts` files**: silent module-load failure → white screen.
   Always `.svelte.ts` for class-based stores.
2. **Streaming token shredding**: persisting every `text-delta` as its
   own `assistant_text` chunk row gives one bubble per token on
   reload. Accumulate in memory, persist the complete segment at
   `text-end`.
3. **Origin header → CORS**: any code path that uses `window.fetch`,
   `@tauri-apps/plugin-http`'s fetch, or any fetch that forwards
   Origin will fail against Anthropic. Use `nativeFetch`.
4. **OAuth fingerprint**: see above. Don't simplify the Anthropic
   header construction without re-reading the upstream source.
5. **Tool entry container styling**: the cockpit style is
   `display: block` with no border. Don't add cards/borders/elevation
   around `.tool-entry`.
6. **Adjacent text chunks**: legacy data may have one row per token.
   `chunksToChatTurns` coalesces these — don't bypass it when
   rendering run chunks.
7. **Asymmetric `.tool-calls` margin**: must be `margin: 0.7em 0`
   (both top and bottom), not `margin-bottom` only.
8. **Adapter sprawl**: don't add a new adapter type when you can fix or
   replace an existing one's transport. Two half-working adapters under
   the same brand confuse users and double the maintenance surface. If
   a transport experiment fails (e.g. text-scraping a TUI-mode CLI),
   delete it — don't leave it as a placeholder.

## Verification

- `npm run check` — svelte-check + TypeScript. Zero errors required.
  Three known cosmetic warnings (NewAgentModal a11y, tsconfig "node"
  type) are acceptable.
- `cd src-tauri && cargo check` — Rust-side check.
- `npm run build` — production SvelteKit bundle. Catches anything
  svelte-check missed.
- Manual: relaunch `npm run tauri:dev` after Rust changes; refresh the
  Tauri window (Cmd+R) for JS-only changes (Vite HMR delivers in-place
  but Svelte state is preserved — a hard refresh is safer when testing
  hydration / first-render logic).
- Wire-level: tail the `tauri:dev` terminal for `[http_stream]`,
  `[delegate]`, `[chat-store]`, `[nativeFetch]` debug lines.

## Commands cheatsheet

| Command | What it does |
|---|---|
| `npm install` | Install JS deps + Tauri CLI |
| `npm run dev` | Vite dev server only (UI iteration without Rust) |
| `npm run tauri:dev` | Full Tauri shell + Vite |
| `npm run build` | SvelteKit static build to `build/` |
| `npm run tauri:build` | Bundle `.app` / `.dmg` |
| `npm run check` | Svelte-kit sync + svelte-check |
| `cd src-tauri && cargo check` | Rust type / lint |
| `cd src-tauri && cargo build --release` | Release Rust build |

## Local data locations (macOS)

| Thing | Path |
|---|---|
| SQLite DB | `~/Library/Application Support/io.github.clive-oss/clive-oss.db` |
| Adapter API keys | macOS keychain via `@tauri-apps/plugin-store` (`credentials.json`) |
| UI prefs | `~/Library/Application Support/io.github.clive-oss/preferences.json` |
| Claude Code OAuth (read-only) | macOS keychain, service `Claude Code-credentials` |

## When in doubt

- Run `npm run check` before claiming a task is done.
- Match the existing component patterns rather than inventing new
  ones. The codebase is deliberately modular — a new feature usually
  fits inside existing abstractions.
- Read the upstream `claude-code` source under
  `~/Documents/github/claude-code/src/` when touching anything that
  talks to `api.anthropic.com` with an OAuth token.
- Prefer one well-named function over a paragraph of inline comments.
