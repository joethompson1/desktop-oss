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
  import oneLightCss from "highlight.js/styles/atom-one-light.css?raw";
  import oneDarkCss from "highlight.js/styles/atom-one-dark.css?raw";

  let { children } = $props();

  // Shell is hidden only when the user hasn't configured any adapter yet
  // (we want to surface the settings page front-and-centre on first run).
  const showShell = $derived(auth.hasToken);
  const onCockpitRoute = $derived(
    page.url.pathname.startsWith("/conversations/"),
  );

  onMount(() => {
    health.start();
    conversations.startPolling();
    void ui.startFullscreenTracking();

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

    <main class:has-pinned-sidebar={!ui.sidebarCollapsed}>
      {#if !onCockpitRoute}
        <AppTopBar />
      {/if}
      <div class="content">
        {@render children()}
      </div>
    </main>
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
    transition: padding-left 0.22s cubic-bezier(0.2, 0, 0.2, 1);
  }
  main.no-shell {
    padding-top: 44px;
  }
  main.has-pinned-sidebar {
    padding-left: 260px;
  }
  .content {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
</style>
