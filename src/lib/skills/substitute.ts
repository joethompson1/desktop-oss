// Variable substitution for skill bodies. Mirrors Claude Code's
// `substituteArguments` (src/utils/argumentSubstitution.ts:94-145)
// almost line-for-line — same regex shapes, same precedence, same
// no-placeholder fallback.

import { parseArgs } from "./parse-args";
import type { Skill } from "./types";

export interface SubstitutionContext {
  /** Free-text arguments string captured after `/skill-name`. */
  rawArgs: string;
  /** Names declared in frontmatter `arguments:`. Used for $name
   *  substitution. Extra args beyond declared names are still
   *  available via $0, $1, $ARGUMENTS. */
  argumentNames: string[];
  /** Absolute path to the skill's directory — substituted into
   *  `${CLAUDE_SKILL_DIR}` and `${DESKTOP_OSS_SKILL_DIR}`. */
  skillDir: string;
  /** Current conversation id — substituted into
   *  `${CLAUDE_SESSION_ID}` and `${DESKTOP_OSS_SESSION_ID}`. */
  sessionId: string;
}

/** Substitute variables in `body`. Order matches Claude Code:
 *
 *    1. Named args $foo / $bar (when `arguments:` declared)
 *    2. Indexed $ARGUMENTS[N]
 *    3. Shorthand $0, $1, $2 ...
 *    4. Full $ARGUMENTS
 *    5. Specials ${CLAUDE_SKILL_DIR}, ${CLAUDE_SESSION_ID} (+ legacy aliases)
 *    6. No-placeholder fallback — if nothing changed and args were
 *       supplied, append `ARGUMENTS: <args>` to the body.
 *
 *  Missing args become empty strings (no throw, no warning) — matches
 *  Claude Code semantics. */
export function substituteVariables(body: string, ctx: SubstitutionContext): string {
  const original = body;
  let out = body;
  const parsed = parseArgs(ctx.rawArgs);

  // 1. Named args
  for (let i = 0; i < ctx.argumentNames.length; i++) {
    const name = ctx.argumentNames[i];
    if (!name) continue;
    out = out.replace(
      new RegExp(`\\$${escapeRegex(name)}(?![\\[\\w])`, "g"),
      parsed[i] ?? "",
    );
  }
  // 2. $ARGUMENTS[N]
  out = out.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, n: string) => parsed[+n] ?? "");
  // 3. $N (shorthand) — but not $123abc
  out = out.replace(/\$(\d+)(?!\w)/g, (_, n: string) => parsed[+n] ?? "");
  // 4. $ARGUMENTS — whole string
  out = out.replaceAll("$ARGUMENTS", ctx.rawArgs);

  // 5. Specials
  out = out
    .replaceAll("${CLAUDE_SKILL_DIR}", ctx.skillDir)
    .replaceAll("${CLAUDE_SESSION_ID}", ctx.sessionId)
    .replaceAll("${DESKTOP_OSS_SKILL_DIR}", ctx.skillDir)
    .replaceAll("${DESKTOP_OSS_SESSION_ID}", ctx.sessionId);

  // 6. No-placeholder fallback
  const argsChangedSomething = out !== original;
  if (!argsChangedSomething && ctx.rawArgs.trim()) {
    out = `${out}\n\nARGUMENTS: ${ctx.rawArgs}`;
  }
  return out;
}

/** Derive the skill's directory from its origin path. Nested skills
 *  (`/skills/<name>/SKILL.md`) → parent dir. Flat skills
 *  (`/commands/<name>.md`) → containing dir. */
export function skillDirFor(skill: Skill): string {
  const lastSlash = skill.origin.lastIndexOf("/");
  if (lastSlash <= 0) return skill.origin;
  const stem = skill.origin.slice(lastSlash + 1);
  // Nested layout: origin ends in "/SKILL.md"; skill dir is the
  // parent.
  if (stem === "SKILL.md") return skill.origin.slice(0, lastSlash);
  // Flat layout: skill dir is the containing dir.
  return skill.origin.slice(0, lastSlash);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
