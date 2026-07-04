# Agent rules — desktop-oss

> The single source of project + agent rules for this repo, read by
> Claude Code as `CLAUDE.md`. If another tool needs the same rules,
> symlink its rules file to this one — keep one source of truth.

## What this repo is

`desktop-oss` is a **local-first, modular agent workspace** — a Tauri v2
desktop app with one chat window driven by a long-running **orchestrator**
agent that **delegates** scoped tasks to sub-agents.

The defining goal is **genericness through modularity**. The app has no
opinion about what it's *for*: the same shell becomes a coding assistant,
a research partner, a guitar tutor, or anything else, depending on the
user's prompt and which **modules** are attached. A module is a drop-in
folder that can add an agent **tool**, a right-hand **panel**,
per-conversation **state**, and **system-prompt** wording — with no edits
to any core file. Treat that plug-and-play property as a hard design
constraint: **prefer extending via a module over hard-wiring a feature
into the core.**

**Bring-your-own-LLM** via adapters: `anthropic` (API key or Claude Code
OAuth), `openai-compatible` (OpenAI, Ollama, LM Studio, vLLM, OpenRouter,
…), `claude-code`, `codex`, `cursor`. **Local-first**: no backend; state
in SQLite, credentials in the OS keychain, provider HTTP through a Rust
command (never the webview's `fetch`).

## Ubiquitous Language

- **Orchestrator** — the user-facing chat agent. Plans, answers, and
  calls `delegate_task`. Its role is *not* fixed — it's shaped by the
  user's prompt + attached modules.
- **Delegate** — a scoped sub-agent for one task. No memory of the
  conversation; runs in a sidecar process (can't touch the UI).
- **Adapter** — an LLM backend. Agentic ones (`claude-code`, `codex`,
  `cursor`) are delegate-only; raw-LLM ones (`anthropic`,
  `openai-compatible`) can also drive the orchestrator.
- **Run / run chunk** — one delegate execution (`runs` row) and its
  streamed events (`run_chunks` rows), persisted so history replays.
- **Module** — a drop-in feature under `src/lib/modules/<id>/`,
  auto-discovered (tool + panel + state + prompt fragment).
- **Panel** — a module's UI in the **right dock**. The **left sidebar**
  (conversation history) is separate.
- **Skill** — a frontmatter-defined slash command discovered from disk.
- **Cockpit** — the in-chat tool-entry style: italic verb + monospace
  detail chip + chevron, no card/border. Mandatory for tool parts.

## Quick start

```bash
npm install
npm run tauri:dev             # full app (Tauri + Vite)
npm run check                 # svelte-check; must exit 0
cd src-tauri && cargo check   # Rust-side check
```

First launch redirects to `/settings` to add an adapter. UI hot-reloads;
Rust changes need a `tauri:dev` restart.

## Architecture in one paragraph

The orchestrator's turn runs **in the webview** via
`streamOrchestratorTurn` (`agent/loop.ts`): it assembles the system
prompt (base + environment + delegate roster + active runs + **enabled
modules' prompt fragments**) and the tool set (built-ins from `tools.ts`
+ **enabled modules' tools**), then runs the AI SDK's `streamText`. For
focused work it calls `delegate_task`; `runDelegate` spawns a sub-agent
against its own adapter in a sidecar, streams `run_chunks`, and returns a
structured result. Because the loop runs in the webview, a module tool's
`execute()` can synchronously mutate a Svelte rune store that its panel
renders — the agent→panel channel.

```
User ⟷ orchestrator chat (webview)
        │  prompt = base + modules · tools = built-ins + modules
        ├── delegate_task ─▶ runDelegate ─▶ delegate adapter (sidecar) ─▶ run_chunks (SQLite)
        └── module tool ─▶ mutate module state (rune store) ─▶ right-dock panel re-renders
```

## The module system (the core extensibility surface)

Modules live in `src/lib/modules/`. **Full authoring guide:
[`src/lib/modules/README.md`](src/lib/modules/README.md).** Essentials:

- **Discovery is automatic** — `registry.ts` uses `import.meta.glob` to
  pick up every `src/lib/modules/<id>/index.ts` that
  `export default defineModule({...})`. Adding/removing a module = a
  folder. **No core edits, ever.**
- **The contract** (`types.ts`): declare any subset of `{ createState,
  panel, inputAccessory, tools, promptFragment, settings }` +
  `id`/`label`/`icon`, plus `defaultEnabled()` — a one-shot capability
  probe persisted as the initial enablement (e.g. the git module is off
  by default when git isn't installed).
- **Seams** (all wired automatically): tools + promptFragment merge in
  `loop.ts` via `integration.ts`; panels render in `RightDock.svelte`;
  input accessories render in `WorkdirBar.svelte` (the bar above the
  prompt input); per-conversation state lives in `host.ts` (shared by
  tool + panel); enablement in `store.svelte.ts`.
- **Keep the agent graph clean.** `modules/{registry,host,integration,
  dock-actions}.ts` are plain TS — no runes, no UI/Tauri imports — and
  the glob is node-guarded, so `loop.ts` stays importable under the
  `node:test` eval harness. A tool opens its panel via
  `dock-actions.requestOpenPanel`, never by importing the `ui` store.
- **Rules:** namespace tool names with the module id; panel state must be
  runes (`.svelte.ts`); modules are orchestrator-only (delegates can't
  reach a panel); if you must edit a core file, a seam is missing — flag
  it rather than work around it.

## Where things live

Don't maintain an exhaustive tree here — it rots. Just the stable anchors:

- `src/lib/adapters/` — one file per LLM backend; `index.ts` is the
  `createAdapter` factory + `buildOrchestratorModel`. `native-fetch.ts`
  is the only fetch you may use for provider HTTP.
- `src/lib/agent/` — orchestrator loop (`loop.ts`), delegation
  (`delegate.ts`), built-in tools (`tools.ts`), prompts (`prompts.ts`),
  `evals/` (node:test harness).
- `src/lib/modules/` — **the module harness; extend the app here.**
- `src/lib/components/{chat,shell}/` — chat UI and app shell. Left
  `Sidebar` = history; `RightDock` = module panels.
- `src/lib/stores/` — reactive stores; `chat-store.svelte.ts` is the
  generic, injectable one. `src/lib/types/` — wire contracts.
- `src/lib/db/` — SQLite. `src/lib/skills/` — disk-discovered slash
  commands.
- `src/routes/` — `sessions/[id]` (orchestrator chat),
  `conversations/[id]` (delegate run), `settings`.
- `src-tauri/` — Rust shell: commands in `src/lib.rs`, `migrations/`,
  `tauri.conf.json`. `sidecar/` — native agent sidecars.

## Stack

| Layer | Pinned |
|---|---|
| Shell | Tauri 2.x (Rust + WKWebView) |
| Frontend | SvelteKit 2.x, **Svelte 5 runes**, TypeScript strict |
| Bundler | Vite 8.x (adapter-static, SSR off) |
| Storage | `@tauri-apps/plugin-sql` (SQLite, `src-tauri/migrations/`) |
| Credentials | `@tauri-apps/plugin-store` + OS keychain |
| HTTP to LLMs | Rust `http_stream` (`reqwest`/rustls), streamed via Tauri Channel |
| Markdown | `marked` + `dompurify` + `highlight.js` |

## Conventions

- **Runes** (`$state`/`$derived`/`$effect`/`$props`) only work in
  `.svelte`/`.svelte.ts`/`.svelte.js`. In a plain `.ts` they throw at
  runtime → blank screen, no error. Class stores live in `*.svelte.ts`.
- **TypeScript strict**; `npm run check` must exit 0. Wire contracts in
  `src/lib/types/`. Avoid `any` (use `unknown` + narrowing).
- **Comments**: default to none; comment WHY for non-obvious
  workarounds/invariants/external-bug refs. Don't reference the task/PR.
- **Styling**: no Tailwind. CSS vars in `app.html` `:root` (light
  overrides via `prefers-color-scheme`). Tool entries use the cockpit
  style (`display:block`, no card); right-dock panels mirror the
  Sidebar's floating-card style.
- **HTTP**: never `window.fetch` for LLM endpoints (its `Origin` header
  trips CORS/anti-abuse at Anthropic). Always
  `import { nativeFetch as fetch } from "$lib/adapters/native-fetch"`.
- **Reuse**: a new chat surface is `new ChatStore({...})` +
  `<ChatSurface store={…}>`. A new stateful feature with UI → a
  **module**, not a bespoke component + singleton.
- **Adapters**: one brand = one implementation; transport preference SDK
  > MCP/stdio > JSON-mode CLI > plain-text CLI (avoid). Delegate-only
  adapters return `null` from `buildOrchestratorModel`.

## Critical pitfalls

1. **Runes in `.ts`** → silent white screen. Use `.svelte.ts`.
2. **Streaming token shredding**: persist the full text segment at
   `text-end`, not one row per `text-delta`.
3. **Origin → CORS**: use `nativeFetch`, never `window.fetch`, for LLMs.
4. **OAuth fingerprint**: don't simplify the Anthropic header
   construction without re-reading upstream (see below).
5. **Tool-entry styling**: cockpit style is `display:block`, no card.
6. **Module eval-graph safety**: keep `modules/{registry,host,integration,
   dock-actions}.ts` runes/UI/Tauri-free and the glob node-guarded —
   `loop.ts` is imported by the eval harness.
7. **No `registerTool()` global** — built-ins are an object literal in
   `tools.ts`; extra tools come from modules via `integration.ts`.
8. **Adapter sprawl**: extend/replace a transport before adding a type;
   delete failed experiments.

## Common tasks

- **Add a feature** → a module: `src/lib/modules/<id>/index.ts` with
  `defineModule({...})`. See its README. Nothing else to wire.
- **Add a built-in tool** → a `tool({...})` entry in `buildEssentialTools`
  (`tools.ts`); add a `tool-summary.ts` case; add a `ToolPartView.svelte`
  branch only if the generic JSON fallback is wrong. Prefer a module for
  feature-specific tools.
- **Add an adapter** → implement `LLMAdapter`, add cases to `index.ts`
  (`createAdapter` + `buildOrchestratorModel`) and the `AdapterType`
  literal + `presets.ts`. Heads-up: several non-exhaustive `switch`es
  over `AdapterType` (presets, loop, settings UI) aren't compiler-caught.
- **Add a chat surface** → `new ChatStore({...})` + `<ChatSurface>`.

## Anthropic OAuth (account mode)

`api.anthropic.com` accepts the CLI's OAuth tokens only when the request
matches an expected fingerprint. If you touch the Anthropic header
construction (`adapters/anthropic.ts` + `claude-code-fingerprint.ts`),
keep ALL of:
- `Authorization: Bearer <oauth_token>` (from
  `read_claude_code_credentials`, keychain).
- `x-app: cli` (the gate).
- `User-Agent: claude-cli/<version> (...)` — `claude-cli/` prefix matters.
- `X-Claude-Code-Session-Id: <uuid>` (stable per app run).
- `anthropic-beta: claude-code-20250219,oauth-2025-04-20` (+
  `,context-1m-2025-08-07` if 1M context is on).
- A line **prepended to the system prompt** (not a header):
  `x-anthropic-billing-header: cc_version=<version>.<3-char fingerprint>; cc_entrypoint=cli;`
  (fingerprint computed in `claude-code-fingerprint.ts`).

Drop any → `429 rate_limit_error` even with quota. Reference: upstream
`claude-code/src/services/api/client.ts` + `utils/`.

## Verification

- `npm run check` (svelte-check + TS, zero errors), `cd src-tauri &&
  cargo check`, `npm run build` (catches what svelte-check misses, incl.
  `import.meta.glob` discovery).
- Restart `tauri:dev` after Rust changes; Cmd+R for JS-only.
- Wire-level: tail `tauri:dev` for `[http_stream]`, `[delegate]`,
  `[chat-store]`, `[nativeFetch]`.

## Local data (macOS)

| Thing | Path |
|---|---|
| SQLite DB | `~/Library/Application Support/io.github.desktop-oss/desktop-oss.db` |
| UI prefs | `…/io.github.desktop-oss/preferences.json` |
| API keys | OS keychain (`@tauri-apps/plugin-store`) |
| Local skills | `~/.desktop-oss/skills/` |
| Claude Code OAuth (read-only) | keychain, service `Claude Code-credentials` |

## Build & release notes

- **Dev needs no Bun** — sidecars run as `node sidecar/<name>/index.mjs`
  (`postinstall` wires them). **Bundles are host-arch** — `stage.mjs`
  builds for the host; no arch literal in `tauri.conf.json` (don't add
  one). **Releases**: push a `v*` tag → `.github/workflows/release.yml`.
- Local `tauri:build` DMG can hang in a non-interactive shell; use
  `CI=1 npm run tauri:build` or `tauri build --bundles app`.
- **New worktree → `cargo check`/`tauri:dev` fails** with `resource path
  sidecar-dist/... doesn't exist`: `tauri.conf.json`'s `bundle.resources`
  is validated at compile time regardless of dev vs. build, but
  `src-tauri/sidecar-dist/` is gitignored and only produced by
  `sidecar/stage.mjs` (needs `bun`). A `post-checkout` git hook
  (`scripts/hooks/post-checkout`, installed into the shared hooks dir by
  `scripts/install-git-hooks.mjs` via `postinstall` — no `core.hooksPath`
  config change) detects a fresh `git worktree add` (prev HEAD = all-zero
  SHA) and runs `scripts/setup-worktree.sh` (`npm install` + `stage.mjs`)
  automatically. If the hook isn't installed yet in your checkout, run
  `npm run setup:worktree` by hand once per new worktree.
