<script lang="ts">
  import { fade } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import {
    permissions,
    resolvePermission,
  } from "$lib/stores/skill-permissions.svelte";

  const head = $derived(permissions.pending[0] ?? null);

  function handleAllowOnce() {
    if (!head) return;
    resolvePermission(head.id, "allow-once", head.suggestedPattern);
  }
  function handleAllowAlways() {
    if (!head) return;
    resolvePermission(head.id, "allow-always", head.suggestedPattern);
  }
  function handleDeny() {
    if (!head) return;
    resolvePermission(head.id, "deny");
  }

  function handleKey(event: KeyboardEvent) {
    if (!head) return;
    // Cmd/Ctrl+Enter → Allow once (matches the kbd hint in the button).
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      handleAllowOnce();
    } else if (event.key === "Escape") {
      event.preventDefault();
      handleDeny();
    }
  }
</script>

<svelte:window onkeydown={handleKey} />

{#if head}
  {#key head.id}
    <!-- Keyed on the request id so each queued card is its own element:
         the old one runs `out:` (fade + slide-up), then the new one
         runs `in:` (fade + slide-up) with a delay equal to the out
         duration — the user sees the card visibly close, brief gap,
         next card open, instead of the text silently swapping. -->
    <div
      class="panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="perm-title"
      in:fade={{ duration: 140, delay: 160, easing: cubicOut }}
      out:fade={{ duration: 140, easing: cubicOut }}
    >
      <div class="head">
      <span class="title" id="perm-title">
        Allow skill <code>/{head.skillName}</code> to run a shell command?
      </span>
    </div>

    <div class="subtitle">{head.skillSourceLabel} skill</div>

    <pre class="cmd-block"><code>{head.command}</code></pre>

    <p class="explanation">
      Output of this command will be spliced into the skill body before
      the model sees it. <strong>Always allow</strong> persists the
      match pattern <code class="pattern-display">{head.suggestedPattern}</code>
      so future runs skip this prompt.
    </p>

    <div class="actions">
      <button class="btn-deny" type="button" onclick={handleDeny}>Deny</button>
      <div class="actions-right">
        <button
          class="btn-always"
          type="button"
          onclick={handleAllowAlways}
        >Always allow</button>
        <button
          class="btn-once"
          type="button"
          onclick={handleAllowOnce}
        >
          Allow once
          <span class="kbd"><span aria-hidden="true">⌘↵</span></span>
        </button>
      </div>
    </div>
  </div>
  {/key}
{/if}

<style>
  .panel {
    box-sizing: border-box;
    background: var(--bg-sidebar);
    border: 1px solid var(--border-strong);
    /* Matches the prompt bar's input-shell radius so the two stack
       as visual siblings rather than the panel feeling more rounded. */
    border-radius: 24px;
    padding: 1.1em 1.3em 0.95em;
    margin-bottom: 0.5em;
    font-family: inherit;
    color: var(--text);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.55em;
    margin-bottom: 0.2em;
  }
  .title {
    flex: 1 1 auto;
    font-weight: 600;
    font-size: 0.95em;
    color: var(--text);
  }
  .title code {
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-weight: 500;
    background: transparent;
    color: var(--text);
    padding: 0;
    font-size: 0.95em;
  }
  .subtitle {
    color: var(--text-muted);
    font-size: 0.8em;
    margin: 0 0 0.55em 0;
  }
  .cmd-block {
    margin: 0 0 0.55em;
    padding: 0.6em 0.85em;
    background: var(--code-inline-bg);
    border-radius: 8px;
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.85em;
    color: var(--text);
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-all;
    overflow-x: auto;
    user-select: text;
  }
  .cmd-block code {
    background: transparent;
    color: inherit;
    font-family: inherit;
  }
  .explanation {
    margin: 0 0 0.8em;
    color: var(--text-muted);
    font-size: 0.82em;
    line-height: 1.55;
  }
  .explanation strong {
    color: var(--text);
    font-weight: 500;
  }
  .pattern-display {
    font-family: "SF Mono", Menlo, Consolas, monospace;
    background: var(--code-inline-bg);
    color: var(--text);
    padding: 0.05em 0.4em;
    border-radius: 4px;
    font-size: 0.92em;
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5em;
  }
  .actions-right {
    display: flex;
    gap: 0.45em;
  }
  .actions button {
    font-family: inherit;
    font-size: 0.85em;
    padding: 0.5em 0.95em;
    border-radius: 8px;
    cursor: pointer;
    border: 1px solid transparent;
    line-height: 1.2;
    display: inline-flex;
    align-items: center;
    gap: 0.45em;
    transition: background-color 0.06s ease, border-color 0.06s ease;
  }
  .btn-deny {
    background: transparent;
    color: var(--text-muted);
    border-color: var(--border-strong);
  }
  .btn-deny:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
  .btn-always {
    background: transparent;
    color: var(--text);
    border-color: var(--text-muted);
  }
  .btn-always:hover {
    background: var(--hover-bg);
    border-color: var(--text);
  }
  /* "Allow once" — the primary action. Inverts to dark in light mode
     and light in dark mode by binding to --text / --bg. */
  .btn-once {
    background: var(--text);
    color: var(--bg);
    border-color: var(--text);
  }
  .btn-once:hover {
    opacity: 0.88;
  }
  .kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.05em 0.45em;
    background: rgba(255, 255, 255, 0.16);
    border-radius: 5px;
    font-size: 0.85em;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    line-height: 1;
  }
</style>
