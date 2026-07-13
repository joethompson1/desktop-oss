// Orchestrator turn driver. The Vercel AI SDK's `streamText` owns the
// multi-step loop, tool-call/result message pairing, and stream
// splicing — this module's only jobs are (1) assemble the model,
// system prompt, tools, and message history for the call, (2) decide
// whether to activate deferred tool loading, (3) yield the SDK's
// `fullStream` events back to the caller (the chat store).

import { stepCountIs, streamText, type ModelMessage } from "ai";
import type { LanguageModelV3, SharedV3ProviderOptions } from "@ai-sdk/provider";

import type { HarnessConfig, HarnessType, LLMHarness } from "$lib/types/harness";
import { harnessKind, HARNESS_KIND_DESCRIPTIONS } from "$lib/types/harness";
import type { ChatStreamPart } from "$lib/types/chat";
import { loadMessages } from "$lib/db/conversations";
import { listRuns } from "$lib/db/runs";
import { homeDir } from "$lib/skills/rust";
import {
  ANTHROPIC_MODEL_PRESETS,
  CLAUDE_CODE_MODEL_PRESETS,
  CODEX_MODEL_PRESETS,
  CURSOR_MODEL_PRESETS,
  type ModelPreset,
} from "$lib/harnesses/presets";

import {
  decideDeferral,
  extractDiscoveredToolNames,
  formatDeferredToolsMessage,
  getToolSearchTool,
  markToolsDeferred,
  TOOL_SEARCH_BETA_HEADER,
} from "./deferred-tools";
import { historyToModelMessages } from "./history-projection";
import {
  applyLastToolCacheBreakpoint,
  injectHistoryCacheBreakpoint,
} from "./prompt-cache";
import { getOrchestratorTools } from "./tools";
import { loadOrchestratorPrompt } from "./prompts";
import { getModuleContributions } from "$lib/modules/integration";

const MAX_STEPS = 50;
const HISTORY_LIMIT = 100;

export interface OrchestratorTurnInput {
  conversationId: string;
  /** Absolute working directory of this session. Injected into the system
   *  prompt's Environment block and handed to spawned delegates so the
   *  orchestrator is grounded in a real path instead of guessing. */
  workingDirectory: string;
  userMessage: string;
  attachments?: Array<{ filename: string; mediaType: string; sizeBytes: number }>;
  /** The orchestrator model, built once by the caller (see
   *  `buildOrchestratorModel` in `$lib/harnesses`). */
  orchestratorModel: LanguageModelV3;
  /** True when the orchestrator model is an Anthropic provider. Gates the
   *  deferred-tool-loading mechanism (Anthropic-specific). */
  isAnthropic: boolean;
  /** Resolve a delegate harness. Called once per `delegate_task` tool call —
   *  passes the optional `harness` field from the tool input so the
   *  orchestrator can route different tasks to different delegates. Returns
   *  null when no usable delegate is configured. */
  resolveDelegateHarness: (preferredName?: string) => LLMHarness | null;
  /** Configs known to the orchestrator, used to build the "Available
   *  delegates" roster in the system prompt. */
  delegateRosterConfigs: HarnessConfig[];
  /** Optional callback fired before each LLM step inside the turn.
   *  Lets the caller inject extra user-role messages into the next
   *  step's input — used today by the orchestrator chat store to
   *  drain background-delegate completion notifications mid-turn at
   *  round boundaries (instead of waiting for the turn to end). The
   *  return value's `messages` REPLACES the SDK's messages for that
   *  step, so the implementation should generally append, not
   *  overwrite. Return `null`/`undefined` to leave the step
   *  untouched. See `chat.svelte.ts` for the production wiring. */
  onPrepareStep?: (input: {
    stepNumber: number;
    messages: ModelMessage[];
  }) => { messages?: ModelMessage[] } | null | undefined;
  signal?: AbortSignal;
}

/** Per-harness-type catalog of swappable models the orchestrator can
 *  pick via `delegate_task`'s `model` field. Returns an empty array
 *  for harness types where the model is bound at configure-time and
 *  not meaningfully overridable per call (anthropic + openai-compatible
 *  expose lots of models too, but the per-delegation override fits
 *  better for the agentic harnesses where the same harness can route
 *  through different models for different sub-tasks). */
function availableModelsFor(type: HarnessType): ModelPreset[] {
  switch (type) {
    case "anthropic":
      return ANTHROPIC_MODEL_PRESETS;
    case "claude-code":
      return CLAUDE_CODE_MODEL_PRESETS;
    case "codex":
      return CODEX_MODEL_PRESETS;
    case "cursor":
      return CURSOR_MODEL_PRESETS;
    case "openai-compatible":
      return [];
  }
}

