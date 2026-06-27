// Shared loader helpers — every source has the same shape: a list of
// recipe entries (root path + a "synthesize description?" flag) plus a
// source-id used for the composite skill id. The orchestration is the
// same; the loaders just feed different recipes in.

import { parseSkill } from "../parse-frontmatter";
import { listSkillFiles, readSkillFile, type SkillFileEntry } from "../rust";
import type { Skill, SkillSource } from "../types";

export interface RootRecipe {
  /** Absolute path to scan. Missing paths are silently skipped. */
  path: string;
  /** When true, the loader will fall back to first-non-empty-line if
   *  the file's frontmatter doesn't include a `description:`. Needed
   *  for sources that conventionally ship plain markdown — Codex
   *  prompts and Cursor commands. */
  forceSynthesizeDescription: boolean;
}

export async function loadFromRoots(
  source: SkillSource,
  recipes: readonly RootRecipe[],
): Promise<Skill[]> {
  // Discover file paths from all recipes in one Tauri round-trip.
  const paths = recipes.map((r) => r.path);
  const entries = await listSkillFiles(paths);
  // Map each entry back to whether its containing root wants
  // synthesised descriptions. Cheap because recipes is short.
  const recipeFor = (entry: SkillFileEntry): RootRecipe | undefined =>
    recipes.find((r) => entry.path.startsWith(`${r.path}/`));

  const skills = await Promise.all(
    entries.map(async (entry) => {
      const recipe = recipeFor(entry);
      const name = nameFromPath(entry);
      if (!name) return null;
      let contents: string;
      try {
        contents = await readSkillFile(entry.path);
      } catch {
        return null;
      }
      try {
        return parseSkill(contents, {
          id: `${source}:${name}`,
          name,
          source,
          origin: entry.path,
          forceSynthesizeDescription: recipe?.forceSynthesizeDescription,
        });
      } catch {
        return null;
      }
    }),
  );
  return skills.filter((s): s is Skill => s !== null);
}

/** Derive the skill name from a discovered file's path + kind.
 *  - Flat (`<root>/<name>.md`) → basename without extension
 *  - Nested (`<root>/<name>/SKILL.md`) → parent directory name */
function nameFromPath(entry: SkillFileEntry): string | null {
  if (entry.kind === "flat") {
    const filename = entry.path.split("/").pop() ?? "";
    const stem = filename.replace(/\.md$/i, "");
    return stem || null;
  }
  // Nested: take the parent directory name.
  const parts = entry.path.split("/");
  // parts[parts.length - 1] === "SKILL.md"
  const parent = parts[parts.length - 2] ?? "";
  return parent || null;
}
