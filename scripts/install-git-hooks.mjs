// Installs scripts/hooks/* into the repo's shared git hooks directory (the
// COMMON git dir — resolved via `git rev-parse --git-common-dir` — so the
// hook applies to every worktree, not just the one `npm install` runs in).
//
// Run automatically by the root `postinstall` script; safe to re-run, it
// just overwrites the destination with the tracked source. Deliberately
// avoids `git config core.hooksPath`: this only ever writes files, never
// touches git config.

import { readdirSync, copyFileSync, chmodSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/..
const srcDir = resolve(repoRoot, "scripts", "hooks");

let hooksDir;
try {
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  hooksDir = resolve(repoRoot, commonDir, "hooks");
} catch {
  console.warn("[install-git-hooks] not a git checkout — skipping.");
  process.exit(0);
}

if (!existsSync(hooksDir)) {
  console.warn(`[install-git-hooks] ${hooksDir} missing — skipping.`);
  process.exit(0);
}

for (const name of readdirSync(srcDir)) {
  const dest = resolve(hooksDir, name);
  copyFileSync(resolve(srcDir, name), dest);
  chmodSync(dest, 0o755);
  console.log(`[install-git-hooks] installed ${name} -> ${dest}`);
}
