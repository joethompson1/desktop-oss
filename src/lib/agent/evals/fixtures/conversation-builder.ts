// Programmatic helpers for seeding the eval database with a conversation
// in a specific shape — useful for scenarios that don't replay a captured
// production snapshot but want to test a particular failure mode (e.g.
// "agent has just been told to delegate" or "agent's last assistant turn
// described a tool call without making one").

import type {
  UIAssistantMessage,
  UIChatTurn,
  UIMessagePart,
  UIUserMessage,
} from "$lib/types/chat";
import { appendMessage } from "$lib/db/conversations";

let _seq = 0;
function nextId(prefix: string): string {
  _seq += 1;
  return `${prefix}-${_seq}-${Math.random().toString(36).slice(2, 6)}`;
}

export interface ScriptedUserTurn {
  role: "user";
  content: string;
}

export interface ScriptedAssistantTurn {
  role: "assistant";
  /** Plain text for the assistant turn. Most synthetic scenarios only
   *  need text — the orchestrator's `historyToModelMessages` strips
   *  everything else on replay anyway. */
  text: string;
}

export type ScriptedTurn = ScriptedUserTurn | ScriptedAssistantTurn;

export interface SeedConversationOptions {
  conversationId: string;
  turns: ScriptedTurn[];
}

/**
 * Append a scripted sequence of turns to a conversation. Messages are
 * written in order with monotonically increasing timestamps so
 * `loadMessages` returns them in the expected sequence.
 */
export async function seedConversation(
  opts: SeedConversationOptions,
): Promise<void> {
  const startedAt = Date.now() - opts.turns.length * 1000;
  for (let i = 0; i < opts.turns.length; i++) {
    const turn = opts.turns[i];
    const createdAt = new Date(startedAt + i * 1000).toISOString();

    if (turn.role === "user") {
      const msg: UIUserMessage = {
        id: nextId("user"),
        role: "user",
        content: turn.content,
        createdAt,
      };
      await appendMessage(opts.conversationId, msg);
    } else {
      const parts: UIMessagePart[] = [
        { type: "text", text: turn.text, state: "done" },
      ];
      const msg: UIAssistantMessage = {
        id: nextId("asst"),
        role: "assistant",
        parts,
        createdAt,
      };
      await appendMessage(opts.conversationId, msg);
    }
  }
}

/**
 * Convenience: a two-turn primer that ends with the assistant offering to
 * delegate. Pair it with a new user turn ("Yes please, go ahead.") sent
 * via `evalAgentTurn()` — the scenario's task — to trigger the
 * followthrough decision the orchestrator must make as a tool call.
 *
 * Pure — does not touch the DB. Pass the result to `seedConversation`.
 */
export function delegationFollowthroughTurns(opts: {
  taskDescription: string;
  delegateName?: string;
}): ScriptedTurn[] {
  const name = opts.delegateName ?? "the delegate";
  return [
    {
      role: "user",
      content: opts.taskDescription,
    },
    {
      role: "assistant",
      text:
        `Got it — I'll set up ${name} to handle this task. ` +
        `Shall I kick that off now?`,
    },
  ];
}

export type { UIChatTurn };
