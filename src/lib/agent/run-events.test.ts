// Unit tests for the Plan-03 normalized run-event vocabulary: the pure
// harness normalization helpers (usage / finish-reason / todo) and the
// chunk-encode + render-reduce round trip. These lock in the subtle
// cache-accounting invariant (Anthropic additive vs OpenAI subset) that the
// whole "% context" feature hinges on.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  claudeUsageToRun,
  normalizeOpenAIUsage,
  mapClaudeStopReason,
  mapOpenAIFinishReason,
  parseTodoWriteInput,
  pickContextWindow,
} from "$lib/harnesses/normalize";
import {
  isAbnormalFinish,
  isRunEventPart,
  runEventPartToChunk,
  type ChunkRow,
  type RunEventPart,
} from "$lib/types/run";
import {
  chunksToChatTurns,
  latestTokenUsage,
} from "$lib/agent/run-chunks-to-turns";
import type { ToolPart, UIAssistantMessage } from "$lib/types/chat";

// ── Token usage: the cache-accounting invariant ───────────────────────────

test("Claude usage sums the three input buckets (additive semantics)", () => {
  const u = claudeUsageToRun(
    {
      input_tokens: 100,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
      output_tokens: 40,
    },
    200_000,
  );
  assert.equal(u?.inputTokens, 1050); // 100 + 900 + 50, all additive
  assert.equal(u?.outputTokens, 40);
  assert.equal(u?.contextTokens, 1090); // input + output
  assert.equal(u?.contextWindow, 200_000);
});

test("Claude usage omits contextWindow when unknown; null when empty", () => {
  const u = claudeUsageToRun({ input_tokens: 10, output_tokens: 5 });
  assert.equal(u?.contextTokens, 15);
  assert.equal(u?.contextWindow, undefined); // hidden, not hardcoded
  assert.equal(claudeUsageToRun({ input_tokens: 0, output_tokens: 0 }), null);
  assert.equal(claudeUsageToRun({}), null);
});

test("OpenAI usage does NOT re-add cached tokens (subset semantics)", () => {
  // prompt_tokens ALREADY includes the 900 cached tokens.
  const u = normalizeOpenAIUsage({
    prompt_tokens: 1000,
    completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 900 },
  });
  assert.equal(u.inputTokens, 1000);
  assert.equal(u.contextTokens, 1040); // prompt + completion; cached NOT added again
  assert.equal(u.contextWindow, undefined); // window unknowable for arbitrary endpoints
});

test("pickContextWindow returns the largest window across models", () => {
  assert.equal(
    pickContextWindow({ main: { contextWindow: 200_000 }, sub: { contextWindow: 1_000_000 } }),
    1_000_000,
  );
  assert.equal(pickContextWindow({ m: {} }), undefined);
  assert.equal(pickContextWindow({}), undefined);
  assert.equal(pickContextWindow(undefined), undefined);
});

// ── Finish-reason mappers ─────────────────────────────────────────────────

test("mapClaudeStopReason normalizes Claude/Anthropic stop reasons", () => {
  assert.equal(mapClaudeStopReason("end_turn"), "stop");
  assert.equal(mapClaudeStopReason("stop_sequence"), "stop");
  assert.equal(mapClaudeStopReason("max_tokens"), "length");
  assert.equal(mapClaudeStopReason("tool_use"), "tool_calls");
  assert.equal(mapClaudeStopReason("refusal"), "content_filter");
  assert.equal(mapClaudeStopReason(null), "stop");
  assert.equal(mapClaudeStopReason(undefined), "stop");
});

test("mapOpenAIFinishReason normalizes OpenAI finish reasons", () => {
  assert.equal(mapOpenAIFinishReason("stop"), "stop");
  assert.equal(mapOpenAIFinishReason("length"), "length");
  assert.equal(mapOpenAIFinishReason("tool_calls"), "tool_calls");
  assert.equal(mapOpenAIFinishReason("function_call"), "tool_calls");
  assert.equal(mapOpenAIFinishReason("content_filter"), "content_filter");
  assert.equal(mapOpenAIFinishReason("something_new"), "other");
  assert.equal(mapOpenAIFinishReason(null), "other");
});

test("isAbnormalFinish flags only truncation/filter/error", () => {
  for (const r of ["length", "content_filter", "error"] as const) {
    assert.equal(isAbnormalFinish(r), true);
  }
  for (const r of ["stop", "tool_calls", "other"] as const) {
    assert.equal(isAbnormalFinish(r), false);
  }
  assert.equal(isAbnormalFinish(undefined), false);
});

// ── Todos ─────────────────────────────────────────────────────────────────

test("parseTodoWriteInput extracts items and defaults unknown status", () => {
  const t = parseTodoWriteInput({
    todos: [
      { content: "a", status: "completed", activeForm: "doing a" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "bogus" },
      { content: "d" },
      { notContent: 1 },
      null,
    ],
  });
  assert.deepEqual(t?.items, [
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "pending" }, // unknown status → pending
    { content: "d", status: "pending" },
  ]);
});

