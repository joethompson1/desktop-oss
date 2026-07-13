// Per-scenario module mock setup. Call `installEvalMocks()` at the top of
// any `*.eval.ts` file BEFORE dynamically importing anything that touches
// the DB or Tauri runtime. This swaps in the SQLite shim for
// `@tauri-apps/plugin-sql` and a no-op `invoke()` for `@tauri-apps/api/core`
// so the orchestrator loop runs end-to-end inside node:test.
//
// Why dynamic import gymnastics: `mock.module()` only affects modules
// loaded *after* it runs. ESM hoists static imports above runtime code,
// so the scenario's first lines must be `installEvalMocks()` and then
// `await import(...)` for anything in the agent graph.

import { mock } from "node:test";

import { Database, resetDatabase } from "./sqlite-shim.js";

let _installed = false;

/**
 * Wire the SQLite shim and Tauri stubs into the module graph. Idempotent —
 * safe to call from helper modules without worrying about double-mocking.
 */
export function installEvalMocks(): void {
  if (_installed) return;
  _installed = true;

  mock.module("@tauri-apps/plugin-sql", {
    defaultExport: Database,
    namedExports: { Database },
  });

  mock.module("@tauri-apps/api/core", {
    namedExports: {
      invoke: async (cmd: string) => {
        throw new Error(
          `[eval] Tauri command "${cmd}" is not available under node:test. ` +
            `If your scenario needs a filesystem tool to fire, stub it explicitly.`,
        );
      },
      // `Channel` is imported (not just `invoke`) by modules in the agent
      // graph — e.g. `$lib/skills/rust`, which `loop.ts` pulls in. The mock
      // must export it or the import fails with "does not provide an export
      // named 'Channel'". A no-op class is enough: evals never stream over a
      // real channel (the orchestrator model uses the SDK's own fetch, the
      // delegate is a scripted mock).
      Channel: class {
        onmessage: ((message: unknown) => void) | null = null;
      },
    },
  });

  // plugin-store is pulled in by harnesses/index.ts (credential storage).
  // We don't import harnesses/index in evals — the orchestrator model is
  // built explicitly by the scenario — but stub it defensively in case
  // a future scenario imports something that transitively needs it.
  mock.module("@tauri-apps/plugin-store", {
    namedExports: {
      LazyStore: class {
        async get() {
          return null;
        }
        async set() {}
        async save() {}
        async delete() {}
      },
    },
  });
}

/**
 * Wipe and re-migrate the in-memory database. Use from a scenario's
 * `beforeEach` so iterations don't bleed state into each other.
 */
export function resetEvalDatabase(): void {
  resetDatabase();
}
