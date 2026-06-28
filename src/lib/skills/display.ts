import type { SkillSource } from "./types";

/** Shortform prefix used in the menu row (and as the namespace-escape
 *  in the textarea) for non-local sources. Local skills have no prefix
 *  to keep the most common case visually clean. */
export function displayPrefix(source: SkillSource): string {
  switch (source) {
    case "claude":
      return "anthropic";
    case "cursor":
      return "cursor";
    case "codex":
      return "codex";
    case "local":
      return "";
  }
}

/** Longer brand name for the hover-tooltip source parenthetical. */
export function sourceLabel(source: SkillSource): string {
  switch (source) {
    case "claude":
      return "Anthropic";
    case "cursor":
      return "Cursor";
    case "codex":
      return "Codex";
    case "local":
      return "Local";
  }
}

/** The string a row should render in the menu. Local skills get the
 *  bare name; everything else gets `prefix:name`. */
export function displayName(source: SkillSource, name: string): string {
  const prefix = displayPrefix(source);
  return prefix ? `${prefix}:${name}` : name;
}
