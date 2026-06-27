<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    children: Snippet;
    header?: Snippet;
    disabled?: boolean;
    testid?: string;
  }

  let { children, header, disabled = false, testid }: Props = $props();
</script>

<div class="composer-wrapper" data-testid={testid}>
  {#if header}
    {@render header()}
  {/if}
  <div class="input-shell" class:disabled>
    {@render children()}
  </div>
</div>

<style>
  .composer-wrapper {
    flex: 0 0 auto;
    padding: 0.5em 1.5em 1.2em 1.5em;
    max-width: 920px;
    width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .input-shell {
    display: flex;
    flex-direction: column;
    gap: 0.3em;
    background: var(--bg-input);
    border-radius: 24px;
    padding: 0.5em 0.6em 0.55em 0.6em;
    box-shadow: var(--surface-shadow), var(--surface-ring);
    transition: box-shadow 0.15s ease;
  }
  .input-shell:focus-within {
    box-shadow: var(--surface-shadow), 0 0 0 1px var(--border-strong);
  }
  .input-shell.disabled {
    opacity: 0.75;
  }
</style>
