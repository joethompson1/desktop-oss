<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import SidebarFooter from "./SidebarFooter.svelte";
  import SessionRow from "./SessionRow.svelte";
  import { conversations } from "$lib/stores/conversations.svelte";

  // Route-follower: keep the session group you're INSIDE expanded, whether
  // you're on the orchestrator chat (/sessions/:id) or one of its delegate
  // pages (/conversations/:runId). Reading sessionIdForRun inside the
  // effect makes it reactive to the runs map, so the expansion also fires
  // once runs finish loading after a cold start.
  $effect(() => {
    const path = page.url.pathname;
    const sessionMatch = path.match(/^\/sessions\/([^/]+)/);
    if (sessionMatch && sessionMatch[1] !== "new") {
      conversations.ensureExpanded(decodeURIComponent(sessionMatch[1]));
      return;
    }
    const runMatch = path.match(/^\/conversations\/([^/]+)/);
    if (runMatch) {
      const sessionId = conversations.sessionIdForRun(
        decodeURIComponent(runMatch[1]),
      );
      if (sessionId) conversations.ensureExpanded(sessionId);
    }
  });

  // "New session" and a group's "+" both open the same empty draft chat;
  // the conversation isn't created (or shown in the sidebar) until the
  // first prompt is sent. "+" pre-selects that group's folder.
  function newSession() {
    void goto("/sessions/new");
  }

  function newSessionInFolder(directory: string) {
    void goto(`/sessions/new?dir=${encodeURIComponent(directory)}`);
  }
</script>

<aside class="sidebar">
  <div class="titlebar-drag"></div>

  <nav class="actions">
    <button type="button" class="action" onclick={newSession}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <path d="M8 3v10" /><path d="M3 8h10" />
      </svg>
      <span>New session</span>
    </button>
  </nav>

  <div class="body">
    {#if !conversations.hydrated && conversations.hydrating}
      <div class="empty-state"><p>Loading sessions…</p></div>
    {:else if conversations.groups.length === 0}
      <div class="empty-state">
        <p>No sessions yet.</p>
        <p class="hint">Start one with "New session" above to pick a working directory.</p>
        {#if conversations.hydrationError}
          <p class="hint error">Could not load sessions: {conversations.hydrationError}</p>
        {/if}
      </div>
    {:else}
      {#each conversations.groups as group (group.directory)}
        <div class="section-label" title={group.directory || "Sessions without a directory"}>
          <span class="label-text">{group.basename}</span>
          <button
            type="button"
            class="group-add"
            aria-label="New session in {group.basename}"
            title="New session in this folder"
            onclick={() => newSessionInFolder(group.directory)}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
              <path d="M8 3.5v9" /><path d="M3.5 8h9" />
            </svg>
          </button>
        </div>
        <div class="group">
          {#each group.sessions as session (session.id)}
            <SessionRow {session} />
          {/each}
        </div>
      {/each}
    {/if}
  </div>

  <SidebarFooter />
</aside>

<style>
  .sidebar {
    position: absolute;
    top: 8px;
    left: 8px;
    bottom: 8px;
    width: 252px;
    background: var(--bg-sidebar);
    border-radius: 10px;
    box-shadow: var(--surface-shadow), var(--surface-ring);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 50;
    transition:
      bottom 0.22s cubic-bezier(0.2, 0, 0.2, 1),
      box-shadow 0.22s cubic-bezier(0.2, 0, 0.2, 1);
  }
  /* Draggable strip clearing the macOS traffic lights (top-left). */
  .titlebar-drag {
    height: 32px;
    flex: 0 0 auto;
    -webkit-app-region: drag;
  }
  .actions {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 0.5em 0.4em 0.5em;
  }
  .action {
    -webkit-app-region: no-drag;
    display: flex;
    align-items: center;
    gap: 0.6em;
    padding: 0.45em 0.7em;
    background: transparent;
    color: var(--text);
    border: 0;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.86em;
    font-weight: 500;
    text-decoration: none;
    text-align: left;
  }
  .action:hover {
    background: var(--hover-bg);
  }
  .action svg {
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .body {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 0.4em 0 0.8em 0;
  }
  .section-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5em;
    font-size: 0.7em;
    letter-spacing: 0.02em;
    color: var(--text-faint);
    font-weight: 500;
    padding: 0.8em 0.9em 0.35em 1.1em;
  }
  .label-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-add {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    background: none;
    border: 0;
    border-radius: 4px;
    color: var(--text-faint);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s linear;
  }
  .section-label:hover .group-add {
    opacity: 1;
  }
  .group-add:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .empty-state {
    padding: 0.4em 1.1em 1em 1.1em;
    color: var(--text-muted);
    font-size: 0.84em;
  }
  .empty-state p {
    margin: 0 0 0.25em 0;
  }
  .hint {
    color: var(--text-faint);
    font-size: 0.95em;
  }
  .hint.error {
    color: var(--danger-text);
    margin-top: 0.5em;
  }
</style>
