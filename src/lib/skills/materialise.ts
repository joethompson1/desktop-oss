// Send-time skill detection + materialisation. The menu's
// `findSlashTrigger` is for live filtering ("is the user still typing
// a command name?"); this module handles the moment the user hits
// Enter on `/command args` — extracting the invocation, looking up
// the skill, substituting variables, and returning the expanded body
// that goes to the model.

import { bodyHasShellBlocks, expandShellBlocks } from "./inline-shell";
import { homeDir } from "./rust";
import { substituteVariables, skillDirFor } from "./substitute";
import type { Skill, SkillSource } from "./types";

export interface MaterialisedInvocation {
  /** The skill that ran. */
  skill: Skill;
  /** Raw arguments string the user typed after the command name. */
  rawArgs: string;
  /** Substituted skill body — what the model sees in addition to the
   *  user's literal text. Shell-block expansion (Phase 4) wraps this. */
  expandedBody: string;
}

/** Detect `/command [args]` ending the input. The slash must be at
 *  start-of-input or preceded by whitespace; the command name must
 *  be one or more non-whitespace, non-slash characters. Returns null
 *  for inputs without a trailing slash command, including bare `/`. */
export function detectInvocation(
  text: string,
): { commandName: string; rawArgs: string; start: number } | null {
  const m = text.match(/(^|\s)(\/)([^\s/][^\s]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const [, prefix = "", , commandName = "", rawArgs = ""] = m;
  const slashIdx = (m.index ?? 0) + prefix.length;
  return { commandName, rawArgs: rawArgs.trim(), start: slashIdx };
}

const SOURCE_PRIORITY: SkillSource[] = [
  "local",
  "claude",
  "cursor",
  "codex",
];

const PREFIX_TO_SOURCE: Record<string, SkillSource> = {
  anthropic: "claude",
  cursor: "cursor",
  codex: "codex",
  local: "local",
};

/** Resolve a typed command name to a concrete skill. Namespaced names
 *  (`anthropic:commit`) bind to that source explicitly; bare names
 *  fall through the source-priority order so `/commit` picks the
 *  user's local `commit` first, then Anthropic's, etc. */
export function lookupSkill(
  commandName: string,
  allSkills: readonly Skill[],
): Skill | null {
  const colon = commandName.indexOf(":");
  if (colon !== -1) {
    const prefix = commandName.slice(0, colon);
    const bareName = commandName.slice(colon + 1);
    const source = PREFIX_TO_SOURCE[prefix];
    if (!source) return null;
    return (
      allSkills.find((s) => s.source === source && s.name === bareName) ?? null
    );
  }
  for (const src of SOURCE_PRIORITY) {
    const match = allSkills.find((s) => s.source === src && s.name === commandName);
    if (match) return match;
  }
  return null;
}

/** End-to-end: detect the slash command at the tail of `text`, look
 *  up the matching skill, materialise the body. Variable substitution
 *  runs first; if the resulting body has any `!\`cmd\`` blocks they
 *  run next (Phase 4) under permission gating. Returns null if the
 *  text doesn't end with a recognised invocation. */
export async function materialiseInvocation(
  text: string,
  allSkills: readonly Skill[],
  sessionId: string,
): Promise<MaterialisedInvocation | null> {
  const detected = detectInvocation(text);
  if (!detected) return null;
  const skill = lookupSkill(detected.commandName, allSkills);
  if (!skill) return null;
  let expandedBody = substituteVariables(skill.body, {
    rawArgs: detected.rawArgs,
    argumentNames: skill.arguments.map((a) => a.name),
    skillDir: skillDirFor(skill),
    sessionId,
  });
  if (bodyHasShellBlocks(expandedBody)) {
    const cwd = (await homeDir()) ?? "/";
    expandedBody = await expandShellBlocks(expandedBody, skill, { cwd });
  }
  return {
    skill,
    rawArgs: detected.rawArgs,
    expandedBody,
  };
}
