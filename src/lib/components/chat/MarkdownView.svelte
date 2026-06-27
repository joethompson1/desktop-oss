<script lang="ts">
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { renderMarkdown } from "$lib/markdown";

  let {
    content,
    streaming = false,
  }: { content: string; streaming?: boolean } = $props();

  // If the streamed content ends mid-code (an unclosed ``` fence or an
  // unclosed `inline` backtick), naïvely appending the loading-ball span
  // would land it INSIDE the code, where it'd render as visible literal
  // HTML to the user. Skip injection in those frames; the next chunk
  // that closes the code will let the ball reappear.
  function endsInsideOpenCode(s: string): boolean {
    const fenceCount = (s.match(/```/g)?.length ?? 0);
    if (fenceCount % 2 === 1) return true;
    // After all complete fenced blocks are removed, count remaining
    // single backticks. Odd → unclosed inline code.
    const stripped = s.replace(/```[\s\S]*?```/g, "");
    const tickCount = (stripped.match(/`/g)?.length ?? 0);
    return tickCount % 2 === 1;
  }

  // While streaming, append an inline marker that marked parses INTO the
  // last block element (paragraph, heading, list item). Result: the dot
  // sits at the end of the trailing line of text, not on its own line.
  const augmented = $derived(
    streaming && !endsInsideOpenCode(content)
      ? `${content} <span class="loading-ball" aria-hidden="true"></span>`
      : content,
  );
  const html = $derived(renderMarkdown(augmented));

  function handleClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const copyBtn = target.closest("button.code-copy") as HTMLButtonElement | null;
    if (copyBtn) {
      event.preventDefault();
      const block = copyBtn.closest(".code-block");
      const codeEl = block?.querySelector("pre code") as HTMLElement | null;
      const text = codeEl?.innerText ?? "";
      if (!text) return;
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          const original = copyBtn.textContent ?? "Copy";
          copyBtn.textContent = "Copied";
          copyBtn.classList.add("copied");
          window.setTimeout(() => {
            copyBtn.textContent = original;
            copyBtn.classList.remove("copied");
          }, 1600);
        })
        .catch(() => {
          /* clipboard unavailable — silently no-op */
        });
      return;
    }

    const anchor = target.closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    if (href.startsWith("http://") || href.startsWith("https://")) {
      event.preventDefault();
      void openUrl(href).catch(() => {
        /* swallow — opener failures shouldn't crash the app */
      });
    }
  }
</script>

<div class="md" onclick={handleClick} role="presentation">
  {@html html}
</div>

