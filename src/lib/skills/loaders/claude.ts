// Loader for the Claude Code source — covers both the new
// `~/.claude/skills/<name>/SKILL.md` directory layout and the legacy
// `~/.claude/commands/<name>.md` flat layout.

import { homeDir, joinPath } from "../rust";
import type { Skill } from "../types";
import { loadFromRoots, type RootRecipe } from "./shared";

export async function loadClaudeSkills(): Promise<Skill[]> {
  const home = await homeDir();
  if (!home) return [];
  const recipes: RootRecipe[] = [
    { path: joinPath(home, ".claude/skills"), forceSynthesizeDescription: false },
    { path: joinPath(home, ".claude/commands"), forceSynthesizeDescription: false },
  ];
  return loadFromRoots("claude", recipes);
}
