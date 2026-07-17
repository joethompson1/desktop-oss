// Unit tests for the hydrate-sweep run-filtering policy: which finished
// delegate runs wake the orchestrator, and — crucially — which don't (the
// no-duplicate guard and the TUI-oscillation exclusion). Runs under
// `npm run test:unit` (tsx --test).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isTerminalRunStatus,
  selectSweepNotifications,
  shouldSweepNotify,
  TERMINAL_RUN_STATUSES,
} from "./completion-sweep";
import type { RunStatus, RunSummary } from "$lib/types/run";

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run-1",
    conversationId: "conv-1",
    title: "task",
    status: "SUCCEEDED",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("terminal-status classification matches the union", () => {
  assert.equal(isTerminalRunStatus("SUCCEEDED"), true);
  assert.equal(isTerminalRunStatus("FAILED"), true);
  assert.equal(isTerminalRunStatus("TIMED_OUT"), true);
  assert.equal(isTerminalRunStatus("CANCELLED"), true);
  assert.equal(isTerminalRunStatus("PENDING"), false);
  assert.equal(isTerminalRunStatus("RUNNING"), false);
});

test("every terminal status sweep-notifies when un-notified and not TUI", () => {
  for (const status of TERMINAL_RUN_STATUSES) {
    assert.equal(
      shouldSweepNotify(run({ status })),
      true,
      `expected ${status} to notify`,
    );
  }
});

test("in-flight runs never sweep-notify", () => {
  for (const status of ["PENDING", "RUNNING"] as RunStatus[]) {
    assert.equal(shouldSweepNotify(run({ status })), false);
  }
});

test("already-notified runs never sweep-notify (no-duplicate guard)", () => {
  assert.equal(
    shouldSweepNotify(run({ status: "SUCCEEDED", completionNotified: true })),
    false,
  );
  // Even an abandoned (CANCELLED) run that was already announced stays silent.
  assert.equal(
    shouldSweepNotify(run({ status: "CANCELLED", completionNotified: true })),
    false,
  );
});

test("TUI-surface runs are excluded even when terminal and un-notified", () => {
  assert.equal(
    shouldSweepNotify(run({ status: "SUCCEEDED", surface: "tui" })),
    false,
  );
  // A GUI (or absent-surface) run in the same shape still notifies.
  assert.equal(
    shouldSweepNotify(run({ status: "SUCCEEDED", surface: "gui" })),
    true,
  );
  assert.equal(
    shouldSweepNotify(run({ status: "SUCCEEDED", surface: undefined })),
    true,
  );
});

test("abandoned (CANCELLED, GUI) runs notify so the orchestrator learns its workers evaporated", () => {
  assert.equal(
    shouldSweepNotify(
      run({ status: "CANCELLED", summary: "Abandoned — app restarted." }),
    ),
    true,
  );
});

test("selectSweepNotifications filters a mixed batch and preserves order", () => {
  const runs: RunSummary[] = [
    run({ id: "a", status: "RUNNING" }), // in flight
    run({ id: "b", status: "SUCCEEDED" }), // notify
    run({ id: "c", status: "SUCCEEDED", completionNotified: true }), // already told
    run({ id: "d", status: "FAILED", surface: "tui" }), // interactive terminal
    run({ id: "e", status: "TIMED_OUT" }), // notify
  ];
  assert.deepEqual(
    selectSweepNotifications(runs).map((r) => r.id),
    ["b", "e"],
  );
});
