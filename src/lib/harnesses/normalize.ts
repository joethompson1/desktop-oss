// Pure normalization helpers shared by the harness streams: they map each
// provider's native usage / finish-reason / todo shapes onto the run-event
// vocabulary (Plan 03). Deliberately free of Tauri / I/O imports so it stays
// unit-testable under `node:test` — the harness files themselves import
// `@tauri-apps/api`, which the test runner can't load.

import type {
  RunFinishReason,
  RunTodoItem,
  RunTodoUpdate,
  RunTokenUsage,
} from "$lib/types/run";

// ── Token usage ──────────────────────────────────────────────────────────

/** Anthropic / Claude per-response usage. The three input buckets are
 *  ADDITIVE — total input = input + cache_read + cache_creation (the
 *  Anthropic SDK docs state exactly this). */
export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Normalize Claude usage into a `RunTokenUsage`. Sums the additive input
 *  buckets. `contextWindow` is passed in (the harness knows it, or leaves it
 *  undefined so the UI shows a token count instead of a wrong percentage).
 *  Returns null when the response reported no tokens. */
export function claudeUsageToRun(
  u: ClaudeUsage,
  contextWindow?: number,
): RunTokenUsage | null {
  const input =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
  const output = u.output_tokens ?? 0;
  if (input === 0 && output === 0) return null;
  return {
    contextTokens: input + output,
    ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
    inputTokens: input,
    outputTokens: output,
  };
}

/** OpenAI-style usage. Unlike Anthropic, `prompt_tokens` ALREADY includes any
 *  cached tokens (`prompt_tokens_details.cached_tokens` is a subset, not an
 *  additive bucket) — so context tokens are just prompt + completion. */
export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export function normalizeOpenAIUsage(u: OpenAIUsage): RunTokenUsage {
  const input = u.prompt_tokens ?? 0;
  const output = u.completion_tokens ?? 0;
  return {
    // Do NOT add cached tokens — they're already inside prompt_tokens.
    // contextWindow is intentionally omitted: an arbitrary OpenAI-compatible
    // endpoint's window isn't knowable here, so the UI shows a token count
    // rather than a misleading percentage.
    contextTokens: input + output,
    inputTokens: input,
    outputTokens: output,
  };
}

/** The largest context window reported across a Claude Code result's
 *  `modelUsage` map (the main model's window; any subagent's is ≤ it).
 *  Returns undefined when none is present — the caller then leaves the
 *  percentage hidden rather than hardcoding a window. */
export function pickContextWindow(
  modelUsage: Record<string, { contextWindow?: number }> | undefined,
): number | undefined {
  if (!modelUsage) return undefined;
  let max = 0;
  for (const m of Object.values(modelUsage)) {
    if (typeof m?.contextWindow === "number" && m.contextWindow > max) {
      max = m.contextWindow;
    }
  }
  return max > 0 ? max : undefined;
}

// ── Finish reasons ─────────────────────────────────────────────────────────

/** Map Claude's `stop_reason` (used by both the raw Anthropic wire and the
 *  Claude Code SDK) onto the normalized `RunFinishReason`. */
export function mapClaudeStopReason(
  reason: string | null | undefined,
): RunFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

/** Map OpenAI's `finish_reason` onto the normalized `RunFinishReason`. */
export function mapOpenAIFinishReason(
  reason: string | null | undefined,
): RunFinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

// ── Todos ────────────────────────────────────────────────────────────────

/** Parse a Claude Code `TodoWrite` tool input into a normalized snapshot. */
export function parseTodoWriteInput(input: unknown): RunTodoUpdate | null {
  if (!input || typeof input !== "object") return null;
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;
  const items: RunTodoItem[] = [];
  for (const t of todos) {
    if (!t || typeof t !== "object") continue;
    const content = (t as { content?: unknown }).content;
    if (typeof content !== "string") continue;
    const status = (t as { status?: unknown }).status;
    items.push({
      content,
      status:
        status === "in_progress" || status === "completed" ? status : "pending",
    });
  }
  return { items };
}
