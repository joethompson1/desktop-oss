// The module contract.
//
// A "module" is a self-contained, drop-in feature that may contribute any
// subset of: a right-dock panel, per-conversation reactive state,
// orchestrator tools, and system-prompt wording. The registry auto-discovers
// modules from `src/lib/modules/<id>/index.ts` — adding one requires NO edits
// to any core file. Deleting the folder removes the panel, tool, and prompt
// text together, and the rest of the app reflows untouched.
//
// Naming is deliberately brand-neutral (`AppModule`, not a product name) so
// the pending app rename never has to touch this harness.

import type { Component } from "svelte";
import type { ToolSet } from "ai";

/** Props every panel component receives. `state` is this module's
 *  per-conversation state instance (see `createState`); cast it to your
 *  module's concrete state type inside the component. */
export interface ModulePanelProps {
  state: unknown;
  conversationId: string;
}

/** Context handed to a module's `tools(...)` factory once per orchestrator
 *  turn. The orchestrator loop runs in the webview, so a tool's `execute()`
 *  may mutate `state` directly (the mounted panel re-renders live) and call
 *  `openPanel()` to surface its panel in the right dock. */
export interface ModuleToolContext<S = unknown> {
  conversationId: string;
  workingDirectory?: string;
  signal?: AbortSignal;
  state: S;
  /** Expand / focus this module's panel in the right dock. */
  openPanel: () => void;
}

/** Context handed to `promptFragment(...)` while assembling the system
 *  prompt. Return a markdown string to teach the agent about this module's
 *  capability; it is concatenated into the prompt only while the module is
 *  enabled. */
export interface ModulePromptContext<S = unknown> {
  conversationId: string;
  workingDirectory?: string;
  state: S;
}

/** The erased descriptor stored in the registry. Author a typed definition
 *  with `defineModule<State>(...)`, which returns this shape. */
export interface AppModule {
  /** Unique id. Namespaces the panel, the settings key, and (by convention)
   *  the module's tool names. Use the folder name. */
  id: string;
  /** Human label for the right-dock rail tooltip and settings. */
  label: string;
  /** Rail button glyph — an emoji or a 1–2 char string. Falls back to the
   *  first letter of `label`. */
  icon?: string;
  /** Defaults to `true` when omitted. */
  enabledByDefault?: boolean;
  /** Per-conversation reactive state. MUST be created in a `.svelte.ts` file
   *  (runes-backed) so mutations from a tool propagate to the panel. */
  createState?: () => unknown;
  /** Right-dock panel. */
  panel?: {
    title?: string;
    component: Component<ModulePanelProps>;
  };
  /** Orchestrator tools, built per turn with live context. */
  tools?: (ctx: ModuleToolContext) => ToolSet;
  /** Extra system-prompt wording, injected while enabled. */
  promptFragment?: (ctx: ModulePromptContext) => string | Promise<string>;
  /** Optional settings panel (rendered in Settings → Modules later). */
  settings?: Component;
}

/** Strongly-typed authoring shape — gives full type-safety on `state` across
 *  the panel, tools, and prompt, then erases to `AppModule` for the registry. */
export interface ModuleDefinition<S = void> {
  id: string;
  label: string;
  icon?: string;
  enabledByDefault?: boolean;
  createState?: () => S;
  panel?: {
    title?: string;
    component: Component<{ state: S; conversationId: string }>;
  };
  tools?: (ctx: ModuleToolContext<S>) => ToolSet;
  promptFragment?: (ctx: ModulePromptContext<S>) => string | Promise<string>;
  settings?: Component;
}

/** Author a module with this helper so `state` is typed end-to-end. The
 *  return value is the erased `AppModule` the registry stores. */
export function defineModule<S = void>(def: ModuleDefinition<S>): AppModule {
  return def as unknown as AppModule;
}
