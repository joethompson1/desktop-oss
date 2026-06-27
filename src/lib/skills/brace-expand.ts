/** Recursive shell-style brace expansion. Ported from Claude Code's
 *  `expandBraces` (src/utils/frontmatterParser.ts:240-266) — the same
 *  one-pair-at-a-time, recurse-on-suffix algorithm. Nested braces with
 *  internal commas aren't supported (matches Claude Code's constraint).
 *
 *  Examples:
 *    expandBraces("a")              → ["a"]
 *    expandBraces("{a,b}")          → ["a", "b"]
 *    expandBraces("src/*.{ts,tsx}") → ["src/*.ts", "src/*.tsx"]
 *    expandBraces("{a,b}/{c,d}")    → ["a/c", "a/d", "b/c", "b/d"]
 */
export function expandBraces(pattern: string): string[] {
  const m = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/);
  if (!m) return [pattern];
  const [, prefix = "", alts = "", suffix = ""] = m;
  return alts
    .split(",")
    .flatMap((alt) => expandBraces(prefix + alt.trim() + suffix));
}

/** Convenience: expand a list of patterns into a flattened list. */
export function expandAll(patterns: readonly string[]): string[] {
  return patterns.flatMap(expandBraces);
}
