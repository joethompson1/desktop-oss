// Pure parser for Claude Code's on-disk session transcript (JSONL) — the
// persistence backbone of TUI-mode delegates (Plan 04). While the user
// drives the real `claude` CLI in the embedded terminal, the app tails the
// session's transcript file and mirrors each entry into `run_chunks`, so
// `get_delegate_history`, the active-runs table, and history replay work
// identically to GUI mode — the orchestrator never knows which surface a
// delegate is on.
//
// Deliberately free of Tauri / I/O imports (mirrors `harnesses/normalize.ts`)
// so it stays unit-testable under `node:test`. The live driver
// (`tui/driver.ts`) owns file tailing and DB writes; this module only maps
// "one transcript line" → "zero or more chunks".
//
// The format is Claude Code's internal session store, observed not
// documented — parse defensively and drop anything unrecognized. Verified
// shapes (v2.x): each line is one JSON object with a `type` of "user" /
// "assistant" / "system" / "summary" / "file-history-snapshot" / …;
// user/assistant lines carry an Anthropic-style `message`, plus flags like
// `isMeta` for injected non-user content.

import type { ChunkKind } from "$lib/types/run";
import {
  claudeUsageToRun,
  parseTodoWriteInput,
  type ClaudeUsage,
} from "$lib/harnesses/normalize";

/** One mirrored chunk, plus bookkeeping the driver needs across lines. */
export interface MirroredChunk {
  kind: ChunkKind;
  text: string;
}

export interface TranscriptParseResult {
  chunks: MirroredChunk[];
  /** tool_use ids whose future tool_result lines must be dropped (their
   *  call was re-surfaced as a normalized event, e.g. TodoWrite). The
   *  driver carries these forward in its per-session state. */
  suppressToolIds: string[];
}

interface TranscriptLine {
  type?: unknown;
  isMeta?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    usage?: ClaudeUsage;
  };
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

/**
 * Parse one transcript JSONL line into mirrored chunks.
 *
 * `suppressedToolIds` is the driver's carried-forward set — tool_result
 * blocks whose id is in it are dropped (and the parser reports new ids to
 * add via `suppressToolIds`).
 */
export function parseTranscriptLine(
  line: string,
  suppressedToolIds: ReadonlySet<string>,
): TranscriptParseResult {
  const none: TranscriptParseResult = { chunks: [], suppressToolIds: [] };
  const trimmed = line.trim();
  if (!trimmed) return none;

  let entry: TranscriptLine;
  try {
    entry = JSON.parse(trimmed) as TranscriptLine;
  } catch {
    return none;
  }
  if (!entry || typeof entry !== "object") return none;

  if (entry.type === "user") return parseUserLine(entry, suppressedToolIds);
  if (entry.type === "assistant") return parseAssistantLine(entry);
  // system / summary / file-history-snapshot / progress / unknown: ignore.
  return none;
}

function parseUserLine(
  entry: TranscriptLine,
  suppressedToolIds: ReadonlySet<string>,
): TranscriptParseResult {
  const chunks: MirroredChunk[] = [];
  // `isMeta` marks injected content (slash-command expansions, hook
  // context, caveat banners) — not something the user typed; skip.
  if (entry.isMeta === true) return { chunks, suppressToolIds: [] };
  const content = entry.message?.content;

  if (typeof content === "string") {
    if (isSyntheticUserText(content)) return { chunks, suppressToolIds: [] };
    chunks.push({ kind: "user_message", text: content });
    return { chunks, suppressToolIds: [] };
  }

  if (Array.isArray(content)) {
    for (const raw of content) {
      const block = raw as ContentBlock;
      if (block.type === "text" && typeof block.text === "string") {
        if (!isSyntheticUserText(block.text)) {
          chunks.push({ kind: "user_message", text: block.text });
        }
      } else if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        if (suppressedToolIds.has(block.tool_use_id)) continue;
        const output = toolResultText(block);
        chunks.push({
          kind: "tool_result",
          text: JSON.stringify({
            toolCallId: block.tool_use_id,
            output: block.is_error === true
              ? `[Error] ${output || "Tool execution failed"}`
              : output,
          }),
        });
      }
    }
  }
  return { chunks, suppressToolIds: [] };
}

function parseAssistantLine(entry: TranscriptLine): TranscriptParseResult {
  const chunks: MirroredChunk[] = [];
  const suppress: string[] = [];
  const content = entry.message?.content;

  if (Array.isArray(content)) {
    for (const raw of content) {
      const block = raw as ContentBlock;
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.trim()) {
          chunks.push({ kind: "assistant_text", text: block.text });
        }
      } else if (
        block.type === "thinking" &&
        typeof block.thinking === "string"
      ) {
        if (block.thinking.trim()) {
          chunks.push({ kind: "thinking", text: block.thinking });
        }
      } else if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        // Same normalization as the GUI driver: TodoWrite becomes a
        // todo_update chunk, not a generic tool card; its result is
        // suppressed.
        if (block.name === "TodoWrite") {
          const todo = parseTodoWriteInput(block.input);
          if (todo) {
            suppress.push(block.id);
            chunks.push({
              kind: "todo_update",
              text: JSON.stringify(todo),
            });
            continue;
          }
        }
        chunks.push({
          kind: "tool_call",
          text: JSON.stringify({
            toolName: block.name,
            toolCallId: block.id,
            input: block.input ?? {},
          }),
        });
      }
    }
  }

  // Per-iteration usage → token_usage chunk (window unknown from the
  // transcript; the UI shows a raw token count — same degradation as an
  // OpenAI-compatible endpoint).
  const usage = entry.message?.usage;
  if (usage) {
    const normalized = claudeUsageToRun(usage);
    if (normalized) {
      chunks.push({ kind: "token_usage", text: JSON.stringify(normalized) });
    }
  }

  return { chunks, suppressToolIds: suppress };
}

/** User-line text the CLI writes that no human typed: slash-command
 *  wrappers, local command output, interruption notices. */
function isSyntheticUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("<command-name>") ||
    t.startsWith("<command-message>") ||
    t.startsWith("<local-command-stdout>") ||
    t.startsWith("[Request interrupted")
  );
}

function toolResultText(block: ContentBlock): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (
          b &&
          typeof b === "object" &&
          "text" in b &&
          typeof (b as { text?: unknown }).text === "string"
        ) {
          return (b as { text: string }).text;
        }
        try {
          return JSON.stringify(b);
        } catch {
          return String(b);
        }
      })
      .join("\n");
  }
  return "";
}

/**
 * Incremental line-splitter for a tailed byte stream. Feed decoded text in
 * arbitrary chunk sizes; get back only COMPLETE lines (the trailing
 * partial line stays buffered until its newline arrives).
 */
export class LineBuffer {
  #buf = "";

  push(text: string): string[] {
    this.#buf += text;
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) !== -1) {
      lines.push(this.#buf.slice(0, nl));
      this.#buf = this.#buf.slice(nl + 1);
    }
    return lines;
  }
}
