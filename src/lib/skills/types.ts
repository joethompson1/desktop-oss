export type SkillSource = "claude" | "cursor" | "codex" | "local";

export interface SkillArgumentSpec {
  name: string;
  hint?: string;
  required?: boolean;
}

/** Normalised skill record used by the menu, the Skill tool, and the
 *  invocation pipeline. Strict superset of an MCP `GetPromptResult`
 *  so MCP-sourced prompts can be wrapped without translation in the
 *  future. */
export interface Skill {
  /** Composite ID — `${source}:${name}`. */
  id: string;
  /** Display name, no leading slash. Hyphenated. */
  name: string;
  source: SkillSource;
  /** Filesystem path to the skill source. */
  origin: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  arguments: SkillArgumentSpec[];
  /** Brace-expanded list (e.g. `Bash(git {add,commit})` →
   *  `['Bash(git add)', 'Bash(git commit)']`). Advisory in Phase 1. */
  allowedTools: string[];
  context: "inline" | "fork";
  /** When context==='fork', harness `name` to dispatch to. Resolved
   *  at invocation time; falls back to the default delegate. */
  agent?: string;
  /** Conditional skills — gitignore-style globs. Hidden from the
   *  menu until a matching file is touched. */
  paths?: string[];
  shell: "bash" | "powershell";
  /** Per-skill model ID override (applied for that skill's turn). */
  modelOverride?: string;
  /** Per-skill thinking budget hint. Translated per provider. */
  effort?: "low" | "medium" | "high" | "max" | number;
  /** Informational metadata; shown in tooltip; round-tripped. */
  version?: string;
  /** Hide from `/` menu (still available to the Skill tool). */
  userInvocable: boolean;
  /** Hide from Skill tool's listing (still available via `/` menu). */
  hideFromSkillTool: boolean;
  /** Body with frontmatter stripped, variables NOT yet substituted. */
  body: string;
  /** Raw parsed frontmatter, for forward-compat and round-trip
   *  through `edit_skill`. */
  frontmatter: Record<string, unknown>;
}

/** Per-name usage stats for recency-weighted ranking. */
export interface UsageEntry {
  usageCount: number;
  lastUsedAt: number;
}

export type UsageMap = Record<string, UsageEntry>;
