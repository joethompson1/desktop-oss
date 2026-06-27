// Pattern matching for skill shell-expansion permissions.
//
// Patterns look like `Bash(git status *)`. The outer envelope tells
// us which tool the pattern applies to (only `Bash` for now —
// `FileRead`, `FileWrite`, etc. would follow the same shape if we
// add them). Inside the parens, `*` is a single greedy wildcard
// matching any character sequence.
//
// Brace expansion (`Bash(git {add,commit,push})`) is handled at
// frontmatter-parse time by `brace-expand.ts`, so patterns reaching
// this matcher are already flat.

import { expandBraces } from "./brace-expand";

/** Result of comparing a command against a list of patterns. */
export interface MatchResult {
  /** True iff at least one pattern matched. */
  matched: boolean;
  /** The pattern that matched (first one wins). */
  pattern: string | null;
}

/** Match a single bash command against a flat list of patterns. */
export function matchBashCommand(
  command: string,
  patterns: readonly string[],
): MatchResult {
  const trimmed = command.trim();
  for (const raw of patterns) {
    for (const expanded of expandBraces(raw)) {
      const inner = extractBashInner(expanded);
      if (inner === null) continue;
      if (globMatch(inner, trimmed)) {
        return { matched: true, pattern: expanded };
      }
    }
  }
  return { matched: false, pattern: null };
}

/** Extract the inner string from a `Bash(...)` envelope. Returns null
 *  if the pattern doesn't target Bash. */
function extractBashInner(pattern: string): string | null {
  const m = pattern.match(/^Bash\((.*)\)$/);
  return m ? (m[1] ?? "") : null;
}

/** Glob match: `*` is the only wildcard; everything else is a
 *  literal. Anchored at both ends. */
function globMatch(pattern: string, input: string): boolean {
  // Escape regex specials except `*`, then convert `*` to `.*`.
  const re = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${re}$`).test(input);
}

/** Suggest a sensible "Always allow" pattern for `command` —
 *  first one or two words + `*`. Editable in the modal before
 *  the user commits. */
export function suggestPattern(command: string): string {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0 || !tokens[0]) return "Bash(*)";
  if (tokens.length === 1) return `Bash(${tokens[0]})`;
  // Two-word commands (e.g. `git status`) get the subcommand baked in
  // for specificity; single-word commands stay narrow.
  const [first = "", second = ""] = tokens;
  return `Bash(${first} ${second} *)`;
}
