// Scripted LLMAdapter that stands in for a real delegate. The orchestrator
// calls `delegate_task` → `runDelegate` → `adapter.streamChat()`; this
// mock returns a canned sequence of chat-stream parts so the test
// completes without contacting an external model.
//
// The adapter records every `streamChat()` call for the scorer/test to
// inspect — useful for asserting "the delegate received a brief that
// mentioned the file we pre-seeded".

import type {
  LLMAdapter,
  AdapterConfig,
  ProbeResult,
  StreamChatParams,
} from "$lib/types/adapter";
import type { ChatStreamPart } from "$lib/types/chat";

export interface MockDelegateCall {
  systemPrompt: string;
  messages: StreamChatParams["messages"];
  startedAt: number;
}

export interface MockDelegateAdapterOptions {
  id?: string;
  name?: string;
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
 * Build a scripted delegate adapter with public access to the call log.
 *
 * Returns `{ adapter, calls }` — append-only `calls` array updated each
 * time the orchestrator invokes the delegate.
 */
export function makeMockDelegateAdapter(
  opts: MockDelegateAdapterOptions = {},
): { adapter: LLMAdapter; calls: MockDelegateCall[] } {
  const id = opts.id ?? "mock-delegate";
  const name = opts.name ?? "Mock Delegate";
  const reply =
    opts.reply ??
    "Done. I completed the requested task and left a note in the report.";
  const filesChanged = opts.filesChanged ?? [];
  const latencyMs = opts.latencyMs ?? 0;
  const calls: MockDelegateCall[] = [];

  const config: AdapterConfig = {
    id,
    type: "openai-compatible",
    name,
    description: "Eval mock delegate — returns a canned completion report.",
    model: "mock-delegate-v1",
  };

  const adapter: LLMAdapter = {
    id,
    name,
    type: "openai-compatible",
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

  return { adapter, calls };
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
