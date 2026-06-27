// Adapter registry — instantiates a concrete LLMAdapter from a config row.
// Credential lookup is wired through here so every adapter consistently
// pulls its API key from the same per-adapter keystore.
//
// Two parallel surfaces live here:
//   - `createAdapter` — returns our internal LLMAdapter. Used by the
//     delegate runner where we hand-roll the loop.
//   - `buildOrchestratorModel` — returns a Vercel AI SDK LanguageModelV3.
//     Used by the orchestrator loop, which delegates multi-step bookkeeping
//     to `streamText` from the `ai` package.

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { LazyStore } from "@tauri-apps/plugin-store";

import type { AdapterConfig, LLMAdapter } from "$lib/types/adapter";
import { AnthropicAdapter } from "./anthropic";
import { buildAnthropicLanguageModel } from "./anthropic-ai-sdk";
import { ClaudeCodeSDKAdapter } from "./claude-code-sdk";
import { CodexAdapter } from "./codex-mcp";
import { CursorAdapter } from "./cursor";
import { nativeFetchAsFetch } from "./native-fetch";
import { OpenAICompatibleAdapter } from "./openai-compatible";

const CREDS_FILE = "credentials.json";

let credStore: LazyStore | null = null;
function getCredStore(): LazyStore {
  if (!credStore) credStore = new LazyStore(CREDS_FILE);
  return credStore;
}

function credKey(adapterId: string): string {
  return `adapter:${adapterId}:apiKey`;
}

export async function getAdapterApiKey(
  adapterId: string,
): Promise<string | null> {
  try {
    return (await getCredStore().get<string>(credKey(adapterId))) ?? null;
  } catch {
    return null;
  }
}

export async function setAdapterApiKey(
  adapterId: string,
  apiKey: string,
): Promise<void> {
  const store = getCredStore();
  await store.set(credKey(adapterId), apiKey);
  await store.save();
}

export async function clearAdapterApiKey(adapterId: string): Promise<void> {
  const store = getCredStore();
  await store.delete(credKey(adapterId));
  await store.save();
}

export function createAdapter(config: AdapterConfig): LLMAdapter {
  switch (config.type) {
    case "anthropic":
      return new AnthropicAdapter(config, {
        getApiKey: () => getAdapterApiKey(config.id),
      });
    case "openai-compatible":
      return new OpenAICompatibleAdapter(config, {
        getApiKey: () => getAdapterApiKey(config.id),
      });
    case "claude-code":
      return new ClaudeCodeSDKAdapter(config);
    case "codex":
      return new CodexAdapter(config);
    case "cursor":
      return new CursorAdapter(config, {
        getApiKey: () => getAdapterApiKey(config.id),
      });
    default: {
      const exhaustive: never = config.type;
      throw new Error(`Unknown adapter type: ${String(exhaustive)}`);
    }
  }
}

export {
  AnthropicAdapter,
  ClaudeCodeSDKAdapter,
  CodexAdapter,
  CursorAdapter,
  OpenAICompatibleAdapter,
};

/**
 * Build a Vercel AI SDK `LanguageModelV3` for the orchestrator. Returns
 * null when the adapter is delegate-only (Claude Code, Codex) — those
 * run their own internal agent loops and don't expose a
 * tool-definitions-in / typed-JSON-events-out protocol that the
 * Vercel AI SDK can drive.
 *
 * Throws on missing credentials so the caller surfaces a user-facing
 * error rather than producing a silently-broken model.
 */
export async function buildOrchestratorModel(
  config: AdapterConfig,
): Promise<LanguageModelV3 | null> {
  switch (config.type) {
    case "anthropic":
      return buildAnthropicLanguageModel(config, {
        getApiKey: () => getAdapterApiKey(config.id).then((k) => k ?? undefined),
      });
    case "openai-compatible": {
      const apiKey = await getAdapterApiKey(config.id);
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
      throw new Error(`Unknown adapter type: ${String(exhaustive)}`);
    }
  }
}
