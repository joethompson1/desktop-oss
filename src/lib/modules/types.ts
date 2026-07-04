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

/** Version of the module host contract (the "plugin ABI"). Bump when the
 *  AppModule shape or the seams change in a breaking way; a future
 *  runtime-loaded / remotely-installed module can check this for
 *  compatibility. */
export const MODULE_API_VERSION = 1;

/** Capabilities a module may declare it needs. Advisory today — captured in
 *  the manifest for transparency and as the seam for a future consent /
 *  permission gate, not yet enforced at runtime. */
export type ModulePermission =
  | "filesystem"
  | "network"
  | "run-commands"
  | "clipboard";

/** Props every panel component receives. `state` is this module's
 *  per-conversation state instance (see `createState`); cast it to your
 *  module's concrete state type inside the component. */
export interface ModulePanelProps {
  state: unknown;
  conversationId: string;
}

/** Props every input-accessory component receives. Accessories render in
 *  the bar directly above the prompt input, after the working-directory
 *  chip. `conversationId` is "" on a draft session (no row yet). */
export interface ModuleInputAccessoryProps {
  state: unknown;
  conversationId: string;
  workingDirectory: string;
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
  /** Persist this module's current state so it survives a reload — call
   *  after mutating `state`. No-ops if the module doesn't implement
   *  `serializeState`. Fire-and-forget (best-effort). */
  persistState: () => void;
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
  /** One-line description for the Modules settings tab / future store. */
  description?: string;
  /** Publishing metadata — advisory today, captured so a future module
   *  registry / "app store" (and remotely-installed modules) has what it
   *  needs. `repository` is the anchor for a git-linked store. */
  version?: string;
  author?: string;
  repository?: string;
  /** Capabilities this module needs. Advisory for now (not enforced) — the
   *  intended home for a future consent gate. */
  permissions?: ModulePermission[];
  /** Defaults to `true` when omitted. */
  enabledByDefault?: boolean;
  /** Capability probe consulted ONCE — when the user has never toggled this
   *  module — and its result persisted as the initial enablement (e.g. "is
   *  git installed?"). Falls back to `enabledByDefault` if it throws. */
  defaultEnabled?: () => boolean | Promise<boolean>;
  /** Per-conversation reactive state. MUST be created in a `.svelte.ts` file
   *  (runes-backed) so mutations from a tool propagate to the panel. */
  createState?: () => unknown;
  /** Snapshot `state` into a JSON-serializable value for persistence.
   *  Optional — a module without this stays memory-only (lost on reload),
   *  which is the default and fine for state that's cheap to regenerate. */
  serializeState?: (state: unknown) => unknown;
  /** Apply a previously `serializeState`d snapshot onto a freshly created
   *  `state` instance (mutate in place — the panel re-renders from this same
   *  instance). Called once, lazily, the first time a conversation's state
   *  is touched after a reload. Validate the snapshot shape before applying
   *  it: it may have been written by an older version of the module. */
  hydrateState?: (state: unknown, snapshot: unknown) => void;
  /** Replay one historical call to one of this module's own tools (matched
   *  by the `${id}_` naming convention) back onto the live `state` — called
   *  when the user clicks that tool's cockpit entry in the chat transcript,
   *  before its panel is opened/focused. Lets a module make an old tool
   *  call's specific effect visible again, since `state` only ever holds
   *  the LATEST call's result otherwise. Validate `input` before using it —
   *  it's the tool call's original arguments, replayed as-is. Optional: a
   *  module without this just re-opens/focuses the panel showing whatever
   *  is currently in `state`. */
  restoreToolCall?: (state: unknown, toolName: string, input: unknown) => void;
  /** Right-dock panel. */
  panel?: {
    title?: string;
    component: Component<ModulePanelProps>;
  };
  /** UI rendered in the bar above the prompt input, after the
   *  working-directory chip. Only shown while a working directory is set. */
  inputAccessory?: {
    component: Component<ModuleInputAccessoryProps>;
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
  description?: string;
  version?: string;
  author?: string;
  repository?: string;
  permissions?: ModulePermission[];
  enabledByDefault?: boolean;
  defaultEnabled?: () => boolean | Promise<boolean>;
  createState?: () => S;
  serializeState?: (state: S) => unknown;
  hydrateState?: (state: S, snapshot: unknown) => void;
  restoreToolCall?: (state: S, toolName: string, input: unknown) => void;
  panel?: {
    title?: string;
    component: Component<{ state: S; conversationId: string }>;
  };
  inputAccessory?: {
    component: Component<{
      state: S;
      conversationId: string;
      workingDirectory: string;
    }>;
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
