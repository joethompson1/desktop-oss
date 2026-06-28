<script lang="ts">
  // Per-session git/GitHub status glyph. Ported from desktop-oss's
  // JobStatusIcon (same SVGs/colors/pulse). Variant precedence: PR state
  // (merged → closed → open) over the session's run activity.
  import type { PrInfo } from "$lib/stores/repo-status.svelte";

  interface Props {
    pr: PrInfo | null;
    /** The session has a delegate currently running. */
    running?: boolean;
    /** The session's folder is a git repo on a branch (no PR). */
    hasBranch?: boolean;
    size?: number;
  }

  let { pr, running = false, hasBranch = false, size = 14 }: Props = $props();

  type Variant =
    | "pending"
    | "running"
    | "branch"
    | "pr-open"
    | "pr-merged"
    | "pr-closed";

  const variant: Variant = $derived.by(() => {
    if (pr?.state === "MERGED") return "pr-merged";
    if (pr?.state === "CLOSED") return "pr-closed";
    if (pr?.state === "OPEN") return "pr-open";
    if (running) return "running";
    if (hasBranch) return "branch";
    return "pending";
  });

  const label = $derived.by(() => {
    switch (variant) {
      case "pending":
        return "No repository";
      case "running":
        return "Running";
      case "branch":
        return "On a branch";
      case "pr-open":
        return pr?.isDraft ? "Draft PR" : "PR open";
      case "pr-merged":
        return "PR merged";
      case "pr-closed":
        return "PR closed";
    }
  });
</script>

<span
  class="status-icon"
  data-variant={variant}
  data-testid="repo-status-icon"
  role="img"
  aria-label={label}
  title={label}
  style="--icon-size: {size}px;"
>
  {#if variant === "pending"}
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="8" cy="8" r="5.5" />
    </svg>
  {:else if variant === "running"}
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle class="running-dot" cx="8" cy="8" r="3.5" fill="currentColor" />
    </svg>
  {:else if variant === "pr-open" || variant === "branch"}
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <circle cx="4" cy="3.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="6.5" r="1.5" fill="currentColor" stroke="none" />
      <path d="M4 5v6" />
      <path d="M4 8c0-1.5 1-3 3-3h3" />
    </svg>
  {:else if variant === "pr-merged"}
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <circle cx="4" cy="3.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="3.5" r="1.5" fill="currentColor" stroke="none" />
      <path d="M4 5v6" />
      <path d="M12 5c0 4-4 4-8 7.5" />
    </svg>
  {:else}
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
      <path d="M3 3l10 10" />
      <path d="M13 3L3 13" />
    </svg>
  {/if}
</span>

<style>
  .status-icon {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--icon-size, 14px);
    height: var(--icon-size, 14px);
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .status-icon[data-variant="pending"],
  .status-icon[data-variant="branch"] {
    color: var(--text-faint);
  }
  .status-icon[data-variant="running"],
  .status-icon[data-variant="pr-merged"] {
    color: #8b5cf6;
  }
  .status-icon[data-variant="pr-open"] {
    color: #16a34a;
  }
  .status-icon[data-variant="pr-closed"] {
    color: #dc2626;
  }

  .running-dot {
    animation: status-pulse 1.6s ease-in-out infinite;
    transform-origin: center;
  }
  @keyframes status-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .running-dot {
      animation: none;
    }
  }
</style>
