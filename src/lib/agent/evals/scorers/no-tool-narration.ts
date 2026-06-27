// Detects the "narrates but doesn't actually call" failure mode that this
// whole harness exists to chase. Fails when the assistant text contains
// strong action verbs hinting it just kicked off a tool — "spawning the
// delegate", "launching the LRU agent", "firing off the search now" —
// but the orchestrator emitted zero tool calls in that turn.
//
// The patterns are intentionally conservative. Status updates that come
// AFTER a real tool call are fine ("Done — here's what came back") and
// must not trigger this scorer. The simplest way to avoid false positives
// is to gate the regex match on `toolCallCount === 0`: if the model did
// call a tool, we don't care how chatty its surrounding prose is.

import type { AgentTurnOutput, AgentTurnExpected, Scorer } from "../types.js";

/**
 * Phrases that strongly imply the assistant is announcing a tool call it
 * is about to make. Each pattern is anchored to an action verb so plain
 * declarative descriptions of past work don't match.
 */
const NARRATION_PATTERNS: RegExp[] = [
  /\bspawning\s+(?:the\s+|a\s+|an\s+)?\S+/i,
  /\blaunching\s+(?:the\s+|a\s+|an\s+)?\S+/i,
  /\bfiring\s+(?:off|up)\s+\S+/i,
  /\bkicking\s+off\s+\S+/i,
  /\bdelegate\s+(?:is\s+)?(?:starting|running|launching|spawning|on\s+the\s+way)/i,
  /\b(?:I'?ll|I\s+will|let\s+me|i'?m\s+going\s+to)\s+(?:now\s+)?(?:spawn|launch|delegate|kick\s+off|fire\s+off|run|spin\s+up)\b/i,
  /\b(?:calling|invoking)\s+(?:the\s+)?\S+\s+(?:tool|now|tool\s+now)\b/i,
  /\bdone[\s!.,]+(?:delegate|task)\s+launched\b/i,
  /\bhere'?s\s+what\s+(?:came|came\s+back|the\s+delegate\s+returned)/i,
];

export function noToolNarration<TInput>(): Scorer<
  TInput,
  AgentTurnOutput,
  AgentTurnExpected
> {
  return ({ output, expected }) => {
    if (expected.mustNotNarrate === false) {
      return { name: "no-tool-narration", score: 1.0 };
    }

    if (output.toolCallCount > 0) {
      return { name: "no-tool-narration", score: 1.0 };
    }

    const reply = output.reply ?? "";
    const matched: string[] = [];
    for (const pattern of NARRATION_PATTERNS) {
      const m = reply.match(pattern);
      if (m) matched.push(m[0]);
    }

    if (matched.length === 0) {
      return { name: "no-tool-narration", score: 1.0 };
    }

    return {
      name: "no-tool-narration",
      score: 0.0,
      metadata: {
        matched,
        toolCallCount: output.toolCallCount,
        replyPreview: reply.slice(0, 240),
      },
    };
  };
}
