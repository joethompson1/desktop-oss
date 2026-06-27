/**
 * Helpers for rendering tool inputs/results in the chat surface. Ported
 * verbatim from clive-desktop's cockpit so the in-chat tool entries pick
 * up the same syntax-highlighting and diff heuristics.
 */

const EXTENSION_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  sql: "sql",
  html: "html",
  htm: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  svelte: "svelte",
  vue: "html",
  dockerfile: "dockerfile",
  makefile: "makefile",
};

/** Map a file path/name to a highlight.js language hint. */
export function languageForPath(path: string | null | undefined): string {
  if (!path) return "text";
  const lower = path.toLowerCase();
  const slash = lower.lastIndexOf("/");
  const base = slash === -1 ? lower : lower.slice(slash + 1);
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  const dot = base.lastIndexOf(".");
  if (dot === -1) return "text";
  const ext = base.slice(dot + 1);
  return EXTENSION_TO_LANG[ext] ?? "text";
}

/** Build a unified-diff string for an old → new replacement. Fed to
 *  hljs's `diff` language. */
export function buildDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];
  if (oldLines.length === 0 && newLines.length === 0) return "(no change)";
  const out: string[] = [];
  for (const l of oldLines) out.push(`-${l}`);
  for (const l of newLines) out.push(`+${l}`);
  return out.join("\n");
}

/** Safely pull a string field out of a tool input object. */
export function stringInput(
  input: Record<string, unknown> | null | undefined,
  key: string,
): string {
  if (!input) return "";
  const v = input[key];
  return typeof v === "string" ? v : "";
}
