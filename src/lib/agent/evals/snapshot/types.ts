// Wire shape for a captured orchestrator conversation. Produced by
// `capture.ts` (reads the Tauri-managed SQLite) and consumed by
// `serialise.ts` (writes a TS fixture under `fixtures/snapshots/`).

import type { UIChatTurn } from "$lib/types/chat";
import type { ChunkRow, RunSummary } from "$lib/types/run";
import type { AdapterConfig } from "$lib/types/adapter";

export interface CapturedSnapshot {
  capturedAt: string;
  conversationId: string;
  /** Conversation title at capture time, used for the fixture file slug. */
  conversationTitle: string | null;
  messages: UIChatTurn[];
  runs: RunSummary[];
  /** Chunks grouped by runId. Empty entries are dropped before
   *  serialisation. */
  runChunks: Record<string, ChunkRow[]>;
  /** Captured at the same instant as the messages — preserves the system
   *  prompt the model actually saw if the user had customised it.
   *  `null` means "use the default prompt". */
  orchestratorPromptOverride: string | null;
  delegatePromptOverride: string | null;
  /** Adapter configs as captured from settings, with credentials stripped.
   *  Used to reconstruct the "Available delegates" roster the model saw. */
  adapterConfigs: AdapterConfig[];
  /** Recorded delegate outputs keyed by canonicalised delegate_task input.
   *  When the orchestrator delegates during replay, the mock adapter
   *  returns the recorded result instead of contacting an external model. */
  recordedDelegateResponses: Record<string, RecordedDelegateResponse>;
}

export interface RecordedDelegateResponse {
  /** Plain text the delegate concluded with — what shows up in the
   *  orchestrator's tool_result. */
  reply: string;
  status: RunSummary["status"];
  filesChanged: string[];
  durationMs: number;
  adapterName: string | null;
  adapterType: string | null;
}

export interface CaptureOptions {
  /** Override the SQLite file path. Defaults to the Tauri-managed location
   *  for `io.github.desktop-oss`. */
  dbPath?: string;
  /** Which conversation to capture. Defaults to the singleton
   *  orchestrator conversation. */
  conversationId?: string;
  /** Truncate messages to those created strictly before this ISO timestamp.
   *  Useful when you want the seeded history to end right before the bad
   *  turn — then the replay scenario re-runs the new user message via
   *  the PROMPT env var. */
  before?: string;
  /** Max messages to capture (most recent N). */
  limit?: number;
}
