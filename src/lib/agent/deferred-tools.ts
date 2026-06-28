// Deferred tool loading for the orchestrator. Ported from the upstream
// backend's `apps/backend/src/agent/deferred-tools.ts`. The mechanism
// has two halves:
//
//  1. Tools we don't expect to be called often are marked with
//     `providerOptions.anthropic.deferLoading = true`. Anthropic then
//     omits their full schemas from the prompt (huge prompt savings
//     for large connector rosters) and instead surfaces only their
//     name + description via a salient synthetic
//     `<available-deferred-tools>` user message.
//
//  2. When the model wants to invoke a deferred tool, it first calls
//     our in-process `tool_search` tool — a CLIENT tool with a real
//     `execute()`. Our handler runs a local BM25-ish keyword search
//     over the deferred set and returns `tool_reference` blocks that
//     Anthropic expands server-side (via the
//     `advanced-tool-use-2025-11-20` beta) into the full schemas the
//     model can then call.
//
// `tool_search` is a CLIENT tool, not Anthropic's native provider tool
// `toolSearchBm25_20251119`. The provider tool stalls the AI SDK's
// multi-step loop (the SDK only continues after a client tool call,
// not after a provider tool with synchronous results — see
// `node_modules/ai/dist/index.mjs` loop continuation condition).
// the upstream backend learned this the hard way (JAR-1485); we adopt the
// fix from the start.

import { tool, type ModelMessage, type Tool, type ToolSet } from "ai";
import { z } from "zod";

const DEFAULT_THRESHOLD_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;
const SCHEMA_BOILERPLATE_CHARS = 64;

/** Wire-level name of the in-process tool search. snake_case. */
export const TOOL_SEARCH_NAME = "tool_search";

/**
 * Anthropic API beta header required for `tool_reference` blocks to be
 * expanded server-side into the full tool schemas. Add this to the
 * `anthropic-beta` header when deferred loading is active.
 */
export const TOOL_SEARCH_BETA_HEADER = "advanced-tool-use-2025-11-20";

/** Wrapper tag used in the per-turn injected message announcing deferred tools. */
export const DEFERRED_TOOLS_TAG = "available-deferred-tools";

/** Maximum length of a single tool's listed description (chars). */
const DEFERRED_TOOL_LINE_MAX_DESC_CHARS = 140;

/**
 * Walks loaded conversation history to find the names of tools the model has
 * already used (or had a schema for) earlier in this conversation. Two
 * signals count as "discovered":
 *
 *   1. Direct `tool-call` parts on assistant messages — the tool was actually
 *      invoked, so its schema must have been in scope at that point.
 *   2. `tool_reference` custom parts inside `tool-result` content — the
 *      Anthropic API expanded the referenced tool's schema server-side.
 *
 * `tool_search` itself is never counted — it's a discovery mechanism, not
 * a discoverable connector tool.
 *
 * Feeds `markToolsDeferred`'s `excludeNames` — without this, the model
 * re-calls `tool_search` every turn for tools it just used.
 */
export function extractDiscoveredToolNames(
  messages: readonly ModelMessage[],
): Set<string> {
  const discovered = new Set<string>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;

    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (!isObjectWithType(part, "tool-call")) continue;
        const name = (part as { toolName?: unknown }).toolName;
        if (typeof name !== "string") continue;
        if (name === TOOL_SEARCH_NAME) continue;
        discovered.add(name);
      }
      continue;
    }

    if (msg.role === "tool") {
      for (const part of msg.content) {
        if (!isObjectWithType(part, "tool-result")) continue;
        const output = (part as { output?: unknown }).output;
        if (!output || typeof output !== "object") continue;
        if ((output as { type?: unknown }).type !== "content") continue;
        const value = (output as { value?: unknown }).value;
        if (!Array.isArray(value)) continue;

        for (const item of value) {
          if (!isObjectWithType(item, "custom")) continue;
          const anthropic = (
            item as {
              providerOptions?: {
                anthropic?: { type?: unknown; toolName?: unknown };
              };
            }
          ).providerOptions?.anthropic;
          if (
            anthropic?.type === "tool-reference" &&
            typeof anthropic.toolName === "string"
          ) {
            discovered.add(anthropic.toolName);
          }
        }
      }
    }
  }

  return discovered;
}

