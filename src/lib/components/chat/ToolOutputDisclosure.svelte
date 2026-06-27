<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** Caption shown next to the chevron, e.g. "Output", "Result". */
    label: string;
    /** Optional preview snippet (e.g. line count) shown when collapsed. */
    summary?: string;
    children: Snippet;
    testid?: string;
  }

  let { label, summary = "", children, testid = "tool-output" }: Props = $props();

  let expanded = $state(false);

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    expanded = !expanded;
  }
</script>

<div class="disclosure" data-testid={testid}>
  <button
    type="button"
    class="head"
    onclick={toggle}
    aria-expanded={expanded}
    data-testid="{testid}-toggle"
  >
    <svg
      class="chev"
      class:open={expanded}
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 4 10 8 6 12" />
    </svg>
    <span class="label">{label}</span>
    {#if summary}
      <span class="summary">{summary}</span>
    {/if}
  </button>
  {#if expanded}
    <div class="body" data-testid="{testid}-body">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .disclosure {
    display: block;
  }
  .head {
    display: inline-flex;
    align-items: center;
    gap: 0.45em;
    background: transparent;
    border: 0;
    color: var(--text-muted);
    padding: 0.1em 0;
    cursor: pointer;
    font-family: inherit;
    font-size: var(--text-meta);
    text-align: left;
  }
  .head:hover {
    color: var(--text);
  }
  .label {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.85em;
    font-weight: 500;
  }
  .summary {
    color: var(--text-faint);
    font-size: 0.85em;
  }
  .chev {
    color: var(--text-faint);
    transition: transform 0.12s ease;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .body {
    margin-top: 0.4em;
  }
</style>
