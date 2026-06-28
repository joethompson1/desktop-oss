// Cross-source skill aggregator. Loaders return per-source skill
// lists; the registry merges them, dedupes by absolute path (so a
// symlink pointing across roots only shows once), resolves intra-
// source name collisions (e.g. `~/.claude/skills/commit/SKILL.md` and
// `~/.claude/commands/commit.md` — first one wins, second is dropped
// with a console warning), and returns the flat list the menu and
// the Skill tool consume.

import { loadClaudeSkills } from "./loaders/claude";
import { loadCursorSkills } from "./loaders/cursor";
import { loadCodexSkills } from "./loaders/codex";
import { loadLocalSkills } from "./loaders/local";
import type { Skill, SkillSource } from "./types";

export interface SourceEnablement {
  /** Per-source on/off toggle. Defaults to all-enabled on first run. */
  enabled: Record<SkillSource, boolean>;
}

export const DEFAULT_SOURCE_ENABLEMENT: SourceEnablement = {
  enabled: {
    local: true,
    claude: true,
    cursor: true,
    codex: true,
  },
};

/** Run every enabled loader, dedupe by path, resolve intra-source
 *  name collisions. Returns the flat list ready for the menu. */
export async function loadAllSkills(
  enablement: SourceEnablement = DEFAULT_SOURCE_ENABLEMENT,
): Promise<Skill[]> {
  const loaders: Array<{ source: SkillSource; load: () => Promise<Skill[]> }> = [
    { source: "local", load: loadLocalSkills },
    { source: "claude", load: loadClaudeSkills },
    { source: "cursor", load: loadCursorSkills },
    { source: "codex", load: loadCodexSkills },
  ];

  const lists = await Promise.all(
    loaders
      .filter((l) => enablement.enabled[l.source])
      .map(async (l) => {
        try {
          return await l.load();
        } catch (err) {
          console.warn(`[skills] loader for ${l.source} failed:`, err);
          return [] as Skill[];
        }
      }),
  );

  // Pass 1: dedupe by absolute path. Same file under two roots (e.g.
  // a project root nested under home) counts once.
  const byPath = new Map<string, Skill>();
  for (const list of lists) {
    for (const skill of list) {
      if (!byPath.has(skill.origin)) {
        byPath.set(skill.origin, skill);
      }
    }
  }

  // Pass 2: resolve intra-source name collisions. Skills are merged
  // back into a flat list; for any (source, name) pair seen twice we
  // keep the first one and drop the rest. Cross-source collisions are
  // NOT dropped — they're disambiguated by the display prefix
  // (`anthropic:commit` vs `cursor:commit` vs bare local `commit`).
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const skill of byPath.values()) {
    const key = `${skill.source}::${skill.name}`;
    if (seen.has(key)) {
      console.warn(
        `[skills] duplicate ${skill.source} skill '${skill.name}'` +
          ` at ${skill.origin} — keeping earlier entry`,
      );
      continue;
    }
    seen.add(key);
    out.push(skill);
  }
  return out;
}
