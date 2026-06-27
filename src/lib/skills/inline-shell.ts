// Inline-shell expansion for skill bodies. Two regex shapes, both
// transcribed from Claude Code's `promptShellExecution.ts`:
//
//   - Block:  ```!\n<cmd>\n```      → multi-line command(s)
//   - Inline: !`<cmd>`               → single-line command
//
// The inline form's positive lookbehind on whitespace prevents false
// matches inside markdown inline-code spans (`` `foo!`bar`` ``).
//
// Execution model: each block runs in parallel via Promise.all, each
// gated independently by the permission store. Output replaces the
// match in-place using a function-replacer so `$` in stdout isn't
// interpreted as a regex back-reference.

import { displayName, sourceLabel } from "./display";
import { requestPermission } from "$lib/stores/skill-permissions.svelte";
import type { Skill } from "./types";
import { runSkillShell, type ShellResult } from "./rust";

const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g;
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm;

export interface ExpandShellOptions {
  /** Working directory to spawn shells in. For now this is the user's
   *  home directory; Phase 8 can expose a per-project setting. */
  cwd: string;
  /** Per-command timeout. Defaults to 30s. */
  timeoutMs?: number;
}

/** Expand every `!\`cmd\`` / ` ```! cmd ``` ` block in `body`,
 *  replacing each in-place with its shell output. Permission-gated
 *  per command. Returns the expanded body — if any command is
 *  denied, its match is replaced with a `<!-- permission denied -->`
 *  marker (the model still sees a body; just without that output). */
export async function expandShellBlocks(
  body: string,
  skill: Skill,
  opts: ExpandShellOptions,
): Promise<string> {
  // Gather both block and inline matches up front. Block matches are
  // greedy and may span lines; inline matches are single-line.
  const blockMatches = Array.from(body.matchAll(BLOCK_PATTERN));
  const inlineMatches = body.includes("!`")
    ? Array.from(body.matchAll(INLINE_PATTERN))
    : [];
  const all = [...blockMatches, ...inlineMatches];
  if (all.length === 0) return body;

  // Run every command in parallel — same as Claude Code's
  // `Promise.all([...blockMatches, ...inlineMatches].map(...))`.
  const replacements = await Promise.all(
    all.map(async (match) => {
      const fullMatch = match[0];
      const cmd = (match[1] ?? "").trim();
      if (!cmd) return { fullMatch, output: "" };
      const decision = await requestPermission({
        command: cmd,
        skillName: skill.name,
        skillSourceLabel: sourceLabel(skill.source),
        skillAllowedTools: skill.allowedTools,
      });
      if (decision === "deny") {
        return {
          fullMatch,
          output: `<!-- permission denied: ${cmd} -->`,
        };
      }
      try {
        const result = await runSkillShell(
          cmd,
          skill.shell === "powershell" ? "powershell" : "bash",
          opts.cwd,
          opts.timeoutMs ?? 30_000,
        );
        return { fullMatch, output: formatShellOutput(cmd, result) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { fullMatch, output: `<!-- shell error: ${msg} -->` };
      }
    }),
  );

  // Apply replacements. Using function-replacers avoids `$` in stdout
  // being interpreted as regex back-references.
  let out = body;
  for (const { fullMatch, output } of replacements) {
    out = out.replace(fullMatch, () => output);
  }
  return out;
}

/** Format `{ stdout, stderr, exit_code, timed_out }` into a single
 *  text block. Mirrors Claude Code's `formatBashOutput` shape: stdout
 *  first, stderr appended inline with a marker, exit code and timeout
 *  surfaced for context. */
function formatShellOutput(cmd: string, result: ShellResult): string {
  const parts: string[] = [];
  if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
  if (result.stderr.trim()) {
    parts.push(`(stderr) ${result.stderr.trimEnd()}`);
  }
  if (result.timed_out) {
    parts.push(`(timed out after running: ${cmd})`);
  } else if (result.exit_code !== 0) {
    parts.push(`(exited ${result.exit_code})`);
  }
  return parts.join("\n");
}

/** Used by the materialise pipeline to know whether shell expansion
 *  is needed at all — skips the (cheap but still non-zero) regex
 *  pass and avoids resolving a home-dir cwd when no commands exist. */
export function bodyHasShellBlocks(body: string): boolean {
  return /```!\s/.test(body) || /(?:^|\s)!`/m.test(body);
}
