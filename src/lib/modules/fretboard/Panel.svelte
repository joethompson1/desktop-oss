<script lang="ts">
  // Right-dock panel: a vertical guitar neck (nut at top, frets descending) —
  // this orientation fits the narrow, tall dock the way a chord chart does,
  // and puts the muted/open row naturally right above the nut.
  import type { FretboardState } from "./state.svelte";
  import { fade, scale } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { cubicOut } from "svelte/easing";
  import {
    DEFAULT_DIMS,
    STRING_COUNT,
    FRET_COUNT,
    INLAY_FRETS,
    stringX,
    fretLineY,
    fretCenterY,
    centerX,
    openMarker,
    isMuted,
    frettedMarkers,
  } from "./geometry";

  let { state }: { state: FretboardState; conversationId: string } = $props();

  const dims = DEFAULT_DIMS;
  const strings = Array.from({ length: STRING_COUNT }, (_, i) => i + 1);
  const frets = Array.from({ length: FRET_COUNT }, (_, i) => i + 1);

  // Thinner for high E (string 1), thicker toward low E (string 6).
  function stringWidth(n: number): number {
    return 2.6 - (STRING_COUNT - n) * 0.32;
  }

  const hasMarkers = $derived(state.markers.length > 0);
  const fretted = $derived(frettedMarkers(state.markers));
  const isProgression = $derived(state.progression.length > 1);

  // Breadcrumb shows at most 4 steps at once — a 7-8 step progression would
  // otherwise either wrap or force a font size too small to read. The
  // window follows the current step (biased one slot from the left edge so
  // there's usually a "next" peek visible) and clamps at both ends of the
  // sequence; `animate:flip` on each keyed slot below is what makes it read
  // as a slide instead of a jump cut.
  const BREADCRUMB_MAX = 4;
  const visibleSteps = $derived.by(() => {
    const total = state.progression.length;
    if (total === 0) return [];
    const maxVisible = Math.min(BREADCRUMB_MAX, total);
    const half = Math.floor((maxVisible - 1) / 2);
    const windowStart = Math.max(0, Math.min(state.stepIndex - half, total - maxVisible));
    return state.progression.slice(windowStart, windowStart + maxVisible).map((step, i) => ({
      index: windowStart + i,
      label: step.caption ?? `#${windowStart + i + 1}`,
    }));
  });

  // Visual layout: low E (string 6) on the left, high E (string 1) on the right.
  const neckLeft = $derived(stringX(STRING_COUNT, dims));
  const neckRight = $derived(stringX(1, dims));
  const neckBottom = $derived(fretLineY(FRET_COUNT, dims));
</script>

