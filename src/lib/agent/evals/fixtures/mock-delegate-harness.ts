// Scripted LLMHarness that stands in for a real delegate. The orchestrator
// calls `delegate_task` → `runDelegate` → `harness.streamChat()`; this
// mock returns a canned sequence of chat-stream parts so the test
// completes without contacting an external model.
//
// The harness records every `streamChat()` call for the scorer/test to
// inspect — useful for asserting "the delegate received a brief that
// mentioned the file we pre-seeded".

import type {
  LLMHarness,
  HarnessConfig,
  HarnessType,
  ProbeResult,
  StreamChatParams,
} from "$lib/types/harness";
import type { ChatStreamPart } from "$lib/types/chat";

export interface MockDelegateCall {
  systemPrompt: string;
  messages: StreamChatParams["messages"];
  startedAt: number;
}

export interface MockDelegateHarnessOptions {
  id?: string;
  name?: string;
  /** Harness type — drives the delegate's *kind* (sealed vs general) in the
   *  roster the orchestrator sees. Defaults to `openai-compatible` (a general
   *  model). Set to e.g. `claude-code` to stand in for a sealed coding agent
   *  when a scenario needs to test kind-appropriate selection. */
  type?: HarnessType;
  /** Free-text description surfaced in the "Available delegates" roster. */
  description?: string;
  /** Text the mock delegate "replies" with. Streamed in one chunk so the
   *  orchestrator's tool-result block carries it as the delegate's
   *  completion summary. */
  reply?: string;
  /** Files the mock claims to have changed. */
  filesChanged?: string[];
  /** Artificial latency in ms before the reply starts streaming. */
  latencyMs?: number;
}

/**
 * Build a scripted delegate harness with public access to the call log.
 *
 * Returns `{ harness, calls }` — append-only `calls` array updated each
 * time the orchestrator invokes the delegate.
 */
export function makeMockDelegateHarness(
  opts: MockDelegateHarnessOptions = {},
): { harness: LLMHarness; calls: MockDelegateCall[] } {
  const id = opts.id ?? "mock-delegate";
  const name = opts.name ?? "Mock Delegate";
  const type = opts.type ?? "openai-compatible";
  const reply =
    opts.reply ??
    "Done. I completed the requested task and left a note in the report.";
  const filesChanged = opts.filesChanged ?? [];
  const latencyMs = opts.latencyMs ?? 0;
  const calls: MockDelegateCall[] = [];

  const config: HarnessConfig = {
    id,
    type,
    name,
    description:
      opts.description ?? "Eval mock delegate — returns a canned completion report.",
    model: "mock-delegate-v1",
  };

  const harness: LLMHarness = {
    id,
    name,
    type,
    config,
    async probe(): Promise<ProbeResult> {
      return { ok: true, latencyMs: 0, message: "mock" };
    },
    streamChat(params: StreamChatParams): AsyncIterable<ChatStreamPart> {
      calls.push({
        systemPrompt: params.systemPrompt,
        messages: params.messages,
        startedAt: Date.now(),
      });
      return scriptedStream(reply, filesChanged, latencyMs, params.signal);
    },
  };

  return { harness, calls };
}

async function* scriptedStream(
  reply: string,
  _filesChanged: string[],
  latencyMs: number,
  signal: AbortSignal | undefined,
): AsyncIterable<ChatStreamPart> {
  if (latencyMs > 0) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, latencyMs);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      }
    });
  }

  const textId = "mock-text-1";
  yield { type: "start" } as unknown as ChatStreamPart;
  yield {
    type: "text-start",
    id: textId,
  } as unknown as ChatStreamPart;
  yield {
    type: "text-delta",
    id: textId,
    text: reply,
  } as unknown as ChatStreamPart;
  yield {
    type: "text-end",
    id: textId,
  } as unknown as ChatStreamPart;
  yield {
    type: "finish",
    finishReason: "stop",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  } as unknown as ChatStreamPart;
}
