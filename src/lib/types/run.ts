// Wire types for delegate sub-agent runs. The orchestrator spawns these via
// the `delegate_task` tool; the cockpit panel renders the streamed output.

import type { ChatStreamPart } from "./chat";

export type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED";

// The chunk vocabulary. The first group is the raw transcript (a run's
// literal input/output); the second is the *normalized run-event* group
// (Plan 03) — a small shared vocabulary every harness maps its native
// stream into, so the run view renders todos / usage / turn state
// identically no matter which backend produced them. Structured kinds
// store a JSON payload in `run_chunks.text`, parsed on read via the
// typed shapes below. The column is TEXT, so new kinds are additive:
// old code reading a new kind falls through to "ignore" everywhere
// (chunksToChatTurns, loadRunMessages, the ChatStore reducer).
export type ChunkKind =
  | "user_message"
  | "assistant_text"
  | "tool_call"
  | "tool_result"
  | "thinking"
  | "stderr"
  | "system"
  // ─── Normalized run events (Plan 03) ───────────────────────────────
  | "token_usage"
  | "todo_update"
  | "turn";

/** Which surface a delegate run is currently on (Plan 04, dual-surface
 *  delegates). The two surfaces are views of ONE underlying harness
 *  session, switchable at turn boundaries:
 *
 *  - `gui` — the headless driver (harness SDK in the sidecar), rendered
 *    as a chat page. The default; an absent surface means gui.
 *  - `tui` — the real agent CLI running interactively in a PTY, rendered
 *    as an embedded terminal on the same page. Only harnesses with a
 *    terminal capability support it (v1: claude-code).
 *
 *  Exactly one driver owns the session at a time (single-driver rule);
 *  the transcript mirror keeps `run_chunks` flowing in TUI mode so the
 *  orchestrator's monitoring is surface-blind. */
export type RunSurface = "gui" | "tui";

export interface RunSummary {
  id: string;
  conversationId: string;
  parentMessageId?: string;
  toolCallId?: string;
  /** Optional label assigned by the orchestrator at spawn time. Used by
   *  message_delegate and get_delegate_history to reference a run by name
   *  instead of its generated run ID. */
  name?: string;
  /** Optional per-spawn role / persona the orchestrator authored for this
   *  delegate (via delegate_task's `role` field). For general (raw-LLM)
   *  delegates it becomes the system prompt; for sealed coding agents it is
   *  folded into the task brief. Persisted so the persona survives history
   *  replay, message_delegate continuations, and the user chatting on the
   *  delegate's own page. Undefined for delegates spawned without a role. */
  role?: string;
  title: string;
  status: RunStatus;
  delegateHarnessId?: string;
  delegateType?: string;
  exitCode?: number;
  summary?: string;
  /** Rolling compressed summary of conversation turns older than the last
   *  CONTEXT_TAIL messages. Null until the run exceeds SUMMARY_THRESHOLD
   *  messages. Prepended as synthetic prior context when continuing a run
   *  to keep harness calls within a predictable token budget. */
  contextSummary?: string;
  /** Harness-provided opaque session token captured on the first turn,
   *  passed back as `resumeSessionId` on continuation. Set by the
   *  claude-code harness (SDK's `session_id`) and the codex harness
   *  (`threadId` from the MCP `codex` tool). Raw-LLM harnesses leave
   *  this undefined. */
  harnessSessionId?: string;
  /** Current surface for dual-surface runs. Absent = "gui". */
  surface?: RunSurface;
  /** The run's real working directory, fixed at spawn. Load-bearing for
   *  dual surfaces: the SDK driver and the TUI CLI must share a cwd or
   *  Claude Code can't resume the session (its store is keyed by cwd). */
  workdir?: string;
  /** For TUI-spawned runs: the task brief to hand the CLI as its first
   *  prompt when the user first opens the terminal. Cleared once used. */
  tuiInitialPrompt?: string;
  /** Whether the orchestrator has already been told this run finished. Set
   *  when a completion notification is enqueued (live bus or hydrate sweep);
   *  the persisted guard against double-notifying. Absent = false. */
  completionNotified?: boolean;
  filesChanged?: string[];
  createdAt: string;
  completedAt?: string;
}

export interface ChunkRow {
  id?: number;
  runId: string;
  seq: number;
  kind: ChunkKind;
  text: string;
  createdAt: string;
}

export interface DelegateResult {
  runId: string;
  status: RunStatus;
  summary: string;
  filesChanged: string[];
  exitCode?: number;
  durationMs: number;
  /** Which harness actually executed this run. Surfaced in the UI so it's
   *  unambiguous whether the delegate landed on the configured local model
   *  or fell back to the orchestrator harness. */
  harness?: {
    id: string;
    name: string;
    type: string;
  };
}

