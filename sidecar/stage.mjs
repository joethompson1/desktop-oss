// Stages the host-arch sidecar binaries + their SDK native binaries into
// `src-tauri/sidecar-dist/` so Tauri's `bundle.resources` can ship them.
// Run by `beforeBundleCommand` in tauri.conf.json.
//
// Why this exists: the bundle must carry binaries matching the machine
// it's built on (Intel vs Apple Silicon vs Linux). Keeping the arch
// choice HERE — and the matching lookup in `src-tauri/src/lib.rs`
// (`cursor_sdk_platform_tag`) — means tauri.conf.json holds no arch
// literal. Both sides derive the same tag from the build host, so a
// bundle built on any machine is internally consistent.
//
// The npm platform tag (`${process.platform}-${process.arch}`, e.g.
// `darwin-x64`) is exactly how `@cursor/sdk` names the optional-dependency
// package it `require.resolve`s at runtime, and how `@anthropic-ai/
// claude-agent-sdk` names its native-binary package. So the same tag
// selects the right source package for both.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sidecarRoot = dirname(fileURLToPath(import.meta.url)); // .../sidecar
const repoRoot = dirname(sidecarRoot);
const distRoot = join(repoRoot, "src-tauri", "sidecar-dist");

const tag = `${process.platform}-${process.arch}`; // e.g. darwin-x64

// Each entry stages into `sidecar-dist/<resourceDir>/`, which tauri.conf.json
// maps 1:1 onto the app's resource directory (and lib.rs resolves from).
const sidecars = [
  {
    name: "claude-agent",
    resourceDir: "claude-agent-bin",
    binary: "claude-agent-sidecar",
    // The Claude SDK is told the native binary path explicitly via the
    // CLAUDE_AGENT_SDK_EXECUTABLE_PATH env (see lib.rs / index.mjs), so we
    // can flatten it to an arch-neutral name in the bundle.
    natives: [
      {
        from: ["node_modules", "@anthropic-ai", `claude-agent-sdk-${tag}`, "claude"],
        to: ["claude"],
      },
    ],
  },
  {
    name: "cursor-agent",
    resourceDir: "cursor-agent-bin",
    binary: "cursor-agent-sidecar",
    // The Cursor SDK does `require.resolve("@cursor/sdk-<tag>")` at runtime,
    // so the platform package must ship UNDER ITS REAL NAME next to the
    // sidecar binary. Copy the whole package dir (package.json + bin/).
    natives: [
      {
        from: ["node_modules", "@cursor", `sdk-${tag}`],
        to: ["node_modules", "@cursor", `sdk-${tag}`],
      },
    ],
  },
];

console.log(`[stage] target platform tag: ${tag}`);
rmSync(distRoot, { recursive: true, force: true });

for (const sc of sidecars) {
  const scDir = join(sidecarRoot, sc.name);
  const nodeModules = join(scDir, "node_modules");
  if (!existsSync(nodeModules)) {
    throw new Error(
      `[stage] ${sc.name}: node_modules missing — run \`npm run sidecar:install\` first.`,
    );
  }

  // 1. Compile the sidecar for the host arch. The sidecar's `build` script
  //    no longer pins --target, so bun targets the current platform.
  console.log(`[stage] building ${sc.name} sidecar for host…`);
  execFileSync("npm", ["run", "build"], { cwd: scDir, stdio: "inherit" });

  const outDir = join(distRoot, sc.resourceDir);
  mkdirSync(outDir, { recursive: true });

  // 2. Stage the compiled sidecar binary.
  const compiled = join(scDir, "dist", sc.binary);
  if (!existsSync(compiled)) {
    throw new Error(`[stage] ${sc.name}: expected compiled binary at ${compiled}`);
  }
  const stagedBinary = join(outDir, sc.binary);
  cpSync(compiled, stagedBinary);
  chmodSync(stagedBinary, 0o755);

  // 3. Stage the SDK native binaries for this arch.
  for (const n of sc.natives) {
    const src = join(scDir, ...n.from);
    if (!existsSync(src)) {
      throw new Error(
        `[stage] ${sc.name}: missing native source for ${tag} at ${src}. ` +
          `Did \`npm install\` run on this machine?`,
      );
    }
    const dest = join(outDir, ...n.to);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    // cpSync preserves mode, but be explicit for single-file native binaries.
    if (n.to.length === 1) chmodSync(dest, 0o755);
  }

  console.log(`[stage] ${sc.name} → ${outDir}`);
}

console.log(`[stage] done → ${distRoot}`);
