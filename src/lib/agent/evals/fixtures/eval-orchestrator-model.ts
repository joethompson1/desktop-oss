// Build an orchestrator model from environment variables. Keeps the
// scenario files free of credential / SDK setup boilerplate.
//
// Env vars:
//   EVAL_PROVIDER       "anthropic" (default) or "openai-compatible"
//   EVAL_MODEL          Provider-specific model id. Default
//                       "claude-sonnet-4-5" for anthropic,
//                       "gpt-4o-mini" for openai-compatible.
//   ANTHROPIC_API_KEY   Required when provider is "anthropic".
//   OPENAI_API_KEY      Required for hosted OpenAI; may be left empty for
//                       Ollama / LM Studio.
//   OPENAI_BASE_URL     For local models (e.g. http://localhost:11434/v1).

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV3 } from "@ai-sdk/provider";

export interface EvalOrchestratorModel {
  model: LanguageModelV3;
  isAnthropic: boolean;
  provider: "anthropic" | "openai-compatible";
  modelId: string;
}

export function buildEvalOrchestratorModel(): EvalOrchestratorModel {
  const provider = (process.env.EVAL_PROVIDER ?? "anthropic") as
    | "anthropic"
    | "openai-compatible";

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "[evals] ANTHROPIC_API_KEY is not set. Either export it or set EVAL_PROVIDER=openai-compatible with the appropriate vars.",
      );
    }
    const modelId = process.env.EVAL_MODEL ?? "claude-sonnet-4-6";
    // Pin the base URL — Claude Code / Claude Desktop inject
    // `ANTHROPIC_BASE_URL=https://api.anthropic.com` (no `/v1`) into the
    // process env, which makes the SDK build a 404 path. See
    // the upstream backend apps/backend/src/agent/model-selection.ts for the same fix.
    const anthropic = createAnthropic({
      apiKey,
      baseURL: "https://api.anthropic.com/v1",
    });
    return {
      model: anthropic(modelId),
      isAnthropic: true,
      provider,
      modelId,
    };
  }

  const baseURL = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const modelId = process.env.EVAL_MODEL ?? "gpt-4o-mini";
  const openai = createOpenAI({ apiKey, baseURL });
  return {
    model: openai(modelId),
    isAnthropic: false,
    provider,
    modelId,
  };
}
