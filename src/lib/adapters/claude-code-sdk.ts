// Claude Code adapter — runs the official `@anthropic-ai/claude-agent-sdk`
// in a bundled Node/Bun sidecar and surfaces its event stream as a delegate.
//
// Implementation choice (per "Adapter conventions" in CLAUDE.md): the SDK
// transport is preferred over wrapping the `claude` CLI binary. Calling
// query() directly gives us typed `SDKMessage` events, graceful
// cancellation, and first-class permission gating via `canUseTool` —
// none of which subprocess output scraping can match.
//
// What it produces:
//   With `systemPrompt: { preset: 'claude_code' }` and
//   `tools: { preset: 'claude_code' }`, the SDK runs the EXACT same
//   framework as Claude Code itself — same system prompt, same default
//   tool set (Read/Edit/Write/Bash/Glob/Grep/Task/WebFetch/TodoWrite/…),
//   same dynamic sections (cwd / git status / `~/.claude/CLAUDE.md` /
//   project `CLAUDE.md`). The delegate behaves identically to running
//   `claude` in a terminal, just inside the orchestrator's run surface.
//
// Architecture:
//   TS adapter → cli_stream (Rust) → `node sidecar/claude-agent/index.mjs <req>`
//     → SDK query() → NDJSON of SDKMessage to stdout → parsed back here.

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AdapterConfig,
  AdapterType,
  ChatMessage,
  LLMAdapter,
  ProbeResult,
  StreamChatParams,
} from "$lib/types/adapter";
import type { ChatStreamPart } from "$lib/types/chat";

interface CliStreamEvent {
  event: "spawned" | "stdout" | "stderr" | "end" | "error";
  pid?: number;
  data?: string;
  code?: number | null;
  error?: string;
}

interface ClaudeAgentRuntime {
  binary: string;
  argsPrefix: string[];
  claudeBinaryPath: string | null;
  mode: "dev" | "prod";
}

interface RawRuntime {
  binary: string;
  args_prefix: string[];
  claude_binary_path: string | null;
  mode: "dev" | "prod";
}

/** Subset of @anthropic-ai/claude-agent-sdk SDKMessage we care about.
 *  See node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts for the full
 *  union — we only parse the events that map onto our ChatStreamPart
 *  output. Unknown `type` values are silently ignored.
 *
 *  Every SDKMessage carries a `session_id` (set by the SDK after the
 *  first `system/init` message is emitted). We capture it once per
 *  stream and forward it via `onSessionInfo` so the caller can store it
 *  on the run row for later `resumeSessionId` continuations. */
interface SDKMessageWithSession {
  session_id?: string;
}

interface SDKAssistantMessage extends SDKMessageWithSession {
  type: "assistant";
  message: {
    content?: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
    >;
  };
  error?: string;
}

/** Tool results land on `SDKUserMessage`s — the SDK frames them as
 *  user-role messages even though the orchestrator didn't author them.
 *  The `tool_use_id` correlates back to the matching `tool_use` block
 *  in an earlier `SDKAssistantMessage`; we use the
 *  `toolNamesById` map below to recover the tool name for the
 *  `tool-result` ChatStreamPart event (since tool_result blocks don't
 *  carry the name themselves). */
interface SDKUserMessage extends SDKMessageWithSession {
  type: "user";
  message: {
    content?: Array<
      | { type: "text"; text: string }
      | {
          type: "tool_result";
          tool_use_id: string;
          content?:
            | string
            | Array<{ type: string; text?: string; [k: string]: unknown }>;
          is_error?: boolean;
        }
    >;
  };
}

interface SDKResultMessageSuccess extends SDKMessageWithSession {
  type: "result";
  subtype: "success";
  result?: string;
}

interface SDKResultMessageError extends SDKMessageWithSession {
  type: "result";
  subtype:
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries";
  errors?: string[];
}

interface SDKErrorPassthrough extends SDKMessageWithSession {
  type: "error";
  error: string;
}

type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessageSuccess
  | SDKResultMessageError
  | SDKErrorPassthrough
  | ({ type: string } & SDKMessageWithSession & { [key: string]: unknown });

export class ClaudeCodeSDKAdapter implements LLMAdapter {
  readonly type: AdapterType = "claude-code";
  readonly id: string;
  readonly name: string;
  readonly config: AdapterConfig;

