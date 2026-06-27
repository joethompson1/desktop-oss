<script lang="ts">
  import { displayName, sourceLabel } from "$lib/skills/display";
  import type { SkillInvocationMeta } from "$lib/types/chat";

  interface Props {
    invocation: SkillInvocationMeta;
    /** Materialised body — what the model received in addition to
     *  the user's literal text. Revealed when the drawer is open. */
    expandedBody?: string;
  }

  let { invocation, expandedBody }: Props = $props();

  let open = $state(false);

  const headerLabel = $derived(
    `/${displayName(invocation.source, invocation.name)}`,
  );
</script>

<div class="chip-wrap" class:open>
  <button
    type="button"
    class="chip"
    onclick={() => (open = !open)}
    aria-expanded={open}
    aria-label="Show resolved skill"
  >
    <span class="chip-icon" aria-hidden="true">
      <!-- minimal chevron -->
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
        <path
          d="M3.5 4.5L6 7l2.5-2.5"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </span>
    <span class="chip-name">{headerLabel}</span>
    <span class="chip-source">— {sourceLabel(invocation.source)}</span>
    {#if invocation.args}
      <span class="chip-args">{invocation.args}</span>
    {/if}
  </button>
  {#if open && expandedBody}
    <pre class="drawer"><code>{expandedBody}</code></pre>
  {/if}
</div>

<style>
  .chip-wrap {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.4em;
    max-width: 75%;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.45em;
    padding: 0.35em 0.75em;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.78em;
    font-weight: 400;
    cursor: pointer;
    transition: background-color 0.06s ease, color 0.06s ease;
  }
  .chip:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
  .chip-icon {
    display: inline-flex;
    transition: transform 0.12s ease;
  }
  .chip-wrap.open .chip-icon {
    transform: rotate(-180deg);
  }
  .chip-name {
    color: var(--text);
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.92em;
  }
  .chip-source {
    color: var(--text-faint);
  }
  .chip-args {
    color: var(--text-faint);
    font-style: italic;
    margin-left: 0.2em;
    max-width: 18ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .drawer {
    margin: 0;
    padding: 0.85em 1em;
    /* Code blocks stay dark in both themes — matches the inline
       code-block convention from MarkdownView. */
    background: #0f0f0f;
    color: #ececec;
    border-radius: 12px;
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.78em;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: break-word;
    max-height: 50vh;
    overflow-y: auto;
    width: 100%;
    box-sizing: border-box;
    text-align: left;
  }
</style>