function isObjectWithType(value: unknown, type: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === type
  );
}

/**
 * Parses a tool name into searchable parts. Handles two shapes:
 *   - MCP-style: `mcp__server__action_with_underscores` → split by both
 *     `__` (server boundary) and `_` (within parts).
 *   - Regular: `addJiraIssue` or `add_jira_issue` → split on CamelCase
 *     transitions and underscores.
 *
 * All parts are lowercased. Used by `searchToolsWithKeywords` for scoring.
 */
export function parseToolName(name: string): {
  parts: string[];
  full: string;
  isMcp: boolean;
} {
  if (name.startsWith("mcp__")) {
    const withoutPrefix = name.replace(/^mcp__/, "").toLowerCase();
    const parts = withoutPrefix.split("__").flatMap((p) => p.split("_"));
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, " ").replace(/_/g, " "),
      isMcp: true,
    };
  }

  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return {
    parts,
    full: parts.join(" "),
    isMcp: false,
  };
}

export interface DeferralDecision {
  active: boolean;
  reason:
    | "force_on"
    | "force_off"
    | "above_threshold"
    | "below_threshold"
    | "non_anthropic_model";
  estimatedTokens: number;
  threshold: number;
}

/** Rough char-based heuristic for the token cost of one tool's schema. */
export function estimateToolTokenCost(t: Tool): number {
  const schema = safeStringify(t.inputSchema ?? {});
  const chars =
    (t.description ?? "").length + schema.length + SCHEMA_BOILERPLATE_CHARS;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateToolSetTokenCost(tools: ToolSet): number {
  return Object.values(tools).reduce(
    (sum, t) => sum + estimateToolTokenCost(t),
    0,
  );
}

/**
 * Decide whether to activate deferred loading for this turn.
 *
 * `force` overrides the threshold (true/false). When `force` is undefined,
 * activates if the total deferrable-tools schema cost exceeds `threshold`
 * (default 10K tokens). Always returns inactive when the model isn't
 * Anthropic — schema deferral is Anthropic-specific.
 */
export function decideDeferral(args: {
  deferrableTools: ToolSet;
  isAnthropic: boolean;
  force?: boolean;
  threshold?: number;
}): DeferralDecision {
  const estimatedTokens = estimateToolSetTokenCost(args.deferrableTools);
  const threshold = args.threshold ?? DEFAULT_THRESHOLD_TOKENS;

  if (!args.isAnthropic) {
    return {
      active: false,
      reason: "non_anthropic_model",
      estimatedTokens,
      threshold,
    };
  }

  if (args.force === true) {
    return { active: true, reason: "force_on", estimatedTokens, threshold };
  }
  if (args.force === false) {
    return { active: false, reason: "force_off", estimatedTokens, threshold };
  }

  const active = estimatedTokens > threshold;
  return {
    active,
    reason: active ? "above_threshold" : "below_threshold",
    estimatedTokens,
    threshold,
  };
}

/**
 * Returns a new ToolSet with `providerOptions.anthropic.deferLoading = true`
 * on every entry, except for tools whose names appear in `excludeNames` —
 * those are passed through with their full schema preserved. Input is not
 * mutated.
 */
export function markToolsDeferred(
  tools: ToolSet,
  excludeNames?: ReadonlySet<string>,
): ToolSet {
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    if (excludeNames?.has(name)) {
      out[name] = t;
      continue;
    }
    const existingAnthropic =
      (t.providerOptions?.anthropic as Record<string, unknown> | undefined) ??
      {};
    out[name] = {
      ...t,
      providerOptions: {
        ...(t.providerOptions ?? {}),
        anthropic: {
          ...existingAnthropic,
          deferLoading: true,
        },
      },
    };
  }
  return out;
}

/**
 * Builds the per-turn synthetic user message announcing deferred tools.
 * The model sees this before the conversation proper, so it knows which
 * tools need a `tool_search` call before they can be invoked.
 *
 * Returns `null` when no entry in `tools` carries `deferLoading: true` —
 * the caller skips the inject in that case.
 *
 * Pure: deterministic for a given input. Output is sorted by tool name
 * so successive turns with the same deferred set produce identical
 * strings (cache-friendly).
 */
