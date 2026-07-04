// Tests for host.ts's persistence round-trip and the first-write-wins
// hydration guard. The DB layer (db/module-state → plugin-sql) is mocked so
// this runs under `tsx --test` without a Tauri/SQLite context. Requires
// --experimental-test-module-mocks (set in the test:unit script).

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { AppModule } from "./types";

// Fake DB layer host reads/writes. `mock.module` here intercepts host.ts's
// `import "$lib/db/module-state"` (same resolved file) before host is loaded.
let stored: unknown;
mock.module("../db/module-state", {
  namedExports: {
    getModuleStateRow: async () => stored,
    setModuleStateRow: async (_c: string, _m: string, data: unknown) => {
      stored = data;
    },
  },
});

const {
  getModuleState,
  persistModuleState,
  disposeConversationState,
} = await import("./host");

interface Cell {
  value: string;
}

function moduleWith(overrides: Partial<AppModule> = {}): AppModule {
  return {
    id: "m",
    label: "M",
    createState: (): Cell => ({ value: "" }),
    serializeState: (s) => ({ value: (s as Cell).value }),
    hydrateState: (s, snap) => {
      const snapshot = snap as { value?: unknown };
      if (typeof snapshot?.value === "string") (s as Cell).value = snapshot.value;
    },
    ...overrides,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("hydrate restores a persisted snapshot onto a fresh instance", async () => {
  stored = { value: "persisted" };
  const state = getModuleState("c1", moduleWith()) as Cell;
  await tick(); // let the background hydrate resolve
  assert.equal(state.value, "persisted");
  disposeConversationState("c1");
});

test("first-write-wins: a mutation before hydrate resolves is NOT clobbered", async () => {
  stored = { value: "stale" };
  const mod = moduleWith();
  const state = getModuleState("c2", mod) as Cell;
  // A tool mutates + persists before the in-flight background read resolves.
  state.value = "fresh";
  persistModuleState("c2", mod, state); // marks the state touched
  await tick();
  assert.equal(state.value, "fresh"); // stale snapshot must not overwrite it
  disposeConversationState("c2");
});

test("absent snapshot leaves the fresh instance untouched", async () => {
  stored = undefined;
  const state = getModuleState("c3", moduleWith()) as Cell;
  await tick();
  assert.equal(state.value, "");
  disposeConversationState("c3");
});
