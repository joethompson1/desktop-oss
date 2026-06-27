<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import {
    conversations,
    runToCard,
    type SessionCard,
  } from "$lib/stores/conversations.svelte";
  import { repoStatus } from "$lib/stores/repo-status.svelte";
  import ConversationRow from "./ConversationRow.svelte";
  import RepoStatusIcon from "./RepoStatusIcon.svelte";

  interface Props {
    session: SessionCard;
  }

  let { session }: Props = $props();

  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);

  const expanded = $derived(conversations.isExpanded(session.id));
  const active = $derived(page.url.pathname === `/sessions/${session.id}`);
  const hasRuns = $derived(session.runs.length > 0);
  const runningCount = $derived(
    session.runs.filter((r) => r.status === "RUNNING" || r.status === "PENDING")
      .length,
  );
  const status = $derived(repoStatus.statusFor(session.workingDirectory));
  const displayTitle = $derived(session.title?.trim() || "New chat");

  function openSession() {
    if (menuOpen) {
      menuOpen = false;
      return;
    }
    void goto(`/sessions/${session.id}`);
  }

  function toggle(event: MouseEvent) {
    event.stopPropagation();
    conversations.toggleExpanded(session.id);
  }

  function openMenuAt(x: number, y: number) {
    menuX = x;
    menuY = y;
    menuOpen = true;
  }

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    openMenuAt(event.clientX, event.clientY);
  }

  function handleMoreClick(event: MouseEvent) {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt(rect.right, rect.bottom);
  }

  async function handleRename() {
    menuOpen = false;
    const next = window.prompt("Rename session", displayTitle);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === displayTitle) return;
    await conversations.renameSession(session.id, trimmed);
  }

  async function handleDelete() {
    menuOpen = false;
    const confirmed = window.confirm(
      `Delete session "${displayTitle}"? This removes its chat history and ${session.runs.length} delegate run${session.runs.length === 1 ? "" : "s"}. This cannot be undone.`,
    );
    if (!confirmed) return;
    await conversations.deleteSession(session.id);
    if (active) await goto("/");
  }
</script>

<svelte:window onclick={() => (menuOpen = false)} />

<div
  class="row"
  class:active
  role="button"
  tabindex="0"
  onclick={openSession}
  oncontextmenu={handleContextMenu}
  onkeydown={(event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openSession();
    }
  }}
  data-testid="session-row"
  data-session-id={session.id}
>
  <button
    type="button"
    class="chevron"
    class:invisible={!hasRuns}
    class:open={expanded}
    aria-label={expanded ? "Collapse" : "Expand"}
    aria-expanded={expanded}
    tabindex={hasRuns ? 0 : -1}
    onclick={toggle}
  >
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="6 4 10 8 6 12" />
    </svg>
  </button>

  <RepoStatusIcon
    pr={status?.pr ?? null}
    running={runningCount > 0}
    hasBranch={!!status?.branch}
    size={13}
  />

  <span class="title" title={displayTitle}>{displayTitle}</span>

  {#if runningCount > 0}
    <span class="badge" title="{runningCount} running">{runningCount}</span>
  {/if}

  <button
    type="button"
    class="more"
    aria-label="Session actions"
    onclick={handleMoreClick}
  >
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="13" cy="8" r="1.2" />
    </svg>
  </button>
</div>

{#if expanded && hasRuns}
  <div class="children">
    {#each session.runs as run (run.id)}
      <ConversationRow conversation={runToCard(run)} />
    {/each}
  </div>
{/if}

{#if menuOpen}
  <div
    class="context-menu"
    role="menu"
    tabindex="-1"
    style="left: {menuX}px; top: {menuY}px;"
    onclick={(event) => event.stopPropagation()}
    onkeydown={(event) => {
      if (event.key === "Escape") menuOpen = false;
    }}
  >
    <button type="button" role="menuitem" onclick={handleRename}>Rename</button>
    <button type="button" role="menuitem" class="danger" onclick={handleDelete}>
      Delete
    </button>
  </div>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 0.4em;
    padding: 0.35em 0.6em 0.35em 0.5em;
    cursor: pointer;
    user-select: none;
    color: var(--text);
    font-size: 0.84em;
    line-height: 1.3;
    border-radius: 6px;
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
  .chevron {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    background: none;
    border: 0;
    color: var(--text-faint);
    cursor: pointer;
    border-radius: 3px;
    transition: transform 0.12s ease;
  }
  .chevron.open {
    transform: rotate(90deg);
  }
  .chevron.invisible {
    visibility: hidden;
    cursor: default;
  }
  .chevron:hover:not(.invisible) {
    color: var(--text);
  }
  .title {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    flex: 0 0 auto;
    font-size: 0.74em;
    font-variant-numeric: tabular-nums;
    color: var(--accent-text);
    background: var(--bg-elevated);
    border-radius: 999px;
    padding: 0.05em 0.45em;
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
  .children {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-left: 1.1em;
    border-left: 1px solid var(--border);
    padding-left: 0.2em;
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
  .context-menu button:hover {
    background: var(--hover-bg);
  }
  .context-menu button.danger {
    color: var(--danger-text);
  }
</style>
