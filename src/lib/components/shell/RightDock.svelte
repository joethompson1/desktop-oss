<script lang="ts">
  // Right-dock for module panels. A horizontal row of standalone icon buttons
  // in the top-right title-bar band (one per enabled panel module); clicking
  // one toggles its panel, which docks on the right below the top bar. Renders
  // nothing when there are no panel modules. The left sidebar (conversation
  // history) is a separate component and not part of this dock.

  import { ui } from "$lib/stores/ui.svelte";
  import { modules } from "$lib/modules/store.svelte";
  import { getModuleState } from "$lib/modules/host";

  interface Props {
    /** Conversation whose per-conversation panel state to render. */
    conversationId: string;
    /** Whether the dock should show (gated by the layout on shell + route). */
    active: boolean;
  }

  let { conversationId, active }: Props = $props();

  const panelModules = $derived(modules.panels());
  const openModule = $derived(
    ui.openPanelId
      ? (panelModules.find((m) => m.id === ui.openPanelId) ?? null)
      : null,
  );
  const panelState = $derived(
    openModule ? getModuleState(conversationId, openModule) : null,
  );
</script>

{#if active && panelModules.length > 0}
  <nav class="dock-rail" class:panel-open={!!openModule} aria-label="Panels">
    {#each panelModules as m (m.id)}
      <button
        type="button"
        class="dock-rail-btn"
        class:active={ui.openPanelId === m.id}
        onclick={() => ui.togglePanel(m.id)}
        title={m.label}
        aria-label={m.label}
        aria-pressed={ui.openPanelId === m.id}
      >
        {m.icon ?? m.label.slice(0, 1).toUpperCase()}
      </button>
    {/each}
  </nav>

  {#if openModule}
    {@const PanelComponent = openModule.panel?.component}
    <section class="dock-panel" aria-label={openModule.label}>
      <header class="dock-panel-head">
        <span class="dock-panel-title"
          >{openModule.panel?.title ?? openModule.label}</span
        >
        <button
          type="button"
          class="dock-panel-close"
          onclick={() => ui.closePanel()}
          aria-label="Close panel"
          title="Close"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div class="dock-panel-body">
        {#if PanelComponent}
          {#key conversationId + openModule.id}
            <PanelComponent state={panelState} {conversationId} />
          {/key}
        {/if}
      </div>
    </section>
  {/if}
{/if}

<style>
  /* Horizontal row of standalone icon buttons in the top-right title-bar
     band — no enclosing card, single row, no wrapping. */
  .dock-rail {
    position: absolute;
    top: 10px;
    right: 12px;
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    align-items: center;
    gap: 2px;
    z-index: 60;
    -webkit-app-region: no-drag;
    transition: right 0.18s cubic-bezier(0.2, 0, 0.2, 1);
  }
  /* With a panel open, the icons sit just to its LEFT on the top-bar line
     (not above it); closed, they rest in the top-right corner. */
  .dock-rail.panel-open {
    right: calc(var(--right-panel-width) + 16px);
  }
  .dock-rail-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text-muted);
    font-family: inherit;
    font-size: 1em;
    line-height: 1;
    cursor: pointer;
    -webkit-app-region: no-drag;
    transition:
      background 0.1s linear,
      color 0.1s linear;
  }
  .dock-rail-btn:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
  .dock-rail-btn.active {
    background: var(--active-bg);
    color: var(--text);
  }

  /* The expanded panel docks full-height on the right; the icon row sits to
     its left on the top-bar line. */
  .dock-panel {
    position: absolute;
    top: 8px;
    right: 8px;
    bottom: 8px;
    width: var(--right-panel-width);
    display: flex;
    flex-direction: column;
    background: var(--bg-sidebar);
    border-radius: 10px;
    box-shadow: var(--surface-shadow), var(--surface-ring);
    overflow: hidden;
    z-index: 50;
  }
  .dock-panel-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5em;
    padding: 0.6em 0.7em 0.6em 0.9em;
    border-bottom: 1px solid var(--border);
  }
  .dock-panel-title {
    font-size: 0.8em;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dock-panel-close {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
  }
  .dock-panel-close:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
  .dock-panel-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
</style>
