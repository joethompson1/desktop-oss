// Thin TS bridge over the Rust skill commands. Keeps `invoke` calls
// in one place so the loaders read cleanly.

import { invoke, Channel } from "@tauri-apps/api/core";

export type SkillFileKind = "flat" | "nested";

export interface SkillFileEntry {
  path: string;
  kind: SkillFileKind;
  mtime_ms: number;
  size_bytes: number;
}

export interface SkillFsEvent {
  kind: "changed";
  path: string;
}

/** One-shot scan. `roots` is a flat list of absolute paths; loaders
 *  build it from a per-source recipe (e.g. `~/.claude/skills`,
 *  `~/.claude/commands`). Roots that don't exist are silently
 *  skipped. */
export async function listSkillFiles(
  roots: readonly string[],
): Promise<SkillFileEntry[]> {
  if (roots.length === 0) return [];
  return invoke<SkillFileEntry[]>("list_skill_files", { roots });
}

/** Install a recursive watcher per root, debounced 300ms. The returned
 *  Channel re-emits one event per touched path; the caller is expected
 *  to re-run discovery on each event. */
export function watchSkillDirs(
  roots: readonly string[],
  onEvent: (event: SkillFsEvent) => void,
): Promise<void> {
  const channel = new Channel<SkillFsEvent>();
  channel.onmessage = onEvent;
  return invoke("watch_skill_dirs", { roots, channel });
}

let cachedHome: string | null | undefined;

/** Resolve the user's home directory (e.g. `/Users/foo`). Cached for
 *  the app lifetime. Returns null on platforms where the lookup fails. */
export async function homeDir(): Promise<string | null> {
  if (cachedHome !== undefined) return cachedHome;
  try {
    const value = await invoke<string | null>("home_dir");
    cachedHome = value ?? null;
  } catch {
    cachedHome = null;
  }
  return cachedHome;
}

/** Read a file as UTF-8. Bridges over the existing read_text_file
 *  Tauri command — kept here so the loaders import a single facade. */
export async function readSkillFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
}

export type ShellKind = "bash" | "powershell";

/** Run a `!\`cmd\`` block from a skill body. Permission gating
 *  happens BEFORE this — only invoke after the user (or a rule) has
 *  approved the pattern. Output is hard-capped Rust-side. */
export async function runSkillShell(
  cmd: string,
  shell: ShellKind = "bash",
  cwd: string,
  timeoutMs = 30_000,
): Promise<ShellResult> {
  return invoke<ShellResult>("run_skill_shell", {
    cmd,
    shell,
    cwd,
    timeoutMs,
  });
}

/** Join path segments with the platform separator. Tauri runs both
 *  Unix and Windows; we keep it Unix-only for now (macOS-targeted
 *  release) but isolate the choice here. */
export function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}
