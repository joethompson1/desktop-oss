// Pass/fail on whether the orchestrator emitted the expected tool calls.
// Ordered mode checks subsequence (the expected names appear in order,
// extras allowed). Unordered mode checks set membership.
//
// Ported from the upstream backend's
// `apps/backend/src/agent/evals/scorers/tool-call-sequence.ts`.

import type { AgentTurnOutput, AgentTurnExpected, Scorer } from "../types.js";

export function mustCallTools<TInput>(
  expected: string[],
  order: "ordered" | "unordered" = "unordered",
): Scorer<TInput, AgentTurnOutput, AgentTurnExpected> {
  return ({ output }) => {
    if (expected.length === 0) {
      return { name: "must-call-tools", score: 1.0 };
    }

    const observed = output.toolCallSequence;

    if (order === "unordered") {
      const observedSet = new Set(observed);
      const missing = expected.filter((name) => !observedSet.has(name));
      const score = missing.length === 0 ? 1.0 : 0.0;
      return {
        name: "must-call-tools",
        score,
        metadata: { expected, observed, missing },
      };
    }

    // Ordered: every expected name must appear as a subsequence of observed.
    let cursor = 0;
    for (const name of expected) {
      const found = observed.indexOf(name, cursor);
      if (found === -1) {
        return {
          name: "must-call-tools",
          score: 0.0,
          metadata: {
            expected,
            observed,
            stoppedAt: name,
            cursor,
          },
        };
      }
      cursor = found + 1;
    }
    return { name: "must-call-tools", score: 1.0 };
  };
}
