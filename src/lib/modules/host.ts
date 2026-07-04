// Per-conversation module state.
//
// Both the mounted panel and the module's tools resolve their state instance
// through here, keyed by (conversationId, moduleId), so a tool's mutation is
// seen by the panel. The state objects themselves are created by the module's
// `createState()` — a runes-backed object defined in the module's own
// `.svelte.ts` file — so reactivity flows tool → state → panel.
//
// This file is intentionally plain (no runes, no UI, no Tauri) so it is safe
// to import from the agent loop.

import type { AppModule } from "./types";
import { getModuleStateRow, setModuleStateRow } from "$lib/db/module-state";

const states = new Map<string, Map<string, unknown>>();

/** Get (lazily creating) this conversation's state instance for a module.
 *  Returns `undefined` for modules that declare no `createState`. A freshly
 *  created instance is hydrated from its last persisted snapshot (if the
 *  module implements `hydrateState`) asynchronously, in the background —
 *  the caller gets the blank instance immediately and it updates in place
 *  once hydration resolves, so callers stay synchronous. */
export function getModuleState(
  conversationId: string,
  module: AppModule,
): unknown {
  if (!module.createState) return undefined;
  let perConversation = states.get(conversationId);
  if (!perConversation) {
    perConversation = new Map();
    states.set(conversationId, perConversation);
  }
  if (!perConversation.has(module.id)) {
    const state = module.createState();
    perConversation.set(module.id, state);
    if (module.hydrateState) {
      void hydrate(conversationId, module, state);
    }
  }
  return perConversation.get(module.id);
}

async function hydrate(
  conversationId: string,
  module: AppModule,
  state: unknown,
): Promise<void> {
  try {
    const snapshot = await getModuleStateRow(conversationId, module.id);
    if (snapshot !== undefined) module.hydrateState?.(state, snapshot);
  } catch {
    // best-effort — e.g. no Tauri context under the node:test eval harness,
    // or nothing persisted yet for this conversation
  }
}

/** Persist a module's current state so it survives a reload. Call after a
 *  tool mutates `state` (see `ModuleToolContext.persistState`). No-ops if
 *  the module doesn't implement `serializeState`. Fire-and-forget. */
export function persistModuleState(
  conversationId: string,
  module: AppModule,
  state: unknown,
): void {
  if (!module.serializeState) return;
  void setModuleStateRow(
    conversationId,
    module.id,
    module.serializeState(state),
  ).catch(() => {
    // best-effort
  });
}

/** Drop a conversation's cached state (e.g. when a session is deleted). */
export function disposeConversationState(conversationId: string): void {
  states.delete(conversationId);
}
