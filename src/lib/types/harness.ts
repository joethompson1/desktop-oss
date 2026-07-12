// Public surface for LLM harnesses. Each harness wraps a different way of
// talking to an LLM (Anthropic API, OpenAI-compatible HTTP, Claude Code
// agent SDK, Codex MCP server) and exposes a uniform streamChat() that
// yields the Vercel AI SDK's `TextStreamPart` events. The orchestrator
// only talks to the raw-LLM harnesses (Anthropic, OpenAI-compatible);
// Claude Code and Codex are delegate-only because they run their own
// internal agent loops.

import type { ChatStreamPart } from "./chat";

/** Brand-level harness identity. The internal type ID is intentionally
 *  brand-only (no `-sdk` / `-cli` suffixes) — each brand maps to a
 *  single canonical implementation strategy. See "Harness conventions"
 *  in CLAUDE.md. */
export type HarnessType =
  | "anthropic"
  | "openai-compatible"
  | "claude-code"
  | "codex"
  | "cursor";

/** True when a harness type can only run as a delegate, never as the
 *  orchestrator. These harnesses wrap full agent harnesses (Claude Code's
 *  SDK, Codex's MCP server, Cursor's SDK) — they don't expose the
 *  tools-in / typed-tool-call-events-out protocol the Vercel AI SDK
 *  orchestrator loop needs to drive. Authoritative source for the UI
 *  (hides "Set as orchestrator") and `buildOrchestratorModel` (returns
 *  null). Keep in sync with that function. */
export function isDelegateOnlyType(type: HarnessType): boolean {
  return type === "claude-code" || type === "codex" || type === "cursor";
}

export type AnthropicAuthMode = "api-key" | "account";

export interface HarnessConfig {
  id: string;
  type: HarnessType;
  name: string;
  /** Free-text role hint surfaced to the orchestrator in its "Available
   *  delegates" roster — helps the orchestrator pick the right delegate
   *  for a given task. E.g. "fast local coding model, no API cost" or
   *  "deep multi-step refactors via Claude Code CLI". */
  description?: string;
  model?: string;
  baseUrl?: string;
  authMode?: AnthropicAuthMode;
  /** When true, the Anthropic harness requests the 1M-context beta. */
  context1m?: boolean;
  /** Codex: name of a profile defined in `~/.codex/config.toml`. Passed
   *  to each `tools/call` as the `profile` argument. Lets one app-side
   *  harness route through any of the user's codex profiles (e.g. a
   *  local-Qwen profile vs a cloud-GPT profile). */
  codexProfile?: string;
  /** Codex: sandbox mode for tool execution. Defaults to
   *  `danger-full-access` to match the prior `codex-cli` behaviour. */
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  isOrchestratorDefault?: boolean;
  isDelegateDefault?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: unknown;
  }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface StreamChatParams {
  messages: ChatMessage[];
  systemPrompt: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Optional per-call model override. When set, the harness uses this
   *  model instead of `config.model` for this single call — used by
   *  the orchestrator when it wants to pick a specific model on a
   *  delegate spawn (e.g. "spawn Codex with gpt-5.5 for planning, then
   *  Codex with the local Qwen3 profile for implementation"). Harnesses
   *  that don't expose model selection (codex profile-only setups,
   *  claude-code-sdk's preset config) ignore this. */
  model?: string;
  /** Resume a prior harness session, when the harness supports session
   *  continuation. For the claude-code-sdk harness this maps to the
   *  SDK's `resume` option — the provider then restores the full session
   *  state (tool scratchpad, file checkpoints, conversation memory)
   *  instead of starting cold. Harnesses that don't support sessions
   *  ignore this. */
  resumeSessionId?: string;
  /** Invoked when the harness receives a session identifier from the
   *  underlying provider. The caller can persist this and feed it back
   *  via `resumeSessionId` on subsequent turns to keep the same
   *  provider-side session. Called at most once per `streamChat()`
   *  invocation, and only by harnesses that expose sessions (currently
   *  only claude-code-sdk). */
  onSessionInfo?: (info: { sessionId: string }) => void;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs?: number;
  message?: string;
}

export interface LLMHarness {
  id: string;
  name: string;
  type: HarnessType;
  config: HarnessConfig;
  streamChat(params: StreamChatParams): AsyncIterable<ChatStreamPart>;
  probe(): Promise<ProbeResult>;
}
