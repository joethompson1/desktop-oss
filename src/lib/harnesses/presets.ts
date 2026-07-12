// Preset catalogs for the harness UI. Saves users from memorising long
// model IDs and from misspelling base URLs.
//
// Anthropic IDs: the current Claude 4.x family is Opus 4.7
// (claude-opus-4-7), Sonnet 4.6 (claude-sonnet-4-6) and Haiku 4.5
// (claude-haiku-4-5-20251001). The "1M context" variants use the same
// underlying model with the `context-1m-2025-08-07` beta header.

import type { HarnessType } from "$lib/types/harness";

export interface ModelPreset {
  /** Display name shown in the dropdown (e.g. "Sonnet 4.6"). */
  label: string;
  /** Wire model ID sent to the provider. */
  model: string;
  /** When true, the Anthropic harness sends the 1M-context beta header. */
  context1m?: boolean;
  /** Optional small note rendered next to the label. */
  hint?: string;
}

export const ANTHROPIC_MODEL_PRESETS: ModelPreset[] = [
  { label: "Sonnet 4.6", model: "claude-sonnet-4-6", hint: "default" },
  { label: "Sonnet 4.6 (1M context)", model: "claude-sonnet-4-6", context1m: true },
  { label: "Opus 4.7", model: "claude-opus-4-7" },
  { label: "Opus 4.7 (1M context)", model: "claude-opus-4-7", context1m: true },
  { label: "Haiku 4.5", model: "claude-haiku-4-5-20251001", hint: "fastest" },
  { label: "Sonnet 4.5", model: "claude-sonnet-4-5-20250929" },
  { label: "Opus 4.1", model: "claude-opus-4-1-20250805" },
];

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** Models known to be available on this provider. */
  models: ModelPreset[];
  /** When true, an API key is expected; when false (local) we skip the key field. */
  requiresApiKey: boolean;
  /** Default model picked when this provider is first selected. */
  defaultModel: string;
}

export const OPENAI_COMPATIBLE_PROVIDERS: ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    defaultModel: "gpt-4.1",
    models: [
      { label: "GPT-4.1", model: "gpt-4.1" },
      { label: "GPT-4.1 mini", model: "gpt-4.1-mini" },
      { label: "GPT-4.1 nano", model: "gpt-4.1-nano" },
      { label: "GPT-4o", model: "gpt-4o" },
      { label: "GPT-4o mini", model: "gpt-4o-mini" },
      { label: "o3", model: "o3", hint: "reasoning" },
      { label: "o3-mini", model: "o3-mini", hint: "reasoning" },
      { label: "o4-mini", model: "o4-mini", hint: "reasoning" },
    ],
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    requiresApiKey: false,
    defaultModel: "qwen2.5-coder:32b",
    models: [
      { label: "Qwen 2.5 Coder 32B", model: "qwen2.5-coder:32b" },
      { label: "Qwen 2.5 Coder 14B", model: "qwen2.5-coder:14b" },
      { label: "Qwen 2.5 Coder 7B", model: "qwen2.5-coder:7b" },
      { label: "Llama 3.3 70B", model: "llama3.3:70b" },
      { label: "Llama 3.2 3B", model: "llama3.2:3b" },
      { label: "DeepSeek R1 32B", model: "deepseek-r1:32b", hint: "reasoning" },
      { label: "GPT-OSS 20B", model: "gpt-oss:20b" },
      { label: "GPT-OSS 120B", model: "gpt-oss:120b" },
    ],
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    requiresApiKey: false,
    defaultModel: "",
    models: [],
  },
  {
    id: "vllm",
    label: "vLLM (local)",
    baseUrl: "http://localhost:8000/v1",
    requiresApiKey: false,
    defaultModel: "",
    models: [],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresApiKey: true,
    defaultModel: "anthropic/claude-sonnet-4.5",
    models: [
      { label: "Claude Sonnet 4.5 (via OpenRouter)", model: "anthropic/claude-sonnet-4.5" },
      { label: "Claude Opus 4.1 (via OpenRouter)", model: "anthropic/claude-opus-4.1" },
      { label: "GPT-4.1 (via OpenRouter)", model: "openai/gpt-4.1" },
      { label: "DeepSeek V3", model: "deepseek/deepseek-chat" },
      { label: "Qwen 3 Coder 480B", model: "qwen/qwen3-coder" },
    ],
  },
  {
    id: "custom",
    label: "Custom endpoint",
    baseUrl: "",
    requiresApiKey: true,
    defaultModel: "",
    models: [],
  },
];

/** Find the provider preset whose baseUrl matches the given URL. Used to
 *  re-resolve which preset was originally chosen when editing a harness. */
export function matchProvider(baseUrl: string | undefined): ProviderPreset {
  if (!baseUrl) return OPENAI_COMPATIBLE_PROVIDERS[0];
  const normalised = baseUrl.replace(/\/$/, "");
  for (const p of OPENAI_COMPATIBLE_PROVIDERS) {
    if (p.baseUrl.replace(/\/$/, "") === normalised) return p;
  }
  return OPENAI_COMPATIBLE_PROVIDERS[OPENAI_COMPATIBLE_PROVIDERS.length - 1];
}

