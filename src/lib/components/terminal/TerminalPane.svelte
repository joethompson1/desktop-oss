<script lang="ts">
  // Renders a live TUI session's xterm into the page. The Terminal
  // instance is OWNED by the tui driver's registry (it survives route
  // changes with scrollback intact); this component only parents its
  // element into the DOM, keeps the PTY sized to the container, and
  // focuses it. Unmounting detaches the DOM node but leaves the session
  // running.
  import { onMount } from "svelte";
  import "@xterm/xterm/css/xterm.css";
  import type { TuiSession } from "$lib/agent/tui/driver";
  import { resizeTui } from "$lib/agent/tui/driver";

  let { session }: { session: TuiSession } = $props();

  let container: HTMLDivElement | undefined = $state();

  onMount(() => {
    if (!container) return;
    if (!session.term.element) {
      session.term.open(container);
    } else {
      container.appendChild(session.term.element);
    }
    resizeTui(session.runId);
    const observer = new ResizeObserver(() => resizeTui(session.runId));
    observer.observe(container);
    session.term.focus();
    return () => observer.disconnect();
  });
</script>

<div class="terminal" bind:this={container}></div>

<style>
  .terminal {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0 1.4em 1em 1.4em;
    padding: 0.6em;
    border-radius: 10px;
    border: 1px solid var(--border);
    /* xterm's default theme is dark; keep the frame dark in both app
       themes so the terminal reads as one coherent surface. Themable via
       --terminal-bg for anyone who restyles xterm too. */
    background: var(--terminal-bg, #000);
    overflow: hidden;
  }
  .terminal :global(.xterm),
  .terminal :global(.xterm-viewport),
  .terminal :global(.xterm-screen) {
    height: 100%;
    width: 100%;
  }
</style>
