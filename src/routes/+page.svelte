<script lang="ts">
  // `/` always redirects (see +page.ts) — to /settings when no harness is
  // configured, otherwise to the most-recent /sessions/[id]. This renders
  // only for the brief moment before the redirect resolves.
</script>

<div class="redirecting" role="status" aria-label="Loading">
  <span></span><span></span><span></span>
</div>

<style>
  .redirecting {
    margin: auto;
    display: flex;
    gap: 8px;
    padding: 2em 0;
    justify-content: center;
    align-items: center;
  }
  .redirecting span {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-faint);
    animation: redirect-pulse 1.3s ease-in-out infinite;
  }
  .redirecting span:nth-child(2) {
    animation-delay: 0.15s;
  }
  .redirecting span:nth-child(3) {
    animation-delay: 0.3s;
  }
  @keyframes redirect-pulse {
    0%,
    80%,
    100% {
      opacity: 0.25;
      transform: scale(0.8);
    }
    40% {
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
