export interface SlashTrigger {
  /** Index of the `/` character in `input`. */
  start: number;
  /** Exclusive end of the trigger range — for menu-open state this is
   *  always `input.length` (cursor sits at end of the typed command
   *  name). */
  end: number;
  /** Text after the `/`, up to `end` — i.e. what the user has typed
   *  of the command name so far. */
  commandName: string;
}

/** Find the active slash-command trigger in `input`. Walks backwards
 *  from the end; the trigger is the most recent `/` that is:
 *
 *    1. preceded by start-of-string, a space, or a newline, AND
 *    2. NOT followed by any whitespace before the end of input.
 *
 *  Returns `null` when neither holds — the user is either not in a
 *  slash command, has typed past the command name (space committed
 *  them to args), or the `/` is mid-word (e.g. `1/2`, `path/foo`).
 *
 *  Examples (cursor at `|`, always end of input):
 *    "/|"               → start 0, name ""
 *    "/he|"             → start 0, name "he"
 *    "hey /|"           → start 4, name ""
 *    "hey /he|"         → start 4, name "he"
 *    "line1\n/he|"      → start 6, name "he"
 *    "hey /he bar|"     → null  (space after the command)
 *    "1/2|"             → null  (slash not preceded by whitespace)
 */
export function findSlashTrigger(input: string): SlashTrigger | null {
  for (let i = input.length - 1; i >= 0; i--) {
    const ch = input[i];
    if (ch === " " || ch === "\n" || ch === "\t") return null;
    if (ch === "/") {
      if (i === 0) {
        return { start: 0, end: input.length, commandName: input.slice(1) };
      }
      const prev = input[i - 1] ?? "";
      if (prev === " " || prev === "\n" || prev === "\t") {
        return {
          start: i,
          end: input.length,
          commandName: input.slice(i + 1),
        };
      }
      // `/` is preceded by a non-whitespace character (e.g. `1/2`,
      // `https://`, `path/foo`) — not a slash-command trigger.
      return null;
    }
  }
  return null;
}

/** Convenience wrapper retained for the filter — returns just the
 *  command-name portion if a trigger exists. */
export interface ParsedSlash {
  commandName: string;
  rawArgs: string;
}

export function parseSlashCommand(input: string): ParsedSlash | null {
  const trigger = findSlashTrigger(input);
  if (trigger === null) return null;
  return { commandName: trigger.commandName, rawArgs: "" };
}

/** True when the menu should be open for the current textarea
 *  content. Pure function of `input` — no other state involved. */
export function shouldShowMenu(input: string): boolean {
  return findSlashTrigger(input) !== null;
}
