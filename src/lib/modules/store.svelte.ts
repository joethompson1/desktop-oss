// Module enablement store — the UI-facing half of the harness.
//
// Discovery is static (registry.ts); this runes store holds the user's on/off
// toggles (persisted in the settings table) and exposes the enabled /
// panel-bearing subsets the right dock and the (future) Settings → Modules tab
// consume reactively. The agent loop does NOT use this store — it reads
// enablement directly in `integration.ts` to keep runes out of the agent graph.

import { getSetting, setSetting } from "$lib/db/settings";
import {
  discoveredModules,
  isModuleEnabled,
  MODULE_ENABLEMENT_KEY,
} from "./registry";
import type { AppModule } from "./types";

class ModulesStore {
  #enablement = $state<Record<string, boolean>>({});
  #hydrated = $state<boolean>(false);

  get hydrated(): boolean {
    return this.#hydrated;
  }

  /** Every discovered module, regardless of enablement. */
  all(): AppModule[] {
    return discoveredModules;
  }

  isEnabled(id: string): boolean {
    const module = discoveredModules.find((m) => m.id === id);
    if (!module) return false;
    return isModuleEnabled(module, this.#enablement);
  }

  /** Enabled modules. */
  enabled(): AppModule[] {
    return discoveredModules.filter((m) =>
      isModuleEnabled(m, this.#enablement),
    );
  }

  /** Enabled modules that contribute a right-dock panel. */
  panels(): AppModule[] {
    return this.enabled().filter((m) => m.panel);
  }

  async hydrate(): Promise<void> {
    if (this.#hydrated) return;
    try {
      const saved = await getSetting<Record<string, boolean>>(
        MODULE_ENABLEMENT_KEY,
      );
      if (saved) this.#enablement = saved;
    } catch {
      // best-effort
    } finally {
      this.#hydrated = true;
    }
  }

  async setEnabled(id: string, value: boolean): Promise<void> {
    this.#enablement = { ...this.#enablement, [id]: value };
    try {
      await setSetting(MODULE_ENABLEMENT_KEY, this.#enablement);
    } catch {
      // best-effort
    }
  }
}

export const modules = new ModulesStore();
