<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  let menuOpen = $state(false);

  function toggleMenu() {
    menuOpen = !menuOpen;
  }

  function closeMenu() {
    menuOpen = false;
  }

  async function handleSettings() {
    closeMenu();
    await goto("/settings");
  }

  async function handleBackHome() {
    closeMenu();
    await goto("/");
  }

  const onSettingsRoute = $derived(page.url.pathname === "/settings");
</script>

<svelte:window onclick={closeMenu} />

<div class="footer">
  <button
    type="button"
    class="user"
    aria-label="Account menu"
    aria-expanded={menuOpen}
    onclick={(event) => {
      event.stopPropagation();
      toggleMenu();
    }}
  >
    <span class="avatar" aria-hidden="true">D</span>
    <span class="label">Desktop OSS</span>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
  {#if menuOpen}
    <div class="menu" role="menu">
      {#if onSettingsRoute}
        <button type="button" role="menuitem" onclick={handleBackHome}>
          ← Back to chat
        </button>
      {:else}
        <button type="button" role="menuitem" onclick={handleSettings}>
          Settings
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .footer {
    position: relative;
    padding: 0.4em 0.5em;
    border-top: 1px solid var(--border);
    flex: 0 0 auto;
  }
  .user {
    display: flex;
    align-items: center;
    gap: 0.6em;
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0.4em 0.5em;
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.85em;
    text-align: left;
  }
  .user:hover {
    background: var(--hover-bg);
  }
  .avatar {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    color: var(--text);
    font-size: 0.7em;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .label {
    flex: 1 1 auto;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0.5em;
    right: 0.5em;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    padding: 0.3em;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    z-index: 10;
  }
  .menu button {
    display: block;
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    padding: 0.5em 0.7em;
    text-align: left;
    border-radius: 5px;
    font-family: inherit;
    font-size: 0.85em;
    cursor: pointer;
  }
  .menu button:hover {
    background: var(--hover-bg);
  }
</style>
