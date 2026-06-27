// Loader for the Local source — skills authored from inside Clive
// itself (Phase 8). The directory is reserved here so a real user
// can also hand-author skills under `~/.clive/skills/` and have them
// picked up immediately.

import { homeDir, joinPath } from "../rust";
import type { Skill } from "../types";
import { loadFromRoots, type RootRecipe } from "./shared";

export async function loadLocalSkills(): Promise<Skill[]> {
  const home = await homeDir();
  if (!home) return [];
  const recipes: RootRecipe[] = [
    { path: joinPath(home, ".clive/skills"), forceSynthesizeDescription: false },
  ];
  return loadFromRoots("local", recipes);
}
