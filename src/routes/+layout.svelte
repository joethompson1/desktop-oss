<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/state";
  import { health } from "$lib/stores/health.svelte";
  import { conversations } from "$lib/stores/conversations.svelte";
  import { auth } from "$lib/stores/auth.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import Sidebar from "$lib/components/shell/Sidebar.svelte";
  import SidebarToggle from "$lib/components/shell/SidebarToggle.svelte";
  import AppTopBar from "$lib/components/shell/AppTopBar.svelte";
  import RightDock from "$lib/components/shell/RightDock.svelte";
  import { modules } from "$lib/modules/store.svelte";
  import { setPanelOpener } from "$lib/modules/dock-actions";
  import oneLightCss from "highlight.js/styles/atom-one-light.css?raw";
  import oneDarkCss from "highlight.js/styles/atom-one-dark.css?raw";

  let { children } = $props();

  // Shell is hidden only when the user hasn't configured any adapter yet
  // (we want to surface the settings page front-and-centre on first run).
  const showShell = $derived(auth.hasToken);
  const onCockpitRoute = $derived(
    page.url.pathname.startsWith("/conversations/"),
  );

  // Right dock: only on routes that carry a conversation id, and only once at
  // least one enabled module contributes a panel. With no modules it never
  // shows and `main` keeps its full width.
  //
  // Deliberately `ui.activeConversationId`, not `page.params.id`: a draft
  // session promoted via `replaceState` (sessions/new's onConversationCreated)
  // changes the URL's matched route WITHOUT a real navigation, and this
  // already-mounted root layout never sees that route/param change reflected
  // in `page` — see ui.svelte.ts for how this store is kept in sync instead.
  const conversationId = $derived(ui.activeConversationId);
  const dockActive = $derived(
    showShell && conversationId !== "" && modules.panels().length > 0,
  );
  const panelOpen = $derived(dockActive && ui.openPanelId !== null);

  onMount(() => {
    health.start();
    conversations.startPolling();
    void ui.startFullscreenTracking();

    // Let module tools open their panel via dock-actions without importing the
    // UI store into the agent graph.
    setPanelOpener((id) => ui.openPanel(id));

    document
      .querySelectorAll("style[data-hljs-theme]")
      .forEach((el) => el.remove());

    const lightStyle = document.createElement("style");
    lightStyle.setAttribute("data-hljs-theme", "atom-one-light");
    lightStyle.setAttribute("media", "(prefers-color-scheme: light)");
    lightStyle.textContent = oneLightCss;

    const darkStyle = document.createElement("style");
    darkStyle.setAttribute("data-hljs-theme", "atom-one-dark");
    darkStyle.setAttribute("media", "(prefers-color-scheme: dark)");
    darkStyle.textContent = oneDarkCss;

    document.head.appendChild(lightStyle);
    document.head.appendChild(darkStyle);

    return () => {
      lightStyle.remove();
      darkStyle.remove();
    };
  });

  onDestroy(() => {
    health.stop();
    conversations.stopPolling();
    ui.stopFullscreenTracking();
  });
</script>

<div class="app">
  {#if showShell}
    <SidebarToggle />

    {#if !ui.sidebarCollapsed}
      <Sidebar />
    {/if}

    <main
      class:has-pinned-sidebar={!ui.sidebarCollapsed}
      class:has-right-panel={panelOpen}
    >
      {#if !onCockpitRoute}
        <AppTopBar />
      {/if}
      <div class="content">
        {@render children()}
      </div>
    </main>

    <RightDock {conversationId} active={dockActive} />
  {:else}
    <main class="no-shell">
      <div class="content">
        {@render children()}
      </div>
    </main>
  {/if}
</div>

<style>
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif;
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
  }
  .app {
    display: flex;
    height: 100vh;
    overflow: hidden;
    position: relative;
  }
  main {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
    transition: padding 0.22s cubic-bezier(0.2, 0, 0.2, 1);
  }
  main.no-shell {
    padding-top: 44px;
  }
  main.has-pinned-sidebar {
    padding-left: 260px;
  }
  /* Reserve space only for an open panel; the icon rail is a top overlay
     and needs no horizontal reservation. */
  main.has-right-panel {
    padding-right: calc(var(--right-panel-width) + 16px);
  }
  .content {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
</style>
