import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { resolve } from "node:path";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — process is provided by Node at config-load time
const proc = (globalThis as { process?: { env: Record<string, string | undefined>; cwd(): string } }).process;
const host = proc?.env.TAURI_DEV_HOST;
const cwd = proc?.cwd() ?? ".";

// When this checkout is a git worktree (laid out as
// `<parent-repo>/.claude/worktrees/<name>/`), npm deps live in the
// parent repo's `node_modules`, not the worktree's own. Vite's FS
// allow-list defaults to the worktree only, so module imports resolved
// from the parent get blocked and the dev server serves a blank page.
// Detect the layout and explicitly allow the parent project root so
// imports up the tree pass the allow-list check.
const extraFsAllow = cwd.includes("/.claude/worktrees/")
  ? [resolve(cwd, "..", "..", "..")]
  : [];

export default defineConfig({
  plugins: [sveltekit()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      allow: [cwd, ...extraFsAllow],
    },
  },
});
