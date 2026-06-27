import { displayPrefix } from "./display";
import type { Skill, SkillSource, UsageMap } from "./types";

/** Display order for source-grouping in the menu — Local first (the
 *  user authored these), then Anthropic / Cursor / Codex by ecosystem
 *  maturity, then MCP (advertised by external servers). */
const SOURCE_ORDER: Record<SkillSource, number> = {
  local: 0,
  claude: 1,
  cursor: 2,
  codex: 3,
  mcp: 4,
};

/** Recency-weighted score, ported from Claude Code's
 *  `getSkillUsageScore`. Halves every 7 days, floor 0.1. */
export function recencyScore(name: string, usage: UsageMap): number {
  const u = usage[name];
  if (!u) return 0;
  const daysSinceUse = (Date.now() - u.lastUsedAt) / 86_400_000;
  const recencyFactor = Math.max(0.5 ** (daysSinceUse / 7), 0.1);
  return u.usageCount * recencyFactor;
}

/** Score for (skill, query) — higher = more relevant. Returns -1 for
 *  non-matches so callers can drop them.
 *
 *  Supports three query shapes:
 *  - `com` — name match (prefix/contains)
 *  - `anthropic` — source-prefix match (returns all Anthropic skills)
 *  - `anthropic:com` — namespace + name match (only Anthropic skills
 *    whose names contain "com")
 */
export function score(skill: Skill, query: string, usage: UsageMap): number {
  const q = query.toLowerCase();
  if (q === "") {
    return recencyScore(skill.name, usage);
  }
  const name = skill.name.toLowerCase();
  const desc = skill.description.toLowerCase();
  const prefix = displayPrefix(skill.source);

  // Namespaced query: "prefix:name"
  const colonIdx = q.indexOf(":");
  if (colonIdx !== -1) {
    const queryPrefix = q.slice(0, colonIdx);
    const queryName = q.slice(colonIdx + 1);
    if (!prefix) return -1; // local skills have no prefix and can't match namespaced queries
    if (queryPrefix && !prefix.startsWith(queryPrefix)) return -1;
    if (queryName === "") return 70 + recencyScore(skill.name, usage);
    if (name === queryName) return 100 + recencyScore(skill.name, usage);
    if (name.startsWith(queryName)) return 80 + recencyScore(skill.name, usage);
    if (name.includes(queryName)) return 60 + recencyScore(skill.name, usage);
    return -1;
  }

  // Single-token query: match against name, source prefix, then description.
  let r: number;
  if (name === q) r = 100;
  else if (name.startsWith(q)) r = 80;
  else if (prefix && prefix.startsWith(q)) r = 75;
  else if (name.includes(q)) r = 60;
  else if (prefix && prefix.includes(q)) r = 50;
  else if (desc.includes(q)) r = 40;
  else return -1;
  return r + recencyScore(skill.name, usage);
}

/** Filter + sort by score. Items scoring -1 are dropped. */
export function filterSkills(
  all: Skill[],
  query: string,
  usage: UsageMap,
): Skill[] {
  const scored: Array<{ s: Skill; r: number }> = [];
  for (const s of all) {
    if (!s.userInvocable) continue;
    const r = score(s, query, usage);
    if (r >= 0) scored.push({ s, r });
  }
  // Sort order:
  //   1. Source group (local → anthropic → cursor → codex → mcp) so the
  //      menu reads as bands of one provider at a time.
  //   2. Score within the group — when filtering, the best name match
  //      floats to the top of its band.
  //   3. Alphabetical fallback so the order is stable.
  scored.sort((a, b) => {
    const so = SOURCE_ORDER[a.s.source] - SOURCE_ORDER[b.s.source];
    if (so !== 0) return so;
    if (b.r !== a.r) return b.r - a.r;
    return a.s.name.localeCompare(b.s.name);
  });
  return scored.map(({ s }) => s);
}
