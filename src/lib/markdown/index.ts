import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";
import xml from "highlight.js/lib/languages/xml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapCodeBlock(langLabel: string, langClass: string, body: string): string {
  const safeLabel = escapeHtml(langLabel);
  const safeClass = escapeHtml(langClass);
  return (
    `<div class="code-block">` +
    `<div class="code-header">` +
    `<span class="code-lang">${safeLabel}</span>` +
    `<button type="button" class="code-copy" aria-label="Copy code">Copy</button>` +
    `</div>` +
    `<pre><code class="hljs language-${safeClass}">${body}</code></pre>` +
    `</div>`
  );
}

const renderer = new marked.Renderer();
renderer.code = function (codeArgs) {
  const { text, lang } = codeArgs;
  const langStr = lang?.trim() ?? "";
  if (langStr && hljs.getLanguage(langStr)) {
    const highlighted = hljs.highlight(text, {
      language: langStr,
      ignoreIllegals: true,
    }).value;
    return wrapCodeBlock(langStr, langStr, highlighted);
  }
  return wrapCodeBlock("text", "text", escapeHtml(text));
};

marked.setOptions({
  renderer,
  gfm: true,
  breaks: true,
});

export function renderMarkdown(input: string): string {
  const dirty = marked.parse(input, { async: false }) as string;
  return DOMPurify.sanitize(dirty, {
    ADD_ATTR: ["target", "rel"],
  });
}

/**
 * Render `text` as highlighted HTML using the same hljs registry that the
 * chat-markdown pipeline uses. Returns plain escaped text when the language
 * isn't registered, so the caller can always drop the result into a
 * `<code class="hljs">`.
 */
export function highlightCode(text: string, language: string): string {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  }
  return escapeHtml(text);
}

export { escapeHtml };
