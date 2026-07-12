<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { getRun, getRunChunks } from "$lib/db/runs";
  import { getLiveText, subscribeToRun } from "$lib/db/run-events";
  import type { RunSummary } from "$lib/types/run";
  import { chunksToChatTurns } from "$lib/agent/run-chunks-to-turns";
  import { streamDelegateContinue } from "$lib/agent/delegate";
  import { harnesses } from "$lib/stores/harnesses.svelte";
  import { ChatStore } from "$lib/stores/chat-store.svelte";
  import ChatSurface from "$lib/components/chat/ChatSurface.svelte";
  import { harnessToSourceFamily } from "$lib/skills/harness-family";
  import type { HarnessType } from "$lib/types/harness";

  // One ChatStore per page mount — bound to this specific run. Same class
  // the orchestrator chat uses; only loadHistory + send differ.
  const runId = $derived(page.params.id ?? "");

  const store = $derived(
    new ChatStore({
      loadHistory: async () => {
        if (!runId) return [];
        const chunks = await getRunChunks(runId);
        return chunksToChatTurns(chunks);
      },
      send({ text, skillExpandedBody }) {
        // Mirror the orchestrator's Phase 3 behaviour: when a skill
        // invocation comes through, the model sees the literal `/cmd`
        // plus the materialised body joined with a blank line. The
        // user bubble keeps the literal text; the drawer reveals the
        // expansion.
        const modelInputText = skillExpandedBody
          ? `${text}\n\n${skillExpandedBody}`
          : text;
        return streamDelegateContinue({
          runId,
          userMessage: modelInputText,
          resolveDelegateHarness: () => harnesses.resolveDelegate(),
        });
      },
    }),
  );

  // Reactive run-meta for the title row's status badge + duration.
  let run = $state<RunSummary | null>(null);
  let loadError = $state<string | null>(null);

  async function refreshRun() {
    if (!runId) return;
    try {
      run = await getRun(runId);
      loadError = null;
    } catch (err) {
      loadError = err instanceof Error ? err.message : "Failed to load run";
    }
  }

  // Hydrate the store + the run-meta when the route param changes.
  $effect(() => {
    void runId;
    void store.hydrate();
    void refreshRun();
  });

  // Subscribe to live updates for this run. The orchestrator's
  // runDelegate / continueRun calls persist chunks and status transitions
  // on a different stack (no in-place generator for us to consume), so we
  // rely on the run-events bus fired from inside appendChunk /
  // updateRunStatus. We coalesce chunk events into a single refresh per
  // animation frame so a fast token stream doesn't trigger N DB reads.
  $effect(() => {
    if (!runId) return;
    const currentRunId = runId;
    const currentStore = store;
    let pendingFrame: number | null = null;

    const flushRefresh = () => {
      pendingFrame = null;
      // Skip if the page's own composer is mid-send. Its ChatStore is
      // already rendering the assistant turn in-place from pendingParts,
      // and a refresh mid-stream would race the local optimistic state
      // with the persisted snapshot, double-painting the assistant bubble.
      if (currentStore.sending) return;
      void currentStore.refresh();
    };

    const unsubscribe = subscribeToRun(currentRunId, {
      onTextDelta: (delta) => {
        // Skip when the page's own composer is driving the run — its
        // ChatStore is already rendering each delta into #pendingParts
        // via the generator, so layering #externalText on top would
        // double-paint the assistant bubble.
        if (currentStore.sending) return;
        currentStore.appendExternalText(delta);
      },
      onChunk: () => {
        // A complete segment just landed in run_chunks. Clear the
        // external streaming buffer (its content is now in the
        // persisted chunk) and schedule a refresh to pull the
        // canonical history back from the DB.
        currentStore.clearExternalText();
        if (pendingFrame !== null) return;
        pendingFrame = window.requestAnimationFrame(flushRefresh);
      },
      onStatus: () => {
        // Refetch the full row so summary / completedAt / duration update
        // alongside the status badge.
        void refreshRun();
      },
    });

    // Seed the external streaming buffer from the module-scoped live
    // text accumulator. Without this, navigating away from an
    // in-flight delegate run and back would lose the tokens that
    // streamed during the unmounted window — they only persist to the
    // DB at `text-end`, and the in-memory page-scoped buffer is
    // destroyed on unmount. By reading from the live-text buffer
    // AFTER the subscriber is registered, we capture any deltas that
    // arrived between subscribe-time and seed-time too (setExternalText
    // replaces rather than appends, so we get an exact snapshot).
    if (!currentStore.sending) {
      currentStore.setExternalText(getLiveText(currentRunId));
    }

    return () => {
      if (pendingFrame !== null) {
        window.cancelAnimationFrame(pendingFrame);
        pendingFrame = null;
      }
      unsubscribe();
    };
  });

  const statusLabel = $derived(run?.status.toLowerCase() ?? "");
  const durationLabel = $derived.by(() => {
    if (!run?.completedAt || !run.createdAt) return null;
    const ms = Date.parse(run.completedAt) - Date.parse(run.createdAt);
    if (!Number.isFinite(ms) || ms < 0) return null;
    return `${Math.round(ms / 100) / 10}s`;
  });
  const composerPlaceholder = $derived(
    `Talk to ${harnesses.delegateConfig?.name ?? "the delegate"}…`,
  );
  const skillSourceFilter = $derived(
    harnessToSourceFamily(run?.delegateType as HarnessType | undefined),
  );