<style>
  .md {
    line-height: 1.75;
    word-wrap: break-word;
    font-weight: 300;
  }
  .md :global(p) {
    margin: 0 0 0.85em 0;
  }
  .md :global(p:last-child) {
    margin-bottom: 0;
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    margin: 1.25em 0 0.55em 0;
    font-weight: 600;
    line-height: 1.3;
    color: var(--text);
  }
  .md :global(h1:first-child),
  .md :global(h2:first-child),
  .md :global(h3:first-child),
  .md :global(h4:first-child) {
    margin-top: 0;
  }
  .md :global(h1) {
    font-size: 1.55em;
  }
  .md :global(h2) {
    font-size: 1.3em;
  }
  .md :global(h3) {
    font-size: 1.12em;
  }
  .md :global(h4) {
    font-size: 1em;
  }
  .md :global(ul),
  .md :global(ol) {
    margin: 0 0 1em 0;
    padding: 0 0 0 1.6em;
  }
  .md :global(li) {
    margin: 0.4em 0;
  }
  .md :global(li > p) {
    margin: 0 0 0.4em 0;
  }
  .md :global(a) {
    color: var(--accent-text);
    text-decoration: none;
    border-bottom: 1px solid color-mix(in srgb, var(--accent-text) 35%, transparent);
    transition: border-color 0.15s ease;
  }
  .md :global(a:hover) {
    border-bottom-color: var(--accent-text);
  }
  /* Inline `<code>` in prose only — exclude the highlighted code blocks
     so the Atom One theme's .hljs colour rules can come through. Without
     :not(.hljs), this selector beats the theme on specificity and forces
     plain code text to var(--text), making non-token text look "off". */
  .md :global(code:not(.hljs)) {
    background: var(--code-inline-bg);
    border-radius: 5px;
    padding: 0.15em 0.4em;
    font-size: 0.9em;
    font-family: "SF Mono", Menlo, Consolas, monospace;
    color: var(--text);
  }

  /* Inline loading ball — sits at the end of the streaming line of text.
     Uses currentColor so it picks up whatever text colour the surrounding
     element uses (paragraph, heading, list item, etc.). */
  .md :global(.loading-ball) {
    display: inline-block;
    width: 0.7em;
    height: 0.7em;
    margin-left: 0.18em;
    vertical-align: -0.05em;
    background: currentColor;
    border-radius: 50%;
    animation: ball-pulse 1s ease-in-out infinite;
    will-change: transform, opacity;
  }
  @keyframes ball-pulse {
    0%, 100% {
      transform: scale(1);
      opacity: 0.85;
    }
    50% {
      transform: scale(0.7);
      opacity: 0.45;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .md :global(.loading-ball) {
      animation: none;
      opacity: 0.6;
    }
  }

  /* Lutia-style code block: dark header bar + scrollable code body.
     No background here — the inner `code.hljs` provides it from the
     active Atom One theme, so the rounded body tracks light/dark. */
  .md :global(.code-block) {
    margin: 1.1em 0;
    border-radius: 10px;
    border: 1px solid var(--border-strong);
    overflow: hidden;
  }
  .md :global(.code-header) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.55em 0.95em;
    background: var(--code-header-bg);
    color: var(--code-header-text);
    font-size: 0.78em;
    font-weight: 400;
    letter-spacing: 0.02em;
  }
  .md :global(.code-lang) {
    text-transform: lowercase;
    font-family: "SF Mono", Menlo, Consolas, monospace;
  }
  .md :global(.code-copy) {
    background: transparent;
    border: none;
    color: var(--code-header-text);
    cursor: pointer;
    font-size: 0.95em;
    font-family: inherit;
    padding: 0.15em 0.4em;
    border-radius: 4px;
    transition: color 0.15s ease, background-color 0.15s ease;
  }
  .md :global(.code-copy:hover) {
    color: var(--code-header-text-strong);
    background: var(--code-header-hover-bg);
  }
  .md :global(.code-copy.copied) {
    color: var(--code-copy-success);
  }
  .md :global(.code-block pre) {
    /* Padding lives on `.hljs` (below) so the theme's background fills
       edge-to-edge under the header bar — no visible gap of the outer
       `.code-block` colour. */
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 0;
    overflow-x: auto;
    margin: 0;
  }
  .md :global(.code-block pre code.hljs) {
    /* Background and token colours come from the active Atom One theme
       injected at the layout level (via prefers-color-scheme media
       queries). We override only padding and font sizing to match the
       rest of the chat surface. */
    display: block;
    padding: 0.95em 1.05em;
    font-size: 0.88em;
    line-height: 1.55;
  }

  /* Fallback for any plain pre that escapes the wrapper.
     Excludes `.hljs` so the theme's background can come through on
     highlighted code (otherwise this rule's higher specificity beats
     `.hljs { background: #fafafa }` and the code area renders empty). */
  .md :global(pre:not(:has(code.hljs))) {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.85em 1em;
    overflow-x: auto;
    margin: 1em 0;
  }
  .md :global(pre code:not(.hljs)) {
    background: transparent;
    padding: 0;
    font-size: 0.88em;
  }

  .md :global(blockquote) {
    border-left: 3px solid var(--border-strong);
    padding: 0.3em 1em;
    color: var(--text-muted);
    margin: 1em 0;
  }
  .md :global(table) {
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
    margin: 1em 0;
    font-size: 0.95em;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    overflow: hidden;
  }
  .md :global(th),
  .md :global(td) {
    border-bottom: 1px solid var(--border);
    padding: 0.55em 0.85em;
    text-align: left;
  }
  .md :global(tr:last-child td) {
    border-bottom: none;
  }
  .md :global(th) {
    font-weight: 600;
    background: var(--bg-elevated);
    color: var(--text);
    font-size: 0.92em;
    letter-spacing: 0.01em;
  }
  .md :global(hr) {
    border: none;
    border-top: 1px solid var(--border-strong);
    margin: 2em 0;
  }
  .md :global(strong) {
    font-weight: 600;
  }
  /* Highlight.js token colours — Atom One Light/Dark, injected at the
     layout level and switched via prefers-color-scheme. No rules here. */
</style>
