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

const states = new Map<string, Map<string, unknown>>();

/** Get (lazily creating) this conversation's state instance for a module.
 *  Returns `undefined` for modules that declare no `createState`. */
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
    perConversation.set(module.id, module.createState());
  }
  return perConversation.get(module.id);
}

/** Drop a conversation's cached state (e.g. when a session is deleted). */
export function disposeConversationState(conversationId: string): void {
  states.delete(conversationId);
}
