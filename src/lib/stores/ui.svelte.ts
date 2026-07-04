// UI preferences (sidebar collapsed, etc.). Persisted to tauri-plugin-store.

import { LazyStore } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";

const PREFS_FILE = "preferences.json";
const SIDEBAR_COLLAPSED_KEY = "sidebarCollapsed";

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (!store) store = new LazyStore(PREFS_FILE);
  return store;
}

class UiStore {
  #sidebarCollapsed = $state<boolean>(false);
  #hydrated = $state<boolean>(false);
  #isFullscreen = $state<boolean>(false);
  #fullscreenUnlisten: (() => void) | null = null;

  // Which right-dock module panel is currently expanded (by module id), or
  // null when the dock shows only its rail. Tabbed: one panel open at a time.
  #openPanelId = $state<string | null>(null);

  // The session/conversation route currently showing, maintained explicitly
  // by sessions/[id]/+page.svelte and sessions/new/+page.svelte rather than
  // read from `page.params.id` in +layout.svelte: a draft promoted via
  // `replaceState` (sessions/new's onConversationCreated) changes the URL's
  // matched route WITHOUT a real navigation, and SvelteKit does not
  // propagate that route/param change to a `$derived`/`$effect` in an
  // already-mounted ancestor like the root layout — confirmed by a direct
  // reactivity probe: an existing `$derived(page.params.id ?? "")` never
  // re-ran after such a promotion, even though a FRESH read of
  // `page.params.id` afterward showed the correct id. `+layout.svelte`'s
  // right-dock activation depends on knowing the real id the instant a
  // draft is promoted (so a module's `openPanel()` call mid-turn works), so
  // it reads this store instead.
  #activeConversationId = $state<string>("");

  get sidebarCollapsed(): boolean {
    return this.#sidebarCollapsed;
  }

  get openPanelId(): string | null {
    return this.#openPanelId;
  }

  get activeConversationId(): string {
    return this.#activeConversationId;
  }

  setActiveConversationId(id: string): void {
    this.#activeConversationId = id;
  }

  openPanel(id: string): void {
    this.#openPanelId = id;
  }

  closePanel(): void {
    this.#openPanelId = null;
  }

  togglePanel(id: string): void {
    this.#openPanelId = this.#openPanelId === id ? null : id;
  }

  get hydrated(): boolean {
    return this.#hydrated;
  }

  get isFullscreen(): boolean {
    return this.#isFullscreen;
  }

  async hydrate(): Promise<void> {
    if (this.#hydrated) return;
    try {
      const value = await getStore().get<boolean>(SIDEBAR_COLLAPSED_KEY);
      if (typeof value === "boolean") this.#sidebarCollapsed = value;
    } catch {
      // best-effort
    } finally {
      this.#hydrated = true;
    }
  }

  async toggleSidebar(): Promise<void> {
    this.#sidebarCollapsed = !this.#sidebarCollapsed;
    try {
      const s = getStore();
      await s.set(SIDEBAR_COLLAPSED_KEY, this.#sidebarCollapsed);
      await s.save();
    } catch {
      // best-effort
    }
  }

  async startFullscreenTracking(): Promise<void> {
    const win = getCurrentWindow();
    this.#isFullscreen = await win.isFullscreen();
    this.#fullscreenUnlisten = await win.onResized(async () => {
      this.#isFullscreen = await win.isFullscreen();
    });
  }

  stopFullscreenTracking(): void {
    this.#fullscreenUnlisten?.();
    this.#fullscreenUnlisten = null;
  }
}

export const ui = new UiStore();
