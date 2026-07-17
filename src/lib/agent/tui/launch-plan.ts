// Pure launch-decision for a TUI session (Plan 04). Extracted from the
// driver so the riskiest branching — fresh vs resume, and WHERE the
// transcript mirror must start — is unit-testable without Tauri/xterm.
//
// The mirror-start rule matters more than it looks (review blocker on
// PR #25): a FRESH launch writes a brand-new transcript whose earliest
// entries exist nowhere else — for a task-spawned terminal the CLI
// auto-submits the brief immediately, racing the tail's first poll, so
// starting at EOF can silently drop the run's first turn. Fresh launches
// therefore mirror from offset 0 (the parser ignores meta lines), while
// resumes mirror from EOF because the fork-seeded history was already
// persisted by whichever driver produced it.

export interface LaunchPlanInput {
  /** Session id currently pinned on the run (may be replaced). */
  sessionId: string;
  hooksPath: string;
  /** Task brief awaiting first delivery (TUI-spawned runs only). */
  initialPrompt: string | null | undefined;
  /** Whether the pinned session has a recorded conversation on disk. */
  hasConversation: boolean;
  /** Mints a fresh session id (injected so tests stay deterministic). */
  mintSessionId: () => string;
}

export interface LaunchPlan {
  args: string[];
  /** Session id the launch will actually use (fresh mints replace a
   *  pinned id that has nothing to resume). */
  sessionId: string;
  /** True when the CLI starts a NEW session: mirror from offset 0.
   *  False for resumes: mirror from EOF (seeded history already
   *  persisted). */
  freshSession: boolean;
}

export function buildLaunchPlan(input: LaunchPlanInput): LaunchPlan {
  if (input.initialPrompt) {
    return {
      args: [
        "--session-id",
        input.sessionId,
        "--settings",
        input.hooksPath,
        input.initialPrompt,
      ],
      sessionId: input.sessionId,
      freshSession: true,
    };
  }
  if (input.hasConversation) {
    return {
      args: ["--resume", input.sessionId, "--settings", input.hooksPath],
      sessionId: input.sessionId,
      freshSession: false,
    };
  }
  // Nothing to resume — mint a NEW id: `--session-id` over an existing
  // (empty-but-created) session errors "already in use", and `--resume`
  // of a conversation-less session errors "no conversation found".
  const fresh = input.mintSessionId();
  return {
    args: ["--session-id", fresh, "--settings", input.hooksPath],
    sessionId: fresh,
    freshSession: true,
  };
}
