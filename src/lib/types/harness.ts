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

/** The delegation *kind* of a harness — the axis the orchestrator reasons
 *  about when matching a task to the right worker.
 *
 *  - `sealed`: a complete coding/computer agent with its own loop, system
 *    prompt, and file/shell tools. You hand it a self-contained task brief;
 *    you cannot reprogram its identity. Superb for code, wrong for "be a
 *    tutor".
 *  - `general`: a raw model whose entire prompt we control, so a delegate
 *    can be given *any* persona — a tutor, a critic, a researcher, a
 *    planner — authored per-spawn by the orchestrator.
 *
 *  Distinct from `isDelegateOnlyType`, which is an *orchestrator-capability*
 *  axis. Today the two coincide, but they answer different questions: a
 *  sealed agent could in principle drive the orchestrator seat (the
 *  claude-code SDK is the future path), so the concepts are kept separate
 *  rather than folded together. */
export type HarnessKind = "sealed" | "general";

export function harnessKind(type: HarnessType): HarnessKind {
  switch (type) {
    case "anthropic":
    case "openai-compatible":
      return "general";
    case "claude-code":
    case "codex":
    case "cursor":
      return "sealed";
    default: {
      const exhaustive: never = type;
      throw new Error(`Unknown harness type: ${String(exhaustive)}`);
    }
  }
}

/** One-line capability descriptions per kind, woven into the delegate
 *  roster the orchestrator sees each turn (see `buildDelegateRoster` in
 *  `agent/loop.ts`). This is product surface — the wording steers which
 *  worker the orchestrator reaches for, so keep it concrete. */
export const HARNESS_KIND_DESCRIPTIONS: Record<HarnessKind, string> = {
  sealed:
    "sealed coding agent — brings its own file-editing and shell tools and a fixed internal identity. Hand it a precise, self-contained task brief (best for writing/refactoring code, running commands, computer work). You cannot give it a persona; any `role` you pass is folded into the brief as best-effort framing, not a true identity.",
  general:
    "general model — no built-in tools, but you author its entire identity via the `role` field at spawn time. Reach for this whenever the work is a persona rather than a code change: a tutor, a researcher, a critic, a planner, a domain expert. This is how you run non-coding delegations.",
};

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
