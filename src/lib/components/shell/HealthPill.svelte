<script lang="ts">
  import { health } from "$lib/stores/health.svelte";
  import type { Overall } from "$lib/api/health";

  const labels: Record<Overall, string> = {
    connected: "Connected",
    degraded: "Degraded",
    unreachable: "Offline",
    unknown: "Connecting…",
  };
</script>

<div
  class="pill"
  data-state={health.overall}
  title={health.snapshot.checkedAt
    ? `Last checked: ${new Date(health.snapshot.checkedAt).toLocaleTimeString()}`
    : "Not yet checked"}
>
  <span class="dot" aria-hidden="true"></span>
  <span class="label">{labels[health.overall]}</span>
</div>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    padding: 0.2em 0.6em;
    border-radius: 999px;
    font-size: 0.75em;
    font-weight: 500;
    background-color: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text-muted);
  }
  .dot {
    width: 0.42em;
    height: 0.42em;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .pill[data-state="connected"] .dot {
    background: var(--success);
  }
  .pill[data-state="degraded"] .dot {
    background: var(--warn);
  }
  .pill[data-state="unreachable"] .dot {
    background: var(--danger);
  }
</style>
