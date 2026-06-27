// Fails when the orchestrator returns an empty reply or the "(No response
// generated)" placeholder. Catches the other half of the hallucination
// failure mode — the model produced nothing at all (often after a failed
// tool-call attempt).

import type { AgentTurnOutput, AgentTurnExpected, Scorer } from "../types.js";

const PLACEHOLDER = "(No response generated)";

export function noEmptyResponse<TInput>(): Scorer<
  TInput,
  AgentTurnOutput,
  AgentTurnExpected
> {
  return ({ output, expected }) => {
    if (expected.mustNotEmitPlaceholder === false) {
      return { name: "no-empty-response", score: 1.0 };
    }

    const reply = (output.reply ?? "").trim();
    // A turn with tool calls but no text is fine — the model may have
    // delegated and is waiting for the next message before saying more.
    if (reply.length === 0 && output.toolCallCount > 0) {
      return { name: "no-empty-response", score: 1.0 };
    }
    if (reply.length === 0 || reply === PLACEHOLDER) {
      return {
        name: "no-empty-response",
        score: 0.0,
        metadata: { reply },
      };
    }
    return { name: "no-empty-response", score: 1.0 };
  };
}