test("parseTodoWriteInput rejects non-todo inputs", () => {
  assert.equal(parseTodoWriteInput(null), null);
  assert.equal(parseTodoWriteInput({}), null);
  assert.equal(parseTodoWriteInput({ todos: "nope" }), null);
});

// ── Wire encode / discriminate ────────────────────────────────────────────

test("runEventPartToChunk maps each part to its chunk kind", () => {
  assert.equal(
    runEventPartToChunk({ type: "run-token-usage", usage: { contextTokens: 1 } }).kind,
    "token_usage",
  );
  assert.equal(
    runEventPartToChunk({ type: "run-todo-update", todo: { items: [] } }).kind,
    "todo_update",
  );
  assert.equal(
    runEventPartToChunk({ type: "run-turn", turn: { phase: "completed" } }).kind,
    "turn",
  );
});

test("isRunEventPart discriminates run events from AI SDK parts", () => {
  assert.equal(isRunEventPart({ type: "run-turn", turn: { phase: "completed" } }), true);
  assert.equal(isRunEventPart({ type: "run-token-usage", usage: { contextTokens: 1 } }), true);
  // AI SDK stream parts must NOT be treated as run events.
  assert.equal(isRunEventPart({ type: "text-delta", id: "x", text: "hi" } as never), false);
  assert.equal(isRunEventPart({ type: "finish" } as never), false);
});

// ── Render reduction ──────────────────────────────────────────────────────

let seq = 0;
function mk(kind: ChunkRow["kind"], text: string): ChunkRow {
  return { id: seq, runId: "r", seq: seq++, kind, text, createdAt: new Date(0).toISOString() };
}
function ev(p: RunEventPart): ChunkRow {
  const { kind, text } = runEventPartToChunk(p);
  return mk(kind, text);
}
function partsOf(turn: unknown): Array<ToolPart | { type: string }> {
  return (turn as UIAssistantMessage).parts as Array<ToolPart | { type: string }>;
}

test("chunksToChatTurns renders todo_update as a checklist tool part", () => {
  const turns = chunksToChatTurns([
    mk("assistant_text", "working"),
    ev({
      type: "run-todo-update",
      todo: {
        items: [
          { content: "a", status: "completed" },
          { content: "b", status: "in_progress" },
        ],
      },
    }),
  ]);
  const todo = partsOf(turns[0]).find((p) => p.type === "tool-todo_update") as ToolPart;
  assert.ok(todo, "expected a tool-todo_update part");
  assert.equal(todo.state, "output-available");
  assert.equal((todo.input as { items: unknown[] }).items.length, 2);
});

test("chunksToChatTurns warns only on an abnormal turn finish", () => {
  const abnormal = chunksToChatTurns([
    mk("assistant_text", "cut off"),
    ev({ type: "run-turn", turn: { phase: "completed", finishReason: "length" } }),
  ]);
  const warn = partsOf(abnormal[0]).find((p) => p.type === "tool-turn") as ToolPart;
  assert.ok(warn, "expected a tool-turn warning for length");
  assert.equal(warn.state, "output-error");
  assert.match(warn.errorText ?? "", /truncated/i);

  const normal = chunksToChatTurns([
    mk("assistant_text", "all good"),
    ev({ type: "run-turn", turn: { phase: "completed", finishReason: "stop" } }),
  ]);
  assert.equal(
    partsOf(normal[0]).some((p) => p.type === "tool-turn"),
    false,
    "a normal finish must not render a warning",
  );
});

test("chunksToChatTurns never renders token_usage inline", () => {
  const turns = chunksToChatTurns([
    mk("assistant_text", "hi"),
    ev({ type: "run-token-usage", usage: { contextTokens: 100, contextWindow: 200_000 } }),
  ]);
  assert.equal(
    partsOf(turns[0]).some((p) => p.type.includes("token")),
    false,
  );
});

test("latestTokenUsage returns the newest usage snapshot, null when none", () => {
  const chunks = [
    ev({ type: "run-token-usage", usage: { contextTokens: 100, contextWindow: 200_000 } }),
    mk("assistant_text", "…"),
    ev({ type: "run-token-usage", usage: { contextTokens: 46_000, contextWindow: 200_000 } }),
  ];
  const u = latestTokenUsage(chunks);
  assert.equal(u?.contextTokens, 46_000);
  assert.equal(latestTokenUsage([mk("assistant_text", "no usage here")]), null);
});

test("old-history chunks (legacy kinds only) still reduce cleanly", () => {
  const turns = chunksToChatTurns([
    mk("user_message", "hi"),
    mk("assistant_text", "hello"),
    mk("tool_call", JSON.stringify({ toolName: "Read", toolCallId: "t1", input: { path: "a.ts" } })),
    mk("tool_result", JSON.stringify({ toolCallId: "t1", output: "contents" })),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[1].role, "assistant");
});
