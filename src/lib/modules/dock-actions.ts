// Indirection so the agent loop can ask the right dock to open a panel
// WITHOUT importing the UI store. This keeps the agent graph free of
// runes/UI/Tauri dependencies (which matters for the node:test eval harness):
// the shell registers the real opener on mount, and a module tool's
// `execute()` calls `requestOpenPanel(id)`.

let opener: ((moduleId: string) => void) | null = null;

/** Registered once by the app shell (RightDock host) on mount. */
export function setPanelOpener(fn: (moduleId: string) => void): void {
  opener = fn;
}

/** Request that a module's panel be opened/focused. No-op until the shell
 *  has registered an opener (e.g. on routes without the dock). */
export function requestOpenPanel(moduleId: string): void {
  opener?.(moduleId);
}
