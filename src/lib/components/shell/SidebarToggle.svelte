<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
</script>

<button
  type="button"
  class="toggle"
  class:fullscreen={ui.isFullscreen}
  aria-label={ui.sidebarCollapsed ? "Open sidebar" : "Close sidebar"}
  onclick={() => void ui.toggleSidebar()}
>
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <line x1="9" y1="4" x2="9" y2="20" />
  </svg>
</button>

<style>
  /* Overlay titlebar — webview extends behind the native title bar.
     Traffic lights: x=20, y=28 (tauri.conf.json#trafficLightPosition).
     left=92 clears the three lights; top=14 centres the button (14+12=26)
     on the light row. In fullscreen the lights are hidden so the toggle
     shifts left to x=20. */
  .toggle {
    position: absolute;
    top: 14px;
    left: 92px;
    width: 24px;
    height: 24px;
    z-index: 200;

    -webkit-appearance: none;
    appearance: none;
    background: transparent;
    background-color: transparent;
    border: 0;
    border-radius: 5px;
    outline: none;
    box-shadow: none;
    padding: 0;
    margin: 0;

    color: var(--text-muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    -webkit-app-region: no-drag;
  }
  .toggle.fullscreen {
    left: 20px;
  }
  .toggle:hover {
    background-color: var(--hover-bg);
    color: var(--text);
  }
  .toggle:focus {
    outline: none;
  }
  .toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
