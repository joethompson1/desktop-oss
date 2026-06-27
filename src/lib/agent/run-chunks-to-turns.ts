// Reduce the flat list of run chunks (user_message | assistant_text |
// tool_call | tool_result | stderr | ...) into the same UIChatTurn[] shape
// the orchestrator chat surface uses. This way the run-detail page is just
// a mini chat view — same ChatMessage component, same markdown rendering,
// same ToolPartView — instead of a per-token timeline.

import type { ChunkRow } from "$lib/types/run";
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
    }
    // thinking / system / unknown: skip for now — they don't have a clean
    // place in the assistant-message shape and are rarely surfaced upstream.
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
