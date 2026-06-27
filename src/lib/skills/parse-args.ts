// Minimal shell-style argument splitter. Handles single- and double-
// quoted strings with backslash escapes, falls through to whitespace
// split for everything else. Mirrors the practical surface of
// `shell-quote` without the dependency — enough for skill invocations
// like `/commit "fix bug" --signoff` → ["fix bug", "--signoff"].

export function parseArgs(rawArgs: string): string[] {
  const trimmed = rawArgs.trim();
  if (!trimmed) return [];
  const args: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    while (i < trimmed.length && /\s/.test(trimmed[i] ?? "")) i++;
    if (i >= trimmed.length) break;
    const ch = trimmed[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let s = "";
      while (i < trimmed.length && trimmed[i] !== quote) {
        if (trimmed[i] === "\\" && i + 1 < trimmed.length) {
          s += trimmed[i + 1];
          i += 2;
        } else {
          s += trimmed[i];
          i++;
        }
      }
      if (i < trimmed.length) i++; // skip closing quote
      args.push(s);
    } else {
      let s = "";
      while (i < trimmed.length && !/\s/.test(trimmed[i] ?? "")) {
        s += trimmed[i];
        i++;
      }
      args.push(s);
    }
  }
  return args;
}
