// Cursor harness — runs the official `@cursor/sdk` in a bundled
// Node/Bun sidecar and surfaces its event stream as a delegate.
//
// Implementation choice (per "Harness conventions" in CLAUDE.md): the
// SDK transport is preferred over wrapping the `cursor-agent` CLI
// binary. Calling `Agent.create()` / `agent.send()` directly:
//   - skips the ~40s cold-start tax that `cursor-agent -p` pays on
//     every invocation (workspace trust + auth verification + model
//     warmup), because the sidecar holds one Cursor `Agent` object
//     across the conversation.
//   - gives us typed `InteractionUpdate` deltas (token-by-token text,
//     tool-call lifecycle, thinking blocks) for free.
//   - exposes `agentId` so we can persist it via `onSessionInfo` and
//     pass it back as `resumeAgentId` on continuations.
//
// Auth: requires a `CURSOR_API_KEY` generated at Cursor Dashboard →
// Integrations → User API Keys. Stored in the per-harness keychain
// like every other harness's API key. The sidecar receives it as a
// field in the request JSON, not via env, so we don't leak it to
// the subprocess's parent environment.

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  HarnessConfig,
  HarnessType,
  ChatMessage,
  LLMHarness,
  ProbeResult,
  StreamChatParams,
} from "$lib/types/harness";
import type { ChatStreamPart } from "$lib/types/chat";

interface CliStreamEvent {
  event: "spawned" | "stdout" | "stderr" | "end" | "error";
  pid?: number;
  data?: string;
  code?: number | null;
  error?: string;
}

interface CursorAgentRuntime {
  binary: string;
  argsPrefix: string[];
  nativeBinDir: string | null;
  mode: "dev" | "prod";
}

interface RawRuntime {
  binary: string;
  args_prefix: string[];
  native_bin_dir: string | null;
  mode: "dev" | "prod";
}

/** Envelope shapes emitted by sidecar/cursor-agent/index.mjs. The
 *  sidecar wraps every yielded payload so the harness doesn't have to
 *  guess whether a line is a low-level `InteractionUpdate`, a higher-
 *  level `SDKMessage`, or a lifecycle marker. */
type SidecarEnvelope =
  | { kind: "agent_ready"; agent_id: string }
  | { kind: "delta"; update: InteractionUpdate }
  | { kind: "message"; message: SdkMessage }
  | {
      kind: "result";
      status: "finished" | "error" | "cancelled";
      result?: string;
      durationMs?: number;
    }
  | { kind: "error"; error: string };

/** Subset of `InteractionUpdate` variants we surface. The SDK exports
 *  ~15 update types; we only need text + tool-call lifecycle. Unknown
 *  variants are ignored — defensive against SDK additions. */
type InteractionUpdate =
  | { type: "text_delta"; text: string; [k: string]: unknown }
  | {
      type: "tool_call_started";
      callId?: string;
      call_id?: string;
      toolName?: string;
      tool_name?: string;
      args?: unknown;
      [k: string]: unknown;
    }
  | {
      type: "tool_call_completed";
      callId?: string;
      call_id?: string;
      toolName?: string;
      tool_name?: string;
      args?: unknown;
      result?: unknown;
      status?: "completed" | "error";
      error?: string;
      [k: string]: unknown;
    }
  | { type: string; [k: string]: unknown };

/** Subset of `SDKMessage` variants. We use the message stream as a
 *  fallback for tool-call envelopes (in case the delta path is missing
 *  them on a given SDK version) and for surfacing init / status info. */
type SdkMessage =
  | { type: "system"; subtype?: "init"; agent_id: string; run_id: string }
  | {
      type: "tool_call";
      call_id: string;
      name: string;
      status: "running" | "completed" | "error";
      args?: unknown;
      result?: unknown;
    }
  | { type: string; [k: string]: unknown };

export class CursorHarness implements LLMHarness {
  readonly type: HarnessType = "cursor";
  readonly id: string;
  readonly name: string;
  readonly config: HarnessConfig;
  readonly #getApiKey: () => Promise<string | null>;