  constructor(config: AdapterConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
  }

  async *streamChat(
    params: StreamChatParams,
  ): AsyncIterable<ChatStreamPart> {
    yield { type: "start" };
    yield { type: "start-step", request: {}, warnings: [] };

    let runtime: ClaudeAgentRuntime;
    try {
      const raw = await invoke<RawRuntime>("resolve_claude_agent_runtime");
      runtime = {
        binary: raw.binary,
        argsPrefix: raw.args_prefix,
        claudeBinaryPath: raw.claude_binary_path,
        mode: raw.mode,
      };
    } catch (err) {
      yield {
        type: "error",
        error:
          err instanceof Error
            ? `Claude Code SDK sidecar unavailable: ${err.message}`
            : "Claude Code SDK sidecar unavailable.",
      };
      return;
    }

    // Per-call override wins over the adapter's configured default.
    const request = buildRequest(
      params,
      params.model ?? this.config.model,
    );
    const requestJson = JSON.stringify(request);
    // eslint-disable-next-line no-console
    console.debug(
      `[claude-code-sdk] invoking sidecar (mode=${runtime.mode})`,
      runtime.binary,
      `request=${requestJson.length} chars`,
    );

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

    // Text segmentation. The Claude Code SDK runs an agent loop and
    // emits ONE `SDKAssistantMessage` per loop iteration, each
    // containing the COMPLETE text for that iteration plus any
    // tool_use blocks. To make the run-detail page render the
    // transcript with natural separation between iterations (and to
    // interleave tool cards properly), we start a fresh text segment
    // (with a new textId) whenever:
    //   - A tool_use block needs to be surfaced between text blocks
    //   - A new SDKAssistantMessage arrives after a previous one
    //     finished (so each iteration's text becomes its own
    //     assistant_text chunk in the DB)
    // This also fixes the "wall of text" rendering bug where multiple
    // iterations' text got jammed into one chunk with no separator.
    let textCounter = 0;
    let currentTextId = `text-${textCounter}`;
    let textStarted = false;
    const startTextIfNeeded = () => {
      if (!textStarted) {
        textStarted = true;
        pushPublic({ type: "text-start", id: currentTextId });
      }
    };
    const endCurrentTextIfOpen = () => {
      if (!textStarted) return;
      pushPublic({ type: "text-end", id: currentTextId });
      textStarted = false;
      textCounter += 1;
      currentTextId = `text-${textCounter}`;
    };

    // Tool-call lifecycle. `tool_use` blocks in `SDKAssistantMessage`
    // carry `{id, name, input}` and arrive BEFORE the matching
    // `tool_result` block in a subsequent `SDKUserMessage`. The
    // tool_result block only carries `tool_use_id` (no name), so we
    // remember each tool's name as we see the tool_use and look it up
    // when the tool_result lands.
    const toolNamesById = new Map<string, string>();

    let stdoutBuf = "";
    let finishEmitted = false;
    let errorEmitted = false;
    let sessionInfoEmitted = false;

    const handleSdkMessage = (msg: SDKMessage) => {
      // The SDK stamps every message with `session_id` once the system
      // init has fired. Capture it once and forward — the caller stores
      // it on the run row so subsequent turns can `resume` the session.
      if (
        !sessionInfoEmitted &&
        typeof (msg as SDKMessageWithSession).session_id === "string"
      ) {
        sessionInfoEmitted = true;
        const sid = (msg as SDKMessageWithSession).session_id as string;
        try {
          params.onSessionInfo?.({ sessionId: sid });
        } catch (err) {
          // Caller's callback errors must never abort the stream.
          // eslint-disable-next-line no-console
          console.warn("[claude-code-sdk] onSessionInfo callback threw:", err);
        }
      }

      if (msg.type === "assistant") {
        const am = msg as SDKAssistantMessage;
        if (am.error) {
          errorEmitted = true;
          pushPublic({
            type: "error",
            error: `Claude Code SDK error: ${am.error}`,
          });
          return;
        }
        // Start a fresh text segment per assistant message so each
        // agent-loop iteration becomes its own assistant_text chunk
        // with natural separation in the rendered transcript. This is
        // the primary fix for the "wall of text" bug.
        endCurrentTextIfOpen();
        for (const block of am.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            startTextIfNeeded();
            pushPublic({
              type: "text-delta",
              id: currentTextId,
              text: block.text,
            });
          } else if (block.type === "tool_use") {
            // Surface the tool call as a proper tool card. Close any
            // open text segment first so the rendered transcript reads
            // [text] → [tool card] → [text] rather than mixing them
            // into one part. Cache the tool name for the matching
            // tool_result that will arrive on a later SDKUserMessage.
            endCurrentTextIfOpen();
            toolNamesById.set(block.id, block.name);
            pushPublic({
              type: "tool-input-start",
              id: block.id,
              toolName: block.name,
              dynamic: true,
            });
            pushPublic({
              type: "tool-call",
              toolCallId: block.id,
              toolName: block.name,
              input: block.input ?? {},
              dynamic: true,
            });
          }
        }
      } else if (msg.type === "user") {
        // The SDK frames tool-execution results as user-role messages.
        // Iterate the content for `tool_result` blocks and emit
        // matching `tool-result` events so the run-detail page can
        // attach the output to the tool card we surfaced earlier.
        // Free-form `text` parts in user messages (rare in
        // non-interactive runs) are ignored — they're not user input
        // that the orchestrator authored, just internal SDK framing.
        const um = msg as SDKUserMessage;
        for (const block of um.message?.content ?? []) {
          if (block.type !== "tool_result") continue;
          const toolName = toolNamesById.get(block.tool_use_id) ?? "tool";
          const output =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((b) =>
                      typeof b === "object" && "text" in b && typeof b.text === "string"
                        ? b.text
                        : JSON.stringify(b),
                    )
                    .join("\n")
                : "";
          // Fold tool errors into the regular tool-result path with an
          // [Error] marker on the output. delegate.ts persists tool
          // events under the `tool_call` / `tool_result` chunk kinds
          // and has no `tool_error` kind; using tool-result keeps the
          // event on the persistence path so it survives a reload and
          // appears in the run-detail page's history. The marker
          // makes the failure visible in the rendered tool card.
          const renderedOutput = block.is_error
            ? `[Error] ${output || "Tool execution failed"}`
            : output;
          pushPublic({
            type: "tool-result",
            toolCallId: block.tool_use_id,
            toolName,
            input: {},
            output: renderedOutput,
            dynamic: true,
          });
        }
      } else if (msg.type === "result") {
        if ("subtype" in msg && msg.subtype === "success") {
          // Already streamed via assistant messages — nothing to add.
        } else if ("subtype" in msg) {
          const errMsg = msg as SDKResultMessageError;
          const errs = errMsg.errors?.length
            ? errMsg.errors.join("; ")
            : errMsg.subtype;
          errorEmitted = true;
          pushPublic({
            type: "error",
            error: `Claude Code SDK ${errMsg.subtype}: ${errs}`,
          });
        }
      } else if (msg.type === "error") {
        const err = msg as SDKErrorPassthrough;
        errorEmitted = true;
        pushPublic({
          type: "error",
          error: err.error || "Claude Code SDK sidecar errored",
        });
      }
    };

