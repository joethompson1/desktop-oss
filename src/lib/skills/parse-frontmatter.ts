import { parse as parseYaml } from "yaml";

import { expandAll } from "./brace-expand";
import type { Skill, SkillArgumentSpec, SkillSource } from "./types";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Result of separating frontmatter from body. */
export interface ParsedDocument {
  /** Raw YAML-parsed object, or `null` when there's no frontmatter
   *  block. Unknown keys are preserved so `edit_skill` (Phase 8) can
   *  round-trip them. */
  frontmatter: Record<string, unknown> | null;
  /** Body with the frontmatter block stripped. Variable substitution
   *  happens later, at invocation time. */
  body: string;
}

/** Split a markdown file into `{ frontmatter, body }`. If the file
 *  starts with `---\n...---\n` we YAML-parse the block; otherwise
 *  `frontmatter` is `null` and `body` is the original text. Throws on
 *  malformed YAML. */
export function splitFrontmatter(input: string): ParsedDocument {
  const match = input.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: input };
  const yamlSrc = match[1] ?? "";
  const parsed = parseYaml(yamlSrc);
  if (parsed === null || parsed === undefined) {
    return { frontmatter: {}, body: input.slice(match[0].length) };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Frontmatter must be a YAML mapping");
  }
  return {
    frontmatter: parsed as Record<string, unknown>,
    body: input.slice(match[0].length),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return fallback;
}

function asContext(value: unknown): "inline" | "fork" {
  if (value === "fork") return "fork";
  return "inline";
}

function asShell(value: unknown): "bash" | "powershell" {
  if (value === "powershell" || value === "pwsh") return "powershell";
  return "bash";
}

function asEffort(value: unknown): Skill["effort"] | undefined {
  if (typeof value === "number") return value;
  if (value === "low" || value === "medium" || value === "high" || value === "max") {
    return value;
  }
  return undefined;
}

function asArguments(
  argumentsValue: unknown,
  hintValue: unknown,
): { args: SkillArgumentSpec[]; hint: string | undefined } {
  const hint = asString(hintValue);
  // Claude Code's convention: `arguments: name1 name2 name3` (space-
  // separated) or `arguments: [name1, name2]`.
  const names: string[] = [];
  if (typeof argumentsValue === "string") {
    for (const tok of argumentsValue.split(/\s+/)) {
      if (tok && !/^\d+$/.test(tok)) names.push(tok);
    }
  } else if (Array.isArray(argumentsValue)) {
    for (const tok of argumentsValue) {
      if (typeof tok === "string" && tok && !/^\d+$/.test(tok)) names.push(tok);
    }
  }
  return {
    args: names.map((name) => ({ name })),
    hint,
  };
}

export interface ParseSkillOptions {
  id: string;
  name: string;
  source: SkillSource;
  origin: string;
}

/** Parse a full SKILL.md (or commands/*.md, etc.) into a normalised
 *  `Skill`. The caller supplies provenance (id/name/source/origin);
 *  this function handles frontmatter parsing, field validation, brace
 *  expansion of `allowed-tools` and `paths`, and default synthesis.
 *
 *  For sources without frontmatter (Codex prompts, Cursor commands),
 *  the caller passes `forceSynthesizeDescription: true` so we lift
 *  the first non-empty body line as the description. */
export function parseSkill(
  input: string,
  opts: ParseSkillOptions & { forceSynthesizeDescription?: boolean },
): Skill {
  const { frontmatter, body: bodyRaw } = splitFrontmatter(input);
  const fm: Record<string, unknown> = frontmatter ?? {};

  const allowedToolsRaw =
    asStringArray(fm["allowed-tools"]) ?? asStringArray(fm.allowedTools) ?? [];
  const allowedTools = expandAll(allowedToolsRaw);

  const pathsRaw = asStringArray(fm.paths);
  const paths = pathsRaw ? expandAll(pathsRaw) : undefined;

  const { args, hint } = asArguments(
    fm.arguments,
    fm["argument-hint"] ?? fm.argumentHint,
  );

  let description = asString(fm.description);
  if (!description && (opts.forceSynthesizeDescription || frontmatter === null)) {
    description = synthesizeDescription(bodyRaw);
  }

  return {
    id: opts.id,
    name: opts.name,
    source: opts.source,
    origin: opts.origin,
    description: description ?? opts.name,
    whenToUse: asString(fm["when-to-use"] ?? fm.whenToUse),
    argumentHint: hint,
    arguments: args,
    allowedTools,
    context: asContext(fm.context),
    agent: asString(fm.agent),
    paths,
    shell: asShell(fm.shell),
    modelOverride: asString(fm.model),
    effort: asEffort(fm.effort),
    version: asString(fm.version),
    userInvocable: asBoolean(fm["user-invocable"] ?? fm.userInvocable, true),
    hideFromSkillTool: asBoolean(
      fm["hide-from-slash-command-tool"] ?? fm.hideFromSkillTool,
      false,
    ),
    body: bodyRaw,
    frontmatter: fm,
  };
}

/** First non-empty line of the body, trimmed to 200 chars. Used when
 *  no `description:` frontmatter is supplied (Codex prompts, Cursor
 *  commands). */
function synthesizeDescription(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return t.length > 200 ? t.slice(0, 197) + "..." : t;
  }
  return "";
}
