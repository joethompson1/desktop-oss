// In-process event bus for live run updates.
//
// The orchestrator-driven delegate paths (`runDelegate`, `continueRun`) persist
// chunks via `appendChunk` and transition status via `updateRunStatus`, but
// they run on the orchestrator's stack — the run-detail page mounted on a
// different route has no way to observe those writes.
//
// This bus fires an event after every persisted chunk and every status
// transition, keyed by runId. The run-detail page subscribes on mount and
// reconciles its ChatStore (and run-meta row) when events arrive.
//
// Deliberately tiny — no dependencies, no replay buffer, no batching. The bus
// fires synchronously; subscribers do their own coalescing (e.g. via
// requestAnimationFrame) if they need it.
//
// Note: chunks written from `streamDelegateContinue` (the run page's own
// composer) also fire events, but the page's ChatStore is consuming the
// generator in-place there, so the subsequent `refresh()` call is a harmless
// no-op against the same persisted state.

import type { RunStatus } from "$lib/types/run";

export type RunChunkListener = () => void;
export type RunStatusListener = (status: RunStatus) => void;
/** Live token delta callback. Fires for every `text-delta` event the
 *  harness yields while a delegate is running, BEFORE the buffered
 *  segment is persisted as a chunk. Lets the passive run-detail
 *  page render tokens as they arrive (same UX as the orchestrator
 *  chat) without persisting one row per token. */
export type RunTextDeltaListener = (text: string) => void;

/** A delegate has just entered a terminal state (SUCCEEDED / FAILED /
 *  TIMED_OUT / CANCELLED). Fired ONLY by the initial `runDelegate`
 *  spawn — not by `continueRun` follow-ups (those are awaited by the
 *  orchestrator, so the result is already in hand). Carries enough
 *  context for the orchestrator chat store to build a notification
 *  message without needing to re-query the DB. */
export interface RunCompletionEvent {
  runId: string;
  /** Whichever the orchestrator named this run at spawn time, or null
   *  if no name was provided. The orchestrator's notification message
   *  prefers `name` for readability and falls back to runId. */
  name: string | null;
  /** Which orchestrator conversation this run belongs to. Subscribers
   *  filter on this to ignore completions for other conversations
   *  (multi-conversation UX, future). */
  conversationId: string;
  status: RunStatus;
  /** Best-effort short summary of the run, or null if the run produced
   *  no text. The orchestrator uses this for ambient awareness; for
   *  authoritative detail it calls get_delegate_history. */
  summary: string | null;
  /** Display name of the harness that ran the delegate. Surfaced in
   *  the notification so the orchestrator knows which transport
   *  produced the work. */
  harnessName: string;
}
export type RunCompletionListener = (event: RunCompletionEvent) => void;

const chunkListeners = new Map<string, Set<RunChunkListener>>();
const statusListeners = new Map<string, Set<RunStatusListener>>();
const textDeltaListeners = new Map<string, Set<RunTextDeltaListener>>();
/** Global (not per-runId) — anyone who cares about delegate completions
 *  across the whole app subscribes once and filters by conversationId
 *  themselves. The orchestrator chat store is the main consumer. */
const completionListeners = new Set<RunCompletionListener>();

/** Module-scoped accumulator of in-flight streamed text per runId.
 *  Independent of subscribers so a passive viewer that mounts after
 *  some streaming already happened can recover the in-flight text
 *  without it being lost.
 *
 *  Lifecycle:
 *   - Written by `emitRunTextDelta` (single writer) — every delta is
 *     appended to the entry for that runId.
 *   - Read by passive viewers via `getLiveText(runId)` after they
 *     hydrate from DB; they seed their in-memory streaming bubble
 *     with this so navigating away and back doesn't lose tokens.
 *   - Cleared by `clearLiveText(runId)` — called from inside
 *     `appendChunk` when an `assistant_text` chunk lands (the
 *     persisted chunk is now canonical) and from `emitRunCompletion`
 *     as belt-and-braces cleanup for runs that error mid-text.
 *
 *  Memory profile: one string per in-flight delegate run. Cleared
 *  promptly when text finalizes or a run completes, so bounded by
 *  the number of concurrent in-flight delegates. */