/** Build a markdown roster of delegate-capable harnesses the orchestrator
 *  can route to. Appended to the system prompt at call time so the model
 *  sees the current configuration (a new harness is visible without an
 *  app restart). */
function buildDelegateRoster(configs: HarnessConfig[]): string {
  if (configs.length === 0) return "";
  const lines: string[] = [];
  lines.push("## Available delegates");
  lines.push(
    "Use the `delegate_task` tool's `harness` field with one of the names below to route a task to a specific delegate. Omit `harness` to use the default. Pass `model` to override the harness's configured default model for a single call — useful when the same harness can route through different models for different kinds of work.",
  );
  lines.push(
    "Each delegate is one of two **kinds** — match the kind to the work (spawn several general delegates in parallel with different roles when useful, e.g. one tutor per chapter):",
  );
  // State each kind's full description once (only for kinds actually
  // configured), then tag each entry with just its kind. Repeating the full
  // description per entry would re-send the same ~60 words for every delegate
  // on every turn.
  const kindsPresent = new Set(configs.map((c) => harnessKind(c.type)));
  for (const k of ["sealed", "general"] as const) {
    if (kindsPresent.has(k)) {
      const label = k === "sealed" ? "sealed coding agent" : "general model";
      lines.push(`- **${label}** — ${HARNESS_KIND_DESCRIPTIONS[k]}`);
    }
  }
  for (const cfg of configs) {
    const tags: string[] = [];
    const kind = harnessKind(cfg.type);
    tags.push(kind === "sealed" ? "sealed coding agent" : "general model");
    tags.push(cfg.type);
    if (cfg.model) tags.push(`default model=${cfg.model}`);
    if (cfg.isDelegateDefault) tags.push("DEFAULT");
    lines.push(`- **${cfg.name}** (${tags.join(", ")})`);
    if (cfg.description) {
      lines.push(`  - ${cfg.description}`);
    }
    const models = availableModelsFor(cfg.type);
    if (models.length > 0) {
      const ids = models
        .map((m) => (m.hint ? `${m.model} (${m.hint})` : m.model))
        .join(", ");
      lines.push(`  - Available models for the \`model\` override: ${ids}`);
    }
  }
  return lines.join("\n");
}

/** Build a markdown table of active delegate runs in this conversation,
 *  injected into the system prompt on every turn. Gives the orchestrator
 *  ambient awareness of runs it has spawned across prior turns without a
 *  tool call. */
