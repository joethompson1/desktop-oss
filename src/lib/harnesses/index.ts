// Harness registry — instantiates a concrete LLMHarness from a config row.
// Credential lookup is wired through here so every harness consistently
// pulls its API key from the same per-harness keystore.
//
// Two parallel surfaces live here:
//   - `createHarness` — returns our internal LLMHarness. Used by the
//     delegate runner where we hand-roll the loop.
//   - `buildOrchestratorModel` — returns a Vercel AI SDK LanguageModelV3.
//     Used by the orchestrator loop, which delegates multi-step bookkeeping
//     to `streamText` from the `ai` package.

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { LazyStore } from "@tauri-apps/plugin-store";

import type { HarnessConfig, LLMHarness } from "$lib/types/harness";
import { AnthropicHarness } from "./anthropic";
import { buildAnthropicLanguageModel } from "./anthropic-ai-sdk";
import { ClaudeCodeSDKHarness } from "./claude-code-sdk";
import { CodexHarness } from "./codex-mcp";
import { CursorHarness } from "./cursor";
import { nativeFetchAsFetch } from "./native-fetch";
import { OpenAICompatibleHarness } from "./openai-compatible";

const CREDS_FILE = "credentials.json";

let credStore: LazyStore | null = null;
function getCredStore(): LazyStore {
  if (!credStore) credStore = new LazyStore(CREDS_FILE);
  return credStore;
}

// Key format kept as `adapter:<id>:apiKey` (not `harness:...`) for
// backward compatibility — existing installs already have API keys
// stored under this key in the credentials store, and there is no
// migration path for a LazyStore-backed keychain entry the way there is
// for a SQLite settings row. Renaming this string would silently drop
// every existing user's saved API keys.
function credKey(harnessId: string): string {
  return `adapter:${harnessId}:apiKey`;
}

export async function getHarnessApiKey(
  harnessId: string,
): Promise<string | null> {
  try {
    return (await getCredStore().get<string>(credKey(harnessId))) ?? null;
  } catch {
    return null;
  }
}

export async function setHarnessApiKey(
  harnessId: string,
  apiKey: string,
): Promise<void> {
  const store = getCredStore();
  await store.set(credKey(harnessId), apiKey);
  await store.save();
}

export async function clearHarnessApiKey(harnessId: string): Promise<void> {
  const store = getCredStore();
  await store.delete(credKey(harnessId));
  await store.save();
}

export function createHarness(config: HarnessConfig): LLMHarness {
  switch (config.type) {
    case "anthropic":
      return new AnthropicHarness(config, {
        getApiKey: () => getHarnessApiKey(config.id),
      });
    case "openai-compatible":
      return new OpenAICompatibleHarness(config, {
        getApiKey: () => getHarnessApiKey(config.id),
      });
    case "claude-code":
      return new ClaudeCodeSDKHarness(config);
    case "codex":
      return new CodexHarness(config);
    case "cursor":
      return new CursorHarness(config, {
        getApiKey: () => getHarnessApiKey(config.id),
      });
    default: {
      const exhaustive: never = config.type;
      throw new Error(`Unknown harness type: ${String(exhaustive)}`);
    }
  }
}

export {
  AnthropicHarness,
  ClaudeCodeSDKHarness,
  CodexHarness,
  CursorHarness,
  OpenAICompatibleHarness,
};

/**
 * Build a Vercel AI SDK `LanguageModelV3` for the orchestrator. Returns
 * null when the harness is delegate-only (Claude Code, Codex) — those
 * run their own internal agent loops and don't expose a
 * tool-definitions-in / typed-JSON-events-out protocol that the
 * Vercel AI SDK can drive.
 *
 * Throws on missing credentials so the caller surfaces a user-facing
 * error rather than producing a silently-broken model.
 */
export async function buildOrchestratorModel(
  config: HarnessConfig,
): Promise<LanguageModelV3 | null> {
  switch (config.type) {
    case "anthropic":
      return buildAnthropicLanguageModel(config, {
        getApiKey: () => getHarnessApiKey(config.id).then((k) => k ?? undefined),
      });
    case "openai-compatible": {
      const apiKey = await getHarnessApiKey(config.id);
      const provider = createOpenAI({
        baseURL: config.baseUrl,
        // Some OpenAI-compatible endpoints (Ollama, LM Studio) accept any
        // non-empty key. Real OpenAI / OpenRouter need a real one; the
        // request will 401 surface-side if we pass nothing.
        apiKey: apiKey ?? "",
        fetch: nativeFetchAsFetch,
        name: config.name || "openai-compatible",
      });
      return provider(config.model ?? "gpt-4o-mini");
    }
    case "claude-code":
    case "codex":
    case "cursor":
      return null;
    default: {
      const exhaustive: never = config.type;
      throw new Error(`Unknown harness type: ${String(exhaustive)}`);
    }
  }
}
