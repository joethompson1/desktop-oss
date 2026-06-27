// Loader for the Cursor source — two roots:
//   - `~/.cursor/skills-cursor/<name>/SKILL.md` (full frontmatter)
//   - `~/.cursor/commands/<name>.md` (plain markdown, synthesise description)

import { homeDir, joinPath } from "../rust";
import type { Skill } from "../types";
import { loadFromRoots, type RootRecipe } from "./shared";

export async function loadCursorSkills(): Promise<Skill[]> {
  const home = await homeDir();
  if (!home) return [];
  const recipes: RootRecipe[] = [
    {
      path: joinPath(home, ".cursor/skills-cursor"),
      forceSynthesizeDescription: false,
    },
    {
      path: joinPath(home, ".cursor/commands"),
      forceSynthesizeDescription: true,
    },
  ];
  return loadFromRoots("cursor", recipes);
}
