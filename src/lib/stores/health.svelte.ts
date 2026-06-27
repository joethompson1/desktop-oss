// Health store. Probes the orchestrator adapter so the top-bar pill
// reflects whether the chat will actually work right now.

import { adapters } from "./adapters.svelte";

export type HealthOverall = "connected" | "degraded" | "unreachable" | "unknown";

export interface HealthSnapshot {
  overall: HealthOverall;
  adapterName: string | null;
  message: string | null;
  latencyMs: number | null;
  checkedAt: string | null;
}

// Five minutes — generous since probes are now credential-only (no
// upstream HTTP), and even for OpenAI-compatible adapters /v1/models
// doesn't need to be hit every 30 seconds. The chat itself is the
// authoritative reachability test.
const POLL_INTERVAL_MS = 300_000;

class HealthStore {
  #snapshot = $state<HealthSnapshot>({
    overall: "unknown",
    adapterName: null,
    message: null,
    latencyMs: null,
    checkedAt: null,
  });
  #pollHandle: number | null = null;

  get snapshot(): HealthSnapshot {
    return this.#snapshot;
  }

  get overall(): HealthOverall {
    return this.#snapshot.overall;
  }

  async probe(): Promise<void> {
    const adapter = adapters.resolveOrchestrator();
    if (!adapter) {
      this.#snapshot = {
        overall: "unknown",
        adapterName: null,
        message: "No orchestrator adapter configured",
        latencyMs: null,
        checkedAt: new Date().toISOString(),
      };
      return;
    }
    try {
      const result = await adapter.probe();
      this.#snapshot = {
        overall: result.ok ? "connected" : "unreachable",
        adapterName: adapter.name,
        message: result.message ?? null,
        latencyMs: result.latencyMs ?? null,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.#snapshot = {
        overall: "unreachable",
        adapterName: adapter.name,
        message: err instanceof Error ? err.message : "Probe failed",
        latencyMs: null,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  start(): void {
    if (this.#pollHandle !== null) return;
    void this.probe();
    this.#pollHandle = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void this.probe();
      }
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.#pollHandle !== null) {
      window.clearInterval(this.#pollHandle);
      this.#pollHandle = null;
    }
  }
}

export const health = new HealthStore();