/** Match an Anthropic model+context1m combination to a preset for display. */
export function matchAnthropicPreset(
  model: string | undefined,
  context1m: boolean | undefined,
): ModelPreset | null {
  if (!model) return null;
  return (
    ANTHROPIC_MODEL_PRESETS.find(
      (p) => p.model === model && !!p.context1m === !!context1m,
    ) ?? null
  );
}

/** Claude Code harness model presets. The SDK's `claude_code` system-prompt
 *  preset already supplies its own default — these IDs are passed through
 *  the sidecar's `options.model` to override that pick. Same IDs as the
 *  raw Anthropic harness; trimmed to the variants people actually want
 *  to run as a coding agent (no Haiku — too weak for tool-use loops). */
export const CLAUDE_CODE_MODEL_PRESETS: ModelPreset[] = [
  { label: "Sonnet 4.6", model: "claude-sonnet-4-6", hint: "default" },
  { label: "Opus 4.7", model: "claude-opus-4-7", hint: "highest quality" },
  { label: "Sonnet 4.5", model: "claude-sonnet-4-5-20250929" },
  { label: "Opus 4.1", model: "claude-opus-4-1-20250805" },
];

/** Codex harness model presets. Passed as the `model` argument to the
 *  `codex` MCP tool — overrides whatever model the codex profile would
 *  otherwise select. Leave blank in the settings UI to defer entirely
 *  to the profile's choice. */
export const CODEX_MODEL_PRESETS: ModelPreset[] = [
  { label: "GPT-5.5", model: "gpt-5.5", hint: "default" },
  { label: "GPT-5", model: "gpt-5" },
  { label: "GPT-5.5-codex", model: "gpt-5.5-codex" },
  { label: "o4-mini", model: "o4-mini", hint: "reasoning" },
  { label: "o3", model: "o3", hint: "reasoning" },
];

/** Cursor harness model presets. Curated from `cursor-agent --list-models`
 *  (~30 entries) to the variants that map onto real day-to-day use. The
 *  trailing `-fast` variants trade a bit of quality for latency — useful
 *  on local-edit delegations. `auto` lets Cursor pick. */
export const CURSOR_MODEL_PRESETS: ModelPreset[] = [
  { label: "Composer 2 Fast", model: "composer-2-fast", hint: "default" },
  { label: "Composer 2", model: "composer-2" },
  { label: "Codex 5.3", model: "gpt-5.3-codex" },
  { label: "Codex 5.3 High", model: "gpt-5.3-codex-high" },
  { label: "Codex 5.3 Extra High", model: "gpt-5.3-codex-xhigh" },
  { label: "GPT-5.2", model: "gpt-5.2" },
  { label: "Sonnet 4 (thinking)", model: "sonnet-4-thinking" },
  { label: "Sonnet 4", model: "sonnet-4" },
  { label: "Auto", model: "auto", hint: "Cursor picks" },
];

export function defaultModelFor(type: HarnessType): string {
  if (type === "anthropic") return ANTHROPIC_MODEL_PRESETS[0].model;
  if (type === "claude-code") return CLAUDE_CODE_MODEL_PRESETS[0].model;
  if (type === "codex") return CODEX_MODEL_PRESETS[0].model;
  if (type === "cursor") return CURSOR_MODEL_PRESETS[0].model;
  return OPENAI_COMPATIBLE_PROVIDERS[0].defaultModel;
}

/** A neutral starting-point description for a brand-new harness. The user
 *  is expected to edit this to describe what the harness is best for in
 *  their setup — we deliberately don't make capability claims (e.g.
 *  "strong at refactors") because those depend on configuration we don't
 *  control: a Codex harness could be routing through gpt-5.5 (great) or
 *  a tiny local model (limited). Stick to wiring facts; let the user
 *  add the editorial judgement. */
export function defaultDescriptionFor(
  type: HarnessType,
  hints: { model?: string; baseUrl?: string; codexProfile?: string } = {},
): string {
  const m = hints.model;
  switch (type) {
    case "anthropic":
      return m
        ? `Anthropic API. Model: ${m}. Edit this to describe what to use this harness for.`
        : "Anthropic API. Edit this to describe what to use this harness for.";
    case "openai-compatible":
      return hints.baseUrl
        ? `OpenAI-compatible endpoint at ${hints.baseUrl}${m ? `, model ${m}` : ""}. Edit this to describe what to use this harness for.`
        : "OpenAI-compatible endpoint. Edit this to describe what to use this harness for.";
    case "claude-code":
      return `Claude Code agent (Anthropic SDK). Full agentic loop with Read/Edit/Bash/Glob/Grep/WebFetch tools.${m ? ` Model: ${m}.` : ""} Edit this to describe what to use this harness for.`;
    case "codex":
      return hints.codexProfile
        ? `Codex agent via MCP server, routed through codex profile \`${hints.codexProfile}\`${m ? ` with model override ${m}` : ""}. Capability depends on the profile's model. Edit this to describe what to use this harness for.`
        : `Codex agent via MCP server${m ? ` with model ${m}` : ""}. Capability depends on the configured profile/model. Edit this to describe what to use this harness for.`;
    case "cursor":
      return `Cursor agent via @cursor/sdk. Inference routes through Cursor's cloud${m ? ` (model: ${m})` : ""}. Full agentic loop with Read/Edit/Write/Bash/Glob/Grep/semantic-search tools. Edit this to describe what to use this harness for.`;
  }
}
