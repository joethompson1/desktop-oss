// AnthropicHarness — talks to api.anthropic.com via either an API key
// (sk-ant-...) or an OAuth bearer token cached by Claude Code in ~/.claude/.
// Both modes use the same /v1/messages wire format; only the auth header
// and the additional beta headers differ.

// IMPORTANT: route HTTP through our Rust-side `nativeFetch` rather than
// `window.fetch` or `@tauri-apps/plugin-http`'s fetch. Both of those
// forward the webview's Origin header to upstream, which makes Anthropic
// classify the request as CORS-originated. Some Anthropic organisations
// have CORS disabled at the policy level, which then 401s the request
// regardless of any opt-in headers. nativeFetch dispatches via reqwest
// directly — no Origin, no CORS classification, no policy denial.
import {
  nativeFetch as fetch,
  type NativeFetchResponse,
} from "./native-fetch";
import type {
  HarnessConfig,
  ChatMessage,
  LLMHarness,
  ProbeResult,
  StreamChatParams,
  ToolDefinition,
} from "$lib/types/harness";
import type { ChatStreamPart } from "$lib/types/chat";
import type {
  HarnessStreamPart,
  RunFinishReason,
  RunTokenUsage,
} from "$lib/types/run";
import { parseSSEStream } from "./sse";
import { getValidClaudeCodeCredentials } from "./claude-code-auth";

import {
  ANTHROPIC_ENDPOINT,
  ANTHROPIC_VERSION,
  buildBillingHeaderLine,
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_CODE_BETA,
  CONTEXT_1M_BETA,
  DEFAULT_MODEL,
  OAUTH_BETA,
  PROMPT_CACHING_BETA,
  SESSION_ID,
} from "./claude-code-fingerprint";

function firstUserMessageText(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  return first?.content ?? "";
}

/** Synthesise the SDK's `finish` event with neutral defaults. We don't
 *  have per-stream usage numbers from the raw Anthropic wire — that's
 *  fine for delegate streams which don't drive billing UI. */
function emptyFinish(): ChatStreamPart {
  return {
    type: "finish",
    finishReason: "stop",
    rawFinishReason: undefined,
    totalUsage: emptyUsage(),
  };
}

function emptyUsage() {
  return {
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
  };
}

export interface AnthropicHarnessDeps {
  /** Resolves the API key when `authMode === 'api-key'`. */
  getApiKey?: () => Promise<string | null>;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export class AnthropicHarness implements LLMHarness {
  readonly type = "anthropic" as const;
  readonly id: string;
  readonly name: string;
  readonly config: HarnessConfig;
  readonly #deps: AnthropicHarnessDeps;

  constructor(config: HarnessConfig, deps: AnthropicHarnessDeps = {}) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.#deps = deps;
  }

