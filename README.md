# Desktop OSS

A **local-first, modular agent workspace** for your desktop. One chat
window, a long-running **orchestrator** agent that can **delegate** work
to sub-agents, and a **plug-in module system** that lets you bolt on new
tools and side panels. Bring your own LLM.

It ships with no opinion about what it's *for*. The same app becomes:

- a **coding assistant** (point it at a repo, let it delegate edits),
- a **research partner** (delegate searches, collect findings),
- a **guitar tutor** (a fretboard panel the agent drives as it teaches),
- …or whatever you build a module for.

> Status: early development. It runs, but expect rough edges and breaking
> changes.

## The idea

```
You ⟷ Orchestrator (one long-running chat)
            │
            ├── delegates scoped tasks ─▶ sub-agents (your choice of model)
            └── drives modules ─▶ tools + side panels on the right
```

- **Orchestrator + delegates.** You talk to one orchestrator. It holds
  the whole conversation, answers directly when that's best, and hands
  focused jobs to sub-agents — which can run on *different* models in
  parallel. Their results come back into the chat.
- **Bring your own LLM.** Configure one or more adapters: Anthropic (API
  key or Claude Code account login), any OpenAI-compatible endpoint
  (OpenAI, Ollama, LM Studio, vLLM, OpenRouter, a Tailscale-hosted
  model), the Claude Code agent, Codex, or Cursor.
- **Modular.** Features are *modules* — drop-in folders that add an agent
  tool, a right-hand panel, and the wording the agent needs to use them.
  Add one and it appears; delete it and the app carries on. See
  [Extending with modules](#extending-with-modules).
- **Local-first & private.** No backend, no account, no telemetry. Your
  conversations live in a local SQLite file; API keys live in your OS
  keychain. Requests go straight from your machine to whichever provider
  you configured.

## Quick start

```bash
npm install
npm run tauri:dev          # launches the app (Vite + Tauri together)
```

On first run the app opens **Settings → Adapters**. Add at least one
adapter (e.g. paste an Anthropic API key, or point at a local Ollama
URL), then start chatting from the home view.

> Native agent sidecars are built for your machine automatically on
> `npm install`; `npm run tauri:build` bundles the right architecture.
> See [CLAUDE.md](./CLAUDE.md) for the build/release details.

## Adapter recipes

| You want… | Adapter | Notes |
|---|---|---|
| Claude via your API key | **Anthropic** (api-key) | paste a key from console.anthropic.com |
| Claude via your Claude subscription | **Anthropic** (account) | reuses the Claude Code login in your keychain |
| A local model | **OpenAI-compatible** | point at Ollama / LM Studio / vLLM (`http://localhost:…/v1`) |
| OpenAI / OpenRouter | **OpenAI-compatible** | base URL + key |
| Claude Code as a worker | **Claude Code** | runs the bundled agent SDK as a delegate |
| Codex / Cursor as a worker | **Codex** / **Cursor** | the vendor's coding agent as a delegate |

The orchestrator (the chat you talk to) must be a raw-LLM adapter
(Anthropic or OpenAI-compatible). The agentic adapters (Claude Code,
Codex, Cursor) run their own loops and are used as **delegates**.

## Extending with modules

A module is a self-contained folder under `src/lib/modules/<id>/`. It can
contribute any combination of:

- an **agent tool** the orchestrator can call,
- a **right-dock panel** (a UI surface on the right of the window),
- **per-conversation state** the tool writes and the panel reads (so the
  agent can drive the UI live),
- **system-prompt wording** that tells the agent the capability exists.

The app **auto-discovers** modules — there's no registry to edit. Drop
the folder in and the tool, panel, and prompt wording light up; delete
it and they all disappear, with the layout reflowing cleanly. This is how
the same shell becomes a coding tool or a guitar tutor: by attaching the
right modules.

Full authoring guide with copy-paste templates:
[`src/lib/modules/README.md`](src/lib/modules/README.md).

## What's where

```
src/lib/adapters   bring-your-own-LLM backends
src/lib/agent      orchestrator loop, delegation, prompts, tools
src/lib/modules    the plug-in module system  ← extend here
src/lib/components  chat UI + app shell (left sidebar, right dock)
src/lib/skills     disk-discovered slash commands
src-tauri          the Rust/Tauri shell (filesystem, HTTP, keychain)
sidecar            native agent sidecars (Claude Code, Cursor)
```

## Local data (macOS)

| Thing | Path |
|---|---|
| Conversations & runs (SQLite) | `~/Library/Application Support/io.github.desktop-oss/desktop-oss.db` |
| UI preferences | `~/Library/Application Support/io.github.desktop-oss/preferences.json` |
| API keys | your OS keychain (never written to disk in plain text) |
| Local skills | `~/.desktop-oss/skills/` |

## Building

```bash
npm run check          # type-check (svelte-check + TypeScript)
npm run build          # production web bundle
npm run tauri:build    # package a .app / .dmg  (use CI=1 in non-interactive shells)
```

Per-OS/arch release installers are built in CI on pushing a `v*` tag (see
`.github/workflows/release.yml`).

## Contributing

Project + agent conventions live in [CLAUDE.md](./CLAUDE.md) (read by
Claude Code and any other agent working in this repo). The short version:
Svelte 5 runes, TypeScript strict, `npm run check` must pass, no Tailwind,
and **prefer adding a module over hard-wiring a feature into the core.**
