<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { getRun, getRunChunks } from "$lib/db/runs";
  import { getLiveText, subscribeToRun } from "$lib/db/run-events";
  import type { RunSummary, RunTokenUsage } from "$lib/types/run";
  import {
    chunksToChatTurns,
    latestTokenUsage,
  } from "$lib/agent/run-chunks-to-turns";
  import { streamDelegateContinue } from "$lib/agent/delegate";
  import { harnesses } from "$lib/stores/harnesses.svelte";
  import { ChatStore } from "$lib/stores/chat-store.svelte";
  import ChatSurface from "$lib/components/chat/ChatSurface.svelte";
  import TerminalPane from "$lib/components/terminal/TerminalPane.svelte";
  import { harnessToSourceFamily } from "$lib/skills/harness-family";
  import type { HarnessType } from "$lib/types/harness";
  import { updateRunSurface } from "$lib/db/runs";
  import {
    attachTui,
    detachTui,
    getTuiSession,
    relaunchTui,
    type TuiSession,
  } from "$lib/agent/tui/driver";

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
        const currentRunId = runId;
        // Implicit driver handoff: sending from chat takes ownership of
        // the session. An idle terminal session is ended automatically
        // (the composer is hidden while the CLI is MID-turn, so this
        // never kills in-flight work); the surface flips back to gui so
        // the SDK drives. The Terminal tab resumes the same session
        // later if wanted.
        return (async function* () {
          await handoffToChat();
          yield* streamDelegateContinue({
            runId: currentRunId,
            userMessage: modelInputText,
            resolveDelegateHarness: () => harnesses.resolveDelegate(),
          });
        })();
      },
    }),
  );

  // Reactive run-meta for the title row's status badge + duration.
  let run = $state<RunSummary | null>(null);
  let loadError = $state<string | null>(null);
  // Latest normalized token usage, for the "% context" chip. Derived from
  // the run's token_usage chunks; null until a harness emits one.
  let usage = $state<RunTokenUsage | null>(null);

  async function refreshRun() {
    if (!runId) return;
    try {
      run = await getRun(runId);
      loadError = null;
    } catch (err) {
      loadError = err instanceof Error ? err.message : "Failed to load run";
    }
  }

  async function refreshUsage() {
    if (!runId) return;
    try {
      usage = latestTokenUsage(await getRunChunks(runId));
    } catch {
      // Non-fatal — the chip just doesn't update.
    }
  }

  function formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
    return `${n}`;
  }

  // Chip label + tooltip. With a known context window we show a
  // percentage; otherwise (e.g. an arbitrary OpenAI-compatible endpoint)
  // we show a raw token count rather than a misleading percentage.
  const usageChip = $derived.by<{ label: string; title: string } | null>(() => {
    if (!usage) return null;
    if (typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
      const pct = Math.min(
        100,
        Math.round((usage.contextTokens / usage.contextWindow) * 100),
      );
      return {
        label: `${pct}% ctx`,
        title: `${usage.contextTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens in context`,
      };
    }
    return {
      label: `${formatTokens(usage.contextTokens)} tok`,
      title: `${usage.contextTokens.toLocaleString()} tokens in context (window unknown)`,
    };
  });

  // Hydrate the store + the run-meta when the route param changes.
  $effect(() => {
    void runId;
    void store.hydrate();
    void refreshRun();
    void refreshUsage();
  });

  // Reconcile once when the page's own composer turn finishes. While
  // `sending` is true the chunk subscription below skips refreshing (to
  // avoid double-painting the streaming bubble), so any todo / usage
  // chunks that landed mid-turn are pulled in here on completion.
  let wasSending = false;
  $effect(() => {
    const sending = store.sending;
    if (wasSending && !sending) {
      void store.refresh();
      void refreshUsage();
    }
    wasSending = sending;
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
      void refreshUsage();
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

  // ─── Dual-surface (Plan 04): gui chat vs tui terminal ────────────────
  // Two views of ONE harness session. `surface` records which DRIVER owns
  // the session (persisted); `view` is what the user is looking at and is
  // ALWAYS free to change — the single-driver rule gates driver handoffs,
  // never sightseeing. The transcript mirror keeps run_chunks live during
  // TUI turns, so the chat view renders read-only while the CLI works; a
  // terminal request during a GUI turn queues and completes itself at the
  // turn boundary instead of presenting a dead button.
  const surface = $derived(run?.surface ?? "gui");
  // v1 capability gate: only the claude-code harness has a TUI story
  // (session pinning + hooks + on-disk transcript). Other harnesses never
  // see the toggle — capability gates, not degraded modes.
  const supportsTui = $derived(run?.delegateType === "claude-code");
  const turnInFlight = $derived(run?.status === "RUNNING");

  let view = $state<"chat" | "terminal">("chat");
  let viewInitialized = $state(false);
  $effect(() => {
    if (!run || viewInitialized) return;
    viewInitialized = true;
    view = run.surface === "tui" && run.delegateType === "claude-code"
      ? "terminal"
      : "chat";
  });

  let tuiSession = $state<TuiSession | null>(null);
  let tuiExited = $state(false);
  let tuiError = $state<string | null>(null);
  let switching = $state(false);

  // Queued driver switch: the user asked for the terminal while the GUI
  // driver was mid-turn (or the run is still gui-owned). Re-runs when
  // run.status changes, so it fires itself at the turn boundary.
  $effect(() => {
    if (
      view !== "terminal" ||
      !run ||
      !supportsTui ||
      surface === "tui" ||
      turnInFlight ||
      switching
    ) {
      return;
    }
    const currentRun = run;
    void (async () => {
      switching = true;
      try {
        await updateRunSurface(currentRun.id, "tui");
        await refreshRun();
      } finally {
        switching = false;
      }
    })();
  });

  // Attach (or re-attach after navigation) while the terminal is the
  // active view and the TUI driver owns the session. The driver is
  // idempotent per runId.
  $effect(() => {
    if (!run || view !== "terminal" || surface !== "tui" || !supportsTui)
      return;
    const currentRun = run;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      try {
        const session =
          getTuiSession(currentRun.id) ?? (await attachTui(currentRun));
        if (disposed) return;
        tuiSession = session;
        tuiExited = session.exited;
        tuiError = null;
        unsubscribe = session.onChange(() => {
          tuiExited = session.exited;
        });
      } catch (err) {
        if (!disposed) {
          // Tauri command failures are plain strings — surface them
          // verbatim; a generic message hides the actual cause.
          tuiError =
            err instanceof Error
              ? err.message
              : typeof err === "string"
                ? err
                : "Failed to start terminal";
        }
      }
    })();
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  });

  // Keep the page honest about LIVENESS, independent of which view is
  // showing: the persisted `surface` says who OWNS the session; the
  // driver registry says whether a CLI is actually ALIVE. The chat
  // view's composer/lock-bar key off liveness — a dead or never-started
  // terminal session must not lock the composer behind a lie.
  $effect(() => {
    if (!run || surface !== "tui") return;
    void view; // re-sync when the user flips views
    const existing = getTuiSession(run.id);
    if (!existing) {
      tuiSession = null;
      tuiExited = false;
      return;
    }
    tuiSession = existing;
    tuiExited = existing.exited;
    return existing.onChange(() => {
      tuiExited = existing.exited;
    });
  });

  /** A live CLI currently owns the session (spawned and not exited).
   *  This — not the persisted surface flag — gates the chat composer. */
  const terminalActive = $derived(
    surface === "tui" && tuiSession !== null && !tuiExited,
  );

  /** Silent version of the handoff used by send(): end any live-but-idle
   *  terminal session and return ownership to the gui driver. No-op when
   *  the run isn't tui-flagged. Safe by construction — the composer is
   *  hidden while the CLI is mid-turn, so send() can't reach this then. */
  async function handoffToChat(): Promise<void> {
    const current = run;
    if (!current || (current.surface ?? "gui") !== "tui") return;
    await detachTui(current.id);
    tuiSession = null;
    tuiExited = false;
    await updateRunSurface(current.id, "gui");
    await refreshRun();
  }

  // The real driver handoff TUI→GUI: kill the CLI session so the chat
  // composer can drive again. Gated at turn boundaries — this is the
  // destructive direction (a live CLI turn would be cancelled).
  async function endTerminalSession() {
    if (!run || switching || turnInFlight) return;
    switching = true;
    try {
      await detachTui(run.id);
      tuiSession = null;
      tuiExited = false;
      await updateRunSurface(run.id, "gui");
      await refreshRun();
      await store.refresh(); // pull in the chunks the mirror persisted
      await refreshUsage();
    } finally {
      switching = false;
    }
  }

  async function relaunch() {
    if (!run) return;
    tuiError = null;
    try {
      await relaunchTui(run.id);
      tuiExited = getTuiSession(run.id)?.exited ?? false;
    } catch (err) {
      tuiError =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Failed to relaunch terminal";
    }
  }

  const durationLabel = $derived.by(() => {
    if (!run?.completedAt || !run.createdAt) return null;
    const ms = Date.parse(run.completedAt) - Date.parse(run.createdAt);
    if (!Number.isFinite(ms) || ms < 0) return null;
    return `${Math.round(ms / 100) / 10}s`;
  });
  const composerPlaceholder = $derived(
    terminalActive
      ? "Send a message — this ends the idle terminal session and continues in chat…"
      : `Talk to ${harnesses.delegateConfig?.name ?? "the delegate"}…`,
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
      {#if usageChip}
        <span class="ctx" title={usageChip.title}>{usageChip.label}</span>
      {/if}
      {#if supportsTui}
        <div
          class="mode-toggle"
          role="group"
          aria-label="Delegate view"
          title="Switch between chat and terminal views of this session"
        >
          <button
            type="button"
            class="mode"
            data-active={view === "chat"}
            onclick={() => (view = "chat")}
          >
            Chat
          </button>
          <button
            type="button"
            class="mode"
            data-active={view === "terminal"}
            onclick={() => (view = "terminal")}
          >
            Terminal
          </button>
        </div>
      {/if}
    {/if}
  </div>

  {#if loadError}
    <div class="banner err">Couldn't load run: {loadError}</div>
  {/if}

  {#if view === "terminal" && supportsTui && surface === "tui"}
    {#if tuiError}
      <div class="banner err">Terminal error: {tuiError}</div>
    {/if}
    {#if tuiSession}
      <TerminalPane session={tuiSession} />
      {#if tuiExited}
        <div class="tui-exit-bar">
          <span>The CLI session ended.</span>
          <button type="button" onclick={() => void relaunch()}>
            Relaunch
          </button>
          <button
            type="button"
            onclick={() => {
              view = "chat";
              void endTerminalSession();
            }}
          >
            Continue in chat
          </button>
        </div>
      {/if}
    {:else if !tuiError}
      <div class="banner">Starting terminal…</div>
    {/if}
  {:else}
    <!-- ONE ChatSurface instance serves both the chat view and the
         queued-switch (terminal-pending) view — remounting it mid-stream
         loses scroll/streaming state for no benefit. The composer stays
         available whenever the GUI driver owns the session, pending or
         not: hiding it turned any wedged turn into a dead end. -->
    {#if view === "terminal" && supportsTui}
      <div class="tui-pending-bar">
        <span>
          {turnInFlight
            ? "Finishing the current turn — the terminal will open as soon as it's done. Live output below."
            : "Opening terminal…"}
        </span>
        <button type="button" onclick={() => (view = "chat")}>
          Stay in chat
        </button>
      </div>
    {/if}
    <ChatSurface
      {store}
      allowAttachments={false}
      composerPlaceholder={composerPlaceholder}
      sourceFilter={skillSourceFilter}
      showComposer={!(terminalActive && turnInFlight)}
    />
    {#if terminalActive && turnInFlight}
      <div class="tui-lock-bar">
        <span>
          The terminal is finishing its turn — the conversation updates
          live here, and chat unlocks the moment it's done.
        </span>
      </div>
    {/if}
  {/if}
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
  .ctx {
    flex: 0 0 auto;
    font-size: 0.78em;
    padding: 0.15em 0.6em;
    border-radius: 999px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    cursor: default;
  }
  .mode-toggle {
    flex: 0 0 auto;
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 999px;
    overflow: hidden;
  }
  .mode {
    background: none;
    border: none;
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.78em;
    padding: 0.2em 0.75em;
    cursor: pointer;
  }
  .mode[data-active="true"] {
    background: var(--bg-elevated);
    color: var(--text);
  }
  .mode:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .tui-pending-bar {
    display: flex;
    align-items: center;
    gap: 0.8em;
    margin: 0 1.4em 0.6em 1.4em;
    padding: 0.45em 0.8em;
    border: 1px dashed var(--border);
    border-radius: 10px;
    color: var(--text-muted);
    font-size: 0.85em;
  }
  .tui-pending-bar span {
    flex: 1 1 auto;
  }
  .tui-pending-bar button {
    background: none;
    border: 1px solid var(--border);
    color: var(--text);
    padding: 0.2em 0.6em;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.95em;
  }
  .tui-pending-bar button:hover {
    background: var(--hover-bg);
  }
  .tui-lock-bar {
    display: flex;
    align-items: center;
    gap: 0.8em;
    padding: 0.6em 1.4em 1em 1.4em;
    color: var(--text-muted);
    font-size: 0.9em;
  }
  .tui-exit-bar {
    display: flex;
    align-items: center;
    gap: 0.8em;
    padding: 0.6em 1.4em 1em 1.4em;
    color: var(--text-muted);
    font-size: 0.9em;
  }
  .tui-exit-bar button {
    background: none;
    border: 1px solid var(--border);
    color: var(--text);
    padding: 0.25em 0.7em;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9em;
  }
  .tui-exit-bar button:hover {
    background: var(--hover-bg);
  }
  .banner {
    padding: 0.7em 1.4em;
  }
  .banner.err {
    color: var(--danger-text);
  }
</style>
