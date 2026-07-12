// Codex harness — drives `codex mcp-server` over JSON-RPC.
//
// Codex (OpenAI's coding agent CLI) ships an MCP server mode that
// exposes two tools — `codex` (run a fresh session) and `codex-reply`
// (continue an existing one) — both of which run codex's full agent
// loop server-side and stream `codex/event` progress notifications
// back as the model produces output. We hold one long-lived
// subprocess per harness instance, multiplex tools/call requests over
// it via McpStdioClient, and translate `codex/event` notifications
// into our standard ChatStreamPart events.
//
// Why MCP server over `codex exec --json`:
//   - One long-lived process across many delegate runs (no spawn cost
//     per task).
//   - Native conversation threading via `threadId` returned by the
//     `codex` tool — we persist it as the run's harness session id and
//     pass it to `codex-reply` on continuation.
//   - Concurrent runs over the same server (multiplexed by JSON-RPC
//     request id).
//   - Structured error responses instead of stdout/stderr scraping.
//
// Per-call configuration (model, profile, sandbox) is passed as
// arguments to the `codex` tool — the same server can route different
// runs to different codex profiles defined in `~/.codex/config.toml`.

import type {
  HarnessConfig,
  HarnessType,
  ChatMessage,
  LLMHarness,
  ProbeResult,
  StreamChatParams,
} from "$lib/types/harness";
import type { ChatStreamPart } from "$lib/types/chat";
import { McpStdioClient } from "./mcp-stdio-client";

const APP_VERSION = "0.1";

interface CodexToolResult {
  threadId?: string;
  content?: string;
}

// Discriminated subset of codex/event `msg` payloads we surface. The
// codex MCP server emits many more event types (token_count,
// raw_response_item, user_message, agent_message, mcp_startup_complete,
// step_start, step_finish, …) — we ignore the redundant / verbose
// ones and surface only the events that map onto ChatStreamPart.
interface SessionConfiguredMsg {
  type: "session_configured";
  session_id: string;
  thread_id: string;
  model: string;
  model_provider_id: string;
}
interface TaskStartedMsg {
  type: "task_started";
  turn_id: string;
  model_context_window: number;
}
interface TaskCompleteMsg {
  type: "task_complete";
  turn_id: string;
  last_agent_message?: string;
  duration_ms: number;
  time_to_first_token_ms?: number;
}
interface AgentMessageContentDeltaMsg {
  type: "agent_message_content_delta";
  thread_id: string;
  turn_id: string;
  item_id: string;
  delta: string;
}
interface ItemStartedMsg {
  type: "item_started";
  item: CodexItem;
}
interface ItemCompletedMsg {
  type: "item_completed";
  item: CodexItem;
}
interface WarningMsg {
  type: "warning";
  message: string;
}
interface ErrorMsg {
  type: "error";
  message?: string;
  error?: { message?: string; name?: string };
}

type CodexEventMsg =
  | SessionConfiguredMsg
  | TaskStartedMsg
  | TaskCompleteMsg
  | AgentMessageContentDeltaMsg
  | ItemStartedMsg
  | ItemCompletedMsg
  | WarningMsg
  | ErrorMsg
  | { type: string; [k: string]: unknown };

type CodexItem =
  | {
      type: "AgentMessage";
      id: string;
      content: Array<{ type: string; text?: string }>;
    }
  | {
      type: "UserMessage";
      id: string;
      content: Array<{ type: string; text?: string }>;
    }
  | {
      type: "ToolUse";
      id: string;
      name?: string;
      tool?: string;
      input?: unknown;
      output?: string;
      arguments?: unknown;
    }
  | { type: string; id: string; [k: string]: unknown };

export class CodexHarness implements LLMHarness {
  readonly type: HarnessType = "codex";
  readonly id: string;
  readonly name: string;
  readonly config: HarnessConfig;

  #client: McpStdioClient | null = null;

  constructor(config: HarnessConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
  }

  async #ensureClient(): Promise<McpStdioClient> {
    if (this.#client && this.#client.isRunning()) return this.#client;
    const client = new McpStdioClient({
      binary: "codex",
      args: ["mcp-server"],
      clientName: "desktop-oss",
      clientVersion: APP_VERSION,
    });
    await client.start();
    this.#client = client;
    return client;
  }

  async *streamChat(
    params: StreamChatParams,
  ): AsyncIterable<ChatStreamPart> {
    yield { type: "start" };
    yield { type: "start-step", request: {}, warnings: [] };

    let client: McpStdioClient;
    try {
      client = await this.#ensureClient();
    } catch (err) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : String(err);
      yield {
        type: "error",
        error: `Codex MCP server unavailable: ${detail}`,
      };
      return;
    }