  async *streamChat(
    params: StreamChatParams,
  ): AsyncIterable<HarnessStreamPart> {
    const headers = await this.#buildHeaders();
    const body = await this.#buildRequestBody(params);

    yield { type: "start" };

    let response: NativeFetchResponse;
    try {
      response = await fetch(ANTHROPIC_ENDPOINT, {
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
      const text = await safeReadText(response);
      yield {
        type: "error",
        error: `Anthropic returned ${response.status}: ${text}`,
      };
      return;
    }

    yield { type: "start-step", request: {}, warnings: [] };

    // Translate Anthropic SSE events into the SDK's TextStreamPart wire format.
    // Block index → identity bookkeeping so we can correlate deltas back
    // to start chunks.
    const textBlockIds = new Map<number, string>();
    const toolBlockIds = new Map<
      number,
      { toolCallId: string; toolName: string; inputJson: string }
    >();

    // Token accounting. Anthropic reports the three input buckets as
    // *additive* (total input = input + cache_read + cache_creation; see
    // the note on RunTokenUsage), so we sum them rather than treating cache
    // reads as a subset. `input` arrives on `message_start`; the running
    // `output` and the `stop_reason` arrive on `message_delta`.
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    let stopReason: RunFinishReason = "stop";
    // 200k is the standard Claude context window; the 1M beta widens it.
    const contextWindow = this.config.context1m ? 1_000_000 : 200_000;

    const completionEvents = (): HarnessStreamPart[] => {
      const events: HarnessStreamPart[] = [];
      if (sawUsage) {
        const usage: RunTokenUsage = {
          contextTokens: inputTokens + outputTokens,
          contextWindow,
          inputTokens,
          outputTokens,
        };
        events.push({ type: "run-token-usage", usage });
      }
      events.push({
        type: "run-turn",
        turn: { phase: "completed", finishReason: stopReason },
      });
      events.push(emptyFinish());
      return events;
    };

    try {
      for await (const record of parseSSEStream(response)) {
        let payload: AnthropicStreamEvent;
        try {
          payload = JSON.parse(record.data) as AnthropicStreamEvent;
        } catch {
          continue;
        }

        if (payload.type === "content_block_start") {
          const block = payload.content_block;
          if (block.type === "text") {
            const id = `text-${payload.index}`;
            textBlockIds.set(payload.index, id);
            yield { type: "text-start", id };
          } else if (block.type === "tool_use") {
            toolBlockIds.set(payload.index, {
              toolCallId: block.id,
              toolName: block.name,
              inputJson: "",
            });
            yield {
              type: "tool-input-start",
              id: block.id,
              toolName: block.name,
            };
          }
        } else if (payload.type === "content_block_delta") {
          const delta = payload.delta;
          if (delta.type === "text_delta") {
            const id = textBlockIds.get(payload.index);
            if (id) yield { type: "text-delta", id, text: delta.text };
          } else if (delta.type === "input_json_delta") {
            const entry = toolBlockIds.get(payload.index);
            if (entry) {
              entry.inputJson += delta.partial_json;
              yield {
                type: "tool-input-delta",
                id: entry.toolCallId,
                delta: delta.partial_json,
              };
            }
          }
        } else if (payload.type === "content_block_stop") {
          const textId = textBlockIds.get(payload.index);
          if (textId) {
            yield { type: "text-end", id: textId };
            textBlockIds.delete(payload.index);
          }
          const toolEntry = toolBlockIds.get(payload.index);
          if (toolEntry) {
            let parsedInput: unknown = {};
            if (toolEntry.inputJson.length > 0) {
              try {
                parsedInput = JSON.parse(toolEntry.inputJson);
              } catch {
                parsedInput = { _raw: toolEntry.inputJson };
              }
            }
            yield {
              type: "tool-call",
              toolCallId: toolEntry.toolCallId,
              toolName: toolEntry.toolName,
              input: parsedInput,
            };
            toolBlockIds.delete(payload.index);
          }
        } else if (payload.type === "message_start") {
          const u = payload.message?.usage;
          if (u) {
            sawUsage = true;
            inputTokens =
              (u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0);
            if (typeof u.output_tokens === "number") outputTokens = u.output_tokens;
          }
        } else if (payload.type === "message_delta") {
          if (typeof payload.usage?.output_tokens === "number") {
            sawUsage = true;
            outputTokens = payload.usage.output_tokens;
          }
          if (payload.delta?.stop_reason) {
            stopReason = mapAnthropicStopReason(payload.delta.stop_reason);
          }
        } else if (payload.type === "message_stop") {
          yield* completionEvents();
          return;
        } else if (payload.type === "error") {
          yield {
            type: "error",
            error: payload.error?.message ?? "Anthropic stream error",
          };
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

    // Stream ended without an explicit `message_stop` — still emit the
    // normalized completion (usage + turn) alongside the finish.
    yield* completionEvents();
  }

  /** Verify the harness has usable credentials. We deliberately do NOT
   *  hit api.anthropic.com here:
   *
   *  - The cheapest endpoint that requires auth (`POST /v1/messages` with
   *    `max_tokens: 1`) still spends tokens, counts against the user's
   *    rate limit, and burns Pro/Max quota for no real benefit.
   *  - Repeated probes were 429-ing for users on heavy Claude Code days,
   *    which then incorrectly painted the health pill red.
   *  - The chat itself is the authoritative reachability test — if Anthropic
   *    is down or the user's key is bad, the next message will surface it.
   *
   *  Probing therefore reduces to: "are credentials loadable?" — same
   *  check `#buildHeaders` performs before any real call. If that succeeds,
   *  we're as confident as we can be without spending an API call. */
  async probe(): Promise<ProbeResult> {
    try {
      await this.#buildHeaders();
      return { ok: true, message: "credentials valid" };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Credentials check failed",
      };
    }
  }

  async #buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "anthropic-version": ANTHROPIC_VERSION,
      // Belt-and-braces: if anything down the line ever re-introduces an
      // Origin header, this opt-in stops Anthropic refusing the request
      // outright. Harmless when the request isn't browser-originated.
      "anthropic-dangerous-direct-browser-access": "true",
    };
    const authMode = this.config.authMode ?? "api-key";
    const betas: string[] = [];
    if (authMode === "account") {
      // `getValidClaudeCodeCredentials` swaps the cached refresh token
      // for a fresh access token (and rotates it back into the keychain)
      // when the cached one has expired, so we don't bounce the user
      // out to `claude auth login` after every idle stretch. It only
      // throws when refresh genuinely fails (revoked / network down).
      const creds = await getValidClaudeCodeCredentials();
      if (!creds.hasCredentials || !creds.accessToken) {
        throw new Error(
          "No Claude Code account login found. Run `claude auth login` first, or switch this harness to API key mode.",
        );
      }
      headers.Authorization = `Bearer ${creds.accessToken}`;

      // Full Claude Code CLI fingerprint. The `x-app: cli` header is the
      // primary gate Anthropic checks — without it, OAuth tokens get
      // aggressively rate-limited (returns 429 with empty "Error" message
      // even when the account has plenty of quota). The session ID and
      // User-Agent round out the request shape so it matches what the
      // real CLI sends. See `claude-code/src/services/api/client.ts`
      // and `claude-code/src/utils/http.ts` for the canonical source.
      headers["x-app"] = "cli";
      headers["User-Agent"] = CLAUDE_CLI_USER_AGENT;
      headers["X-Claude-Code-Session-Id"] = SESSION_ID;
      headers["x-client-app"] = "desktop-oss";

      // Beta header order matches `claude-code/src/utils/betas.ts`:
      // claude-code beta first, then oauth, then optional 1m-context.
      betas.push(CLAUDE_CODE_BETA, OAUTH_BETA);
    } else {
      const apiKey = await this.#deps.getApiKey?.();
      if (!apiKey) {
        throw new Error(
          `No API key configured for harness "${this.name}". Add one in Settings.`,
        );
      }
      headers["x-api-key"] = apiKey;
      betas.push(PROMPT_CACHING_BETA);
    }
    if (this.config.context1m) betas.push(CONTEXT_1M_BETA);
    headers["anthropic-beta"] = betas.join(",");
    return headers;
  }

  async #buildRequestBody(
    params: StreamChatParams,
  ): Promise<Record<string, unknown>> {
    const authMode = this.config.authMode ?? "api-key";

    // In account mode, prepend the CLI's billing-header line to the system
    // prompt. The server side parses this from the prompt body — not from
    // HTTP headers — to attribute the request to a Claude Code client and
    // avoid the anti-abuse rate limiter. See `claude-code/src/services/api/
    // claude.ts:1360` (it's the first entry in the system-prompt array).
    let system = params.systemPrompt;
    if (authMode === "account") {
      const billingLine = await buildBillingHeaderLine(
        firstUserMessageText(params.messages),
      );
      system = `${billingLine}\n${params.systemPrompt}`;
    }

    return {
      // Per-call override (from `StreamChatParams.model`) wins over the
      // harness's configured default — lets the orchestrator pick a
      // different Claude variant per delegate spawn.
      model: params.model ?? this.config.model ?? DEFAULT_MODEL,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 1,
      system,
      messages: toAnthropicMessages(params.messages),
      tools: params.tools ? toAnthropicTools(params.tools) : undefined,
      stream: true,
    };
  }
}

function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue; // handled out-of-band
    if (msg.role === "user") {
      out.push({
        role: "user",
        content: [{ type: "text", text: msg.content }],
      });
    } else if (msg.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (msg.content.length > 0) {
        blocks.push({ type: "text", text: msg.content });
      }
      if (msg.toolCalls) {
        for (const call of msg.toolCalls) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input,
          });
        }
      }
      out.push({ role: "assistant", content: blocks });
    } else if (msg.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId ?? "",
            content: msg.content,
          },
        ],
      });
    }
  }
  return out;
}

function toAnthropicTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

async function safeReadText(res: NativeFetchResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `<unable to read response body>`;
  }
}

/** Anthropic's per-response usage block. The three input buckets are
 *  additive (total input = input + cache_read + cache_creation). */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

type AnthropicStreamEvent =
  | { type: "message_start"; message: { usage?: AnthropicUsage } }
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: unknown };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason?: string | null };
      usage?: { output_tokens?: number };
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

/** Map Anthropic's `stop_reason` onto the normalized `RunFinishReason`. */
function mapAnthropicStopReason(reason: string | null | undefined): RunFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}
