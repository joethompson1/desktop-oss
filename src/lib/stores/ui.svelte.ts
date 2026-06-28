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

  get sidebarCollapsed(): boolean {
    return this.#sidebarCollapsed;
  }

  get openPanelId(): string | null {
    return this.#openPanelId;
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
