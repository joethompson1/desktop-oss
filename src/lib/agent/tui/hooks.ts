// Pure helpers for the TUI hook relay (Plan 04). Free of Tauri / I/O
// imports so they're unit-testable under `node:test`; the live driver owns
// the file writes and tailing.
//
// Mechanism: the embedded `claude` CLI is launched with an extra
// `--settings <file>` layer whose hooks append each event's JSON payload
// to a per-run relay file. The app tails that file and gets live status
// (working / idle) plus the authoritative session identity — Claude Code
// forks a NEW session id (and transcript file) on every resume, and the
// SessionStart payload is how we follow the fork. Hook stdin IS the
// payload, so the command is just `cat >> relay` plus a newline guard.

/** Hook events the relay records. SessionStart carries identity;
 *  UserPromptSubmit / Stop drive the run's working/idle status. */
export const RELAY_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
] as const;

/**
 * Build the JSON for the `--settings` layer that wires every relay hook.
 * `relayPath` is embedded in a shell command — quote-guarded, but paths
 * containing double quotes are rejected rather than escaped (they never
 * occur under our app-data root and the quoting rules differ per shell).
 */
export function buildHookSettings(relayPath: string): string {
  if (relayPath.includes('"')) {
    throw new Error(`relay path must not contain double quotes: ${relayPath}`);
  }
  const command = `sh -c 'cat >> "${relayPath}"; printf "\\n" >> "${relayPath}"'`;
  const hookEntry = [{ hooks: [{ type: "command", command }] }];
  const hooks: Record<string, typeof hookEntry> = {};
  for (const event of RELAY_HOOK_EVENTS) hooks[event] = hookEntry;
  return JSON.stringify({ hooks }, null, 2);
}

/** The relay-payload fields we consume (subset of Claude Code's hook
 *  input; every event carries the identity trio). */
export interface RelayEvent {
  hookEventName: string;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
}

/** Parse one relay line (a hook's stdin JSON). Null for blank/garbage. */
export function parseRelayLine(line: string): RelayEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = payload.hook_event_name;
  if (typeof name !== "string" || !name) return null;
  return {
    hookEventName: name,
    sessionId:
      typeof payload.session_id === "string" ? payload.session_id : undefined,
    transcriptPath:
      typeof payload.transcript_path === "string"
        ? payload.transcript_path
        : undefined,
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
  };
}

/**
 * Claude Code's project-directory munge: the session store lives at
 * `~/.claude/projects/<munged-cwd>/<session-id>.jsonl` where the munge
 * replaces every non-alphanumeric character with `-`. Used only as the
 * FALLBACK transcript location when no SessionStart hook payload has
 * arrived (the payload's `transcript_path` is authoritative).
 */
export function mungeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function fallbackTranscriptPath(
  home: string,
  cwd: string,
  sessionId: string,
): string {
  return `${home}/.claude/projects/${mungeProjectPath(cwd)}/${sessionId}.jsonl`;
}
