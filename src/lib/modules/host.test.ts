// Tests for the module harness's pure runtime logic: the per-conversation
// state cache (the agent->panel channel) and the enablement helper. These run
// under `tsx --test` (node), so they cover everything EXCEPT import.meta.glob
// discovery, which is Vite-only and is exercised by `npm run build`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getModuleState, disposeConversationState } from "./host";
import { isModuleEnabled } from "./registry";
import type { AppModule } from "./types";

function makeModule(id: string, overrides: Partial<AppModule> = {}): AppModule {
  return {
    id,
    label: id,
    createState: () => ({ count: 0 }),
    ...overrides,
  };
}

test("getModuleState returns the SAME instance for a (conversation, module) — this is the agent->panel channel", () => {
  const mod = makeModule("alpha");
  const a = getModuleState("conv-1", mod) as { count: number };
  const b = getModuleState("conv-1", mod) as { count: number };
  assert.equal(a, b, "tool and panel must resolve the same state object");

  // A mutation by one caller (the tool) is visible to the other (the panel).
  a.count = 42;
  assert.equal(b.count, 42);
});

test("state is isolated per conversation", () => {
  const mod = makeModule("beta");
  const one = getModuleState("conv-A", mod) as { count: number };
  const two = getModuleState("conv-B", mod) as { count: number };
  one.count = 7;
  assert.notEqual(one, two);
  assert.equal(two.count, 0, "a different conversation gets a fresh instance");
});

test("modules without createState resolve to undefined", () => {
  const mod = makeModule("gamma", { createState: undefined });
  assert.equal(getModuleState("conv-1", mod), undefined);
});

test("disposeConversationState drops the cache so a fresh instance is created", () => {
  const mod = makeModule("delta");
  const first = getModuleState("conv-X", mod) as { count: number };
  first.count = 99;
  disposeConversationState("conv-X");
  const second = getModuleState("conv-X", mod) as { count: number };
  assert.notEqual(first, second);
  assert.equal(second.count, 0);
});

test("isModuleEnabled: defaults to true, honours enabledByDefault and explicit overrides", () => {
  const def = makeModule("e1");
  const offByDefault = makeModule("e2", { enabledByDefault: false });
  assert.equal(isModuleEnabled(def, {}), true);
  assert.equal(isModuleEnabled(offByDefault, {}), false);
  // Explicit enablement wins over the default.
  assert.equal(isModuleEnabled(offByDefault, { e2: true }), true);
  assert.equal(isModuleEnabled(def, { e1: false }), false);
});
