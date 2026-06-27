<script lang="ts">
  import { onDestroy } from "svelte";
  import type { Skill } from "$lib/skills/types";
  import { displayName, sourceLabel } from "$lib/skills/display";

  interface MenuAnchor {
    /** Viewport top of the line containing the `/` character. */
    top: number;
    /** Viewport left of the `/` character. */
    left: number;
    /** Height of that line, used to seat the menu flush above the slash. */
    lineHeight: number;
  }

  interface Props {
    skills: Skill[];
    highlightIndex: number;
    onPick: (skill: Skill) => void;
    onHighlightChange: (index: number) => void;
    /** Viewport coordinates of the `/` the user typed. When set, the
     *  menu floats above that point; when null, falls back to a static
     *  position above the prompt-bar (preview / SSR-safe fallback). */
    anchor?: MenuAnchor | null;
  }

  let {
    skills,
    highlightIndex,
    onPick,
    onHighlightChange,
    anchor = null,
  }: Props = $props();

  // Convert the slash's viewport coordinates into CSS for a
  // position:fixed menu that floats just above the line. A 6px gap
  // separates the menu's bottom from the slash's top.
  const positionStyle = $derived.by(() => {
    if (!anchor) return "";
    const bottom = Math.max(0, window.innerHeight - anchor.top + 6);
    const left = Math.max(8, anchor.left);
    return `left: ${left}px; bottom: ${bottom}px;`;
  });

  // Tooltip is hover-driven with a delay (mirrors Claude Code's
  // behaviour: hover a row for ~600ms → description bubble appears).
  // Keyboard nav moves the highlight but does NOT show the tooltip —
  // the active row gets a background; tooltips are only for mouse
  // dwellers.
  const TOOLTIP_DELAY_MS = 600;
  let hoveredIndex = $state<number | null>(null);
  let tooltipVisible = $state(false);
  let tooltipTimer: ReturnType<typeof setTimeout> | null = null;
  let rowEls = $state<(HTMLButtonElement | undefined)[]>([]);

  const tooltipSkill = $derived(
    hoveredIndex !== null ? (skills[hoveredIndex] ?? null) : null,
  );

  // Vertically align the tooltip with the hovered row, relative to the
  // .slash-menu containing block (the row's offsetParent). Recomputes
  // when the hovered row changes.
  const tooltipTopPx = $derived.by(() => {
    if (hoveredIndex === null) return 0;
    const el = rowEls[hoveredIndex];
    return el?.offsetTop ?? 0;
  });

  function scheduleTooltip(): void {
    clearTooltipTimer();
    tooltipTimer = setTimeout(() => {
      tooltipVisible = true;
      tooltipTimer = null;
    }, TOOLTIP_DELAY_MS);
  }

  function clearTooltipTimer(): void {
    if (tooltipTimer !== null) {
      clearTimeout(tooltipTimer);
      tooltipTimer = null;
    }
  }

  function hideTooltip(): void {
    clearTooltipTimer();
    tooltipVisible = false;
  }

  function handleRowEnter(i: number): void {
    onHighlightChange(i);
    hoveredIndex = i;
    scheduleTooltip();
  }

  function handleMenuLeave(): void {
    hideTooltip();
    hoveredIndex = null;
  }

  // When the highlight moves (keyboard nav) past the visible viewport
  // of the scrollable list, ensure the active row is in view.
  // `block: 'nearest'` is a no-op when the row is already visible, so
  // mouse hover doesn't trigger spurious scrolling.
  $effect(() => {
    const el = rowEls[highlightIndex];
    el?.scrollIntoView({ block: "nearest" });
  });

  onDestroy(() => clearTooltipTimer());
</script>

{#if skills.length > 0}
  <div
    class="slash-menu"
    class:floating={anchor !== null}
    style={positionStyle}
    onmouseleave={handleMenuLeave}
    role="presentation"
  >
    <ul class="slash-list" role="listbox" aria-label="Available skills">
      {#each skills as skill, i (skill.id)}
        <li role="presentation">
          <button
            bind:this={rowEls[i]}
            class="row"
            class:active={i === highlightIndex}
            type="button"
            role="option"
            aria-selected={i === highlightIndex}
            tabindex="-1"
            onmouseenter={() => handleRowEnter(i)}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => onPick(skill)}
          >
            <span class="name">{displayName(skill.source, skill.name)}</span>
          </button>
        </li>
      {/each}
    </ul>
    {#if tooltipSkill && tooltipVisible}
      <div class="tooltip" role="tooltip" style:top="{tooltipTopPx}px">
        <span class="tooltip-source">({sourceLabel(tooltipSkill.source)})</span>
        {tooltipSkill.description}
      </div>
    {/if}
  </div>
{/if}

<style>
  .slash-menu {
    position: absolute;
    /* Fallback when no anchor has been computed yet — sits flush
       above the prompt-bar at column 0 of the input. */
    left: calc(1.5em + 0.6em + 1.1em);
    bottom: 100%;
    z-index: 30;
  }
  .slash-menu.floating {
    /* Anchored to the live `/` caret position via inline style
       (`top`/`left`/`bottom` come from positionStyle). */
    position: fixed;
    left: auto;
    bottom: auto;
  }
  .slash-list {
    list-style: none;
    margin: 0;
    padding: 0.3em;
    width: 240px;
    max-height: 50vh;
    overflow-y: auto;
    background: var(--bg-elevated);
    border-radius: 10px;
    box-shadow: var(--surface-shadow), var(--surface-ring);
  }
  .row {
    display: block;
    width: 100%;
    padding: 0.4em 0.7em;
    border: none;
    background: transparent;
    color: var(--text);
    text-align: left;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.92em;
    font-weight: 300;
    line-height: 1.4;
    transition: background-color 0.06s ease;
  }
  .row.active {
    background: var(--active-bg);
  }
  .row:focus {
    outline: none;
  }
  .name {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
  }
  .tooltip {
    position: absolute;
    top: 0;
    left: calc(100% + 0.6em);
    width: 320px;
    max-width: 320px;
    padding: 0.7em 0.9em;
    background: rgba(20, 20, 20, 0.96);
    color: rgba(255, 255, 255, 0.92);
    border-radius: 8px;
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.32);
    font-size: 0.84em;
    line-height: 1.5;
    font-weight: 300;
    /* Multi-line clamp with ellipsis */
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    pointer-events: none;
    animation: tooltip-fade-in 0.12s ease-out;
  }
  .tooltip-source {
    color: rgba(255, 255, 255, 0.55);
    margin-right: 0.3em;
  }
  @keyframes tooltip-fade-in {
    from {
      opacity: 0;
      transform: translateY(2px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