</script>

<div class="surface">
  <div class="title-row">
    <button
      class="back"
      type="button"
      onclick={() => void goto("/")}
      aria-label="Back to chat"
    >
      ← Chat
    </button>
    {#if run}
      <span class="title" title={run.title}>{run.title}</span>
      {#if run.delegateType}
        <span class="harness">via <code>{run.delegateType}</code></span>
      {/if}
      {#if durationLabel}
        <span class="duration">{durationLabel}</span>
      {/if}
      <span class="status" data-status={run.status}>{statusLabel}</span>
    {/if}
  </div>

  {#if loadError}
    <div class="banner err">Couldn't load run: {loadError}</div>
  {/if}

  <ChatSurface
    {store}
    allowAttachments={false}
    composerPlaceholder={composerPlaceholder}
    sourceFilter={skillSourceFilter}
  />
</div>

<style>
  .surface {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 0.7em;
    padding: 28px 1.4em 0.7em 1.4em;
    -webkit-app-region: drag;
  }
  .title-row > * {
    -webkit-app-region: no-drag;
  }
  .back {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 0.3em 0.7em;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85em;
  }
  .back:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
  .title {
    flex: 1 1 auto;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .harness {
    color: var(--text-muted);
    font-size: 0.85em;
  }
  .harness code {
    font-family: var(--code-mono);
    color: var(--text);
    background: var(--code-inline-bg);
    padding: 0.05em 0.4em;
    border-radius: 4px;
  }
  .duration {
    color: var(--text-faint);
    font-size: 0.84em;
    font-variant-numeric: tabular-nums;
  }
  .status {
    flex: 0 0 auto;
    font-size: 0.78em;
    padding: 0.15em 0.6em;
    border-radius: 999px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text-muted);
    text-transform: lowercase;
  }
  .status[data-status="RUNNING"],
  .status[data-status="PENDING"] {
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .status[data-status="SUCCEEDED"] {
    color: var(--success);
    border-color: var(--success);
  }
  .status[data-status="FAILED"],
  .status[data-status="TIMED_OUT"],
  .status[data-status="CANCELLED"] {
    color: var(--danger-text);
    border-color: var(--danger);
  }
  .banner {
    padding: 0.7em 1.4em;
  }
  .banner.err {
    color: var(--danger-text);
  }
</style>
