// Orchestrator chat store factory. Each session (one conversation rooted
// in a working directory) gets its own ChatStore instance plus its own
// background-completion subscription, created by `createOrchestratorChatStore`
// and torn down by the returned `dispose`. The run-detail page builds its
// own ChatStore against a runId the same way — see
// conversations/[id]/+page.svelte.

import type { ModelMessage } from "ai";

import { ChatStore } from "./chat-store.svelte";
import { harnesses } from "./harnesses.svelte";
import { buildOrchestratorModel } from "$lib/harnesses";
import { streamOrchestratorTurn } from "$lib/agent/loop";
import {
  appendMessage,
  createConversation,
  loadMessages,
} from "$lib/db/conversations";
import {
  claimRunsForNotification,
  listUnnotifiedRuns,
} from "$lib/db/runs";
import {
  subscribeToRunCompletions,
  type RunCompletionEvent,
} from "$lib/db/run-events";
import { selectSweepNotifications } from "$lib/agent/completion-sweep";
import type { RunSummary } from "$lib/types/run";

const HISTORY_LIMIT = 100;

export interface OrchestratorChatStoreOptions {
  /** Existing session id, or null for a draft — the conversation row is
   *  created lazily on the first send, so an untouched draft never shows
   *  up in the sidebar. */
  conversationId: string | null;
  /** Latest working directory. A getter (not a value) so a draft reflects
   *  whatever folder the user picked via the chip before sending. */
  getWorkingDirectory: () => string;
  /** Draft mode only: called with the new id immediately after the
   *  conversation is created on first send. The page uses it to swap the
   *  URL to /sessions/[id] and refresh the sidebar. */
  onConversationCreated?: (id: string) => void;
}

function deriveTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "New chat";
  if (!firstLine) return "New chat";
  return firstLine.length > 60 ? firstLine.slice(0, 57) + "…" : firstLine;
}

// Completions can arrive in bursts when parallel delegates finish
// near-simultaneously. Debounce ~500ms and batch into one notification so
// the orchestrator sees them as a coherent group rather than firing N
// back-to-back turns.
const COMPLETION_DEBOUNCE_MS = 500;

export interface OrchestratorChatStore {
  store: ChatStore;
  /** Reconcile delegate runs that reached a terminal state while this
   *  session wasn't mounted (user on another page at completion, or an app
   *  restart), enqueuing ONE batched "[Background delegate update]" for the
   *  un-notified ones. MUST be called AFTER `store.hydrate()` — it appends a
   *  system bubble, and hydrate replaces the message list wholesale, so a
   *  bubble enqueued before hydrate resolves would be wiped. Idempotent and
   *  safe to await; the persisted flag guards against re-notifying. */
  notifyBackgroundCompletions: () => Promise<void>;
  /** Unsubscribe from completions and clear the pending-flush timer. The
   *  session page calls this on unmount / when the session id changes. */
  dispose: () => void;
}

/**
 * Build an orchestrator-bound ChatStore for one session. `conversationId`
 * scopes history, persistence, spawned-delegate nesting, and the
 * background-completion subscription; `workingDirectory` grounds the
 * orchestrator (Environment block) and the delegates it spawns.
 */
