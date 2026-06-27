// OpenAICompatibleAdapter — works against any /v1/chat/completions
// endpoint that speaks the OpenAI streaming wire format: OpenAI itself,
// Ollama, LM Studio, vLLM, llama.cpp server, Azure OpenAI, OpenRouter, etc.

// Custom Rust-backed fetch — bypasses CORS by dispatching via reqwest
// directly. See `native-fetch.ts` for the why. The fetch surface area is
// preserved (response.ok, status, text(), body.getReader()) so the rest
// of the adapter is unchanged.
import {
  nativeFetch as fetch,
  type NativeFetchResponse,
} from "./native-fetch";
import type {
  AdapterConfig,
  ChatMessage,
  LLMAdapter,
  ProbeResult,
  StreamChatParams,
  ToolDefinition,
} from "$lib/types/adapter";
import type { ChatStreamPart } from "$lib/types/chat";
import { parseSSEStream } from "./sse";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

export interface OpenAIAdapterDeps {
  getApiKey?: () => Promise<string | null>;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export class OpenAICompatibleAdapter implements LLMAdapter {
  readonly type = "openai-compatible" as const;
  readonly id: string;
  readonly name: string;
  readonly config: AdapterConfig;
  readonly #deps: OpenAIAdapterDeps;

  constructor(config: AdapterConfig, deps: OpenAIAdapterDeps = {}) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.#deps = deps;
  }

  async *streamChat(
    params: StreamChatParams,
  ): AsyncIterable<ChatStreamPart> {
    const url = `${this.#baseUrl()}/chat/completions`;
    const headers = await this.#buildHeaders();
    const body = this.#buildBody(params);

    yield { type: "start" };

    let response: NativeFetchResponse;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      yield {
        type: "error",
        error:
          err instanceof Error ? err.message : "Network request failed",
      };
      return;
    }

    if (!response.ok) {
      yield {
        type: "error",
        error: `Adapter "${this.name}" returned ${response.status}: ${await safeReadText(response)}`,
      };
      return;
    }

    yield { type: "start-step", request: {}, warnings: [] };

    // Translate OpenAI's chat-completion deltas into the SDK's TextStreamPart
    // wire format. Each assistant message has at most one text segment per
    // choice; tool calls arrive as incremental function-call deltas keyed
    // by `index` which we map to stable tool_call_ids.
    const textId = "text-0";
    let textStarted = false;
    const toolByIndex = new Map<
      number,
      { id: string; name: string; argBuf: string; announced: boolean }
    >();

    try {
      for await (const rec of parseSSEStream(response)) {
        if (rec.data === "[DONE]") break;
        let payload: OpenAIStreamChunk;
        try {
          payload = JSON.parse(rec.data) as OpenAIStreamChunk;
        } catch {
          continue;
        }
        const choice = payload.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        if (typeof delta.content === "string" && delta.content.length > 0) {
          if (!textStarted) {
            textStarted = true;
            yield { type: "text-start", id: textId };
          }
          yield {
            type: "text-delta",
            id: textId,
            text: delta.content,
          };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let entry = toolByIndex.get(idx);
            if (!entry) {
              entry = {
                id: tc.id ?? `tool_${idx}_${Date.now()}`,
                name: tc.function?.name ?? "",
                argBuf: "",
                announced: false,
              };
              toolByIndex.set(idx, entry);
            }
            if (tc.id && tc.id !== entry.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (!entry.announced && entry.name) {
              entry.announced = true;
              yield {
                type: "tool-input-start",
                id: entry.id,
                toolName: entry.name,
              };
            }
            if (tc.function?.arguments) {
              entry.argBuf += tc.function.arguments;
              if (entry.announced) {
                yield {
                  type: "tool-input-delta",
                  id: entry.id,
                  delta: tc.function.arguments,
                };
              }
            }
          }
        }

        if (choice.finish_reason) {
          if (textStarted) yield { type: "text-end", id: textId };
          for (const entry of toolByIndex.values()) {
            let input: unknown = {};
            if (entry.argBuf.length > 0) {
              try {
                input = JSON.parse(entry.argBuf);
              } catch {
                input = { _raw: entry.argBuf };
              }
            }
            yield {
              type: "tool-call",
              toolCallId: entry.id,
              toolName: entry.name,
              input,
            };
          }
          yield emptyFinish();
          return;
        }
      }
    } catch (err) {
      yield {
        type: "error",
        error:
          err instanceof Error ? err.message : "Stream interrupted",
      };
      return;
    }

    if (textStarted) yield { type: "text-end", id: textId };
    yield emptyFinish();
  }

  async probe(): Promise<ProbeResult> {
    try {
      const headers = await this.#buildHeaders();
      const started = performance.now();
      // /v1/models is the cheapest endpoint that proves auth + connectivity.
      const res = await fetch(`${this.#baseUrl()}/models`, {
        method: "GET",
        headers,
      });
      const latencyMs = Math.round(performance.now() - started);
      if (res.ok) return { ok: true, latencyMs };
      return {
        ok: false,
        latencyMs,
        message: `${res.status}: ${await safeReadText(res)}`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Probe failed",
      };
    }
  }

  #baseUrl(): string {
    return (this.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  async #buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    const apiKey = await this.#deps.getApiKey?.();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  #buildBody(params: StreamChatParams): Record<string, unknown> {
    const messages: OpenAIMessage[] = [
      { role: "system", content: params.systemPrompt },
      ...toOpenAIMessages(params.messages),
    ];
    return {
      // Per-call override (from `StreamChatParams.model`) wins over the
      // adapter's configured default — lets the orchestrator pick a
      // different model per delegate spawn.
      model: params.model ?? this.config.model ?? DEFAULT_MODEL,
      messages,
      temperature: params.temperature ?? 1,
      max_tokens: params.maxTokens ?? 4096,
      stream: true,
      tools: params.tools ? toOpenAITools(params.tools) : undefined,
    };
  }
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  return messages.map((m): OpenAIMessage => {
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: m.content,
      };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content.length > 0 ? m.content : null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: {
            name: c.name,
            arguments: JSON.stringify(c.input ?? {}),
          },
        })),
      };
    }
    return {
      role: m.role,
      content: m.content,
    };
  });
}

function toOpenAITools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

async function safeReadText(res: NativeFetchResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unable to read response body>";
  }
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

/** Synthesise the SDK's `finish` event with neutral defaults — the raw
 *  /v1/chat/completions response doesn't always include usage. */
function emptyFinish(): ChatStreamPart {
  return {
    type: "finish",
    finishReason: "stop",
    rawFinishReason: undefined,
    totalUsage: {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: {
        textTokens: undefined,
        reasoningTokens: undefined,
      },
    },
  };
}