<div class="fretboard-panel">
  {#if isProgression}
    <div class="breadcrumb" role="group" aria-label={state.progressionName || "Chord progression"}>
      <button
        type="button"
        class="crumb-nav"
        disabled={state.stepIndex === 0}
        aria-label="Previous chord"
        onclick={() => state.goToStep(state.stepIndex - 1)}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="10 4 6 8 10 12" />
        </svg>
      </button>
      <div class="crumbs">
        {#each visibleSteps as vs, i (vs.index)}
          <span class="crumb-slot" animate:flip={{ duration: 220, easing: cubicOut }} in:fade={{ duration: 150 }} out:fade={{ duration: 100 }}>
            <button
              type="button"
              class="crumb"
              class:current={vs.index === state.stepIndex}
              aria-current={vs.index === state.stepIndex}
              onclick={() => state.goToStep(vs.index)}
            >{vs.label}</button>
            {#if i < visibleSteps.length - 1}<span class="divider" aria-hidden="true">·</span>{/if}
          </span>
        {/each}
      </div>
      <button
        type="button"
        class="crumb-nav"
        disabled={state.stepIndex === state.progression.length - 1}
        aria-label="Next chord"
        onclick={() => state.goToStep(state.stepIndex + 1)}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="6 4 10 8 6 12" />
        </svg>
      </button>
    </div>
  {:else if state.caption}
    <div class="caption" title={state.caption}>{state.caption}</div>
  {/if}

  <div class="diagram-area" class:fill={!hasMarkers}>
  {#if !hasMarkers}
    <p class="empty" transition:fade={{ duration: 120 }}>Ask the agent to show a chord or scale.</p>
  {:else}
    <svg
      class="neck"
      viewBox={`0 0 ${dims.width} ${dims.height}`}
      preserveAspectRatio="xMidYMin meet"
      role="img"
      aria-label={state.caption || "Guitar fretboard diagram"}
      transition:fade={{ duration: 120 }}
    >
      <rect
        x={neckLeft}
        y={dims.nutY}
        width={neckRight - neckLeft}
        height={neckBottom - dims.nutY}
        rx="3"
        fill="var(--bg-elevated)"
      />

      {#each INLAY_FRETS as f (f)}
        {#if f === 12}
          <circle cx={centerX(dims) - 7} cy={fretCenterY(f, dims)} r="3" fill="var(--border-strong)" />
          <circle cx={centerX(dims) + 7} cy={fretCenterY(f, dims)} r="3" fill="var(--border-strong)" />
        {:else}
          <circle cx={centerX(dims)} cy={fretCenterY(f, dims)} r="3" fill="var(--border-strong)" />
        {/if}
      {/each}

      {#each frets as f (f)}
        <line
          x1={neckLeft}
          x2={neckRight}
          y1={fretLineY(f, dims)}
          y2={fretLineY(f, dims)}
          stroke="var(--border-strong)"
          stroke-width="1"
        />
        <text x={neckRight + 8} y={fretCenterY(f, dims)} class="fret-num">{f}</text>
      {/each}

      {#each strings as s (s)}
        <line
          x1={stringX(s, dims)}
          x2={stringX(s, dims)}
          y1={dims.nutY}
          y2={neckBottom}
          stroke="var(--text-muted)"
          stroke-width={stringWidth(s)}
        />
      {/each}

      <rect
        x={neckLeft - 2}
        y={dims.nutY - 3}
        width={neckRight - neckLeft + 4}
        height="6"
        rx="2"
        fill="var(--text-faint)"
      />

      {#each strings as s (s)}
        {@const open = openMarker(state.markers, s)}
        {#if open}
          <g
            class="marker"
            in:scale={{ duration: 160, start: 0.5, easing: cubicOut }}
            out:fade={{ duration: 100 }}
          >
            <circle
              cx={stringX(s, dims)}
              cy={fretCenterY(0, dims)}
              r="9"
              fill={open.root ? "var(--accent)" : "var(--text)"}
            />
            {#if open.label}
              <text
                x={stringX(s, dims)}
                y={fretCenterY(0, dims) + 3.5}
                class="marker-label"
                fill={open.root ? "#fff" : "var(--bg)"}
              >{open.label}</text>
            {/if}
          </g>
        {:else if isMuted(state.markers, s)}
          <text
            x={stringX(s, dims)}
            y={fretCenterY(0, dims) + 4}
            class="mute"
            in:fade={{ duration: 160 }}
            out:fade={{ duration: 100 }}
          >×</text>
        {/if}
      {/each}

      {#each fretted as m (`${m.string}:${m.fret}`)}
        <g
          class="marker"
          in:scale={{ duration: 160, start: 0.5, easing: cubicOut }}
          out:fade={{ duration: 100 }}
        >
          <circle
            cx={stringX(m.string, dims)}
            cy={fretCenterY(m.fret, dims)}
            r="9"
            fill={m.root ? "var(--accent)" : "var(--text)"}
          />
          {#if m.label}
            <text
              x={stringX(m.string, dims)}
              y={fretCenterY(m.fret, dims) + 3.5}
              class="marker-label"
              fill={m.root ? "#fff" : "var(--bg)"}
            >{m.label}</text>
          {/if}
        </g>
      {/each}
    </svg>
  {/if}
  </div>
</div>

<style>
  .fretboard-panel {
    display: flex;
    flex-direction: column;
    gap: 0.6em;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
    padding: 0.9em;
  }
  .caption {
    flex: 0 0 auto;
    font-size: 0.85em;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .breadcrumb {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .crumb-nav {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      background 0.1s linear,
      color 0.1s linear;
  }
  .crumb-nav:hover:not(:disabled) {
    background: var(--hover-bg);
    color: var(--text);
  }
  .crumb-nav:disabled {
    color: var(--text-faint);
    opacity: 0.35;
    cursor: not-allowed;
  }
  .crumbs {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: baseline;
    justify-content: center;
    overflow: hidden;
  }
  .crumb-slot {
    display: inline-flex;
    align-items: baseline;
    flex: 0 0 auto;
  }
  .crumb {
    border: none;
    background: transparent;
    padding: 0 3px;
    margin: 0;
    max-width: 4.2em;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: inherit;
    font-size: 0.85em;
    color: var(--text-faint);
    cursor: pointer;
    white-space: nowrap;
    transition: color 0.12s linear;
  }
  .crumb:hover {
    color: var(--text-muted);
  }
  .crumb.current {
    max-width: 7em;
    font-size: 1.15em;
    font-weight: 700;
    color: var(--text);
  }
  .crumb.current:hover {
    color: var(--text);
  }
  .divider {
    color: var(--border-strong);
    font-size: 0.85em;
    padding: 0 1px;
    user-select: none;
  }
  /* Sized to its natural content (the neck's own aspect ratio at 100%
     width) — NOT stretched to fill leftover space, since the dock panel is
     always full-window-tall regardless of how much the diagram needs; that
     stretch was leaving a large dead gap between the neck and the controls
     below it. `flex-shrink` + the SVG's `max-height` are a safety net for a
     genuinely short window, not the common-case sizing. */
  .diagram-area {
    flex: 0 1 auto;
    min-height: 0;
    display: flex;
    align-items: flex-start;
    justify-content: center;
  }
  /* Empty state has no intrinsic size to hug, so it's the one case that
     SHOULD fill the leftover space — that's what centers the placeholder
     text nicely in the middle of the panel. */
  .diagram-area.fill {
    flex: 1 1 auto;
    align-items: center;
  }
  .empty {
    margin: auto;
    max-width: 20em;
    color: var(--text-faint);
    font-size: 0.85em;
    text-align: center;
  }
  .neck {
    width: 100%;
    height: auto;
    max-height: 100%;
    overflow: visible;
  }
  .fret-num {
    font-family: var(--code-mono);
    font-size: 8px;
    fill: var(--text-faint);
    dominant-baseline: middle;
  }
  .marker circle {
    transition: fill 0.15s ease;
  }
  .marker-label {
    font-family: var(--code-mono);
    font-size: 9px;
    font-weight: 700;
    text-anchor: middle;
    transition: fill 0.15s ease;
  }
  .mute {
    font-size: 11px;
    font-weight: 600;
    fill: var(--text-faint);
    text-anchor: middle;
  }
</style>