export function createOrchestratorChatStore(
  options: OrchestratorChatStoreOptions,
): OrchestratorChatStore {
  // Mutable so draft mode can fill it in on first send; the completion
  // subscription below reads it live.
  let conversationId: string | null = options.conversationId;
  // Debounce timer coalescing bursts of live completion events into one
  // sweep (closed over so two sessions don't share it).
  let completionFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // Serializes sweeps for this store. A sweep's DB claim is a SELECT-then-
  // UPDATE pair; chaining every sweep after the previous one guarantees two
  // sweeps (e.g. the post-hydrate reconcile and a live completion arriving at
  // the same moment) can't interleave and both notify the same run.
  let sweepChain: Promise<void> = Promise.resolve();

  const store: ChatStore = new ChatStore({
    async loadHistory() {
      return conversationId
        ? await loadMessages(conversationId, HISTORY_LIMIT)
        : [];
    },

    async *send({ text, attachments, skillExpandedBody }) {
      const orchestratorConfig = harnesses.orchestratorConfig;
      if (!orchestratorConfig) {
        yield {
          type: "error",
          error:
            "No orchestrator harness configured. Go to Settings → Harnesses and add one.",
        };
        return;
      }
      let orchestratorModel;
      try {
        orchestratorModel = await buildOrchestratorModel(orchestratorConfig);
      } catch (err) {
        yield {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        };
        return;
      }
      if (!orchestratorModel) {
        yield {
          type: "error",
          error: `Harness "${orchestratorConfig.name}" can't run as the orchestrator — Claude Code and Codex run their own internal agent loops with their own tool sets, so they can only be delegates. Choose an Anthropic or OpenAI-compatible harness as the orchestrator in Settings (it's the agent that talks to you and decides which delegates to spawn).`,
        };
        return;
      }

      const workingDirectory = options.getWorkingDirectory();
      // Draft mode: only now — once we know we can actually run — do we
      // create the conversation row, so an untouched draft never lands in
      // the sidebar. Subsequent sends reuse the id.
      if (!conversationId) {
        conversationId = await createConversation({
          workingDirectory,
          title: deriveTitle(text),
        });
        options.onConversationCreated?.(conversationId);
      }

      const attachmentMeta = attachments?.length
        ? attachments.map((a) => ({
            filename: a.filename,
            mediaType: a.mediaType,
            sizeBytes: a.sizeBytes,
          }))
        : undefined;
      // Inline skill execution: when the user invokes a skill, the model
      // sees the literal `/command` text AND the materialised body joined
      // with a blank line. The user-facing bubble stays the literal text.
      const modelInputText = skillExpandedBody
        ? `${text}\n\n${skillExpandedBody}`
        : text;
      yield* streamOrchestratorTurn({
        conversationId,
        workingDirectory,
        userMessage: modelInputText,
        attachments: attachmentMeta,
        orchestratorModel,
        isAnthropic: orchestratorConfig.type === "anthropic",
        // The orchestrator may pass an explicit `harness` field in each
        // delegate_task tool call to pick which delegate handles it. We
        // try that first, fall back to the default delegate, and finally
        // to null (which makes the runner surface a clear error).
        resolveDelegateHarness: (preferredName) => {
          if (preferredName) {
            const named = harnesses.resolveByNameOrId(preferredName);
            if (named) return named;
          }
          return harnesses.resolveDelegate();
        },
        delegateRosterConfigs: harnesses.findConfigsByDelegateRole(),
        // Mid-turn injection of background-delegate completion
        // notifications: drain any queued system-event items at each
        // step boundary so the orchestrator reacts immediately instead
        // of waiting for the turn to end. Consumed items are removed
        // from the queue so the post-turn drain won't re-fire them.
        onPrepareStep: ({ messages }) => {
          const pending = store.consumePendingSystemEvents();
          if (pending.length === 0) return undefined;
          const injected: ModelMessage[] = pending.map((evt) => ({
            role: "user",
            content: evt.text,
          }));
          return { messages: [...messages, ...injected] };
        },
      });
    },

    async onTurnFinalized(userMessage, assistantMessage) {
      // conversationId is always set by now (send creates it before
      // streaming). Persist user first so the next turn's history load
      // includes it, then the assistant. Best-effort.
      if (!conversationId) return;
      await appendMessage(conversationId, userMessage).catch(() => {});
      await appendMessage(conversationId, assistantMessage).catch(() => {});
    },
  });

  // The single completion-notification path, shared by the post-hydrate
  // reconcile and the live run-events bus. Reads the conversation's
  // un-notified runs from the DB (the authoritative source — not a fleeting
  // event payload), applies the pure terminal/TUI policy, atomically claims
  // the survivors, and enqueues ONE batched notification for exactly the runs
  // this call claimed. The persisted `completion_notified` flag is the only
  // dedupe guard, so remount / replay / two near-simultaneous completions all
  // resolve to at most one notification per run.
  async function runSweep(): Promise<void> {
    if (!conversationId) return; // draft session — no runs yet
    let candidates: RunSummary[];
    try {
      const runs = await listUnnotifiedRuns(conversationId);
      candidates = selectSweepNotifications(runs);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[chat] completion sweep query failed", err);
      return;
    }
    if (candidates.length === 0) return;
    let claimed: string[];
    try {
      claimed = await claimRunsForNotification(candidates.map((r) => r.id));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[chat] completion claim failed", err);
      return;
    }
    const claimedSet = new Set(claimed);
    const toNotify = candidates.filter((r) => claimedSet.has(r.id));
    if (toNotify.length === 0) return;
    store.enqueueSystemNotification(
      formatCompletionNotification(toNotify.map(runToCompletionEvent)),
    );
  }

  function sweep(): Promise<void> {
    const next = sweepChain.then(runSweep, runSweep);
    sweepChain = next.catch(() => {});
    return next;
  }

  const unsubscribe = subscribeToRunCompletions((event) => {
    if (event.conversationId !== conversationId) return;
    // Coalesce bursts, then sweep the DB rather than trust this event's
    // payload — same code path (and same dedupe flag) as the hydrate sweep.
    if (completionFlushTimer) clearTimeout(completionFlushTimer);
    completionFlushTimer = setTimeout(() => {
      completionFlushTimer = null;
      void sweep();
    }, COMPLETION_DEBOUNCE_MS);
  });

  function dispose(): void {
    unsubscribe();
    if (completionFlushTimer) {
      clearTimeout(completionFlushTimer);
      completionFlushTimer = null;
    }
  }

  return { store, notifyBackgroundCompletions: sweep, dispose };
}

