/// <reference types="vite/client" />

// Module auto-discovery. Every module lives at
// `src/lib/modules/<id>/index.ts` and `export default defineModule({...})`.
// This glob picks them up at build time with no central registration — a new
// module folder is all it takes. With no module folders present the list is
// simply empty and the app behaves exactly as before.
//
// The glob is a Vite-only macro. Under non-Vite runtimes (the node:test eval
// harness) `import.meta.glob` is undefined, so we guard the call and fall back
// to an empty set. This keeps the agent graph importable outside Vite.

import type { AppModule } from "./types";

/** Settings key holding the `{ [moduleId]: boolean }` enablement map. Shared
 *  by the UI store and the agent-side integration so both agree on which
 *  modules are on. */
export const MODULE_ENABLEMENT_KEY = "moduleEnablement";

let found: Record<string, { default?: AppModule }> = {};
try {
  found = import.meta.glob<{ default?: AppModule }>("./*/index.ts", {
    eager: true,
  });
} catch {
  found = {};
}

export const discoveredModules: AppModule[] = Object.values(found)
  .map((mod) => mod.default)
  .filter(
    (m): m is AppModule => !!m && typeof m.id === "string" && !!m.label,
  );

/** Is a module enabled, given the persisted enablement map? Absent entries
 *  fall back to the module's `enabledByDefault` (default true). */
export function isModuleEnabled(
  module: AppModule,
  enablement: Record<string, boolean>,
): boolean {
  if (module.id in enablement) return enablement[module.id];
  return module.enabledByDefault ?? true;
}

/** The panel-bearing module that owns a tool name, if any — found by the
 *  `${module.id}_...` namespacing convention (README.md rule 1), not by
 *  calling `tools()` (which needs a live turn context). Lets a cockpit entry
 *  route its click to that module's panel instead of the generic JSON
 *  disclosure. */
export function moduleForToolName(toolName: string): AppModule | undefined {
  return discoveredModules
    .filter((m) => m.panel)
    .find((m) => toolName.startsWith(`${m.id}_`));
}
