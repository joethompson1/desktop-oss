<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    left?: Snippet;
    center?: Snippet;
    right?: Snippet;
    sidebarCollapsed?: boolean;
    testid?: string;
  }

  let {
    left,
    center,
    right,
    sidebarCollapsed = false,
    testid,
  }: Props = $props();
</script>

<header
  class="title-row"
  class:sidebar-collapsed={sidebarCollapsed}
  data-testid={testid}
>
  {#if left}
    <div class="slot left-slot">{@render left()}</div>
  {/if}
  {#if center}
    <div class="slot center-slot">{@render center()}</div>
  {/if}
  <div class="spacer"></div>
  {#if right}
    <div class="slot right-slot">{@render right()}</div>
  {/if}
</header>

<style>
  .title-row {
    flex: 0 0 auto;
    height: 40px;
    display: flex;
    align-items: center;
    gap: 0.6em;
    padding: 0 0.85em 0 0.85em;
    -webkit-app-region: drag;
    background: var(--bg);
    /* No border / no shadow — the visual separation between title row and
       scroll area comes from a `mask-image` fade on the scroll element
       below (see ConversationScroll.svelte `.scroll`). That makes content
       gently dissolve into the title bar as it scrolls up, instead of
       being cut by a hard 1px line. */
    position: relative;
    z-index: 1;
  }
  /* Sidebar collapsed → leave room for the floating SidebarToggle that
     overlaps the title row at left:92 (≈ 124px from the window edge). */
  .title-row.sidebar-collapsed {
    padding-left: 124px;
  }
  .spacer {
    flex: 1 1 auto;
  }
  /* Shift each slot's content down so centres land at y=25 —
     same baseline as the macOS traffic lights' visible centre and the
     sidebar toggle. The flex-row stays `align-items: center` (content
     centre at y=20); the +5px transform brings everything onto the y=25
     baseline without changing layout. Applied to slot wrappers rather
     than the row itself so the row's bounding box (and the mist fade
     below it) stays in place. */
  .slot {
    -webkit-app-region: no-drag;
    transform: translateY(5px);
    display: inline-flex;
    align-items: center;
    gap: 0.6em;
    min-width: 0;
  }
  .center-slot {
    flex: 0 1 auto;
    min-width: 0;
  }
</style>