export function formatDeferredToolsMessage(tools: ToolSet): string | null {
  const entries: Array<{ name: string; description: string }> = [];
  for (const [name, t] of Object.entries(tools)) {
    const anthropic = t.providerOptions?.anthropic as
      | { deferLoading?: unknown }
      | undefined;
    if (anthropic?.deferLoading !== true) continue;
    entries.push({
      name,
      description: condenseDescription(t.description ?? ""),
    });
  }

  if (entries.length === 0) return null;

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const lines = entries.map(({ name, description }) =>
    description ? `- ${name}: ${description}` : `- ${name}`,
  );

  return `<${DEFERRED_TOOLS_TAG}>\n${lines.join("\n")}\n</${DEFERRED_TOOLS_TAG}>`;
}

/**
 * Reduces a tool description to a single line of bounded length. Strips
 * angle brackets + C0/DEL control characters so a hostile description
 * (e.g. from a malicious MCP server) can't break out of the wrapper or
 * smuggle ANSI sequences.
 */
function condenseDescription(raw: string): string {
  const firstLine =
    raw.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
  // eslint-disable-next-line no-control-regex
  const sanitised = firstLine.replace(/[<>\x00-\x1F\x7F]/g, "");
  if (sanitised.length <= DEFERRED_TOOL_LINE_MAX_DESC_CHARS) return sanitised;
  return `${sanitised.slice(0, DEFERRED_TOOL_LINE_MAX_DESC_CHARS - 1).trimEnd()}…`;
}

const TOOL_SEARCH_INPUT_SCHEMA = z.object({
  query: z
    .string()
    .describe(
      "Keywords, an MCP server prefix (`mcp__server`), or `select:Tool1,Tool2` for direct selection.",
    ),
  max_results: z.number().int().min(1).max(50).optional().default(5),
});

/**
 * Builds the `tool_search` entry. Returns an empty ToolSet when there
 * are no deferrable tools — registering an unusable search tool would
 * only confuse the model.
 *
 * CLIENT tool (has `execute`), not Anthropic's provider tool — see the
 * file header for why.
 */
export function getToolSearchTool(
  deferrableTools: ToolSet,
  allTools: ToolSet,
): ToolSet {
  if (Object.keys(deferrableTools).length === 0) return {};

  return {
    [TOOL_SEARCH_NAME]: tool({
      description: TOOL_SEARCH_DESCRIPTION,
      inputSchema: TOOL_SEARCH_INPUT_SCHEMA,
      execute: async ({ query, max_results }) => {
        try {
          const matches = searchToolsWithKeywords(
            query,
            deferrableTools,
            allTools,
            max_results,
          );

          if (matches.length === 0) {
            return { type: "text" as const, value: "No matching deferred tools found." };
          }

          // Partition: deferred tools need server-side schema expansion
          // via tool_reference; hot tools (matched via the post-compaction
          // safety-net fallback) already have their schemas loaded —
          // emitting tool_reference for them risks API rejection.
          const deferredMatches = matches.filter((n) => n in deferrableTools);
          const hotMatches = matches.filter(
            (n) => !(n in deferrableTools) && n in allTools,
          );

          if (deferredMatches.length > 0) {
            return {
              type: "content" as const,
              value: deferredMatches.map((toolName) => ({
                type: "custom" as const,
                providerOptions: {
                  anthropic: {
                    type: "tool-reference",
                    toolName,
                  },
                },
              })),
            };
          }

          return {
            type: "text" as const,
            value: `Already loaded — call directly: ${hotMatches.join(", ")}.`,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            type: "error-text" as const,
            value: `Error searching tools: ${message}`,
          };
        }
      },
    }),
  };
}

export const TOOL_SEARCH_DESCRIPTION = `Searches deferred connector tools and returns their full schemas so they become callable.

Deferred connector tools are listed by name in an \`<${DEFERRED_TOOLS_TAG}>\` message at the start of the conversation. Until you fetch a tool's schema via this tool it cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' full schemas inline. Once a tool's schema is returned, it is callable exactly like any tool whose schema was loaded up front. When the user has confirmed or directly requested a connector action, fetch the relevant schema and call the tool — don't just describe what you would do.

Essential tools (delegate_task, message_delegate, get_delegate_history, remember, recall, list_runs, read_file, list_files) always carry their full schema and never need a search.

Query forms:
- \`select:tool_one,tool_two\` — fetch these exact tools by name
- \`keyword1 keyword2\` — keyword search, up to max_results best matches
- \`+keyword1 keyword2\` — require keyword1 in the tool name, rank by remaining terms`;

