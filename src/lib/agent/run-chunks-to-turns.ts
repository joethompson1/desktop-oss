// Reduce the flat list of run chunks (user_message | assistant_text |
// tool_call | tool_result | stderr | ...) into the same UIChatTurn[] shape
// the orchestrator chat surface uses. This way the run-detail page is just
// a mini chat view — same ChatMessage component, same markdown rendering,
// same ToolPartView — instead of a per-token timeline.

import type {
  ChunkRow,
  RunTokenUsage,
  RunTodoUpdate,
  RunTurnEvent,
} from "$lib/types/run";
import { isAbnormalFinish } from "$lib/types/run";
import type {
  TextPart,
  ToolPart,
  UIAssistantMessage,
  UIChatTurn,
  UIMessagePart,
  UIUserMessage,
} from "$lib/types/chat";

interface ToolCallPayload {
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
}

interface ToolResultPayload {
  toolCallId?: string;
  output?: unknown;
}

export function chunksToChatTurns(chunks: ChunkRow[]): UIChatTurn[] {
  const turns: UIChatTurn[] = [];
  let assistantParts: UIMessagePart[] | null = null;
  let assistantSeq = 0;
  // Map toolCallId → index inside the current assistant turn so the
  // tool-result chunk can patch the matching tool-call part.
  let toolPartIdx = new Map<string, number>();

  function flushAssistant() {
    if (assistantParts && assistantParts.length > 0) {
      const msg: UIAssistantMessage = {
        id: `chunk-asst-${assistantSeq++}`,
        role: "assistant",
        parts: assistantParts,
        createdAt: new Date().toISOString(),
      };
      turns.push(msg);
    }
    assistantParts = null;
    toolPartIdx = new Map();
  }

  function ensureAssistant() {
    if (!assistantParts) {
      assistantParts = [];
      toolPartIdx = new Map();
    }
    return assistantParts;
  }

  for (const chunk of chunks) {
    if (chunk.kind === "user_message") {
      flushAssistant();
      const userMsg: UIUserMessage = {
        id: `chunk-user-${chunk.id ?? chunk.seq}`,
        role: "user",
        content: chunk.text,
        createdAt: chunk.createdAt,
      };
      turns.push(userMsg);
    } else if (chunk.kind === "assistant_text") {
      const parts = ensureAssistant();
      // Coalesce adjacent assistant_text rows into one TextPart. Old
      // delegate runs were persisting one row per streamed token (bug,
      // since fixed); without this merge, every token would render as a
      // separate paragraph. With the merge, both old and new data render
      // as one clean assistant bubble.
      const tail = parts[parts.length - 1];
      if (tail && tail.type === "text") {
        const joiner = chunk.text.startsWith(" ") || chunk.text.startsWith("\n")
          ? ""
          : "";
        parts[parts.length - 1] = {
          ...tail,
          text: tail.text + joiner + chunk.text,
        };
      } else {
        parts.push({
          type: "text",
          text: chunk.text,
          state: "done",
        } satisfies TextPart);
      }
    } else if (chunk.kind === "tool_call") {
      const parts = ensureAssistant();
      const payload = safeJson<ToolCallPayload>(chunk.text);
      if (payload?.toolCallId && payload?.toolName) {
        const part: ToolPart = {
          type: `tool-${payload.toolName}`,
          toolCallId: payload.toolCallId,
          state: "input-available",
          input: payload.input,
        };
        toolPartIdx.set(payload.toolCallId, parts.length);
        parts.push(part);
      }
    } else if (chunk.kind === "tool_result") {
      const parts = ensureAssistant();
      const payload = safeJson<ToolResultPayload>(chunk.text);
      if (payload?.toolCallId) {
        const idx = toolPartIdx.get(payload.toolCallId);
        if (idx !== undefined) {
          const existing = parts[idx] as ToolPart;
          parts[idx] = {
            ...existing,
            state: "output-available",
            output: payload.output,
          };
        }
      }
    } else if (chunk.kind === "stderr") {
      // Surface delegate-side stderr as an inline error text part so the
      // user sees what went wrong without it disappearing into the timeline.
      const parts = ensureAssistant();
      parts.push({
        type: "text",
        text: `Error: ${chunk.text}`,
        state: "done",
      } satisfies TextPart);
    } else if (chunk.kind === "todo_update") {
      // Normalized todo snapshot → a cockpit entry rendered as a checklist
      // (ToolPartView has a `todo_update` branch). The payload rides in
      // `input` so the header can summarise progress and the body can list
      // items.
      const payload = safeJson<RunTodoUpdate>(chunk.text);
      if (payload && Array.isArray(payload.items)) {
        const parts = ensureAssistant();
        parts.push({
          type: "tool-todo_update",
          toolCallId: `todo-${chunk.id ?? chunk.seq}`,
          state: "output-available",
          input: payload,
        } satisfies ToolPart);
      }
    } else if (chunk.kind === "turn") {
      // Turn boundaries are silent on a normal finish; an abnormal one
      // (truncated / filtered / errored) surfaces as a warning cockpit
      // entry so a clipped delegate reply is never mistaken for complete.
      const payload = safeJson<RunTurnEvent>(chunk.text);
      if (
        payload &&
        payload.phase === "completed" &&
        isAbnormalFinish(payload.finishReason)
      ) {
        const parts = ensureAssistant();
        parts.push({
          type: "tool-turn",
          toolCallId: `turn-${chunk.id ?? chunk.seq}`,
          state: "output-error",
          input: payload,
          errorText: turnWarningText(payload),
        } satisfies ToolPart);
      }
    }
    // token_usage: consumed by latestTokenUsage() for the run-header chip,
    // not rendered inline. thinking / system / unknown: skipped — no clean
    // place in the assistant-message shape.
  }

  flushAssistant();
  return turns;
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Extract the most recent normalized token-usage snapshot from a run's
 * chunks, for the run-header "% context" chip. Returns null when the run
 * has emitted no usage (e.g. a harness that doesn't report it).
 */
export function latestTokenUsage(chunks: ChunkRow[]): RunTokenUsage | null {
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i].kind !== "token_usage") continue;
    const parsed = safeJson<RunTokenUsage>(chunks[i].text);
    if (parsed && typeof parsed.contextTokens === "number") return parsed;
  }
  return null;
}

/** Human-readable warning for an abnormal turn finish. */
function turnWarningText(turn: RunTurnEvent): string {
  switch (turn.finishReason) {
    case "length":
      return "Response truncated — the model hit its max output length before finishing.";
    case "content_filter":
      return "Response stopped by a content filter.";
    case "error":
      return "The turn ended with an error before completing.";
    default:
      return "The turn ended abnormally.";
  }
}
