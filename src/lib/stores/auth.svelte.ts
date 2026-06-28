// Auth store, OSS-stripped version. There is no remote backend and no
// bearer token. "Authenticated" simply means: at least one adapter is
// configured. Keeps the same `hasToken` getter that the layout reads
// (renamed conceptually but kept by the same name for shell compatibility).

import { adapters } from "./adapters.svelte";

class AuthStore {
  #hydrated = $state<boolean>(false);

  get hydrated(): boolean {
    return this.#hydrated;
  }

  /** Kept for backwards compatibility with the copied shell components.
   *  Returns true iff at least one adapter is configured. */
  get hasToken(): boolean {
    return adapters.configs.length > 0;
  }

  /** No-op kept for shell components that call into auth setters. */
  get token(): string | null {
    return this.hasToken ? "configured" : null;
  }

  hydrate(): void {
    this.#hydrated = true;
  }

  setToken(_value: string | null): void {
    // no-op — adapter list is the source of truth
  }
}

export const auth = new AuthStore();