/** Case-insensitive lookup; returns the entry's stored name. */
function findToolByName(tools: ToolSet, name: string): string | null {
  const target = name.toLowerCase();
  for (const key of Object.keys(tools)) {
    if (key.toLowerCase() === target) return key;
  }
  return null;
}

/**
 * Keyword search over deferrable tool names + descriptions. Ported
 * near-verbatim from claude-code's `searchToolsWithKeywords`.
 *
 * Fast paths in order:
 *   1. Empty / whitespace query → no matches.
 *   2. `select:Name1,Name2` → direct multi-select; missing names dropped.
 *   3. Exact-name match (case-insensitive) → returns immediately.
 *   4. `mcp__server` prefix → returns deferrable tool names beginning with the prefix.
 *
 * Otherwise: weighted keyword scoring against deferrable tools.
 * `+term` prefix requires the term to be present.
 */
export function searchToolsWithKeywords(
  query: string,
  deferrableTools: ToolSet,
  allTools: ToolSet,
  maxResults: number,
): string[] {
  const queryLower = query.toLowerCase().trim();
  if (queryLower.length === 0) return [];

  const selectMatch = queryLower.match(/^select:(.+)$/);
  if (selectMatch) {
    const requested = selectMatch[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const found: string[] = [];
    for (const toolName of requested) {
      const matched =
        findToolByName(deferrableTools, toolName) ??
        findToolByName(allTools, toolName);
      if (matched && !found.includes(matched)) {
        found.push(matched);
      }
    }
    return found;
  }

  const exactMatch =
    findToolByName(deferrableTools, queryLower) ??
    findToolByName(allTools, queryLower);
  if (exactMatch) return [exactMatch];

  if (queryLower.startsWith("mcp__") && queryLower.length > 5) {
    const prefixMatches = Object.keys(deferrableTools)
      .filter((name) => name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults);
    if (prefixMatches.length > 0) return prefixMatches;
  }

  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 0);

  const requiredTerms: string[] = [];
  const optionalTerms: string[] = [];
  for (const term of queryTerms) {
    if (term.startsWith("+") && term.length > 1) {
      requiredTerms.push(term.slice(1));
    } else {
      optionalTerms.push(term);
    }
  }

  const allScoringTerms =
    requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms;
  const termPatterns = compileTermPatterns(allScoringTerms);

  const deferrableEntries = Object.entries(deferrableTools);

  const passesRequired = (toolName: string, description: string): boolean => {
    if (requiredTerms.length === 0) return true;
    const parsed = parseToolName(toolName);
    const descLower = description.toLowerCase();
    return requiredTerms.every((term) => {
      const pattern = termPatterns.get(term)!;
      return (
        parsed.parts.includes(term) ||
        parsed.parts.some((p) => p.includes(term)) ||
        pattern.test(descLower)
      );
    });
  };

  type Scored = { name: string; score: number };
  const scored: Scored[] = [];

  for (const [name, def] of deferrableEntries) {
    const description = def.description ?? "";
    if (!passesRequired(name, description)) continue;

    const parsed = parseToolName(name);
    const descLower = description.toLowerCase();
    let score = 0;

    for (const term of allScoringTerms) {
      const pattern = termPatterns.get(term)!;

      if (parsed.parts.includes(term)) {
        score += parsed.isMcp ? 12 : 10;
      } else if (parsed.parts.some((p) => p.includes(term))) {
        score += parsed.isMcp ? 6 : 5;
      }

      if (pattern.test(descLower)) {
        score += 2;
      }
    }

    if (score > 0) {
      scored.push({ name, score });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileTermPatterns(terms: string[]): Map<string, RegExp> {
  const out = new Map<string, RegExp>();
  for (const term of terms) {
    if (out.has(term)) continue;
    out.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`));
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