    const prompt = buildPromptFromMessages(params.messages);
    const isResume = Boolean(params.resumeSessionId);
    const toolName = isResume ? "codex-reply" : "codex";

    const args: Record<string, unknown> = isResume
      ? { threadId: params.resumeSessionId, prompt }
      : {
          prompt,
          "approval-policy": "never",
          sandbox: this.config.codexSandbox ?? "danger-full-access",
          ...(this.config.codexProfile
            ? { profile: this.config.codexProfile }
            : {}),
          // Per-call override (from `StreamChatParams.model`) wins over
          // the harness's configured default model — and over the
          // profile's model too, since codex's `--model` flag takes
          // precedence over the profile.
          ...((params.model ?? this.config.model)
            ? { model: params.model ?? this.config.model }
            : {}),
          ...(params.systemPrompt
            ? { "developer-instructions": params.systemPrompt }
            : {}),
        };

    const textId = "text-0";
    let textStarted = false;
    const startTextIfNeeded = function* (): Generator<ChatStreamPart> {
      if (!textStarted) {
        textStarted = true;
        yield { type: "text-start", id: textId };
      }
    };

    const seenTools = new Set<string>();
    let errorEmitted = false;
    let usage: TokenUsage | null = null;

    try {
      for await (const evt of client.callTool(toolName, args, {
        signal: params.signal,
      })) {
        if (evt.kind === "notification") {
          if (evt.method !== "codex/event") continue;
          const msg = (evt.params.msg ?? {}) as CodexEventMsg;
          yield* this.#translateMsg(
            msg,
            textId,
            startTextIfNeeded,
            seenTools,
            params.onSessionInfo,
          );
          if (
            msg.type === "task_complete" ||
            (msg.type === "token_count" &&
              (msg as { info?: { total_token_usage?: unknown } }).info)
          ) {
            usage = extractUsage(msg);
          }
        } else if (evt.kind === "result") {
          const res = evt.result as { structuredContent?: CodexToolResult } | null;
          const threadId = res?.structuredContent?.threadId;
          if (threadId) {
            try {
              params.onSessionInfo?.({ sessionId: threadId });
            } catch (cbErr) {
              // eslint-disable-next-line no-console
              console.warn("[codex-mcp] onSessionInfo threw:", cbErr);
            }
          }
        } else if (evt.kind === "error") {
          errorEmitted = true;
          yield {
            type: "error",
            error: `Codex MCP error (${evt.error.code}): ${evt.error.message}`,
          };
        }
      }
    } catch (err) {
      errorEmitted = true;
      yield {
        type: "error",
        error: err instanceof Error ? err.message : "Codex stream failed",
      };
    }

    if (textStarted) yield { type: "text-end", id: textId };
    yield {
      type: "finish",
      finishReason: errorEmitted ? "error" : "stop",
      rawFinishReason: undefined,
      totalUsage: usage ?? emptyUsage(),
    };
  }

  *#translateMsg(
    msg: CodexEventMsg,
    textId: string,
    startTextIfNeeded: () => Generator<ChatStreamPart>,
    seenTools: Set<string>,
    onSessionInfo: StreamChatParams["onSessionInfo"],
  ): Generator<ChatStreamPart> {
    switch (msg.type) {
      case "session_configured": {
        const sc = msg as SessionConfiguredMsg;
        if (sc.thread_id) {
          try {
            onSessionInfo?.({ sessionId: sc.thread_id });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("[codex-mcp] onSessionInfo threw:", err);
          }
        }
        return;
      }
      case "agent_message_content_delta": {
        const d = msg as AgentMessageContentDeltaMsg;
        if (!d.delta) return;
        yield* startTextIfNeeded();
        yield { type: "text-delta", id: textId, text: d.delta };
        return;
      }
      case "item_started": {
        const it = (msg as ItemStartedMsg).item;
        if (it.type === "ToolUse" && !seenTools.has(it.id)) {
          seenTools.add(it.id);
          const toolName = readToolName(it);
          yield {
            type: "tool-input-start",
            id: it.id,
            toolName,
            dynamic: true,
          };
          yield {
            type: "tool-call",
            toolCallId: it.id,
            toolName,
            input: readToolInput(it) ?? {},
            dynamic: true,
          };
        }
        return;
      }
      case "item_completed": {
        const it = (msg as ItemCompletedMsg).item;
        if (it.type === "ToolUse") {
          if (!seenTools.has(it.id)) {
            // Tool completed without a prior item_started — surface
            // both so the chat-store has the full lifecycle.
            seenTools.add(it.id);
            const toolName = readToolName(it);
            yield {
              type: "tool-input-start",
              id: it.id,
              toolName,
              dynamic: true,
            };
            yield {
              type: "tool-call",
              toolCallId: it.id,
              toolName,
              input: readToolInput(it) ?? {},
              dynamic: true,
            };
          }
          const toolName = readToolName(it);
          yield {
            type: "tool-result",
            toolCallId: it.id,
            toolName,
            input: readToolInput(it) ?? {},
            output: readToolOutput(it) ?? "",
            dynamic: true,
          };
        }
        return;
      }
      case "warning": {
        const w = msg as WarningMsg;
        if (w.message) {
          yield* startTextIfNeeded();
          yield {
            type: "text-delta",
            id: textId,
            text: `\n[codex warning] ${w.message}\n`,
          };
        }
        return;
      }
      case "error": {
        const e = msg as ErrorMsg;
        const detail =
          e.error?.message ?? e.error?.name ?? e.message ?? "unknown error";
        yield { type: "error", error: `Codex: ${detail}` };
        return;
      }
      // task_started / task_complete handled implicitly — the wrapping
      // start-step / finish events bracket the whole stream. Other
      // event types (raw_response_item, user_message, agent_message,
      // step_start, step_finish, token_count, mcp_startup_complete)
      // are ignored as redundant or noise.
      default:
        return;
    }
  }

  async probe(): Promise<ProbeResult> {
    try {
      const started = performance.now();
      const client = await this.#ensureClient();
      const latencyMs = Math.round(performance.now() - started);
      const info = client.serverInfo;
      return {
        ok: true,
        latencyMs,
        message: info
          ? `${info.title ?? info.name} v${info.version}`
          : "codex mcp-server ready",
      };
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : "codex mcp-server not available",
      };
    }
  }

  /** Tear down the long-lived subprocess. Called when the harness is
   *  removed from the registry — the HarnessesStore should invoke this. */
  async dispose(): Promise<void> {
    if (this.#client) {
      await this.#client.stop().catch(() => {});
      this.#client = null;
    }
  }
}

