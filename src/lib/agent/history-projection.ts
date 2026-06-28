// Project persisted conversation history into the AI SDK's `ModelMessage[]`
// shape — faithfully including past `tool-call` and `tool-result` parts
// instead of stripping them down to text.
//
// The point of the faithful projection: the model's own past turns become
// the strongest exemplar it has for "what does the right output look like".
// If we replay past delegations as descriptive prose, the model learns to
// describe; if we replay them as tool_use blocks, it learns to emit tool
// calls. The CRITICAL section of the system prompt only carries weight
// when the history is consistent with it.
//
// Pattern mirrored from the upstream backend's `conversation-manager.ts`
// (`rowToModelMessage` + `ensureToolResultPairing`), adapted for
// desktop-oss's `UIChatTurn` shape — text + tool parts live on the same
// assistant turn rather than spanning ASSISTANT and TOOL rows, which
// simplifies orphan handling.

import type { ModelMessage } from "ai";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";

import type { ToolPart, UIChatTurn, UIMessagePart } from "$lib/types/chat";

type AssistantContentPart = Extract<
  ModelMessage,
  { role: "assistant" }
>["content"] extends string | (infer P)[]
  ? P
  : never;
type ToolContentPart = Extract<
  ModelMessage,
  { role: "tool" }
>["content"][number];

/**
 * Convert persisted `UIChatTurn[]` into the AI SDK's `ModelMessage[]`
 * input shape. Pure — no I/O, no logging.
 */
export function historyToModelMessages(
  history: readonly UIChatTurn[],
): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const turn of history) {
    if (turn.role === "user") {
      if (turn.content) {
        messages.push({ role: "user", content: turn.content });
      }
      continue;
    }

    const assistantContent: AssistantContentPart[] = [];
    const toolResults: ToolContentPart[] = [];

    for (const part of turn.parts) {
      projectAssistantPart(part, assistantContent, toolResults);
    }

    // Empty assistant turns (no text, no completed tool calls) get dropped
    // — they'd serialise as `{ content: [] }` which Anthropic rejects.
    if (assistantContent.length > 0) {
      messages.push({ role: "assistant", content: assistantContent });
    }
    if (toolResults.length > 0) {
      messages.push({ role: "tool", content: toolResults });
    }
  }

  return messages;
}

function projectAssistantPart(
  part: UIMessagePart,
  assistantContent: AssistantContentPart[],
  toolResults: ToolContentPart[],
): void {
  if (part.type === "text") {
    if (part.text) {
      assistantContent.push({ type: "text", text: part.text });
    }
    return;
  }

  // `step-start` and any other non-text/non-tool marker is irrelevant
  // for the model's input — drop silently.
  if (!part.type.startsWith("tool-")) return;

  const toolPart = part as ToolPart;
  const toolName = part.type.slice("tool-".length);
  if (!toolName) return;
  if (toolPart.input === undefined) return;

  // Orphan handling: skip any tool call that didn't complete. In-flight
  // calls (`input-streaming`, `input-available`) would emit a tool_use
  // with no paired tool_result and the SDK would reject the request.
  const hasOutput =
    toolPart.state === "output-available" && toolPart.output !== undefined;
  const hasError = toolPart.state === "output-error";
  if (!hasOutput && !hasError) return;

  assistantContent.push({
    type: "tool-call",
    toolCallId: toolPart.toolCallId,
    toolName,
    input: toolPart.input,
  });

  const output: ToolResultOutput = hasError
    ? {
        type: "error-text",
        value:
          toolPart.errorText ??
          (typeof toolPart.output === "string"
            ? toolPart.output
            : "Tool errored"),
      }
    : wrapToolOutput(toolPart.output);

  toolResults.push({
    type: "tool-result",
    toolCallId: toolPart.toolCallId,
    toolName,
    output,
  });
}

/**
 * Coerce a tool's raw `output` value into the AI SDK's `ToolResultOutput`
 * discriminated union. If the value already carries a recognised `type`
 * field, pass it through unchanged — the orchestrator's persistence layer
 * stores SDK-shaped outputs from `tool-result` events, so this is the
 * common case. Otherwise, fall back to `text` for strings and `json` for
 * everything else.
 */
function wrapToolOutput(output: unknown): ToolResultOutput {
  if (output && typeof output === "object" && "type" in output && "value" in output) {
    const t = (output as { type: unknown }).type;
    if (
      t === "text" ||
      t === "json" ||
      t === "error-text" ||
      t === "error-json" ||
      t === "execution-denied" ||
      t === "content"
    ) {
      return output as ToolResultOutput;
    }
  }
  if (typeof output === "string") {
    return { type: "text", value: output };
  }
  // JSONValue accepts any JSON-serialisable shape including undefined →
  // coerce to null so the wire stays valid.
  return { type: "json", value: (output ?? null) as never };
}
