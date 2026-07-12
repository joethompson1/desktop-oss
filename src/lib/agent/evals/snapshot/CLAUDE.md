# Snapshot capture + replay

CLI for grabbing a real orchestrator conversation out of the Tauri-managed
SQLite database and turning it into a deterministic eval fixture. The
intended flow: while you're using the app, you hit unexpected behaviour
→ run `npm run capture-eval-snapshot` → replay it later under the eval
harness to iterate on a fix.

## Quick start

```bash
# Capture the singleton orchestrator conversation as it stands right now.
npm run capture-eval-snapshot

# Truncate to messages strictly before a timestamp (so the seeded history
# ends just before the bad turn — useful when you want the replay to
# re-run the user's last message via PROMPT).
npm run capture-eval-snapshot -- --before 2026-05-18T16:53:22Z

# Custom output slug.
npm run capture-eval-snapshot -- --out lru-repro

# Point at a different DB or conversation.
npm run capture-eval-snapshot -- \
  --db /path/to/desktop-oss.db \
  --conversation-id some-other-id
```

The script prints a one-liner that replays the snapshot once it's written.

The Tauri DB is opened **read-only** with WAL mode — safe to run while
the app is open. No locks, no contention.

## Output

Fixture files land in `src/lib/agent/evals/fixtures/snapshots/` and are
**gitignored** (they're real conversations). Each file exports:

- `buildSnapshotConversation(conversationId)` — seeds the in-memory eval
  database with the captured messages, runs, and run chunks. Also writes
  any custom orchestrator/delegate prompts the user had configured. The
  conversation id is re-targeted so the snapshot can replay against any
  fake conversation (typically `orchestrator-main`).
- `snapshotRecordedResponses` — map from `stableHash(brief)` → recorded
  delegate output. When the orchestrator calls `delegate_task` during
  replay, the mock harness looks up the brief and replays what the real
  delegate said at capture time. New / unmatched briefs fall back to the
  mock's default reply.
- `snapshotHarnessConfigs` — sanitised harness configs (no API keys) for
  the "Available delegates" roster in the system prompt.
- `snapshotMetadata` — timestamps and counts for sanity checks.

The file is hand-readable TypeScript, not minified — diff it before
sharing if the conversation has sensitive content.

## Replay

```bash
ANTHROPIC_API_KEY=sk-ant-... \
  SNAPSHOT=<slug-from-the-cli-output> \
  EXPECTED_TOOLS=delegate_task \
  PROMPT="ok i should have fixed it now, please can you try again" \
  ITERATIONS=3 \
  npm run evals:one src/lib/agent/evals/scenarios/snapshot-replay.eval.ts
```

Env vars:

| Var | Effect |
|---|---|
| `SNAPSHOT` | Required. Fixture slug without `.ts`. Must match `/^[a-z0-9-]+$/`. |
| `EXPECTED_TOOLS` | Required. Comma-separated tool names that must fire. |
| `PROMPT` | Optional. User message to send after the snapshot is seeded. Leave empty to let the orchestrator respond to the last seeded turn. |
| `ITERATIONS` | Optional. Default 1. Bump for intermittent regressions. |

## Why a CLI rather than an in-app button

The capture is dev-only — it's not for end users. A CLI keeps the
production app surface clean and means the capture script can evolve
faster than a Tauri command would (no Rust-side rebuild loop).

## Implementation notes

| File | Purpose |
|---|---|
| `types.ts` | `CapturedSnapshot`, `RecordedDelegateResponse`, `CaptureOptions`. |
| `capture.ts` | Opens the Tauri SQLite read-only, queries every relevant table, returns a `CapturedSnapshot`. Exports `defaultDbPath()` for the macOS / Linux / Windows paths and `stableHash()` for keying delegate responses. |
| `serialise.ts` | Renders a `CapturedSnapshot` as a TypeScript fixture module. Hand-readable, diffable. |
| `cli.ts` | Argument parsing, file writing, friendly logs. |

The fixture's `buildSnapshotConversation` does raw `INSERT`s for `runs`
and `run_chunks` (snapshot fidelity requires preserving timestamps,
status, summary etc.) but uses the public `appendMessage` API for
messages so any future change to message persistence is automatically
covered.

## Caveats

- The default conversation id is `orchestrator-main` — the singleton.
  If you start using multiple conversations, pass `--conversation-id`.
- API keys never live in the SQLite settings table (they're in Tauri's
  plugin-store credentials file), so snapshots are credential-safe by
  construction. Still: review the JSON before sharing.
- The replay seeds runs / chunks but the orchestrator's
  `historyToModelMessages` strips assistant tool-call parts on load
  ([loop.ts:221](../../../loop.ts:221)). So the model sees the
  captured conversation the same way it would have at capture time —
  good for reproducing the bug, but the structural fix in Phase 3 will
  start emitting tool-use blocks here.