function buildPromptFromMessages(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      lines.push(m.content);
    } else if (m.role === "assistant" && m.content) {
      lines.push(`[Prior assistant turn]\n${m.content}`);
    } else if (m.role === "tool" && m.content) {
      lines.push(`[Tool result for ${m.toolCallId}]\n${m.content}`);
    }
  }
  return lines.join("\n\n");
}

function readToolName(it: CodexItem): string {
  if (it.type !== "ToolUse") return "tool";
  const named = it as { name?: string; tool?: string };
  return named.name ?? named.tool ?? "tool";
}

function readToolInput(it: CodexItem): unknown {
  if (it.type !== "ToolUse") return null;
  const t = it as { input?: unknown; arguments?: unknown };
  return t.input ?? t.arguments ?? null;
}

function readToolOutput(it: CodexItem): string | null {
  if (it.type !== "ToolUse") return null;
  const t = it as { output?: unknown };
  if (typeof t.output === "string") return t.output;
  if (t.output && typeof t.output === "object") {
    try {
      return JSON.stringify(t.output);
    } catch {
      return null;
    }
  }
  return null;
}

interface TokenUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
  inputTokenDetails: {
    noCacheTokens: number | undefined;
    cacheReadTokens: number | undefined;
    cacheWriteTokens: number | undefined;
  };
  outputTokenDetails: {
    textTokens: number | undefined;
    reasoningTokens: number | undefined;
  };
}

function extractUsage(msg: CodexEventMsg): TokenUsage | null {
  const m = msg as {
    info?: {
      total_token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
        reasoning_output_tokens?: number;
        total_tokens?: number;
      };
    };
    last_token_usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  const totals = m.info?.total_token_usage;
  if (!totals) return null;
  return {
    inputTokens: totals.input_tokens,
    outputTokens: totals.output_tokens,
    totalTokens: totals.total_tokens,
    inputTokenDetails: {
      noCacheTokens:
        typeof totals.input_tokens === "number" &&
        typeof totals.cached_input_tokens === "number"
          ? Math.max(0, totals.input_tokens - totals.cached_input_tokens)
          : undefined,
      cacheReadTokens: totals.cached_input_tokens,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: totals.output_tokens,
      reasoningTokens: totals.reasoning_output_tokens,
    },
  };
}

function emptyUsage(): TokenUsage {
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
