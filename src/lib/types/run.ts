// Wire types for delegate sub-agent runs. The orchestrator spawns these via
// the `delegate_task` tool; the cockpit panel renders the streamed output.

export type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED";

export type ChunkKind =
  | "user_message"
  | "assistant_text"
  | "tool_call"
  | "tool_result"
  | "thinking"
  | "stderr"
  | "system";

export interface RunSummary {
  id: string;
  conversationId: string;
  parentMessageId?: string;
  toolCallId?: string;
  /** Optional label assigned by the orchestrator at spawn time. Used by
   *  message_delegate and get_delegate_history to reference a run by name
   *  instead of its generated run ID. */
  name?: string;
  title: string;
  status: RunStatus;
  delegateHarnessId?: string;
  delegateType?: string;
  exitCode?: number;
  summary?: string;
  /** Rolling compressed summary of conversation turns older than the last
   *  CONTEXT_TAIL messages. Null until the run exceeds SUMMARY_THRESHOLD
   *  messages. Prepended as synthetic prior context when continuing a run
   *  to keep harness calls within a predictable token budget. */
  contextSummary?: string;
  /** Harness-provided opaque session token captured on the first turn,
   *  passed back as `resumeSessionId` on continuation. Set by the
   *  claude-code harness (SDK's `session_id`) and the codex harness
   *  (`threadId` from the MCP `codex` tool). Raw-LLM harnesses leave
   *  this undefined. */
  harnessSessionId?: string;
  filesChanged?: string[];
  createdAt: string;
  completedAt?: string;
}

export interface ChunkRow {
  id?: number;
  runId: string;
  seq: number;
  kind: ChunkKind;
  text: string;
  createdAt: string;
}

export interface DelegateResult {
  runId: string;
  status: RunStatus;
  summary: string;
  filesChanged: string[];
  exitCode?: number;
  durationMs: number;
  /** Which harness actually executed this run. Surfaced in the UI so it's
   *  unambiguous whether the delegate landed on the configured local model
   *  or fell back to the orchestrator harness. */
  harness?: {
    id: string;
    name: string;
    type: string;
  };
}
