// Unit tests for the TUI launch decision (fresh vs resume, and where the
// transcript mirror starts). Runs under `npm run test:unit`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildLaunchPlan } from "./launch-plan";

const mint = () => "minted-uuid";

test("initial prompt → fresh --session-id launch carrying the brief, mirror from 0", () => {
  const plan = buildLaunchPlan({
    sessionId: "sess-1",
    hooksPath: "/tmp/hooks.json",
    initialPrompt: "Do the task",
    hasConversation: false,
    mintSessionId: mint,
  });
  assert.deepEqual(plan.args, [
    "--session-id",
    "sess-1",
    "--settings",
    "/tmp/hooks.json",
    "Do the task",
  ]);
  assert.equal(plan.sessionId, "sess-1");
  // The CLI auto-submits the brief at startup; only a from-0 mirror is
  // guaranteed to capture that first turn (review blocker on PR #25).
  assert.equal(plan.freshSession, true);
});

test("recorded conversation → --resume, mirror from EOF", () => {
  const plan = buildLaunchPlan({
    sessionId: "sess-2",
    hooksPath: "/tmp/hooks.json",
    initialPrompt: undefined,
    hasConversation: true,
    mintSessionId: mint,
  });
  assert.deepEqual(plan.args, [
    "--resume",
    "sess-2",
    "--settings",
    "/tmp/hooks.json",
  ]);
  assert.equal(plan.sessionId, "sess-2");
  assert.equal(plan.freshSession, false);
});

test("pinned id but nothing to resume → minted fresh id, mirror from 0", () => {
  const plan = buildLaunchPlan({
    sessionId: "sess-3",
    hooksPath: "/tmp/hooks.json",
    initialPrompt: null,
    hasConversation: false,
    mintSessionId: mint,
  });
  assert.deepEqual(plan.args, [
    "--session-id",
    "minted-uuid",
    "--settings",
    "/tmp/hooks.json",
  ]);
  assert.equal(plan.sessionId, "minted-uuid");
  assert.equal(plan.freshSession, true);
});

test("initial prompt wins over a (stale) hasConversation claim", () => {
  const plan = buildLaunchPlan({
    sessionId: "sess-4",
    hooksPath: "/tmp/hooks.json",
    initialPrompt: "Brief",
    hasConversation: true,
    mintSessionId: mint,
  });
  assert.equal(plan.args[0], "--session-id");
  assert.equal(plan.freshSession, true);
});