// ─── Normalized run-event payloads (Plan 03) ─────────────────────────────
//
// These are the typed shapes stored (JSON-encoded) in `run_chunks.text` for
// the structured kinds, and carried live over the stream as `RunEventPart`s.

/** Normalized token / context usage for one turn.
 *
 *  IMPORTANT — the cache-accounting trap: providers report cached tokens
 *  with opposite semantics. Anthropic reports `cache_read` /
 *  `cache_creation` as *separate additive* buckets (total input =
 *  input + cache_read + cache_creation), while OpenAI-style APIs report
 *  cached tokens as a *subset already inside* `prompt_tokens`. So the
 *  HARNESS must compute the normalized `contextTokens` itself from its own
 *  wire semantics; the renderer only divides `contextTokens / contextWindow`
 *  and must never re-derive usage from raw token fields. */
export interface RunTokenUsage {
  /** Tokens occupying the context window after this turn: the full prompt
   *  the model saw (input incl. any cache buckets, counted once) plus the
   *  generated output. Already normalized — divide by `contextWindow`. */
  contextTokens: number;
  /** The model's context window in tokens. Omitted when the harness can't
   *  know it (e.g. an arbitrary OpenAI-compatible endpoint); the UI then
   *  shows a raw token count instead of a percentage. */
  contextWindow?: number;
  /** Raw split for a detail tooltip. Optional and advisory only. */
  inputTokens?: number;
  outputTokens?: number;
}

export type RunTodoStatus = "pending" | "in_progress" | "completed";

export interface RunTodoItem {
  content: string;
  status: RunTodoStatus;
}

/** A full snapshot of the agent's todo list. Each update REPLACES the
 *  previous snapshot (it is not a delta). */
export interface RunTodoUpdate {
  items: RunTodoItem[];
}

/** Normalized turn finish reason. Harnesses map their native reason
 *  (`end_turn` / `max_tokens` / `stop` / `length` / `tool_use` / …) onto
 *  this small set. `length`, `content_filter` and `error` are the
 *  "abnormal" reasons the run view surfaces as a warning. */
export type RunFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "other";

export type RunTurnPhase = "started" | "completed";

export interface RunTurnEvent {
  phase: RunTurnPhase;
  /** Set on `completed`. */
  finishReason?: RunFinishReason;
}

/** The abnormal finish reasons the run view renders as a visible warning.
 *  Normal completions (`stop` / `tool_calls` / `other`) render nothing. */
export function isAbnormalFinish(reason: RunFinishReason | undefined): boolean {
  return reason === "length" || reason === "content_filter" || reason === "error";
}

// ─── Live stream vocabulary ──────────────────────────────────────────────
//
// Harnesses yield the AI SDK's `ChatStreamPart`s (text / tool events) plus
// these `RunEventPart`s for the normalized signals above. The `run-`
// prefix guarantees no collision with any AI SDK part type. `delegate.ts`
// persists each `RunEventPart` as its matching structured chunk kind;
// non-run-event parts flow through unchanged. Extend this union (and
// `runEventPartToChunk`) to add a new normalized kind.

export type RunEventPart =
  | { type: "run-token-usage"; usage: RunTokenUsage }
  | { type: "run-todo-update"; todo: RunTodoUpdate }
  | { type: "run-turn"; turn: RunTurnEvent };

/** What a harness's `streamChat` yields: AI SDK stream parts plus our
 *  normalized run events. */
export type HarnessStreamPart = ChatStreamPart | RunEventPart;

export function isRunEventPart(part: HarnessStreamPart): part is RunEventPart {
  return (
    part.type === "run-token-usage" ||
    part.type === "run-todo-update" ||
    part.type === "run-turn"
  );
}

/** Map a live `RunEventPart` to the persisted `{ kind, text }` chunk it
 *  becomes. The single source of truth for the wire encoding — the render
 *  side (`run-chunks-to-turns.ts`) parses `text` back with the payload
 *  types above. */
export function runEventPartToChunk(part: RunEventPart): {
  kind: ChunkKind;
  text: string;
} {
  switch (part.type) {
    case "run-token-usage":
      return { kind: "token_usage", text: JSON.stringify(part.usage) };
    case "run-todo-update":
      return { kind: "todo_update", text: JSON.stringify(part.todo) };
    case "run-turn":
      return { kind: "turn", text: JSON.stringify(part.turn) };
  }
}
