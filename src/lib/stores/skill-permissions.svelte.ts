// Permission flow for skill shell-expansion. Three layers in resolve
// order:
//
//   1. Skill frontmatter `allowed-tools` — auto-allow for the duration
//      of that one skill's expansion. Caller passes them in via the
//      `skillAllowedTools` arg to `request()`.
//   2. Session grants — patterns the user approved "this session"
//      this run; cleared on reload.
//   3. Persistent rules — patterns the user approved "always"; live
//      in the settings store across reloads.
//
// When none of the above match, we queue a request and the modal
// (mounted at +layout) renders the head of the queue. The user's
// decision resolves the awaiting promise from inside the materialise
// pipeline.

import { getSetting, setSetting } from "$lib/db/settings";
import { matchBashCommand, suggestPattern } from "$lib/skills/permission-matcher";

const SETTING_KEY = "skillPermissionRules";

export type Decision = "allow-once" | "allow-always" | "deny";

export interface PermissionRequest {
  /** Internal id — used to resolve the right promise when the modal
   *  fires. */
  id: string;
  /** Display name of the skill making the request. */
  skillName: string;
  /** Display name for the skill's source (e.g. "Anthropic"). */
  skillSourceLabel: string;
  /** Concrete bash command that wants to run. */
  command: string;
  /** Pre-filled "always allow" pattern, editable in the modal. */
  suggestedPattern: string;
}

export interface PersistentRule {
  pattern: string;
  createdAt: number;
}

interface PermissionState {
  pending: PermissionRequest[];
  rules: PersistentRule[];
  /** Patterns the user approved "this session" via Allow-once. */
  sessionGrants: string[];
  hydrated: boolean;
}

export const permissions = $state<PermissionState>({
  pending: [],
  rules: [],
  sessionGrants: [],
  hydrated: false,
});

const resolvers = new Map<string, (d: Decision) => void>();

/** Load persistent rules from settings. Safe to call repeatedly. */
export async function hydratePermissions(): Promise<void> {
  if (permissions.hydrated) return;
  permissions.hydrated = true;
  try {
    const stored = await getSetting<PersistentRule[]>(SETTING_KEY);
    if (stored) permissions.rules = stored;
  } catch {
    // best-effort; rules just stay empty
  }
}

/** Request permission to run `command`. Resolves immediately if any
 *  layer pre-allows; otherwise pushes onto the modal queue and
 *  waits for the user. */
export async function requestPermission(args: {
  command: string;
  skillName: string;
  skillSourceLabel: string;
  /** Pre-grants from the skill's frontmatter `allowed-tools`. */
  skillAllowedTools: readonly string[];
}): Promise<Decision> {
  await hydratePermissions();
  const { command, skillAllowedTools } = args;

  // 1. Skill's own allowed-tools pre-grants.
  if (matchBashCommand(command, skillAllowedTools).matched) {
    return "allow-once";
  }
  // 2. Session grants.
  if (matchBashCommand(command, permissions.sessionGrants).matched) {
    return "allow-once";
  }
  // 3. Persistent rules.
  const rulePatterns = permissions.rules.map((r) => r.pattern);
  if (matchBashCommand(command, rulePatterns).matched) {
    return "allow-once";
  }

  // 4. Prompt.
  const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const suggested = suggestPattern(command);
  permissions.pending = [
    ...permissions.pending,
    {
      id,
      skillName: args.skillName,
      skillSourceLabel: args.skillSourceLabel,
      command,
      suggestedPattern: suggested,
    },
  ];
  return new Promise<Decision>((resolve) => {
    resolvers.set(id, resolve);
  });
}

/** Resolve the request with the given id. Called from the modal. The
 *  optional `pattern` only applies when `decision === 'allow-always'`
 *  — at that point we persist the rule. */
export function resolvePermission(
  id: string,
  decision: Decision,
  pattern?: string,
): void {
  const resolver = resolvers.get(id);
  if (!resolver) return;
  resolvers.delete(id);
  permissions.pending = permissions.pending.filter((p) => p.id !== id);

  if (decision === "allow-always" && pattern) {
    void addPersistentRule(pattern);
  }
  // "Allow once" is a literal one-time approval — we deliberately do
  // NOT push the pattern to session grants here. The next matching
  // command should prompt again. Session grants stay as a separate
  // mechanism that nothing currently mutates (Phase 8 polish could
  // add a third button if we want a "for this session" middle
  // ground).
  resolver(decision);
}

async function addPersistentRule(pattern: string): Promise<void> {
  const trimmed = pattern.trim();
  if (!trimmed) return;
  if (permissions.rules.some((r) => r.pattern === trimmed)) return;
  permissions.rules = [
    ...permissions.rules,
    { pattern: trimmed, createdAt: Date.now() },
  ];
  await setSetting(SETTING_KEY, permissions.rules);
}

/** Remove a persistent rule. Used by the Settings → Skills →
 *  Permissions list. */
export async function revokeRule(pattern: string): Promise<void> {
  permissions.rules = permissions.rules.filter((r) => r.pattern !== pattern);
  await setSetting(SETTING_KEY, permissions.rules);
}
