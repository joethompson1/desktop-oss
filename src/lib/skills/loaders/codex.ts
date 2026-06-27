// Loader for the Codex source — single root with plain markdown
// files. Every file gets a synthesised description (lifted from the
// first non-empty body line) because Codex doesn't use frontmatter.

import { homeDir, joinPath } from "../rust";
import type { Skill } from "../types";
import { loadFromRoots, type RootRecipe } from "./shared";

export async function loadCodexSkills(): Promise<Skill[]> {
  const home = await homeDir();
  if (!home) return [];
  const recipes: RootRecipe[] = [
    {
      path: joinPath(home, ".codex/prompts"),
      forceSynthesizeDescription: true,
    },
  ];
  return loadFromRoots("codex", recipes);
}
