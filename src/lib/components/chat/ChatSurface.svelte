<script lang="ts">
  import { tick, onDestroy } from "svelte";
  import ChatMessage from "$lib/components/chat/ChatMessage.svelte";
  import ChatInput from "$lib/components/chat/ChatInput.svelte";
  import ConversationScroll from "$lib/components/shared/ConversationScroll.svelte";
  import type { ChatStore } from "$lib/stores/chat-store.svelte";
  import type { RepoStatus } from "$lib/stores/repo-status.svelte";
  import type { SkillSource } from "$lib/skills/types";

  interface Props {
    /** Store backing this surface. The session page passes its
     *  orchestrator store; the delegate run page passes its own per-run
     *  store so the same surface renders that conversation. */
    store: ChatStore;
    /** Conversation/session id, threaded to the composer for skill
     *  materialisation. Omitted on delegate run surfaces. */
    sessionId?: string;
    /** Working directory shown in the branch bar just above the prompt bar.
     *  When set with `onChangeDirectory`, the folder chip is clickable. */
    workingDirectory?: string;
    /** git/GitHub status of the working directory, shown in the branch bar. */
    repoStatus?: RepoStatus | null;
    /** Invoked when the user clicks the folder chip. Omit to render it
     *  read-only (or omit `workingDirectory` to hide the bar entirely). */
    onChangeDirectory?: () => void;
    /** Whether to render the prompt-bar / composer below the message list. */
    showComposer?: boolean;
    /** Whether the composer (when shown) accepts file attachments. */
    allowAttachments?: boolean;
    /** Placeholder text shown inside the composer. */
    composerPlaceholder?: string;
    /** Restrict the slash-menu to (local) ∪ (this source). `null` shows
     *  everything (orchestrator surface). Used by delegate surfaces to
     *  match the adapter's source family. */
    sourceFilter?: SkillSource | null;
  }

  let {
    store,
    sessionId,
    workingDirectory,
    repoStatus,
    onChangeDirectory,
    showComposer = true,
    allowAttachments = true,
    composerPlaceholder,
    sourceFilter = null,
  }: Props = $props();

  const chat = $derived<ChatStore>(store);

  let surfaceEl: HTMLDivElement | null = $state(null);
  let scrollEl: HTMLDivElement | null = $state(null);

  // Bottom-padding tracks the prompt-bar's measured height (plus breathing
  // room), so a multi-line message in the textarea doesn't bury the last
  // assistant message. Default sized for a 1-line prompt bar — overwritten
  // by ResizeObserver once mounted.
  let bottomPad = $state(140);

  // Eased rAF auto-scroll state — port of lutia's smoothScrollToBottom.
  // Programmatic scrolls call scrollBy() inside a rAF loop; user wheel/touch
  // events flip userScrollDetected which cancels the loop, so the user can
  // always take over.
  let scrollAnimationFrame: number | null = null;
  let isScrollingProgrammatically = false;
  let userScrollDetected = false;

  // Track when a new message lands so we can fire the eased scroll only on
  // submit, not on every streaming chunk.
  let prevMessageCount = $state(0);
  let prevHydrated = $state(false);

  function stopProgrammaticScroll() {
    if (scrollAnimationFrame !== null) {
      cancelAnimationFrame(scrollAnimationFrame);
      scrollAnimationFrame = null;
    }
    isScrollingProgrammatically = false;
  }

  /** rAF-driven eased scroll that lands at `targetScrollTop`. Bails if the
   *  user starts scrolling manually. */
  function smoothScrollTo(targetScrollTop: number) {
    if (!scrollEl) return;
    if (scrollAnimationFrame !== null) cancelAnimationFrame(scrollAnimationFrame);
    isScrollingProgrammatically = true;
    userScrollDetected = false;

    const step = () => {
      if (userScrollDetected || !scrollEl) {
        stopProgrammaticScroll();
        return;
      }
      const distance = targetScrollTop - scrollEl.scrollTop;
      const absDist = Math.abs(distance);
      if (absDist > 1) {
        // Same easing curve lutia uses: linear chunks scaled by 1/12 of remaining,
        // never less than 1px. Large jumps early, small jumps near target.
        const stepSize = Math.min(absDist, Math.max(1, absDist / 12));
        scrollEl.scrollBy(0, distance > 0 ? stepSize : -stepSize);
        scrollAnimationFrame = requestAnimationFrame(step);
      } else {
        stopProgrammaticScroll();
      }
    };
    step();
  }

  /** Bring `el` to the top of the visible scroll area, with a small offset
   *  for breathing room. Lutia's scrollLastMessageIntoView equivalent. */
  function smoothScrollMessageToTop(el: HTMLElement) {
    if (!scrollEl) return;
    const containerRect = scrollEl.getBoundingClientRect();
    const targetRect = el.getBoundingClientRect();
    const target = scrollEl.scrollTop + (targetRect.top - containerRect.top) - 44;
    smoothScrollTo(Math.max(0, target));
  }

  function handleUserScroll() {
    // Wheel/touch: only the user fires these. If we're animating, hand control over.
    if (isScrollingProgrammatically) {
      userScrollDetected = true;
      stopProgrammaticScroll();
    }
  }

  $effect(() => {
    if (chat.hydrated && !prevHydrated) {
      prevHydrated = true;
      // Synchronous so the "new message landed" effect below sees count === prevMessageCount
      // when it runs in the same reactive flush and doesn't fire its Lutia bring-to-top
      // animation against our hydration snap.
      prevMessageCount = chat.messages.length;
      void tick().then(() => {
        const deadline = performance.now() + 600;
        const step = () => {
          if (!scrollEl) return;
          scrollEl.scrollTop = scrollEl.scrollHeight;
          if (performance.now() < deadline) {
            requestAnimationFrame(step);
          }
        };
        step();
      });
    }
  });

  // New message landed (i.e., user just submitted): bring it to the top of
  // the visible area with the eased scroll. Doing this *only* on count-up
  // (not on every pendingAssistant chunk) is the lutia model — the streaming
  // bubble's 80vh min-height anchors the page so we don't need per-chunk scroll.
  $effect(() => {
    const count = chat.messages.length;
    if (count > prevMessageCount && prevHydrated) {
      prevMessageCount = count;
      const lastMsg = chat.messages[count - 1];
      const targetId = lastMsg?.id;
      void tick().then(() => {
        if (!scrollEl || !targetId) return;
        // Look up by stable message ID rather than CSS class — decouples
        // scroll behaviour from layout-class names.
        const el = scrollEl.querySelector(
          `[data-msg-id="${CSS.escape(targetId)}"]`,
        ) as HTMLElement | null;
        if (el) smoothScrollMessageToTop(el);
      });
    } else {
      prevMessageCount = count;
    }
  });

  // Track the prompt-bar's measured height so the inner's bottom padding
  // can grow with it (textarea expansion, attachment tray opening, etc).
  $effect(() => {
    if (!surfaceEl) return;
    const wrapper = surfaceEl.querySelector(".composer-wrapper");
    if (!wrapper) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (typeof h === "number") {
        // 36px breathing room above the prompt bar — feels like the old 9em
        // floor at minimum prompt-bar size, scales up as it grows.
        bottomPad = Math.round(h + 36);
      }
    });
    ro.observe(wrapper);
    return () => ro.disconnect();
  });

  onDestroy(() => stopProgrammaticScroll());

  const isEmpty = $derived(
    chat.hydrated &&
      chat.messages.length === 0 &&
      !chat.hasPending,
  );
