<script lang="ts">
  import type { RunStatus } from "$lib/types/run";

  interface Props {
    status: RunStatus;
    prState?: null;
    pendingPermissions?: number;
    size?: number;
  }

  let { status, size = 14 }: Props = $props();

  const isRunning = $derived(status === "RUNNING" || status === "PENDING");
  const isError = $derived(
    status === "FAILED" || status === "TIMED_OUT" || status === "CANCELLED",
  );
  const isOk = $derived(status === "SUCCEEDED");
</script>

<span
  class="status"
  class:running={isRunning}
  class:err={isError}
  class:ok={isOk}
  style:width={`${size}px`}
  style:height={`${size}px`}
>
  {#if isRunning}
    <span class="spinner" aria-hidden="true"></span>
  {:else if isError}
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <line x1="4" y1="4" x2="12" y2="12" stroke-linecap="round" />
      <line x1="12" y1="4" x2="4" y2="12" stroke-linecap="round" />
    </svg>
  {:else if isOk}
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <polyline points="3,9 7,13 13,4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  {/if}
</span>

<style>
  .status {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
  }
  .status.running {
    color: var(--accent-text);
  }
  .status.err {
    color: var(--danger-text);
  }
  .status.ok {
    color: var(--success);
  }
  .spinner {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
