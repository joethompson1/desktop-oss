<script lang="ts">
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { highlightCode } from "$lib/markdown";

  interface Props {
    /** Raw code body. */
    content: string;
    /** hljs language hint (typescript, bash, diff, …). */
    language?: string;
    /** Optional caption shown in the slim header row (typically a file path). */
    caption?: string;
    /** Whether to render line numbers in a gutter on the left. */
    showLineNumbers?: boolean;
    /**
     * When set, the caption becomes a clickable link that hands the path to
     * the OS's default opener (which respects the user's default-app
     * association — VS Code, Cursor, Xcode, etc). Typically the same value
     * as `caption`, but kept separate so a caller could show a friendly
     * short label while linking to the absolute path.
     */
    openPathOnClick?: string;
  }

  let {
    content,
    language = "text",
    caption = "",
    showLineNumbers = false,
    openPathOnClick = "",
  }: Props = $props();

  const lines = $derived(content.split("\n"));
  const highlightedLines = $derived(
    lines.map((line) => highlightCode(line, language)),
  );

  let copiedFlash = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  function copyAll(event: MouseEvent) {
    event.stopPropagation();
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(content)
      .then(() => {
        copiedFlash = true;
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => {
          copiedFlash = false;
          copyTimer = null;
        }, 1400);
      })
      .catch(() => {
        /* clipboard unavailable — silently no-op */
      });
  }

  /**
   * Hand the path to the user's IDE via the `vscode://` URL scheme. Both
   * Cursor and VS Code register this on install, so whichever the user has
   * (or both — macOS will pick the default handler) will catch it. Using
   * the URL scheme rather than `openPath` matters because `openPath` opens
   * with macOS's default app for the file extension — usually TextEdit or
   * Xcode for `.ts`/`.svelte`, not the user's IDE.
   *
   * Errors are surfaced via `console.warn` rather than silently swallowed,
   * so a misconfigured environment is debuggable. The most common failure
   * mode is "no app registered for vscode://" — install VS Code or Cursor.
   */
  function openInIde(event: MouseEvent) {
    event.stopPropagation();
    if (!openPathOnClick) return;
    const url = `vscode://file${encodeURI(openPathOnClick)}`;
    void openUrl(url).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[tool-code-block] could not open ${url}:`, err);
    });
  }
</script>

<div class="code-card" data-testid="tool-code-block">
  {#if caption}
    <div class="header">
      {#if openPathOnClick}
        <button
          type="button"
          class="caption caption-link"
          title={`Open ${openPathOnClick}`}
          onclick={openInIde}
          data-testid="tool-code-block-open"
        >
          {caption}
        </button>
      {:else}
        <span class="caption" title={caption}>{caption}</span>
      {/if}
      <button
        type="button"
        class="copy"
        class:copied={copiedFlash}
        onclick={copyAll}
        aria-label="Copy code"
      >
        {#if copiedFlash}Copied{:else}Copy{/if}
      </button>
    </div>
  {/if}
  <pre><code class="hljs language-{language}">{#if showLineNumbers}{#each highlightedLines as line, i (i)}<span class="line"><span class="ln">{i + 1}</span><span class="content">{@html line || "&nbsp;"}</span></span>{#if i < highlightedLines.length - 1}{"\n"}{/if}{/each}{:else}{@html highlightCode(content, language)}{/if}</code></pre>
</div>

<style>
  .code-card {
    border-radius: 8px;
    border: 1px solid var(--border);
    overflow: hidden;
    /* Pure surface — white in light, near-black in dark. The atom-one
       theme's own panel grey (#fafafa) is overridden on `code.hljs` below
       so the card's surface shows through edge-to-edge, with no divider
       between the caption row and the code body. */
    background: var(--bg);
    margin: 0;
    min-width: 0;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4em 0.7em;
    background: transparent;
    font-size: 0.78em;
    gap: 0.6em;
  }
  .caption {
    font-family: var(--code-mono);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    background: transparent;
    border: 0;
    padding: 0;
    text-align: left;
    font-size: inherit;
  }
  .caption-link {
    cursor: pointer;
    color: var(--text-muted);
    transition: color 0.12s ease;
  }
  .caption-link:hover {
    color: var(--accent-text);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .copy {
    flex: 0 0 auto;
    background: transparent;
    border: 0;
    color: var(--text-muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.95em;
    padding: 0.15em 0.45em;
    border-radius: 4px;
    transition: color 0.15s ease, background-color 0.15s ease;
  }
  .copy:hover {
    color: var(--text);
    background: var(--code-inline-bg);
  }
  .copy.copied {
    color: var(--accent-text);
  }
  pre {
    margin: 0;
    padding: 0;
    background: transparent;
    border: none;
    overflow-x: auto;
    min-width: 0;
  }
  /* Override hljs background — we want the card's neutral background, not
     the heavy atom-one panel colour. Tokens still get their theme colours. */
  pre :global(code.hljs) {
    display: block;
    background: transparent !important;
    padding: 0.7em 0.9em;
    font-size: 0.86em;
    line-height: 1.55;
    font-family: var(--code-mono);
  }
  /* Line-numbered layout: each `.line` is a flex row so the gutter stays
     fixed-width and the content scrolls horizontally if needed. */
  pre :global(.line) {
    display: flex;
    align-items: flex-start;
    gap: 0.85em;
    padding: 0 0.9em;
  }
  pre :global(.line:first-child) {
    padding-top: 0.7em;
  }
  pre :global(.line:last-child) {
    padding-bottom: 0.7em;
  }
  pre :global(.line .ln) {
    flex: 0 0 auto;
    user-select: none;
    color: var(--text-faint);
    text-align: right;
    min-width: 2.2em;
    font-variant-numeric: tabular-nums;
  }
  pre :global(.line .content) {
    flex: 1 1 auto;
    min-width: 0;
    white-space: pre;
  }
  /* Diff coloring — hljs's `diff` language emits .hljs-addition / .hljs-deletion
     for full +/- lines. Give them inline backgrounds so the line "lights up"
     in green / red like a GitHub-style diff. */
  pre :global(code.hljs .hljs-addition) {
    background: color-mix(in srgb, #34d399 18%, transparent);
    color: color-mix(in srgb, #047857 70%, var(--text));
    display: inline-block;
    width: 100%;
  }
  pre :global(code.hljs .hljs-deletion) {
    background: color-mix(in srgb, #f87171 18%, transparent);
    color: color-mix(in srgb, #b91c1c 70%, var(--text));
    display: inline-block;
    width: 100%;
  }
</style>
