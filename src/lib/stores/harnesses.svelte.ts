// Harness store: knows about configured LLM harnesses and which one is the
// active orchestrator vs the active delegate. Persists configs to SQLite
// settings; API keys stay in the per-harness credential store.

import type { HarnessConfig, LLMHarness } from "$lib/types/harness";
import { createHarness } from "$lib/harnesses";
import { getSetting, setSetting } from "$lib/db/settings";

const HARNESSES_SETTING_KEY = "harnesses.list";
// Pre-rename key. Existing installs have their configured harnesses
// stored under this key — read it as a one-time fallback on hydrate so
// nobody's saved configuration silently disappears. We never write to
// it again; once hydrate() finds data here it immediately persists it
// under HARNESSES_SETTING_KEY and all subsequent reads use that.
const LEGACY_ADAPTERS_SETTING_KEY = "adapters.list";

class HarnessesStore {
  #configs = $state<HarnessConfig[]>([]);
  #hydrated = $state<boolean>(false);
  #hydrating = $state<boolean>(false);

  get configs(): HarnessConfig[] {
    return this.#configs;
  }

  get hydrated(): boolean {
    return this.#hydrated;
  }

  get orchestratorConfig(): HarnessConfig | null {
    return (
      this.#configs.find((c) => c.isOrchestratorDefault) ??
      this.#configs[0] ??
      null
    );
  }

  get delegateConfig(): HarnessConfig | null {
    return (
      this.#configs.find((c) => c.isDelegateDefault) ??
      this.orchestratorConfig
    );
  }

  resolveOrchestrator(): LLMHarness | null {
    const cfg = this.orchestratorConfig;
    return cfg ? createHarness(cfg) : null;
  }

  resolveDelegate(): LLMHarness | null {
    const cfg = this.delegateConfig;
    return cfg ? createHarness(cfg) : null;
  }

  /** Look up a harness by exact name or id. Returns the instantiated
   *  harness or null. Used when the orchestrator's `delegate_task` tool
   *  call specifies which delegate to route to via its `harness` field. */
  resolveByNameOrId(nameOrId: string): LLMHarness | null {
    const cfg = this.#configs.find(
      (c) => c.id === nameOrId || c.name === nameOrId,
    );
    return cfg ? createHarness(cfg) : null;
  }

  /** Plain config matches (no instantiation). Handy for the orchestrator
   *  system prompt's delegate roster. Excludes the active orchestrator —
   *  the orchestrator shouldn't delegate to itself (that's just doing
   *  more work in the same agent loop with extra serialization overhead).
   *  If a user genuinely wants to use the same provider for both roles,
   *  they configure two harness entries — one as orchestrator, one as
   *  delegate. */
  findConfigsByDelegateRole(): HarnessConfig[] {
    const orchId = this.orchestratorConfig?.id;
    return orchId
      ? this.#configs.filter((c) => c.id !== orchId)
      : this.#configs;
  }

  async hydrate(): Promise<void> {
    if (this.#hydrated || this.#hydrating) return;
    this.#hydrating = true;
    try {
      let stored = await getSetting<HarnessConfig[]>(HARNESSES_SETTING_KEY);
      let mustPersist = false;
      if (stored === null) {
        // First read since the adapter → harness rename: fall back to
        // the legacy key so an existing install's configured harnesses
        // still show up. Re-saved under the new key below.
        const legacy = await getSetting<HarnessConfig[]>(
          LEGACY_ADAPTERS_SETTING_KEY,
        );
        if (legacy !== null) {
          stored = legacy;
          mustPersist = true;
        }
      }
      const { configs, mutated } = migrateLegacyHarnessTypes(stored ?? []);
      this.#configs = configs;
      if (mutated || mustPersist) await this.save();
    } catch {
      this.#configs = [];
    } finally {
      this.#hydrated = true;
      this.#hydrating = false;
    }
  }

  async save(): Promise<void> {
    await setSetting(HARNESSES_SETTING_KEY, this.#configs);
  }

  async upsert(config: HarnessConfig): Promise<void> {
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

export const harnesses = new HarnessesStore();

/** Normalise legacy harness-type strings to the current brand-only set:
 *  `claude-code-sdk` collapses into `claude-code`; the discontinued CLI
 *  sidecar types (`claude-code-cli`, `opencode-cli`, `codex-cli`) are
 *  dropped — they have no replacement implementation in the registry.
 *  Returns the normalised list plus a flag indicating whether anything
 *  changed (so the caller can persist the new shape exactly once). */
function migrateLegacyHarnessTypes(
  raw: HarnessConfig[],
): { configs: HarnessConfig[]; mutated: boolean } {
  let mutated = false;
  const out: HarnessConfig[] = [];
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
        `[harnesses] dropping legacy "${t}" harness "${cfg.name}" — that transport was removed; reconfigure with the SDK-based "claude-code" or MCP-based "codex" harness instead.`,
      );
      mutated = true;
    } else {
      out.push(cfg);
    }
  }
  return { configs: out, mutated };
}