</script>

<div class="surface" bind:this={surfaceEl}>
  <ConversationScroll
    onmount={(el) => (scrollEl = el)}
    onwheel={handleUserScroll}
    ontouchstart={handleUserScroll}
    ontouchmove={handleUserScroll}
    role="log"
    ariaLive="polite"
    ariaLabel="Conversation"
    innerClass="chat-inner"
  >
    <div class="chat-body" style="padding-bottom: {bottomPad}px">
      {#if !chat.hydrated}
        <div class="loader" role="status" aria-label="Loading conversation">
          <span></span><span></span><span></span>
        </div>
      {:else if isEmpty}
        <div class="empty">
          <h1 class="hero">How can I help you?</h1>
          <p>
            Ask a question, kick off an agent, or check in on what your agents are doing.
          </p>
        </div>
      {/if}
      {#if chat.hydrationError}
        <div class="status error">
          Couldn't load history: {chat.hydrationError}
        </div>
      {/if}
      {#each chat.messages as msg (msg.id)}
        {#if msg.role === "user"}
          <ChatMessage
            messageId={msg.id}
            role="user"
            content={msg.content}
            attachments={msg.attachments}
            skillInvocation={msg.skillInvocation}
            skillExpandedBody={msg.skillExpandedBody}
            skillStatus={msg.skillStatus}
            systemEvent={msg.systemEvent}
          />
        {:else}
          <ChatMessage
            messageId={msg.id}
            role="assistant"
            parts={msg.parts}
          />
        {/if}
      {/each}
      {#if chat.hasPending}
        <ChatMessage
          role="assistant"
          parts={chat.pendingParts}
          streaming
        />
      {/if}
    </div>
  </ConversationScroll>
  {#if showComposer}
    <ChatInput
      store={chat}
      {sessionId}
      {workingDirectory}
      {repoStatus}
      {onChangeDirectory}
      sending={chat.sending}
      onSend={(text, attachments, skillContext) =>
        chat.send(text, attachments, skillContext)}
      placeholder={composerPlaceholder ?? "Talk to Clive…"}
      allowAttachments={allowAttachments}
      sourceFilter={sourceFilter}
    />
  {/if}
</div>

<style>
  .surface {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
  }
  :global(.chat-inner) {
    padding: 2.6em 1.5em 0 1.5em;
    min-height: 100%;
  }
  .chat-body {
    display: flex;
    flex-direction: column;
    gap: 2.4em;
    min-height: 100%;
    box-sizing: border-box;
  }
  .empty {
    margin: auto;
    text-align: center;
    color: var(--text-muted);
    padding: 1em;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.8em;
  }
  .empty .hero {
    margin: 0;
    font-weight: 700;
    font-size: 2.6em;
    letter-spacing: -0.02em;
    line-height: 1.15;
    background: linear-gradient(
      270deg,
      #4f7cff,
      #c084fc,
      #ec4899,
      #4f7cff
    );
    background-size: 400% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
    animation: hero-gradient 18s ease infinite;
  }
  .empty p {
    margin: 0;
    font-size: 1em;
    font-weight: 300;
    color: var(--text-muted);
    max-width: 28em;
  }
  @keyframes hero-gradient {
    0% {
      background-position: 0% 50%;
    }
    50% {
      background-position: 100% 50%;
    }
    100% {
      background-position: 0% 50%;
    }
  }
  .status {
    text-align: center;
    color: var(--text-muted);
    font-size: 0.86em;
    padding: 0.5em 0;
  }
  .status.error {
    color: var(--danger-text);
  }
  .loader {
    margin: auto;
    display: flex;
    gap: 8px;
    padding: 1em 0;
    justify-content: center;
    align-items: center;
  }
  .loader span {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-faint);
    animation: loader-pulse 1.3s ease-in-out infinite;
  }
  .loader span:nth-child(2) { animation-delay: 0.15s; }
  .loader span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes loader-pulse {
    0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }
</style>
