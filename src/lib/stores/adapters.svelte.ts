// Adapter store: knows about configured LLM adapters and which one is the
// active orchestrator vs the active delegate. Persists configs to SQLite
// settings; API keys stay in the per-adapter credential store.

import type { AdapterConfig, LLMAdapter } from "$lib/types/adapter";
import { createAdapter } from "$lib/adapters";
import { getSetting, setSetting } from "$lib/db/settings";

const ADAPTERS_SETTING_KEY = "adapters.list";

class AdaptersStore {
  #configs = $state<AdapterConfig[]>([]);
  #hydrated = $state<boolean>(false);
  #hydrating = $state<boolean>(false);

  get configs(): AdapterConfig[] {
    return this.#configs;
  }

  get hydrated(): boolean {
    return this.#hydrated;
  }

  get orchestratorConfig(): AdapterConfig | null {
    return (
      this.#configs.find((c) => c.isOrchestratorDefault) ??
      this.#configs[0] ??
      null
    );
  }

  get delegateConfig(): AdapterConfig | null {
    return (
      this.#configs.find((c) => c.isDelegateDefault) ??
      this.orchestratorConfig
    );
  }

  resolveOrchestrator(): LLMAdapter | null {
    const cfg = this.orchestratorConfig;
    return cfg ? createAdapter(cfg) : null;
  }

  resolveDelegate(): LLMAdapter | null {
    const cfg = this.delegateConfig;
    return cfg ? createAdapter(cfg) : null;
  }

  /** Look up an adapter by exact name or id. Returns the instantiated
   *  adapter or null. Used when the orchestrator's `delegate_task` tool
   *  call specifies which delegate to route to via its `adapter` field. */
  resolveByNameOrId(nameOrId: string): LLMAdapter | null {
    const cfg = this.#configs.find(
      (c) => c.id === nameOrId || c.name === nameOrId,
    );
    return cfg ? createAdapter(cfg) : null;
  }

  /** Plain config matches (no instantiation). Handy for the orchestrator
   *  system prompt's delegate roster. Excludes the active orchestrator —
   *  the orchestrator shouldn't delegate to itself (that's just doing
   *  more work in the same agent loop with extra serialization overhead).
   *  If a user genuinely wants to use the same provider for both roles,
   *  they configure two adapter entries — one as orchestrator, one as
   *  delegate. */
  findConfigsByDelegateRole(): AdapterConfig[] {
    const orchId = this.orchestratorConfig?.id;
    return orchId
      ? this.#configs.filter((c) => c.id !== orchId)
      : this.#configs;
  }

  async hydrate(): Promise<void> {
    if (this.#hydrated || this.#hydrating) return;
    this.#hydrating = true;
    try {
      const stored = await getSetting<AdapterConfig[]>(ADAPTERS_SETTING_KEY);
      const { configs, mutated } = migrateLegacyAdapterTypes(stored ?? []);
      this.#configs = configs;
      if (mutated) await this.save();
    } catch {
      this.#configs = [];
    } finally {
      this.#hydrated = true;
      this.#hydrating = false;
    }
  }

  async save(): Promise<void> {
    await setSetting(ADAPTERS_SETTING_KEY, this.#configs);
  }

  async upsert(config: AdapterConfig): Promise<void> {
    const idx = this.#configs.findIndex((c) => c.id === config.id);
    if (idx === -1) {
      this.#configs = [...this.#configs, config];
    } else {
      const next = [...this.#configs];
      next[idx] = config;
      this.#configs = next;
    }
    await this.save();
  }

  async remove(id: string): Promise<void> {
    this.#configs = this.#configs.filter((c) => c.id !== id);
    await this.save();
  }

  async setOrchestratorDefault(id: string): Promise<void> {
    this.#configs = this.#configs.map((c) => ({
      ...c,
      isOrchestratorDefault: c.id === id,
    }));
    await this.save();
  }

  async setDelegateDefault(id: string): Promise<void> {
    this.#configs = this.#configs.map((c) => ({
      ...c,
      isDelegateDefault: c.id === id,
    }));
    await this.save();
  }
}

export const adapters = new AdaptersStore();

/** Normalise legacy adapter-type strings to the current brand-only set:
 *  `claude-code-sdk` collapses into `claude-code`; the discontinued CLI
 *  sidecar types (`claude-code-cli`, `opencode-cli`, `codex-cli`) are
 *  dropped — they have no replacement implementation in the registry.
 *  Returns the normalised list plus a flag indicating whether anything
 *  changed (so the caller can persist the new shape exactly once). */
function migrateLegacyAdapterTypes(
  raw: AdapterConfig[],
): { configs: AdapterConfig[]; mutated: boolean } {
  let mutated = false;
  const out: AdapterConfig[] = [];
  for (const cfg of raw) {
    const t = cfg.type as string;
    if (t === "claude-code-sdk") {
      out.push({ ...cfg, type: "claude-code" });
      mutated = true;
    } else if (
      t === "claude-code-cli" ||
      t === "opencode-cli" ||
      t === "codex-cli"
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `[adapters] dropping legacy "${t}" adapter "${cfg.name}" — that transport was removed; reconfigure with the SDK-based "claude-code" or MCP-based "codex" adapter instead.`,
      );
      mutated = true;
    } else {
      out.push(cfg);
    }
  }
  return { configs: out, mutated };
}
