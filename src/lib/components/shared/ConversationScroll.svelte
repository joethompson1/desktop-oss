<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    children: Snippet;
    innerClass?: string;
    onmount?: (el: HTMLDivElement) => void;
    onwheel?: (event: WheelEvent) => void;
    ontouchstart?: (event: TouchEvent) => void;
    ontouchmove?: (event: TouchEvent) => void;
    onscroll?: (event: Event) => void;
    testid?: string;
    role?: string;
    ariaLive?: "off" | "polite" | "assertive";
    ariaLabel?: string;
  }

  let {
    children,
    innerClass,
    onmount,
    onwheel,
    ontouchstart,
    ontouchmove,
    onscroll,
    testid,
    role,
    ariaLive,
    ariaLabel,
  }: Props = $props();

  let scrollEl: HTMLDivElement | null = $state(null);

  $effect(() => {
    if (scrollEl && onmount) onmount(scrollEl);
  });
</script>

<div
  class="scroll"
  bind:this={scrollEl}
  data-testid={testid}
  role={role}
  aria-live={ariaLive}
  aria-label={ariaLabel}
  onwheel={onwheel}
  ontouchstart={ontouchstart}
  ontouchmove={ontouchmove}
  onscroll={onscroll}
>
  <div class="inner {innerClass ?? ''}">
    {@render children()}
  </div>
</div>

<style>
  .scroll {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    /* "Mist" effect at both edges of the scroll viewport: content fades
       from transparent at y=0 → fully visible by 28px, then fully visible
       through to 28px from the bottom, then back to transparent at the
       very bottom edge. Combined with the title row above and the
       composer below (both painted on var(--bg)), this makes text appear
       to dissolve into those bars as it scrolls past, instead of being
       clipped by hard edges. The mask operates on the scroll element's
       viewport — not the document — so the fade always sits at both
       edges regardless of scroll position. */
    -webkit-mask-image: linear-gradient(
      to bottom,
      transparent 0,
      #000 28px,
      #000 calc(100% - 28px),
      transparent 100%
    );
    mask-image: linear-gradient(
      to bottom,
      transparent 0,
      #000 28px,
      #000 calc(100% - 28px),
      transparent 100%
    );
  }
  .inner {
    max-width: 920px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    margin: 0 auto;
  }
  .inner :global(pre) {
    max-width: 100%;
    overflow-x: auto;
  }
  .inner :global(.code-block) {
    max-width: 100%;
    overflow-x: auto;
  }
</style>
