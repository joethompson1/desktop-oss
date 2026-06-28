// Loader for the Local source — skills authored from inside the app
// itself (Phase 8). The directory is reserved here so a real user
// can also hand-author skills under `~/.desktop-oss/skills/` and have them
// picked up immediately.

import { homeDir, joinPath } from "../rust";
import type { Skill } from "../types";
import { loadFromRoots, type RootRecipe } from "./shared";

export async function loadLocalSkills(): Promise<Skill[]> {
  const home = await homeDir();
  if (!home) return [];
  const recipes: RootRecipe[] = [
    { path: joinPath(home, ".desktop-oss/skills"), forceSynthesizeDescription: false },
  ];
  return loadFromRoots("local", recipes);
}
