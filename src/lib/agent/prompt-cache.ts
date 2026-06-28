// Prompt-cache breakpoint helpers for Anthropic models. Ported from the upstream
// backend's `apps/backend/src/agent/prompt-cache.ts`.
//
// Three cache_control: { type: 'ephemeral' } breakpoints per turn maximise
// Anthropic KV cache reuse:
//
//   1. **System prompt** — passed as a SystemModelMessage with
//      providerOptions.anthropic.cacheControl. Wired directly in loop.ts;
//      no helper needed.
//   2. **Tool list** — `applyLastToolCacheBreakpoint(tools)` stamps the last
//      function tool. Anthropic treats everything up to that point as one
//      cacheable prefix, so one marker covers the whole list.
//   3. **Conversation history** — `injectHistoryCacheBreakpoint(messages)`
//      stamps the last assistant message. Everything up to it is the stable
//      prefix; the current user turn appended after is the only volatile part.
//
// Non-Anthropic providers ignore the providerOptions.anthropic blocks
// entirely, so these helpers are safe to call regardless of which model
// the orchestrator is on — the loop just doesn't bother when isAnthropic
// is false.

import type { ModelMessage, ToolSet } from "ai";

/**
 * Returns a new ToolSet with cache_control: { type: 'ephemeral' } applied to
 * the last *function* tool's providerOptions.anthropic. Only one entry gets a
 * breakpoint — Anthropic caches everything up to that point as one prefix,
 * so one marker covers the entire tool list without burning extra budget slots.
 *
 * Provider-defined tools are skipped: @ai-sdk/anthropic hard-codes
 * `cache_control: void 0` for those, so a breakpoint on one would silently
 * vanish and the entire tool list would go uncached. Walking back to the
 * last function tool keeps the breakpoint on a position that survives
 * serialisation.
 *
 * Input is not mutated.
 */
export function applyLastToolCacheBreakpoint(tools: ToolSet): ToolSet {
  const entries = Object.entries(tools);
  let targetKey: string | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const [key, tool] = entries[i]!;
    if ((tool as { type?: string }).type !== "provider") {
      targetKey = key;
      break;
    }
  }
  if (!targetKey) return tools;

  const targetTool = tools[targetKey]!;
  const existingAnthropic =
    (targetTool.providerOptions?.anthropic as Record<string, unknown> | undefined) ?? {};

  return {
    ...tools,
    [targetKey]: {
      ...targetTool,
      providerOptions: {
        ...(targetTool.providerOptions ?? {}),
        anthropic: {
          ...existingAnthropic,
          cacheControl: { type: "ephemeral" },
        },
      },
    },
  };
}

/**
 * Returns a new messages array with cache_control: { type: 'ephemeral' }
 * added to the last assistant message's providerOptions.anthropic. Caching
 * at this position captures all stable conversation history as a reusable
 * prefix — the current user turn appended after this call is the only
 * volatile part. Input is not mutated.
 */
export function injectHistoryCacheBreakpoint(
  messages: ModelMessage[],
): ModelMessage[] {
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex === -1) return messages;

  const original = messages[lastAssistantIndex]!;
  const patched: ModelMessage = {
    ...original,
    providerOptions: {
      ...(original.providerOptions ?? {}),
      anthropic: {
        ...((original.providerOptions?.anthropic as
          | Record<string, unknown>
          | undefined) ?? {}),
        cacheControl: { type: "ephemeral" },
      },
    },
  };

  return [
    ...messages.slice(0, lastAssistantIndex),
    patched,
    ...messages.slice(lastAssistantIndex + 1),
  ];
}
