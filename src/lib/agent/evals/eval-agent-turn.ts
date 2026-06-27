// Wraps the orchestrator's streaming turn driver into a single async
// function that returns the collapsed turn output (reply text, tool-call
// sequence, raw stream). Scenarios call `evalAgentTurn()` from their
// `task()` callback.
//
// The orchestrator model and delegate resolver are provided by the
// scenario — typical setup: a real LanguageModelV3 for the orchestrator
// (we want real API behaviour) and a scripted mock LLMAdapter for the
// delegate (so the test doesn't burn delegate-side tokens or wait on a
// real CLI subprocess).

import type { LanguageModelV3 } from "@ai-sdk/provider";

import type { AdapterConfig, LLMAdapter } from "$lib/types/adapter";
import { streamOrchestratorTurn } from "../loop.js";
import { ensureOrchestratorConversation } from "$lib/db/conversations";

import type { AgentTurnOutput, StepResult } from "./types.js";
import type { ChatStreamPart } from "$lib/types/chat";

export interface EvalTurnInput {
  /** User message to deliver to the orchestrator. */
  message: string;
  /** Pre-built orchestrator model. Anthropic SDK adapters set
   *  `isAnthropic: true` to enable the deferred-tools machinery. */
  orchestratorModel: LanguageModelV3;
  isAnthropic: boolean;
  /** Resolver invoked when the orchestrator calls `delegate_task`. Return
   *  null to simulate "no delegate configured" (the tool then surfaces an
   *  error to the model). */
  resolveDelegateAdapter: (preferredName?: string) => LLMAdapter | null;
  /** Adapter configs surfaced to the orchestrator via the "Available
   *  delegates" section of the system prompt. Usually one entry that
   *  matches the mock adapter the resolver returns. */
  delegateRosterConfigs?: AdapterConfig[];
  /** Conversation ID to drive the turn against. Defaults to the singleton
   *  orchestrator conversation. */
  conversationId?: string;
  signal?: AbortSignal;
}

/**
 * Run one orchestrator turn and collapse its event stream into the shape
 * scorers expect.
 */
export async function evalAgentTurn(
  input: EvalTurnInput,
): Promise<AgentTurnOutput> {
  const conversationId =
    input.conversationId ?? (await ensureOrchestratorConversation());

  const stream = streamOrchestratorTurn({
    conversationId,
    workingDirectory: "/",
    userMessage: input.message,
    orchestratorModel: input.orchestratorModel,
    isAnthropic: input.isAnthropic,
    resolveDelegateAdapter: input.resolveDelegateAdapter,
    delegateRosterConfigs: input.delegateRosterConfigs ?? [],
    signal: input.signal,
  });

  const rawStream: ChatStreamPart[] = [];
  const stepsByCallId = new Map<string, StepResult>();
  const stepOrder: string[] = [];
  const replyParts: string[] = [];
  const streamErrors: string[] = [];

  for await (const part of stream) {
    rawStream.push(part);

    if (part.type === "error") {
      const err = (part as { error?: unknown }).error;
      streamErrors.push(
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err),
      );
      continue;
    }

    if (part.type === "text-delta") {
      replyParts.push(part.text ?? "");
      continue;
    }

    if (part.type === "tool-input-start") {
      const callId = part.id;
      if (!callId) continue;
      if (!stepsByCallId.has(callId)) {
        stepOrder.push(callId);
        stepsByCallId.set(callId, {
          toolName: part.toolName ?? "unknown",
          toolCallId: callId,
          input: undefined,
        });
      }
      continue;
    }

    if (part.type === "tool-call") {
      const callId = part.toolCallId;
      const existing = stepsByCallId.get(callId);
      if (existing) {
        existing.input = part.input;
        existing.toolName = part.toolName ?? existing.toolName;
      } else {
        stepOrder.push(callId);
        stepsByCallId.set(callId, {
          toolName: part.toolName,
          toolCallId: callId,
          input: part.input,
        });
      }
      continue;
    }

    if (part.type === "tool-result") {
      const step = stepsByCallId.get(part.toolCallId);
      if (step) {
        step.output = part.output;
      }
      continue;
    }

    if (part.type === "tool-error") {
      const step = stepsByCallId.get(part.toolCallId);
      if (step) {
        step.errorText =
          typeof part.error === "string"
            ? part.error
            : JSON.stringify(part.error);
      }
      continue;
    }
  }

  const steps = stepOrder.map((id) => stepsByCallId.get(id)!).filter(Boolean);
  const toolCallSequence = steps.map((s) => s.toolName);

  return {
    reply: replyParts.join(""),
    steps,
    toolCallSequence,
    toolCallCount: steps.length,
    rawStream,
    streamErrors,
  };
}