const liveTextBuffer = new Map<string, string>();

export function emitChunkAppended(runId: string): void {
  const set = chunkListeners.get(runId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[run-events] chunk listener threw", err);
    }
  }
}

export function emitRunStatusChanged(runId: string, status: RunStatus): void {
  const set = statusListeners.get(runId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(status);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[run-events] status listener threw", err);
    }
  }
}

export function emitRunCompletion(event: RunCompletionEvent): void {
  // Belt-and-braces cleanup. The buffer is normally cleared inside
  // `appendChunk` when the final `assistant_text` chunk lands, but a
  // run that errors mid-text (no terminal `text-end`) wouldn't hit
  // that path — clear here too so the map can't grow unbounded.
  liveTextBuffer.delete(event.runId);
  for (const fn of completionListeners) {
    try {
      fn(event);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[run-events] completion listener threw", err);
    }
  }
}

export function subscribeToRunCompletions(
  listener: RunCompletionListener,
): () => void {
  completionListeners.add(listener);
  return () => {
    completionListeners.delete(listener);
  };
}

export function emitRunTextDelta(runId: string, text: string): void {
  if (!text) return;
  // Single writer: accumulate the in-flight text BEFORE fanning out
  // to subscribers, so any subscriber that joins mid-stream and then
  // calls `getLiveText(runId)` sees a consistent snapshot.
  const existing = liveTextBuffer.get(runId) ?? "";
  liveTextBuffer.set(runId, existing + text);
  const set = textDeltaListeners.get(runId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(text);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[run-events] text-delta listener threw", err);
    }
  }
}

/** Read the accumulated in-flight streamed text for a run. Returns an
 *  empty string if nothing has streamed yet or the buffer has already
 *  been cleared (chunk persisted, run completed). Passive viewers
 *  (run-detail page, embedded delegate cards) call this on mount to
 *  recover any tokens streamed while they were unmounted. */
export function getLiveText(runId: string): string {
  return liveTextBuffer.get(runId) ?? "";
}

/** Drop the in-flight text buffer for a run. Called by `appendChunk`
 *  when an `assistant_text` chunk lands — the chunk is now the
 *  canonical source so the buffer is redundant. Idempotent. */
export function clearLiveText(runId: string): void {
  liveTextBuffer.delete(runId);
}

export interface RunSubscription {
  onChunk?: RunChunkListener;
  onStatus?: RunStatusListener;
  onTextDelta?: RunTextDeltaListener;
}

/** Subscribe to live updates for a single run. Returns an unsubscribe fn
 *  that must be called when the consumer (typically a Svelte page) unmounts. */
export function subscribeToRun(
  runId: string,
  handlers: RunSubscription,
): () => void {
  if (handlers.onChunk) {
    let set = chunkListeners.get(runId);
    if (!set) {
      set = new Set();
      chunkListeners.set(runId, set);
    }
    set.add(handlers.onChunk);
  }
  if (handlers.onStatus) {
    let set = statusListeners.get(runId);
    if (!set) {
      set = new Set();
      statusListeners.set(runId, set);
    }
    set.add(handlers.onStatus);
  }
  if (handlers.onTextDelta) {
    let set = textDeltaListeners.get(runId);
    if (!set) {
      set = new Set();
      textDeltaListeners.set(runId, set);
    }
    set.add(handlers.onTextDelta);
  }
  return () => {
    if (handlers.onChunk) {
      const set = chunkListeners.get(runId);
      if (set) {
        set.delete(handlers.onChunk);
        if (set.size === 0) chunkListeners.delete(runId);
      }
    }
    if (handlers.onStatus) {
      const set = statusListeners.get(runId);
      if (set) {
        set.delete(handlers.onStatus);
        if (set.size === 0) statusListeners.delete(runId);
      }
    }
    if (handlers.onTextDelta) {
      const set = textDeltaListeners.get(runId);
      if (set) {
        set.delete(handlers.onTextDelta);
        if (set.size === 0) textDeltaListeners.delete(runId);
      }
    }
  };
}
