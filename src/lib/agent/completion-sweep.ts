// Which finished delegate runs should wake the orchestrator with a
// "[Background delegate update]" notification, and which should be left alone.
//
// Pure (types only, no runes / DB / Tauri) so it stays unit-testable and
// node-importable — the interesting policy lives here; the DB query and the
// enqueue live in the orchestrator chat store factory (stores/chat.svelte.ts).

import type { RunStatus, RunSummary } from "$lib/types/run";

/** The states a run never leaves — the delegate is done, one way or another.
 *  PENDING/RUNNING are excluded (still in flight). */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Should the hydrate sweep enqueue a completion notification for this run?
 *
 * True iff the run has reached a terminal state, the orchestrator hasn't
 * already been told (`completionNotified`), and it is NOT currently a TUI
 * (interactive terminal) session.
 *
 * TUI policy — why `surface === "tui"` runs are excluded: a TUI run's
 * SUCCEEDED status means "the CLI finished the current turn and is idle,
 * waiting for the user's next prompt", NOT "the delegated task is done". The
 * user is driving that terminal hands-on, so it oscillates RUNNING ⇄ SUCCEEDED
 * every turn — treating each idle as a completion would spam the orchestrator
 * with premature "worker finished" notices for work the user is still doing.
 * The orchestrator can inspect a TUI delegate's progress at any time via
 * get_delegate_history; it does not fire-and-forget an interactive terminal
 * the way it does a headless (GUI) delegate. Headless delegates — the ones the
 * orchestrator actually awaits, and the ones markStaleRunsAbandoned cancels on
 * restart — carry surface `gui`/absent and so are always covered.
 */
export function shouldSweepNotify(run: RunSummary): boolean {
  if (run.completionNotified) return false;
  if (!isTerminalRunStatus(run.status)) return false;
  if (run.surface === "tui") return false;
  return true;
}

/** The runs from `runs` that qualify for a sweep notification, in input order
 *  (callers pass them oldest-first so the batched notification is chronological). */
export function selectSweepNotifications(
  runs: readonly RunSummary[],
): RunSummary[] {
  return runs.filter(shouldSweepNotify);
}
