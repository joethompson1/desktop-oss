import type { LLMHarness, ChatMessage } from "$lib/types/harness";
import type { ChatStreamPart } from "$lib/types/chat";
import type { DelegateResult, HarnessStreamPart, RunStatus } from "$lib/types/run";
import { isRunEventPart, runEventPartToChunk } from "$lib/types/run";
import {
  appendChunk,
  createRun,
  getRun,
  getRunChunks,
  updateHarnessSessionId,
  updateContextSummary,
  updateRunStatus,
} from "$lib/db/runs";
import {
  emitRunCompletion,
  emitRunTextDelta,
} from "$lib/db/run-events";
import { getOrchestratorConversationId } from "$lib/db/conversations";
import { loadDelegatePrompt } from "./prompts";

// Once a run accumulates more than this many reconstructed messages, a
// rolling context summary is generated after each turn. The last
// CONTEXT_TAIL messages are kept as raw history; everything older is
// compressed into contextSummary.
const SUMMARY_THRESHOLD = 30;
const CONTEXT_TAIL = 10;

export interface DelegateInput {
  task: string;
  context?: string;
  filesOfInterest?: string[];
  /** Optional label for this run. When set, the orchestrator can reference
   *  this delegate later via message_delegate or get_delegate_history using
   *  the name instead of the generated run ID. Names should be short and
   *  descriptive (e.g. "researcher", "coder", "reviewer"). Unique within a
   *  conversation — if a name is reused the most recent run wins. */
  name?: string;
  /** Optional model override for this run. Threads through to the
   *  harness's `streamChat(model)` so the orchestrator can pick a
   *  different model than the harness's configured default — e.g.
   *  spawn Codex with gpt-5.5 for planning then Codex with the local
   *  Qwen3 profile for implementation, on the same harness. Ignored
   *  by harnesses that don't support per-call model overrides. */
  model?: string;
  /** Working directory of the spawning session. Surfaced in the brief so
   *  the delegate resolves filesystem work against the same root the
   *  orchestrator is grounded in, instead of guessing. */
  workingDirectory?: string;
  /** Optional pre-allocated run ID. When set, `runDelegate` uses this
   *  instead of generating its own. The non-blocking `delegate_task`
   *  tool uses this so it can return the runId to the orchestrator
   *  synchronously and kick off the actual execution in the
   *  background. Caller is responsible for uniqueness. */
  runId?: string;
}

export interface DelegateRunnerDeps {
  resolveDelegateHarness: () => LLMHarness | null;
  /** Conversation (session) the spawning orchestrator belongs to. The run
   *  is created under this id so it nests beneath the right session in the
   *  sidebar. Falls back to the legacy singleton when absent (e.g. tests). */
  conversationId?: string;
  parentMessageId?: string;
  toolCallId: string;
}

