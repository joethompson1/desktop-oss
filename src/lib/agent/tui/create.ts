// Creation path for TUI-surface delegate runs (Plan 04), shared by the
// orchestrator's `delegate_task` (surface: "tui") and the user's "terminal
// agent" affordance. DB-only — the PTY itself is attached by the run page
// when the user opens it, via `tui/driver.ts`. Deliberately free of
// xterm / Tauri-channel imports so `tools.ts` (eval graph) can import it.

import type { LLMHarness } from "$lib/types/harness";
import { harnessKind } from "$lib/types/harness";
import { createRun } from "$lib/db/runs";
import { buildDelegateBrief } from "../delegate-prompt";

/** Settings key for the user's preferred surface when spawning a delegate
 *  on a terminal-capable harness without an explicit `surface` argument.
 *  Values: "gui" (default) | "tui". Read by delegate_task; written by
 *  Settings → Harnesses. */
export const DEFAULT_SURFACE_SETTING_KEY = "delegates.defaultSurface";

export interface CreateTuiRunInput {
  conversationId: string;
  harness: LLMHarness;
  /** Task brief. When set, it becomes the CLI's first prompt on the first
   *  terminal launch; when absent (user-opened blank terminal agent), the
   *  session starts idle. */
  task?: string;
  context?: string;
  filesOfInterest?: string[];
  name?: string;
  role?: string;
  workingDirectory?: string;
  parentMessageId?: string;
  toolCallId?: string;
  /** Pre-allocated run id (delegate_task pattern); generated when absent. */
  runId?: string;
}

/** Harness TYPES with a TUI story (session pinning + hooks + on-disk
 *  transcript). v1: Claude Code only — a clean capability gate, per the
 *  uniformity principle: harnesses either have the surface or don't.
 *  Single source of truth: every "supports a terminal?" check anywhere in
 *  the app goes through these two helpers, never a string literal. */
export function harnessTypeSupportsTui(type: string | undefined): boolean {
  return type === "claude-code";
}

export function harnessSupportsTui(harness: LLMHarness): boolean {
  return harnessTypeSupportsTui(harness.type);
}

/**
 * Create the run row for a TUI-surface delegate. Returns the run id. The
 * run stays PENDING until the user opens the terminal and the CLI's first
 * turn starts (hook relay flips it to RUNNING).
 */
export async function createTuiRun(input: CreateTuiRunInput): Promise<string> {
  if (!harnessSupportsTui(input.harness)) {
    throw new Error(
      `Harness "${input.harness.name}" (${input.harness.type}) has no terminal surface. TUI delegates require a claude-code harness.`,
    );
  }
  const runId =
    input.runId ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const brief = input.task
    ? buildDelegateBrief(
        {
          task: input.task,
          context: input.context,
          filesOfInterest: input.filesOfInterest,
          role: input.role,
          workingDirectory: input.workingDirectory,
        },
        harnessKind(input.harness.type),
      )
    : undefined;

  await createRun({
    id: runId,
    conversationId: input.conversationId,
    parentMessageId: input.parentMessageId,
    toolCallId: input.toolCallId,
    name: input.name,
    role: input.role,
    title: input.task
      ? truncateTitle(input.task)
      : "Terminal agent",
    delegateHarnessId: input.harness.id,
    delegateType: input.harness.type,
    surface: "tui",
    workdir: input.workingDirectory,
    tuiInitialPrompt: brief,
  });

  // Session identity is deliberately NOT pinned here: the driver mints and
  // persists it at first attach, where it can pick `--session-id` (fresh)
  // vs `--resume` (has history) correctly. Pinning now would make a
  // never-launched run look resumable — `--resume <uuid>` of a session
  // that never existed fails in the CLI.
  return runId;
}

function truncateTitle(task: string): string {
  const firstLine = task.split("\n")[0]?.trim() ?? "Terminal agent";
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine;
}