    const channel = new Channel<CliStreamEvent>();
    channel.onmessage = (evt) => {
      if (evt.event === "spawned") {
        // eslint-disable-next-line no-console
        console.debug(`[claude-code-sdk] spawned pid=${evt.pid}`);
      } else if (evt.event === "stdout" && typeof evt.data === "string") {
        stdoutBuf += evt.data;
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            handleSdkMessage(JSON.parse(line) as SDKMessage);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              "[claude-code-sdk] failed to parse SDK message:",
              line.slice(0, 200),
              err,
            );
          }
        }
      } else if (evt.event === "stderr" && typeof evt.data === "string") {
        // The sidecar writes operational warnings to stderr (e.g. auth
        // hints). Surface them to the dev console; don't pollute the
        // chat stream with them.
        // eslint-disable-next-line no-console
        console.debug(`[claude-code-sdk] stderr: ${evt.data.trim()}`);
      } else if (evt.event === "end") {
        if (stdoutBuf.trim()) {
          try {
            handleSdkMessage(JSON.parse(stdoutBuf) as SDKMessage);
          } catch {
            // ignore trailing garbage
          }
          stdoutBuf = "";
        }
        if (textStarted) {
          pushPublic({ type: "text-end", id: currentTextId });
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
            error: evt.error ?? "Claude Code SDK sidecar failed",
          });
        }
        push({ type: "__done" });
      }
    };

    const env: Record<string, string> = {
      CLAUDE_AGENT_SDK_CLIENT_APP: "desktop-oss",
    };
    if (runtime.claudeBinaryPath) {
      env.CLAUDE_AGENT_SDK_EXECUTABLE_PATH = runtime.claudeBinaryPath;
    }

    const invokePromise = invoke<void>("cli_stream", {
      binary: runtime.binary,
      args: [...runtime.argsPrefix, requestJson],
      env,
      onEvent: channel,
    }).catch((err) => {
      const dependency =
        runtime.mode === "dev" ? "Node.js" : "the bundled sidecar binary";
      const msg =
        err instanceof Error
          ? `Failed to spawn Claude Code SDK sidecar: ${err.message}. (${dependency})`
          : `Failed to spawn Claude Code SDK sidecar. (${dependency})`;
      if (!errorEmitted) {
        errorEmitted = true;
        pushPublic({ type: "error", error: msg });
      }
      push({ type: "__done" });
    });
    void invokePromise;

    while (true) {
      if (queue.length === 0) await waitForChunk();
      const next = queue.shift();
      if (!next) continue;
      if (next.type === "__done") return;
      yield next;
    }
  }

  async probe(): Promise<ProbeResult> {
    // Cheap probe — just confirm the sidecar resolver returns valid
    // paths. A full round-trip via cli_stream + SDK init would be more
    // authoritative but takes seconds; the health pill wants something
    // synchronous-feeling. Auth failures still surface clearly on the
    // first real run.
    try {
      const raw = await invoke<RawRuntime>("resolve_claude_agent_runtime");
      return {
        ok: true,
        message: `Claude Code SDK sidecar present (${raw.mode})`,
      };
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : "Claude Code SDK sidecar not installed",
      };
    }
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