export async function runDelegate(
  input: DelegateInput,
  deps: DelegateRunnerDeps,
): Promise<DelegateResult> {
  const harness = deps.resolveDelegateHarness();
  if (!harness) {
    throw new Error(
      "No delegate harness configured. Add one in Settings and mark it as the delegate default.",
    );
  }
  // eslint-disable-next-line no-console
  console.debug("[delegate] dispatching to harness:", {
    id: harness.id,
    name: harness.name,
    type: harness.type,
    baseUrl: harness.config.baseUrl,
    model: harness.config.model,
  });

  const runId =
    input.runId ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const conversationId = deps.conversationId ?? getOrchestratorConversationId();
  const title = truncateTitle(input.task);
  const startedAt = performance.now();

  await createRun({
    id: runId,
    conversationId,
    parentMessageId: deps.parentMessageId,
    toolCallId: deps.toolCallId,
    name: input.name,
    title,
    delegateHarnessId: harness.id,
    delegateType: harness.type,
  });
  await updateRunStatus(runId, "RUNNING");

  const systemPrompt = await loadDelegatePrompt();
  const brief = buildDelegateBrief(input);
  const messages: ChatMessage[] = [{ role: "user", content: brief }];

  await appendChunk({ runId, kind: "user_message", text: brief });

  let assistantText = "";
  let status: RunStatus = "RUNNING";
  let errorText: string | undefined;
  let textBuffer: Record<string, string> = {};

  try {
    for await (const chunk of harness.streamChat({
      messages,
      systemPrompt,
      ...(input.model ? { model: input.model } : {}),
      onSessionInfo: ({ sessionId }) => {
        // Fire-and-forget — store the harness's session token so
        // follow-up turns can resume the same provider-side session.
        // Failures here are non-fatal (we'd just continue without
        // resume support).
        void updateHarnessSessionId(runId, sessionId).catch(() => {});
      },
    })) {
      if (await persistIfRunEvent(runId, chunk)) continue;
      if (chunk.type === "text-start") {
        textBuffer[chunk.id] = "";
      } else if (chunk.type === "text-delta") {
        textBuffer[chunk.id] = (textBuffer[chunk.id] ?? "") + chunk.text;
        emitRunTextDelta(runId, chunk.text);
      } else if (chunk.type === "text-end") {
        const segment = textBuffer[chunk.id] ?? "";
        if (segment.length > 0) {
          assistantText += (assistantText ? "\n\n" : "") + segment;
          await appendChunk({ runId, kind: "assistant_text", text: segment });
        }
        delete textBuffer[chunk.id];
      } else if (chunk.type === "tool-call") {
        await appendChunk({
          runId,
          kind: "tool_call",
          text: JSON.stringify({
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            input: chunk.input,
          }),
        });
      } else if (chunk.type === "tool-result") {
        await appendChunk({
          runId,
          kind: "tool_result",
          text: JSON.stringify({
            toolCallId: chunk.toolCallId,
            output: chunk.output,
          }),
        });
      } else if (chunk.type === "error") {
        errorText = errorToText(chunk.error);
        status = "FAILED";
        await appendChunk({ runId, kind: "stderr", text: errorText });
        break;
      } else if (chunk.type === "finish") {
        status = "SUCCEEDED";
      }
    }
    if (status === "RUNNING") status = "SUCCEEDED";
  } catch (err) {
    errorText = err instanceof Error ? err.message : "Delegate failed";
    status = "FAILED";
    await appendChunk({ runId, kind: "stderr", text: errorText });
  }

  for (const segment of Object.values(textBuffer)) {
    if (segment.length > 0) {
      assistantText += (assistantText ? "\n\n" : "") + segment;
      await appendChunk({ runId, kind: "assistant_text", text: segment });
    }
  }

  const summary = assistantText.trim() || errorText || "(no output)";
  const durationMs = Math.round(performance.now() - startedAt);
  const filesChanged = extractFilesChanged(assistantText);

  await updateRunStatus(runId, status, { summary, filesChanged });

  // Fire a completion event so the orchestrator chat store can enqueue
  // a synthetic notification turn. Only initial-spawn runs (this
  // function) fire this — `continueRun` is awaited by the orchestrator
  // already, so a notification would be redundant. Errors caught so a
  // listener throw doesn't break the run-finalization path.
  try {
    emitRunCompletion({
      runId,
      name: input.name ?? null,
      conversationId,
      status,
      summary: assistantText.trim() || errorText || null,
      harnessName: harness.name,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[delegate] emitRunCompletion threw:", err);
  }

  // Non-fatal: if this run is already long enough to warrant a rolling
  // summary, generate one now so subsequent continuations stay bounded.
  const allMessages = await loadRunMessages(runId);
  await maybeUpdateContextSummary(runId, allMessages, harness).catch(() => {});

  return {
    runId,
    status,
    summary,
    filesChanged,
    durationMs,
    harness: { id: harness.id, name: harness.name, type: harness.type },
  };
}

function errorToText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * If `chunk` is a normalized run-event (todo / usage / turn), persist it as
 * its matching structured chunk kind and return true so the caller skips its
 * regular text/tool handling. Returns false for ordinary AI SDK stream parts.
 *
 * Shared by the three delegate stream loops (initial spawn, orchestrator
 * continuation, UI continuation) so the run-event → chunk mapping lives in
 * exactly one place.
 */
async function persistIfRunEvent(
  runId: string,
  chunk: HarnessStreamPart,
): Promise<boolean> {
  if (!isRunEventPart(chunk)) return false;
  const { kind, text } = runEventPartToChunk(chunk);
  await appendChunk({ runId, kind, text });
  return true;
}

function buildDelegateBrief(input: DelegateInput): string {
  const lines: string[] = [`# Task\n${input.task.trim()}`];
  if (input.workingDirectory && input.workingDirectory.trim()) {
    lines.push(
      `\n# Working directory\nResolve relative paths and run filesystem work against:\n${input.workingDirectory.trim()}`,
    );
  }
  if (input.context && input.context.trim()) {
    lines.push(`\n# Context\n${input.context.trim()}`);
  }
  if (input.filesOfInterest && input.filesOfInterest.length > 0) {
    lines.push(
      `\n# Files of interest\n${input.filesOfInterest.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  return lines.join("\n");
}

function truncateTitle(task: string): string {
  const firstLine = task.split("\n")[0]?.trim() ?? "Delegate task";
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine;
}

function extractFilesChanged(text: string): string[] {
  const match = text.match(/files? changed[:\n]([\s\S]*?)(\n\n|$)/i);
  if (!match) return [];
  const block = match[1];
  return block
    .split("\n")
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter((l) => l.length > 0 && l.length < 200);
}

/**
 * Reconstruct the full multi-turn message history for a delegate run from
 * its persisted chunks. user_message → user role; sequences of
 * assistant_text / tool_call / tool_result collapse into one assistant turn.
 */
async function loadRunMessages(runId: string): Promise<ChatMessage[]> {
  const chunks = await getRunChunks(runId);
  const messages: ChatMessage[] = [];
  let pendingAssistantText: string[] = [];
  let pendingToolCalls: Array<{ id: string; name: string; input: unknown }> = [];

  const flushAssistant = () => {
    if (pendingAssistantText.length === 0 && pendingToolCalls.length === 0) return;
    messages.push({
      role: "assistant",
      content: pendingAssistantText.join(""),
      toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
    });
    pendingAssistantText = [];
    pendingToolCalls = [];
  };

  for (const chunk of chunks) {
    if (chunk.kind === "user_message") {
      flushAssistant();
      messages.push({ role: "user", content: chunk.text });
    } else if (chunk.kind === "assistant_text") {
      pendingAssistantText.push(chunk.text);
    } else if (chunk.kind === "tool_call") {
      try {
        const parsed = JSON.parse(chunk.text) as {
          toolName?: string;
          toolCallId?: string;
          input?: unknown;
        };
        if (parsed.toolCallId && parsed.toolName) {
          pendingToolCalls.push({
            id: parsed.toolCallId,
            name: parsed.toolName,
            input: parsed.input ?? {},
          });
        }
      } catch {
        // skip malformed
      }
    } else if (chunk.kind === "tool_result") {
      flushAssistant();
      try {
        const parsed = JSON.parse(chunk.text) as {
          toolCallId?: string;
          output?: unknown;
        };
        messages.push({
          role: "tool",
          toolCallId: parsed.toolCallId ?? "",
          content:
            typeof parsed.output === "string"
              ? parsed.output
              : JSON.stringify(parsed.output ?? {}),
        });
      } catch {
        // skip
      }
    }
    // thinking / stderr / system: not part of wire history
  }
  flushAssistant();
  return messages;
}

/**
 * Given the full reconstructed message list for a run, apply the rolling
 * context window: if there is an existing contextSummary and more than
 * CONTEXT_TAIL messages, replace the older portion with a synthetic
 * summary pair so the harness call stays within a predictable token budget.
 *
 * When no contextSummary exists (the run is still short), returns the
 * messages unchanged.
 */
function buildBoundedMessages(
  allMessages: ChatMessage[],
  contextSummary: string | undefined,
): ChatMessage[] {
  if (!contextSummary || allMessages.length <= CONTEXT_TAIL) {
    return allMessages;
  }
  const tail = allMessages.slice(-CONTEXT_TAIL);
  return [
    {
      role: "user",
      content: `[Summary of prior conversation]\n${contextSummary}`,
    },
    {
      role: "assistant",
      content:
        "Understood. I have the context summary from our prior conversation and will continue from there.",
    },
    ...tail,
  ];
}

/**
 * After each delegate turn, check whether the run has grown long enough
 * to warrant a rolling context summary. If so, call the harness with a
 * compact summarisation prompt and persist the result.
 *
 * Only the portion of history older than CONTEXT_TAIL messages is
 * summarised — the recent tail is kept verbatim. The summary covers
 * everything from the start of the run up to (but not including) the tail,
 * so it always reflects the latest state of the conversation.
 *
 * This is non-fatal: callers should .catch(() => {}) so a failed summary
 * call does not abort the delegate turn.
 */
async function maybeUpdateContextSummary(
  runId: string,
  allMessages: ChatMessage[],
  harness: LLMHarness,
): Promise<void> {
  if (allMessages.length <= SUMMARY_THRESHOLD) return;

  const toSummarise = allMessages.slice(0, -CONTEXT_TAIL);
  const formatted = toSummarise
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  let summaryText = "";
  const textBuffer: Record<string, string> = {};

  for await (const chunk of harness.streamChat({
    messages: [
      {
        role: "user",
        content: `Summarise the following conversation in 3-5 sentences. Capture key decisions made, work completed, outputs produced, and the current state. Output only the summary with no preamble:\n\n${formatted}`,
      },
    ],
    systemPrompt: "You are a concise summariser. Output only the requested summary.",
  })) {
    if (chunk.type === "text-start") {
      textBuffer[chunk.id] = "";
    } else if (chunk.type === "text-delta") {
      textBuffer[chunk.id] = (textBuffer[chunk.id] ?? "") + chunk.text;
    } else if (chunk.type === "text-end") {
      summaryText += textBuffer[chunk.id] ?? "";
      delete textBuffer[chunk.id];
    }
  }

  for (const seg of Object.values(textBuffer)) summaryText += seg;

  if (summaryText.trim()) {
    await updateContextSummary(runId, summaryText.trim());
  }
}

export interface ContinueRunInput {
  runId: string;
  userMessage: string;
}

export interface ContinueRunDeps {
  resolveDelegateHarness: () => LLMHarness | null;
}

/**
 * Send a follow-up message to an existing delegate run from the orchestrator.
 *
 * Loads the run's prior history with bounded context reconstruction
 * (contextSummary + last CONTEXT_TAIL messages), appends the new user
 * message, streams a fresh reply, and persists the exchange as new chunks.
 *
 * Called by the message_delegate tool in the orchestrator loop.
 * For the UI run-detail page use streamDelegateContinue instead.
 */
export async function continueRun(
  input: ContinueRunInput,
  deps: ContinueRunDeps,
): Promise<{ status: RunStatus; summary: string }> {
  const harness = deps.resolveDelegateHarness();
  if (!harness) {
    throw new Error(
      "No delegate harness configured. Add one in Settings and mark it as the delegate default.",
    );
  }

  const run = await getRun(input.runId);
  // If the harness recorded a session token on the first turn, lean on
  // its native session-resume: skip the reconstructed-history replay
  // and let the provider restore state from disk. The harness receives
  // only the new user message; the prior conversation, tool scratchpad
  // and file checkpoints come back via the session restore on the
  // provider side. This is dramatically cheaper (no re-read, no
  // re-tokenisation of the history) than the replay path used by
  // sessionless harnesses.
  const harnessSessionId = run?.harnessSessionId;
  const history = await loadRunMessages(input.runId);
  const messages: ChatMessage[] = harnessSessionId
    ? [{ role: "user", content: input.userMessage }]
    : [
        ...buildBoundedMessages(history, run?.contextSummary),
        { role: "user", content: input.userMessage },
      ];

  await appendChunk({ runId: input.runId, kind: "user_message", text: input.userMessage });
  await updateRunStatus(input.runId, "RUNNING");

  const systemPrompt = await loadDelegatePrompt();
  let assistantText = "";
  let status: RunStatus = "RUNNING";
  let errorText: string | undefined;
  const textBuffer: Record<string, string> = {};

  try {
    for await (const chunk of harness.streamChat({
      messages,
      systemPrompt,
      resumeSessionId: harnessSessionId,
      onSessionInfo: ({ sessionId }) => {
        void updateHarnessSessionId(input.runId, sessionId).catch(() => {});
      },
    })) {
      if (await persistIfRunEvent(input.runId, chunk)) continue;
      if (chunk.type === "text-start") {
        textBuffer[chunk.id] = "";
      } else if (chunk.type === "text-delta") {
        textBuffer[chunk.id] = (textBuffer[chunk.id] ?? "") + chunk.text;
        emitRunTextDelta(input.runId, chunk.text);
      } else if (chunk.type === "text-end") {
        const segment = textBuffer[chunk.id] ?? "";
        if (segment.length > 0) {
          assistantText += (assistantText ? "\n\n" : "") + segment;
          await appendChunk({ runId: input.runId, kind: "assistant_text", text: segment });
        }
        delete textBuffer[chunk.id];
      } else if (chunk.type === "tool-call") {
        await appendChunk({
          runId: input.runId,
          kind: "tool_call",
          text: JSON.stringify({
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            input: chunk.input,
          }),
        });
      } else if (chunk.type === "tool-result") {
        await appendChunk({
          runId: input.runId,
          kind: "tool_result",
          text: JSON.stringify({
            toolCallId: chunk.toolCallId,
            output: chunk.output,
          }),
        });
      } else if (chunk.type === "error") {
        errorText = errorToText(chunk.error);
        status = "FAILED";
        await appendChunk({ runId: input.runId, kind: "stderr", text: errorText });
        break;
      } else if (chunk.type === "finish") {
        status = "SUCCEEDED";
      }
    }
    if (status === "RUNNING") status = "SUCCEEDED";
  } catch (err) {
    errorText = err instanceof Error ? err.message : "Delegate failed";
    status = "FAILED";
    await appendChunk({ runId: input.runId, kind: "stderr", text: errorText });
  }

  for (const segment of Object.values(textBuffer)) {
    if (segment.length > 0) {
      assistantText += (assistantText ? "\n\n" : "") + segment;
      await appendChunk({ runId: input.runId, kind: "assistant_text", text: segment });
    }
  }

  const summary = assistantText.trim() || errorText || "(no output)";
  await updateRunStatus(input.runId, status, { summary });

  const updatedMessages = await loadRunMessages(input.runId);
  await maybeUpdateContextSummary(input.runId, updatedMessages, harness).catch(() => {});

  return { status, summary };
}

export interface StreamDelegateContinueInput {
  runId: string;
  userMessage: string;
  resolveDelegateHarness: () => LLMHarness | null;
}

/**
 * Generator counterpart to continueRun — same persistence side-effects but
 * also yields each SDK TextStreamPart so the run-detail page's ChatStore
 * can paint the assistant bubble live.
 *
 * Uses the same bounded context reconstruction as continueRun: the prior
 * conversation is represented as contextSummary + last CONTEXT_TAIL messages
 * rather than the full raw history, so very long runs do not balloon the
 * harness's context window.
 */
export async function* streamDelegateContinue(
  input: StreamDelegateContinueInput,
): AsyncIterable<ChatStreamPart> {
  const harness = input.resolveDelegateHarness();
  if (!harness) {
    yield {
      type: "error",
      error:
        "No delegate harness configured. Add one in Settings and mark it as the delegate default.",
    };
    return;
  }

  // Append the user message first so it's included when loadRunMessages
  // reconstructs the full history (the bounded tail will naturally include
  // this new turn at the end).
  await appendChunk({ runId: input.runId, kind: "user_message", text: input.userMessage });
  await updateRunStatus(input.runId, "RUNNING");

  const run = await getRun(input.runId);
  const harnessSessionId = run?.harnessSessionId;
  // Same fork as continueRun: if the harness has a recorded session
  // token, send only the new user message and let the provider restore
  // state. Otherwise, replay the bounded history.
  const messages = harnessSessionId
    ? [{ role: "user" as const, content: input.userMessage }]
    : buildBoundedMessages(
        await loadRunMessages(input.runId),
        run?.contextSummary,
      );
  const systemPrompt = await loadDelegatePrompt();

  let status: RunStatus = "RUNNING";
  let errorText: string | undefined;
  let assistantText = "";
  const textBuffer: Record<string, string> = {};

  try {
    for await (const chunk of harness.streamChat({
      messages,
      systemPrompt,
      resumeSessionId: harnessSessionId,
      onSessionInfo: ({ sessionId }) => {
        void updateHarnessSessionId(input.runId, sessionId).catch(() => {});
      },
    })) {
      // Persist normalized run-events but don't forward them to the
      // consuming ChatStore — it only understands AI SDK stream parts.
      // The passive run-detail refresh path picks them up from the DB.
      // The type predicate also narrows `chunk` back to ChatStreamPart
      // for the `yield` below.
      if (isRunEventPart(chunk)) {
        const { kind, text } = runEventPartToChunk(chunk);
        await appendChunk({ runId: input.runId, kind, text });
        continue;
      }

      yield chunk;

      if (chunk.type === "text-start") {
        textBuffer[chunk.id] = "";
      } else if (chunk.type === "text-delta") {
        textBuffer[chunk.id] = (textBuffer[chunk.id] ?? "") + chunk.text;
        emitRunTextDelta(input.runId, chunk.text);
      } else if (chunk.type === "text-end") {
        const segment = textBuffer[chunk.id] ?? "";
        if (segment.length > 0) {
          assistantText += (assistantText ? "\n\n" : "") + segment;
          await appendChunk({ runId: input.runId, kind: "assistant_text", text: segment });
        }
        delete textBuffer[chunk.id];
      } else if (chunk.type === "tool-call") {
        await appendChunk({
          runId: input.runId,
          kind: "tool_call",
          text: JSON.stringify({
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            input: chunk.input,
          }),
        });
      } else if (chunk.type === "tool-result") {
        await appendChunk({
          runId: input.runId,
          kind: "tool_result",
          text: JSON.stringify({
            toolCallId: chunk.toolCallId,
            output: chunk.output,
          }),
        });
      } else if (chunk.type === "error") {
        errorText = errorToText(chunk.error);
        status = "FAILED";
        await appendChunk({ runId: input.runId, kind: "stderr", text: errorText });
      } else if (chunk.type === "finish") {
        if (status === "RUNNING") status = "SUCCEEDED";
      }
    }
    if (status === "RUNNING") status = "SUCCEEDED";
  } catch (err) {
    errorText = err instanceof Error ? err.message : "Delegate failed";
    status = "FAILED";
    await appendChunk({ runId: input.runId, kind: "stderr", text: errorText });
    yield { type: "error", error: errorText };
  }

  for (const segment of Object.values(textBuffer)) {
    if (segment.length > 0) {
      assistantText += (assistantText ? "\n\n" : "") + segment;
      await appendChunk({ runId: input.runId, kind: "assistant_text", text: segment });
    }
  }

  const summary = assistantText.trim() || errorText || "(no output)";
  await updateRunStatus(input.runId, status, { summary });

  const updatedMessages = await loadRunMessages(input.runId);
  await maybeUpdateContextSummary(input.runId, updatedMessages, harness).catch(() => {});
}

/**
 * Return the bounded conversation history for a delegate run, for use by
 * the get_delegate_history orchestrator tool.
 *
 * Returns the last `tailSize` reconstructed messages. When the run has a
 * contextSummary the caller should surface that alongside the recent messages
 * so the orchestrator has a coherent picture of the full conversation.
 */
export async function getRunHistoryForOrchestrator(
  runId: string,
  tailSize: number,
): Promise<ChatMessage[]> {
  const allMessages = await loadRunMessages(runId);
  return allMessages.slice(-tailSize);
}