/** Resolve a display name for the harness that ran a delegate. Prefers the
 *  live config's name; falls back to the stored id / type if the config was
 *  since removed. Used only for the notification's human-readable text. */
function resolveHarnessName(run: RunSummary): string {
  if (run.delegateHarnessId) {
    const cfg = harnesses.configs.find((c) => c.id === run.delegateHarnessId);
    if (cfg) return cfg.name;
  }
  return run.delegateHarnessId ?? run.delegateType ?? "unknown harness";
}

/** Project a persisted run into the completion-event shape
 *  `formatCompletionNotification` consumes, so the sweep and the live bus
 *  render identical notification text. */
function runToCompletionEvent(run: RunSummary): RunCompletionEvent {
  return {
    runId: run.id,
    name: run.name ?? null,
    conversationId: run.conversationId,
    status: run.status,
    summary: run.summary ?? null,
    harnessName: resolveHarnessName(run),
  };
}

function formatCompletionNotification(batch: RunCompletionEvent[]): string {
  const header =
    batch.length === 1
      ? `[Background delegate update] 1 delegate just finished:`
      : `[Background delegate update] ${batch.length} delegates just finished:`;
  const lines = batch.map((evt) => {
    const label = evt.name ? `"${evt.name}"` : `(runId ${evt.runId})`;
    const summary = evt.summary
      ? ` Summary: ${evt.summary.length > 280 ? evt.summary.slice(0, 280) + "…" : evt.summary}`
      : " (no text output — check tool calls via get_delegate_history if relevant.)";
    return `- Delegate ${label} on harness "${evt.harnessName}" finished with status ${evt.status}.${summary}`;
  });
  const footer =
    `\nThis is a system-generated notification — not a user request. Decide whether to act on these completions based on what the user previously asked for. To USE a delegate's actual output (quote it, build on it, hand off to another delegate), call get_delegate_history(name or runId) first; the summaries above are a preview only.`;
  return [header, ...lines, footer].join("\n");
}