  constructor(
    config: HarnessConfig,
    deps: { getApiKey: () => Promise<string | null> },
  ) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.#getApiKey = deps.getApiKey;
  }

  async *streamChat(
    params: StreamChatParams,
  ): AsyncIterable<ChatStreamPart> {
    yield { type: "start" };
    yield { type: "start-step", request: {}, warnings: [] };

    const apiKey = await this.#getApiKey();
    if (!apiKey) {
      yield {
        type: "error",
        error:
          "Cursor harness has no API key set. Generate one at Cursor Dashboard → Integrations → User API Keys and add it in Settings.",
      };
      return;
    }

    let runtime: CursorAgentRuntime;
    try {
      const raw = await invoke<RawRuntime>("resolve_cursor_agent_runtime");
      runtime = {
        binary: raw.binary,
        argsPrefix: raw.args_prefix,
        nativeBinDir: raw.native_bin_dir,
        mode: raw.mode,
      };
    } catch (err) {
      yield {
        type: "error",
        error:
          err instanceof Error
            ? `Cursor SDK sidecar unavailable: ${err.message}`
            : `Cursor SDK sidecar unavailable: ${String(err)}`,
      };
      return;
    }

    const request = {
      prompt: buildPromptFromMessages(params.messages, params.systemPrompt),
      options: {
        apiKey,
        // Per-call override (from `StreamChatParams.model`) wins over
        // the harness's configured default — lets the orchestrator
        // pick a different Cursor model per delegate spawn (composer-2
        // for fast edits, gpt-5.3-codex-high for hard refactors, etc.).
        ...((params.model ?? this.config.model)
          ? { model: params.model ?? this.config.model }
          : {}),
        // Workspace cwd is intentionally NOT set at harness-config
        // level — the orchestrator picks per-delegation cwd via the
        // delegate_task tool. See the "Per-delegation model +
        // workspace" backlog item.
        ...(params.resumeSessionId
          ? { resumeAgentId: params.resumeSessionId }
          : {}),
      },
    };

    type InternalChunk = ChatStreamPart | { type: "__done" };
    const queue: InternalChunk[] = [];
    let pendingResolve: ((value: void) => void) | null = null;
    const push = (chunk: InternalChunk) => {
      queue.push(chunk);
      pendingResolve?.();
      pendingResolve = null;
    };
    const pushPublic = (chunk: ChatStreamPart) => push(chunk);
    const waitForChunk = () =>
      new Promise<void>((resolve) => {
        if (queue.length > 0) resolve();
        else pendingResolve = resolve;
      });

    const textId = "text-0";
    let textStarted = false;
    const startTextIfNeeded = () => {
      if (!textStarted) {
        textStarted = true;
        pushPublic({ type: "text-start", id: textId });
      }
    };
    const announcedTools = new Set<string>();
    const announceTool = (id: string, name: string, input: unknown) => {
      if (announcedTools.has(id)) return;
      announcedTools.add(id);
      pushPublic({
        type: "tool-input-start",
        id,
        toolName: name,
        dynamic: true,
      });
      pushPublic({
        type: "tool-call",
        toolCallId: id,
        toolName: name,
        input: input ?? {},
        dynamic: true,
      });
    };

    let stdoutBuf = "";
    let finishEmitted = false;
    let errorEmitted = false;
    let sessionInfoEmitted = false;

    const handleEnvelope = (env: SidecarEnvelope) => {
      switch (env.kind) {
        case "agent_ready": {
          if (!sessionInfoEmitted && env.agent_id) {
            sessionInfoEmitted = true;
            try {
              params.onSessionInfo?.({ sessionId: env.agent_id });
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn("[cursor] onSessionInfo callback threw:", err);
            }
          }
          return;
        }
        case "delta": {
          const u = env.update;
          if (u.type === "text_delta" && typeof u.text === "string" && u.text) {
            startTextIfNeeded();
            pushPublic({ type: "text-delta", id: textId, text: u.text });
            return;
          }
          if (u.type === "tool_call_started") {
            const id = readToolId(u);
            if (!id) return;
            const name = readToolName(u);
            announceTool(id, name, u.args);
            return;
          }
          if (u.type === "tool_call_completed") {
            const id = readToolId(u);
            if (!id) return;
            const name = readToolName(u);
            announceTool(id, name, u.args);
            if (u.status === "error") {
              pushPublic({
                type: "tool-error",
                toolCallId: id,
                toolName: name,
                input: u.args ?? {},
                error: u.error ?? "Tool errored",
                dynamic: true,
              });
            } else {
              pushPublic({
                type: "tool-result",
                toolCallId: id,
                toolName: name,
                input: u.args ?? {},
                output: stringifyOutput(u.result),
                dynamic: true,
              });
            }
            return;
          }
          // Ignored update types: thinking_*, summary_*, token_*,
          // shell_output_*, turn_ended, user_message_appended,
          // partial_tool_call. Add cases here if a future delta type
          // needs surfacing.
          return;
        }
        case "message": {
          // Surface tool calls from the SDKMessage stream as a fallback —
          // covers SDK versions where deltas don't include tool_call_*.
          const m = env.message;
          if (m.type === "tool_call") {
            const id = (m as { call_id?: string }).call_id;
            const name = (m as { name?: string }).name ?? "tool";
            if (!id) return;
            announceTool(id, name, (m as { args?: unknown }).args);
            if (m.status === "completed") {
              pushPublic({
                type: "tool-result",
                toolCallId: id,
                toolName: name,
                input: (m as { args?: unknown }).args ?? {},
                output: stringifyOutput((m as { result?: unknown }).result),
                dynamic: true,
              });
            } else if (m.status === "error") {
              pushPublic({
                type: "tool-error",
                toolCallId: id,
                toolName: name,
                input: (m as { args?: unknown }).args ?? {},
                error: "Tool call failed",
                dynamic: true,
              });
            }
          }
          return;
        }
        case "result": {
          if (env.status === "error") {
            errorEmitted = true;
            pushPublic({
              type: "error",
              error: `Cursor run failed${env.result ? `: ${env.result}` : ""}`,
            });
          }
          // Status `finished` / `cancelled` — no extra event; the
          // wrapping `finish` will fire from the end handler.
          return;
        }
        case "error": {
          errorEmitted = true;
          pushPublic({ type: "error", error: `Cursor: ${env.error}` });
          return;
        }
      }
    };

    const channel = new Channel<CliStreamEvent>();
    channel.onmessage = (evt) => {
      if (evt.event === "spawned") {
        // eslint-disable-next-line no-console
        console.debug(`[cursor] spawned pid=${evt.pid} mode=${runtime.mode}`);
      } else if (evt.event === "stdout" && typeof evt.data === "string") {
        stdoutBuf += evt.data;
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line.trim()) continue;
          let env: SidecarEnvelope;
          try {
            env = JSON.parse(line) as SidecarEnvelope;
          } catch {
            // eslint-disable-next-line no-console
            console.warn("[cursor] non-JSON stdout:", line.slice(0, 200));
            continue;
          }
          handleEnvelope(env);
        }
      } else if (evt.event === "stderr" && typeof evt.data === "string") {
        // eslint-disable-next-line no-console
        console.debug(`[cursor] stderr: ${evt.data.trim()}`);
      } else if (evt.event === "end") {
        if (stdoutBuf.trim()) {
          try {
            handleEnvelope(JSON.parse(stdoutBuf) as SidecarEnvelope);
          } catch {
            // ignore trailing garbage
          }
          stdoutBuf = "";
        }
        if (textStarted) {
          pushPublic({ type: "text-end", id: textId });
        }
        if (!finishEmitted) {
          finishEmitted = true;
          pushPublic({
            type: "finish",
            finishReason: errorEmitted ? "error" : "stop",
            rawFinishReason: undefined,
            totalUsage: emptyUsage(),
          });
        }
        push({ type: "__done" });
      } else if (evt.event === "error") {
        if (!errorEmitted) {
          errorEmitted = true;
          pushPublic({
            type: "error",
            error: evt.error ?? "Cursor sidecar failed",
          });
        }
        push({ type: "__done" });
      }
    };

    const env: Record<string, string> = {};
    if (runtime.nativeBinDir) {
      // Hand the SDK absolute paths to its platform-specific helpers
      // in prod, where the @cursor/sdk-<platform> node_modules layout
      // isn't adjacent to the compiled sidecar binary.
      env.CURSOR_SDK_NATIVE_BIN_DIR = runtime.nativeBinDir;
    }

    invoke<void>("cli_stream", {
      binary: runtime.binary,
      args: [...runtime.argsPrefix, JSON.stringify(request)],
      env,
      onEvent: channel,
    }).catch((err) => {
      const dep = runtime.mode === "dev" ? "Node.js" : "the bundled sidecar binary";
      const msg =
        err instanceof Error
          ? `Failed to spawn Cursor SDK sidecar: ${err.message}. (${dep})`
          : `Failed to spawn Cursor SDK sidecar: ${String(err)}. (${dep})`;
      if (!errorEmitted) {
        errorEmitted = true;
        pushPublic({ type: "error", error: msg });
      }
      push({ type: "__done" });
    });

    while (true) {
      if (queue.length === 0) await waitForChunk();
      const next = queue.shift();
      if (!next) continue;
      if (next.type === "__done") return;
      yield next;
    }
  }

  async probe(): Promise<ProbeResult> {
    try {
      const raw = await invoke<RawRuntime>("resolve_cursor_agent_runtime");
      const hasKey = (await this.#getApiKey()) !== null;
      return {
        ok: hasKey,
        message: hasKey
          ? `Cursor SDK sidecar present (${raw.mode})`
          : "Cursor SDK sidecar present but no API key set",
      };
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error ? err.message : "Cursor SDK sidecar unavailable",
      };
    }
  }
}

function buildPromptFromMessages(
  messages: ChatMessage[],
  systemPrompt: string,
): string {
  // The Cursor SDK doesn't separate system from user — we prepend the
  // delegate framing as the first segment so the agent's instructions
  // come through.
  const lines: string[] = [];
  if (systemPrompt && systemPrompt.trim()) {
    lines.push(systemPrompt.trim());
    lines.push("");
  }
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

function readToolId(u: Record<string, unknown>): string | null {
  const v = u.callId ?? u.call_id;
  return typeof v === "string" && v ? v : null;
}

function readToolName(u: Record<string, unknown>): string {
  const v = u.toolName ?? u.tool_name ?? u.name;
  return typeof v === "string" && v ? v : "tool";
}

function stringifyOutput(out: unknown): string {
  if (typeof out === "string") return out;
  if (out === null || out === undefined) return "";
  try {
    return JSON.stringify(out);
  } catch {
    return String(out);
  }
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