async function buildActiveRoster(conversationId: string): Promise<string> {
  const runs = await listRuns(conversationId, { limit: 50 });
  if (runs.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Active delegate runs");
  lines.push(
    "These are all delegate runs spawned in this conversation. " +
      "Use `message_delegate` to send a follow-up to a named delegate, or " +
      "`get_delegate_history` to inspect the detail of what a delegate did. " +
      "Reference delegates by `name` (if set) or `runId`. " +
      "Spawn a new delegate with `delegate_task` — do not reuse a run for an unrelated task.",
  );
  lines.push("");
  lines.push("| Name | Run ID | Status | Summary |");
  lines.push("|------|--------|--------|---------|");

  for (const run of runs) {
    const name = run.name ?? "—";
    const rawSummary = run.summary ?? "—";
    const summary =
      rawSummary.length > 80
        ? rawSummary.slice(0, 77).replace(/\n/g, " ") + "…"
        : rawSummary.replace(/\n/g, " ");
    lines.push(`| ${name} | ${run.id} | ${run.status} | ${summary} |`);
  }

  return lines.join("\n");
}

/** Ground the orchestrator in the session's real location. Without this
 *  the model has no filesystem context and invents paths. */
async function buildEnvironment(workingDirectory: string): Promise<string> {
  const home = (await homeDir()) ?? "";
  const platform =
    typeof navigator === "undefined"
      ? "unknown"
      : /Mac/i.test(navigator.platform)
        ? "macOS (darwin)"
        : /Win/i.test(navigator.platform)
          ? "Windows"
          : /Linux/i.test(navigator.platform)
            ? "Linux"
            : "unknown";
  const lines = ["## Environment", `- Platform: ${platform}`];
  if (home) lines.push(`- Home directory: ${home}`);
  lines.push(`- Working directory: ${workingDirectory}`);
  lines.push(
    'Treat the working directory as the base for all filesystem work. The `read_file` and `list_files` tools accept paths relative to it (use "." for the directory itself), and any delegate you spawn inherits it. Do not guess or invent paths — if you need to know what is in the working directory, list it.',
  );
  return lines.join("\n");
}

export async function* streamOrchestratorTurn(
  input: OrchestratorTurnInput,
): AsyncIterable<ChatStreamPart> {
  const history = await loadMessages(input.conversationId, HISTORY_LIMIT);
  const moduleCtx = {
    conversationId: input.conversationId,
    workingDirectory: input.workingDirectory,
    signal: input.signal,
  };
  const [baseSystemPrompt, environment, activeRoster, moduleContributions] =
    await Promise.all([
      loadOrchestratorPrompt(),
      buildEnvironment(input.workingDirectory),
      buildActiveRoster(input.conversationId),
      getModuleContributions(moduleCtx),
    ]);
  const delegateRoster = buildDelegateRoster(input.delegateRosterConfigs);
  const systemPrompt = [
    baseSystemPrompt,
    environment,
    delegateRoster,
    activeRoster,
    ...moduleContributions.promptFragments,
  ]
    .filter(Boolean)
    .join("\n\n");

  const orchestratorTools = getOrchestratorTools({
    resolveDelegateHarness: input.resolveDelegateHarness,
    conversationId: input.conversationId,
    workingDirectory: input.workingDirectory,
    signal: input.signal,
  });
  const essential = {
    ...orchestratorTools.essential,
    ...moduleContributions.tools,
  };
  const connector = orchestratorTools.connector;

  const messages = historyToModelMessages(history);
  messages.push({ role: "user", content: input.userMessage });

  // Decide whether to defer the connector tool schemas. Anthropic-only;
  // dormant whenever the connector budget is small or we're on OpenAI.
  // Today `connector` is empty so this returns inactive, but the plumbing
  // is here for when we add MCP / filesystem / git tool sets.
  const decision = decideDeferral({
    deferrableTools: connector,
    isAnthropic: input.isAnthropic,
  });

  let tools: typeof essential;
  const providerOptions: SharedV3ProviderOptions = {};
  if (decision.active) {
    const discovered = extractDiscoveredToolNames(messages);
    const allTools: typeof essential = { ...essential, ...connector };
    const deferredConnector = markToolsDeferred(connector, discovered);
    const toolSearch = getToolSearchTool(deferredConnector, allTools);
    tools = { ...essential, ...deferredConnector, ...toolSearch };

    const announcement = formatDeferredToolsMessage(deferredConnector);
    if (announcement) {
      messages.unshift({ role: "user", content: announcement });
    }

    // Beta is needed server-side to expand `tool_reference` blocks into
    // full tool schemas. Passed via providerOptions so the SDK's Anthropic
    // provider merges it into the `anthropic-beta` header on the wire.
    providerOptions.anthropic = {
      ...(providerOptions.anthropic ?? {}),
      betas: [TOOL_SEARCH_BETA_HEADER],
    };
  } else {
    tools = { ...essential, ...connector };
  }

  // Three cache breakpoints for Anthropic — cuts billed input tokens
  // dramatically on multi-turn conversations and tool-heavy turns:
  //
  //   1. System prompt:  pass as a SystemModelMessage with cacheControl
  //                      (the streamText `system: string` form has no hook
  //                      to attach providerOptions — the upstream app does the same).
  //   2. Last tool:      stamp the final function tool — Anthropic caches
  //                      everything up to that marker as one prefix.
  //   3. Last assistant: stamp the most recent assistant turn in history —
  //                      stable prefix; the new user turn appended below is
  //                      the only volatile part.
  //
  // Non-Anthropic providers ignore providerOptions.anthropic entirely so
  // the helpers are safe to call unconditionally, but we gate on
  // isAnthropic to keep the prompt structure simpler for OpenAI-compat.
  let finalMessages: ModelMessage[] = messages;
  let finalTools = tools;
  if (input.isAnthropic) {
    finalTools = applyLastToolCacheBreakpoint(tools);
    finalMessages = injectHistoryCacheBreakpoint(messages);
    finalMessages = [
      {
        role: "system",
        content: systemPrompt,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
      ...finalMessages,
    ];
  }

  const result = streamText({
    model: input.orchestratorModel,
    // Pass system only when we haven't already prepended it as a cached
    // SystemModelMessage above — otherwise the SDK would double up.
    system: input.isAnthropic ? undefined : systemPrompt,
    messages: finalMessages,
    tools: finalTools,
    providerOptions:
      Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
    stopWhen: stepCountIs(MAX_STEPS),
    abortSignal: input.signal,
    // Mid-turn injection hook. Fires before every LLM step (including
    // step 0). The caller can inject extra user-role messages into the
    // step's input — used today for background-delegate completion
    // notifications that arrived between rounds, so the orchestrator
    // sees them at the next round boundary instead of having to wait
    // for the turn to finish. The SDK uses the returned `messages` for
    // this step's LLM call.
    ...(input.onPrepareStep
      ? {
          prepareStep: ({ stepNumber, messages }) => {
            const override = input.onPrepareStep?.({ stepNumber, messages });
            if (!override) return undefined;
            return override;
          },
        }
      : {}),
  });

  yield* result.fullStream;
}