interface SidecarRequest {
  /** The prompt string passed to query(). Composed from the messages
   *  array — the SDK handles its own conversation framing when we set
   *  systemPrompt via the preset. */
  prompt: string;
  options: {
    systemPrompt: {
      type: "preset";
      preset: "claude_code";
      append?: string;
    };
    tools: { type: "preset"; preset: "claude_code" };
    permissionMode: "bypassPermissions";
    maxTurns: number;
    cwd?: string;
    /** Optional model override. Passed straight to the SDK's `query()`
     *  options — when unset, the SDK falls back to whatever the user's
     *  Claude Code keychain entry resolves to (typically the latest
     *  Sonnet). */
    model?: string;
    /** When set, resumes the SDK session with this ID — the SDK loads
     *  the persisted session state (tool scratchpad, file checkpoints,
     *  conversation memory) and continues from the last assistant turn
     *  rather than starting cold. */
    resume?: string;
  };
}

function buildRequest(
  params: StreamChatParams,
  model: string | undefined,
): SidecarRequest {
  const append = params.systemPrompt.trim() || undefined;
  return {
    prompt: buildPromptFromMessages(params.messages),
    options: {
      // These three presets are what makes the adapter behave identically
      // to a `claude` CLI session: full system prompt (with dynamic
      // sections — cwd, git status, ~/.claude/CLAUDE.md, project
      // CLAUDE.md), full default tool set, no interactive permission
      // prompts. `append` layers our delegate framing on top of the
      // built-in Claude Code system prompt.
      systemPrompt: { type: "preset", preset: "claude_code", append },
      tools: { type: "preset", preset: "claude_code" },
      permissionMode: "bypassPermissions",
      maxTurns: 50,
      ...(model ? { model } : {}),
      ...(params.resumeSessionId ? { resume: params.resumeSessionId } : {}),
    },
  };
}

function buildPromptFromMessages(messages: ChatMessage[]): string {
  // Single-shot prompt — concatenate visible turns. The SDK's `query()`
  // also accepts an AsyncIterable<SDKUserMessage> for multi-turn use,
  // which is the upgrade path when we wire streamDelegateContinue
  // to keep the sidecar alive across turns.
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
