// Pure delegate-prompt composition: turning an orchestrator-authored role
// plus the base delegate prompt into the system prompt and task brief a
// delegate actually receives. Kept free of DB / Tauri imports so the rules
// here — "sealed → role in the brief, general → role in the system prompt" —
// are unit-testable in plain `node:test` (see delegate-prompt.test.ts). The
// DB-bound runner (`delegate.ts`) wires these into runDelegate / continueRun /
// streamDelegateContinue.

import type { HarnessKind } from "$lib/types/harness";

/**
 * Footer appended after an orchestrator-authored role for a general
 * (raw-LLM) delegate. Keeps the persona primary but reinstates the generic
 * delegate hygiene the coding-flavoured default prompt would otherwise
 * provide — without contradicting the persona (a tutor must not be told it
 * is a "specialist coding sub-agent").
 */
export const DELEGATE_ROLE_FOOTER =
  "---\n" +
  "You are running as a delegate sub-agent inside a larger workspace, in the role described above. " +
  "You have no memory of the orchestrator's conversation beyond the brief you were given — everything you need is in the brief. " +
  "Stay in this role and within the scope of your task. The user may open your page and talk to you directly; stay in character when they do. " +
  "When you have completed the task (or taken it as far as you can), report back concisely: what you did or found, any assumptions you made, and anything the orchestrator should know.";

/** The subset of a delegate spawn that shapes the task brief. */
export interface DelegateBriefInput {
  task: string;
  role?: string;
  context?: string;
  filesOfInterest?: string[];
  workingDirectory?: string;
}

/**
 * Build the system prompt for a delegate turn, given the (possibly
 * user-edited) base delegate prompt, the orchestrator-authored role (if any),
 * the harness kind, and the stock default prompt (so we can tell a
 * user-customized base apart from the shipped one).
 *
 * - general delegates WITH a role: the role is the delegate's identity, plus
 *   a hygiene footer. The shipped coding-flavoured default is dropped (it
 *   would fight the persona), but a base the user edited in Settings is
 *   preserved beneath the persona — it may carry org policy or safety
 *   constraints that must survive regardless of the persona.
 * - sealed delegates: the role can't override the agent's own system prompt,
 *   so it is folded into the task brief instead (see buildDelegateBrief) and
 *   the base prompt is passed through unchanged.
 * - anything without a role: the base prompt, unchanged.
 */
export function composeDelegateSystemPrompt(
  base: string,
  role: string | undefined,
  kind: HarnessKind,
  defaultBase: string,
): string {
  const trimmedRole = role?.trim();
  if (!trimmedRole || kind === "sealed") return base;

  const parts = [trimmedRole];
  // Preserve a base the user deliberately customized (policy/safety), but not
  // the shipped coding-flavoured default, which contradicts a persona.
  const trimmedBase = base.trim();
  if (trimmedBase && trimmedBase !== defaultBase.trim()) {
    parts.push(trimmedBase);
  }
  parts.push(DELEGATE_ROLE_FOOTER);
  return parts.join("\n\n");
}

export function buildDelegateBrief(
  input: DelegateBriefInput,
  kind: HarnessKind,
): string {
  const lines: string[] = [];
  // Sealed coding agents can't be reprogrammed via the system prompt, so a
  // role the orchestrator authored is folded into the brief as framing.
  // General delegates receive the role as their system prompt instead (see
  // composeDelegateSystemPrompt), so it is omitted here to avoid duplication.
  if (kind === "sealed" && input.role && input.role.trim()) {
    lines.push(`# Role\n${input.role.trim()}`);
  }
  lines.push(`# Task\n${input.task.trim()}`);
  if (input.workingDirectory && input.workingDirectory.trim()) {
    lines.push(
      `\n# Working directory\nResolve relative paths and run filesystem work against:\n${input.workingDirectory.trim()}`,
    );
  }
  if (input.context && input.context.trim()) {
    lines.push(`\n# Context\n${input.context.trim()}`);
  }
  if (input.filesOfInterest && input.filesOfInterest.length > 0) {
    lines.push(
      `\n# Files of interest\n${input.filesOfInterest.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  return lines.join("\n");
}
