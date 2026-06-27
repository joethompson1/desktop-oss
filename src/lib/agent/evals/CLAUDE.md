# Eval Harness

Real-LLM scenario runner for the orchestrator. Lives under
`src/lib/agent/evals/` and runs through `npm run evals` — separate from
the normal app build because every scenario hits a real model and burns
tokens.

The harness is built for one specific bug class: **the orchestrator
narrating a tool call ("Spawning the delegate now…") instead of emitting
the `tool_use` block.** Scorers and fixtures are designed around catching
that, but the shape generalises to any "did the model do the right thing
under this exact prompt and history" question.

## Quick start

```bash
# Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...

# Run the one scenario we ship today
npm run evals:one src/lib/agent/evals/scenarios/narrates-instead-of-calls.eval.ts

# Run every scenario
npm run evals
```

The scenario file self-skips with a log line when its credentials aren't
set, so a full `npm run evals` won't break in a fresh worktree.

## What this looks like under the hood

Tauri's SQLite plugin (`@tauri-apps/plugin-sql`) is not available outside
the Tauri runtime, so the harness mocks it at the module boundary:

1. `installEvalMocks()` (in `setup.ts`) is the first thing every scenario
   calls. It swaps `@tauri-apps/plugin-sql` for the in-memory shim in
   `sqlite-shim.ts` (backed by `node:sqlite`) and stubs `@tauri-apps/api/core`
   so the filesystem tools don't crash on import.
2. The shim applies `src-tauri/migrations/0001_initial.sql` once on
   startup. The DB layer (`$lib/db/*`) is **not** mocked — real queries
   run against the in-memory database.
3. Each scenario calls `resetEvalDatabase()` in `beforeEach` so
   iterations don't bleed state into each other.

Because of ESM hoisting, scenarios must `installEvalMocks()` first and
then `await import(...)` any module that transitively pulls in the
orchestrator loop. See `scenarios/narrates-instead-of-calls.eval.ts`
for the canonical shape.

## Vocabulary

| Term | Meaning |
|---|---|
| **Scenario** | One `*.eval.ts` file. A `name`, a `data()` generator, a `task()`, and a list of scorers. |
| **Row** | One `{ input, expected }` produced by `data()`. Each row × iteration becomes one assertion. |
| **Scorer** | `({ input, output, expected }) => { name, score: 0..1, metadata? }`. Pure; deterministic given inputs. |
| **Passing score** | Threshold per scorer (default `1.0`). All scorers must hit it for the row to pass. |
| **Iteration** | A replay of the same row. Bumps the chance of catching intermittent regressions; raises token cost linearly. |

## Layout

```
src/lib/agent/evals/
├── CLAUDE.md                       # this file
├── types.ts                        # EvalScenario, Scorer, AgentTurnOutput
├── runner.ts                       # runEvalLocally — node:test wrapper
├── eval-agent-turn.ts              # wraps streamOrchestratorTurn for tests
├── sqlite-shim.ts                  # @tauri-apps/plugin-sql shim
├── setup.ts                        # installEvalMocks + resetEvalDatabase
├── scorers/
│   ├── must-call-tools.ts          # asserts a tool fired
│   ├── no-tool-narration.ts        # catches "narrates but doesn't call"
│   └── no-empty-response.ts        # catches "(No response generated)"
├── fixtures/
│   ├── conversation-builder.ts     # seedConversation, delegationFollowthroughTurns
│   ├── eval-orchestrator-model.ts  # build LanguageModelV3 from env vars
│   ├── mock-delegate-adapter.ts    # scripted LLMAdapter for the delegate
│   └── snapshots/                  # captured prod conversations (gitignored)
├── snapshot/
│   ├── CLAUDE.md                   # capture + replay workflow
│   ├── types.ts                    # CapturedSnapshot, RecordedDelegateResponse
│   ├── capture.ts                  # read from real Tauri SQLite (read-only)
│   ├── serialise.ts                # CapturedSnapshot → .ts fixture
│   └── cli.ts                      # npm run capture-eval-snapshot
└── scenarios/
    ├── narrates-instead-of-calls.eval.ts   # synthetic primer
    └── snapshot-replay.eval.ts             # parameterised replay template
```

The directory is a parallel to Clive backend's `apps/backend/src/agent/evals/`
— types and scorer names match where they make sense, so anything we
learn in either project ports cleanly.

## Adding a scenario

1. Copy `scenarios/narrates-instead-of-calls.eval.ts` as a starting
   point. The phases (mock setup → static pure imports → dynamic
   imports → env check → `runScenario`) are the safe order.
2. The scenario must call `installEvalMocks()` before importing anything
   else. ESM hoists static imports above runtime code — anything in the
   agent graph must be loaded via `await import(...)`.
3. Decide if your scenario depends on a particular conversation history.
   For synthetic histories, use `seedConversation()` in `beforeEach`.
   For captured prod conversations, the snapshot system is planned but
   not yet built — see "Roadmap" below.
4. Pick scorers. `mustCallTools` + `noToolNarration` + `noEmptyResponse`
   is the default trio for delegate-followthrough scenarios.

## Env vars

| Var | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Required for `EVAL_PROVIDER=anthropic` (the default). |
| `EVAL_PROVIDER` | `anthropic` (default) or `openai-compatible`. |
| `EVAL_MODEL` | Override the model id. Default `claude-sonnet-4-6` / `gpt-4o-mini`. |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | Used when `EVAL_PROVIDER=openai-compatible`. Leave key empty for Ollama / LM Studio. |
| `ITERATIONS` | Override per-scenario iteration count (only the scenario currently honours it). |

## Mocking philosophy

- **SQLite:** in-memory shim via `node:sqlite`. Real DB-layer code runs.
- **Tauri commands (`@tauri-apps/api/core`):** stubbed to throw. If a
  scenario actually needs `read_file` or `list_files` to succeed, mock
  it explicitly inside the scenario.
- **Delegate adapter:** scripted (see `mock-delegate-adapter.ts`). The
  orchestrator calls it through the real `runDelegate` path, so chunks
  are persisted to the in-memory DB just like in production.
- **Orchestrator model:** real. The whole point.

## Snapshot capture (Phase 2)

Grab a real conversation out of the Tauri-managed SQLite for
deterministic replay:

```bash
npm run capture-eval-snapshot -- --before 2026-05-18T16:53:00Z
```

The CLI reads the live DB read-only (safe while the app is open),
writes a TypeScript fixture under `fixtures/snapshots/` (gitignored),
and prints the exact `SNAPSHOT=... npm run evals:one ...` command to
replay it. See [snapshot/CLAUDE.md](./snapshot/CLAUDE.md) for the full
flow.

## Roadmap

What's deliberately not here yet:

- **Cross-adapter coverage.** Today scenarios hardcode one provider via
  env vars. A matrix scenario that loops over `[anthropic,
  openai-compatible]` is the natural next step once we have a second
  failing case.
- **Glob-based scenario discovery.** The npm script uses a shell glob;
  if a scenario list grows beyond a handful, swap in `--test-glob`
  (Node 22.6+) for finer control.
