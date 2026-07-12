// Map a harness's `type` to the skill source family whose skills
// should appear in that delegate's slash menu. Used by the
// run-detail surface to filter the menu so a Claude Code delegate
// only sees Anthropic + Local skills, etc.
//
// Returns `null` for harnesses with no specific source family — those
// surfaces fall back to "Local only" in the menu (the user has
// explicitly picked a generic-API harness; they aren't tied to any
// ecosystem's skill format).

import type { HarnessType } from "$lib/types/harness";
import type { SkillSource } from "./types";

export function harnessToSourceFamily(
  type: HarnessType | undefined,
): SkillSource | null {
  switch (type) {
    case "claude-code":
      return "claude";
    case "codex":
      return "codex";
    case "cursor":
      return "cursor";
    case "anthropic":
    case "openai-compatible":
    case undefined:
      return null;
  }
}
