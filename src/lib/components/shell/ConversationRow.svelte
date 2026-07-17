<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { ConversationCard } from "$lib/stores/conversations.svelte";
  import { conversations } from "$lib/stores/conversations.svelte";
  import type { RunStatus } from "$lib/types/run";
  import ConversationStatusIcon from "./ConversationStatusIcon.svelte";

  interface Props {
    conversation: ConversationCard;
  }

  let { conversation }: Props = $props();

  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);

  const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
    "SUCCEEDED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
  ]);

  const status = $derived<RunStatus>(conversation.status as RunStatus);
  // Same selection marker the session row has — the nested delegate row
  // highlights while its page is the one being viewed.
  const active = $derived(
    page.url.pathname === `/conversations/${conversation.id}`,
  );
  const isTerminal = $derived(TERMINAL_STATUSES.has(status));
  // PENDING is deletable too: it's the parked state of a terminal agent
  // that was created but never prompted (gui runs pass through PENDING
  // for milliseconds only). RUNNING stays protected.
  const canDelete = $derived(
    isTerminal || status === "PENDING" || conversation.archived,
  );
  const displayTitle = $derived(
    conversation.title?.trim() || "Untitled run",
  );

  async function handleClick() {
    if (menuOpen) {
      closeMenu();
      return;
    }
    await goto(`/conversations/${conversation.id}`);
  }

  function openMenuAt(x: number, y: number) {
    menuX = x;
    menuY = y;
    menuOpen = true;
  }

  function closeMenu() {
    menuOpen = false;
  }

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    openMenuAt(event.clientX, event.clientY);
  }

  function handleMoreClick(event: MouseEvent) {
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    openMenuAt(rect.right, rect.bottom);
  }

  async function handleArchive() {
    closeMenu();
    // Archive isn't wired up yet — leave as a no-op until the store
    // grows archive/unarchive methods. The menu item is disabled so
    // this shouldn't fire in practice, but keep the handler defined
    // so the click handler doesn't throw if someone enables it early.
  }

  async function handleDelete() {
    closeMenu();
    if (!canDelete) return;
    const confirmed = window.confirm(
      `Delete run "${displayTitle}"? This removes its chunk log and cannot be undone.`,
    );
    if (!confirmed) return;
    try {
      await conversations.deleteRun(conversation.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[conversations] delete failed", err);
    }
    if (page.url.pathname === `/conversations/${conversation.id}`) {
      await goto("/");
    }
  }
</script>

<svelte:window onclick={closeMenu} />

<div
  class="row"
  class:active
  role="button"
  tabindex="0"
  onclick={handleClick}
  oncontextmenu={handleContextMenu}
  onkeydown={(event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void handleClick();
    }
  }}
  data-testid="conversation-row"
  data-conversation-id={conversation.id}
>
  <ConversationStatusIcon {status} />
  <span class="title" title={displayTitle}>{displayTitle}</span>
  <button
    type="button"
    class="more"
    aria-label="Row actions"
    onclick={handleMoreClick}
  >
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="3" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="13" cy="8" r="1.2" />
    </svg>
  </button>
</div>

{#if menuOpen}
  <div
    class="context-menu"
    role="menu"
    tabindex="-1"
    style="left: {menuX}px; top: {menuY}px;"
    data-testid="conversation-row-menu"
    onclick={(event) => event.stopPropagation()}
    onkeydown={(event) => {
      if (event.key === "Escape") closeMenu();
    }}
  >
    <button
      type="button"
      role="menuitem"
      disabled
      title="Archive coming soon"
      onclick={handleArchive}
    >
      {conversation.archived ? "Unarchive" : "Archive"}
    </button>
    <button
      type="button"
      role="menuitem"
      class="danger"
      disabled={!canDelete}
      title={canDelete
        ? undefined
        : "Only finished or cancelled runs can be deleted"}
      onclick={handleDelete}
    >
      Delete
    </button>
  </div>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 0.55em;
    padding: 0.35em 0.8em 0.35em 1.1em;
    cursor: pointer;
    user-select: none;
    color: var(--text);
    font-size: 0.84em;
    line-height: 1.3;
    border-radius: 4px;
    margin: 0 0.3em;
    outline: none;
  }
  .row:hover {
    background: var(--hover-bg);
  }
  .row.active {
    background: var(--active-bg, var(--hover-bg));
  }
  .row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .title {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .more {
    flex: 0 0 auto;
    background: none;
    border: 0;
    padding: 2px 4px;
    color: var(--text-faint);
    border-radius: 4px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s linear;
  }
  .row:hover .more,
  .row:focus-within .more {
    opacity: 1;
  }
  .more:hover {
    background: var(--bg-elevated);
    color: var(--text);
  }

  .context-menu {
    position: fixed;
    min-width: 160px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    padding: 0.25em;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    z-index: 1000;
  }
  .context-menu button {
    display: block;
    width: 100%;
    background: none;
    border: 0;
    color: inherit;
    text-align: left;
    padding: 0.45em 0.7em;
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85em;
  }
  .context-menu button:hover:not(:disabled) {
    background: var(--hover-bg);
  }
  .context-menu button:disabled {
    color: var(--text-faint);
    cursor: not-allowed;
  }
  .context-menu button.danger {
    color: var(--danger-text);
  }
  .context-menu button.danger:disabled {
    color: var(--text-faint);
  }
</style>
