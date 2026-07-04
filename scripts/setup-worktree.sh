#!/usr/bin/env bash
# Makes a freshly created worktree (or a fresh clone) ready for
# `npm run tauri:dev`: installs JS deps (root + sidecars, via the root
# `postinstall` script) and stages the sidecar binaries that
# tauri.conf.json's `bundle.resources` expects at src-tauri/sidecar-dist/
# (see sidecar/stage.mjs) — without it, even `cargo check` fails with
# "resource path sidecar-dist/... doesn't exist". Safe to re-run.
#
# Run automatically for new worktrees by scripts/hooks/post-checkout (see
# scripts/install-git-hooks.mjs). Run it by hand after `git worktree add` if
# you skipped hook installation, or via `npm run setup:worktree`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "[setup-worktree] npm install…"
npm install

echo "[setup-worktree] staging sidecar binaries…"
node sidecar/stage.mjs

echo "[setup-worktree] done — npm run tauri:dev is ready."
