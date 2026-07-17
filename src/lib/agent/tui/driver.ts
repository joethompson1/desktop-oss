// Live driver for TUI-mode delegates (Plan 04): spawns the real `claude`
// CLI in a PTY (Rust `pty_*` commands), renders it via xterm.js, and keeps
// the run's persistence flowing while the USER drives the conversation:
//
//   - hook relay tail  → live status (working / idle) + session identity
//   - transcript tail  → mirrors the CLI's own session JSONL into
//                        `run_chunks`, so the orchestrator's monitoring
//                        (get_delegate_history, active-runs table) is
//                        surface-blind
//
// Sessions live in a module-scoped registry keyed by runId and SURVIVE
// route changes — navigating away leaves the PTY running; the page
// re-attaches the same xterm instance on return. This module is imported
// only by UI components (run page / terminal pane), never by the agent
// graph, so the eval harness never loads xterm or the Tauri APIs here.
//
// Single-driver rule: while a TUI session is attached, the GUI driver must
// not run a turn (the page enforces this by surface + status gating).

import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { RunSummary } from "$lib/types/run";
import {
  appendChunk,
  clearTuiInitialPrompt,
  updateHarnessSessionId,
  updateRunStatus,
} from "$lib/db/runs";
import { LineBuffer, parseTranscriptLine } from "./transcript";
import {
  buildHookSettings,
  fallbackTranscriptPath,
  parseRelayLine,
} from "./hooks";

interface PtyEvent {
  event: "spawned" | "data" | "exit";
  pid?: number;
  data?: string;
  code?: number | null;
}

interface TailEvent {
  event: "data";
  data: string;
  offset: number;
}

interface RawRuntime {
  binary: string;
  args_prefix: string[];
  claude_binary_path: string | null;
  mode: "dev" | "prod";
}

export interface TuiSession {
  runId: string;
  term: Terminal;
  fit: FitAddon;
  /** True once the PTY child exited; the page offers a relaunch. */
  exited: boolean;
  /** Exit code of the last PTY child (null = signal / unknown). */
  exitCode: number | null;
  /** Subscribe to session state changes (exit, relaunch). */
  onChange: (cb: () => void) => () => void;
}

interface InternalSession extends TuiSession {
  sessionId: string;
  cwd: string;
  home: string;
  relayPath: string;
  hooksPath: string;
  turnInFlight: boolean;
  transcriptTailStarted: boolean;
  suppressedToolIds: Set<string>;
  chunkQueue: Promise<void>;
  changeListeners: Set<() => void>;
  disposeTermData: { dispose: () => void } | null;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, InternalSession>();

/** Tauri command failures reject with plain STRINGS (the Rust `Err`
 *  value), not Error instances — stringify faithfully so real causes
 *  reach the UI instead of a generic fallback. */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Label each attach step so a failure says WHAT failed ("spawn PTY:
 *  pty_spawn not found" pinpoints a stale Rust build immediately). */
async function step<T>(label: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    throw new Error(`${label}: ${errText(err)}`);
  }
}

export function getTuiSession(runId: string): TuiSession | null {
  return sessions.get(runId) ?? null;
}

/**
 * Attach (or re-attach) the TUI session for a run. Idempotent: an existing
 * live session is returned as-is so route changes don't spawn duplicates.
 * A session that exited stays in the registry (scrollback intact) until
 * `relaunchTui` or `detachTui`.
 */
export async function attachTui(run: RunSummary): Promise<TuiSession> {
  const existing = sessions.get(run.id);
  if (existing) return existing;

  const home = await step(
    "resolve home directory",
    invoke<string | null>("home_dir"),
  );
  if (!home) throw new Error("Could not resolve the home directory.");
  const cwd = run.workdir ?? home;

  // Pin session identity. GUI-first runs already carry the SDK's session
  // id; TUI-first runs mint one here so the transcript location is known
  // before the CLI even starts.
  let sessionId = run.harnessSessionId;
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    await updateHarnessSessionId(run.id, sessionId);
  }

  const dir = `${home}/.desktop-oss/tui/${run.id}`;
  const relayPath = `${dir}/relay.jsonl`;
  const hooksPath = `${dir}/hooks.json`;
  // Truncate the relay per attach — its events are only meaningful for
  // the live session; history already landed in run_chunks.
  await step(
    "write hook relay files",
    invoke("write_text_file", { path: relayPath, contents: "" }),
  );
  await step(
    "write hook settings",
    invoke("write_text_file", {
      path: hooksPath,
      contents: buildHookSettings(relayPath),
    }),
  );

  const term = new Terminal({
    // Concrete font stack — xterm measures glyphs via canvas, which can't
    // resolve CSS custom properties.
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const session: InternalSession = {
    runId: run.id,
    term,
    fit,
    exited: false,
    exitCode: null,
    sessionId,
    cwd,
    home,
    relayPath,
    hooksPath,
    turnInFlight: false,
    transcriptTailStarted: false,
    suppressedToolIds: new Set(),
    chunkQueue: Promise.resolve(),
    changeListeners: new Set(),
    disposeTermData: null,
    fallbackTimer: null,
    onChange(cb) {
      session.changeListeners.add(cb);
      return () => session.changeListeners.delete(cb);
    },
  };
  sessions.set(run.id, session);

  try {
    await startRelayTail(session);
    await spawnPty(session, run);
  } catch (err) {
    sessions.delete(run.id);
    term.dispose();
    void invoke("tail_stop", { watchId: relayWatchId(run.id) }).catch(() => {});
    throw err;
  }
  return session;
}

/** Relaunch the CLI after the PTY child exited — same xterm, same session
 *  id (`--resume`), fresh child. */
export async function relaunchTui(runId: string): Promise<void> {
  const session = sessions.get(runId);
  if (!session || !session.exited) return;
  session.exited = false;
  session.exitCode = null;
  session.term.writeln("\r\n\x1b[2m— relaunching —\x1b[0m\r\n");
  await startRelayTail(session);
  await spawnPty(session, null);
  notifyChange(session);
}

/**
 * Tear the session down: kill the child, stop the tails, drop the xterm.
 * Used when switching back to the GUI surface (single-driver rule) and
 * when abandoning a dead terminal.
 */
export async function detachTui(runId: string): Promise<void> {
  const session = sessions.get(runId);
  if (!session) return;
  sessions.delete(runId);
  if (session.fallbackTimer) clearTimeout(session.fallbackTimer);
  session.disposeTermData?.dispose();
  await invoke("pty_kill", { sessionId: ptyId(runId) }).catch(() => {});
  await invoke("tail_stop", { watchId: relayWatchId(runId) }).catch(() => {});
  await invoke("tail_stop", { watchId: transcriptWatchId(runId) }).catch(
    () => {},
  );
  // If the CLI died mid-turn the RUNNING badge would otherwise stick.
  if (session.turnInFlight) {
    await updateRunStatus(runId, "CANCELLED", {
      summary: "Terminal session ended mid-turn.",
    }).catch(() => {});
  }
  session.term.dispose();
}

/** Fit the terminal to its container and propagate the size to the PTY. */
export function resizeTui(runId: string): void {
  const session = sessions.get(runId);
  if (!session) return;
  try {
    session.fit.fit();
  } catch {
    return; // container not laid out yet
  }
  void invoke("pty_resize", {
    sessionId: ptyId(runId),
    cols: session.term.cols,
    rows: session.term.rows,
  }).catch(() => {});
}

// ─── internals ─────────────────────────────────────────────────────────

function ptyId(runId: string): string {
  return `tui-${runId}`;
}
function relayWatchId(runId: string): string {
  return `tui-relay-${runId}`;
}
function transcriptWatchId(runId: string): string {
  return `tui-transcript-${runId}`;
}

function notifyChange(session: InternalSession): void {
  for (const cb of session.changeListeners) cb();
}

async function resolveClaudeBinary(): Promise<string> {
  // Prod bundles ship the native `claude` binary as a resource; dev
  // resolves it from the (login-augmented) PATH inside pty_spawn.
  try {
    const raw = await invoke<RawRuntime>("resolve_claude_agent_runtime");
    if (raw.claude_binary_path) return raw.claude_binary_path;
  } catch {
    // dev without sidecar staging — PATH lookup below still works
  }
  return "claude";
}

async function spawnPty(
  session: InternalSession,
  run: RunSummary | null,
): Promise<void> {
  const binary = await resolveClaudeBinary();

  // First-ever launch of a TUI-spawned run hands the CLI the task brief
  // as its opening prompt; every other path resumes the shared session.
  // (`--resume` forks a new session id — the SessionStart hook follows
  // the fork and re-points the transcript mirror.)
  const initialPrompt = run?.tuiInitialPrompt;
  const hasHistory = !initialPrompt && run?.harnessSessionId;
  const args = initialPrompt
    ? [
        "--session-id",
        session.sessionId,
        "--settings",
        session.hooksPath,
        initialPrompt,
      ]
    : hasHistory || !run
      ? ["--resume", session.sessionId, "--settings", session.hooksPath]
      : ["--session-id", session.sessionId, "--settings", session.hooksPath];

  const channel = new Channel<PtyEvent>();
  channel.onmessage = (evt) => {
    if (evt.event === "data" && typeof evt.data === "string") {
      session.term.write(b64ToBytes(evt.data));
    } else if (evt.event === "exit") {
      session.exited = true;
      session.exitCode = typeof evt.code === "number" ? evt.code : null;
      if (session.turnInFlight) {
        session.turnInFlight = false;
        void updateRunStatus(session.runId, "CANCELLED", {
          summary: "Terminal session ended mid-turn.",
        }).catch(() => {});
      }
      session.term.writeln(
        `\r\n\x1b[2m— session ended (${session.exitCode ?? "signal"}) —\x1b[0m`,
      );
      notifyChange(session);
    }
  };

  await step(
    `spawn PTY (${binary})`,
    invoke("pty_spawn", {
      sessionId: ptyId(session.runId),
      command: binary,
      args,
      cwd: session.cwd,
      env: null,
      cols: session.term.cols,
      rows: session.term.rows,
      onEvent: channel,
    }),
  );

  session.disposeTermData?.dispose();
  session.disposeTermData = session.term.onData((data) => {
    void invoke("pty_write", {
      sessionId: ptyId(session.runId),
      dataB64: bytesToB64(new TextEncoder().encode(data)),
    }).catch(() => {});
  });

  if (initialPrompt) {
    await clearTuiInitialPrompt(session.runId).catch(() => {});
  }

  // Belt-and-braces: if no SessionStart hook lands (user's own settings
  // interfering, hook exec failure), fall back to the computed transcript
  // location so mirroring still works.
  session.fallbackTimer = setTimeout(() => {
    if (!session.transcriptTailStarted && sessions.has(session.runId)) {
      void startTranscriptTail(
        session,
        fallbackTranscriptPath(session.home, session.cwd, session.sessionId),
      );
    }
  }, 8000);
}

async function startRelayTail(session: InternalSession): Promise<void> {
  const lines = new LineBuffer();
  const decoder = new TextDecoder();
  const channel = new Channel<TailEvent>();
  channel.onmessage = (evt) => {
    if (evt.event !== "data") return;
    const text = decoder.decode(b64ToBytes(evt.data), { stream: true });
    for (const line of lines.push(text)) {
      const relay = parseRelayLine(line);
      if (!relay) continue;
      handleRelayEvent(session, relay);
    }
  };
  await step(
    "start hook relay tail",
    invoke("tail_file", {
      watchId: relayWatchId(session.runId),
      path: session.relayPath,
      fromOffset: 0,
      onEvent: channel,
    }),
  );
}

function handleRelayEvent(
  session: InternalSession,
  relay: { hookEventName: string; sessionId?: string; transcriptPath?: string },
): void {
  if (relay.hookEventName === "SessionStart") {
    // Authoritative identity for THIS live session — resumes fork a new
    // session id + transcript file; follow both.
    if (relay.sessionId && relay.sessionId !== session.sessionId) {
      session.sessionId = relay.sessionId;
      void updateHarnessSessionId(session.runId, relay.sessionId).catch(
        () => {},
      );
    }
    if (relay.transcriptPath) {
      void startTranscriptTail(session, relay.transcriptPath);
    }
  } else if (relay.hookEventName === "UserPromptSubmit") {
    session.turnInFlight = true;
    void updateRunStatus(session.runId, "RUNNING").catch(() => {});
  } else if (relay.hookEventName === "Stop") {
    session.turnInFlight = false;
    void updateRunStatus(session.runId, "SUCCEEDED").catch(() => {});
  }
}

async function startTranscriptTail(
  session: InternalSession,
  path: string,
): Promise<void> {
  session.transcriptTailStarted = true;
  if (session.fallbackTimer) {
    clearTimeout(session.fallbackTimer);
    session.fallbackTimer = null;
  }
  const lines = new LineBuffer();
  const decoder = new TextDecoder();
  const channel = new Channel<TailEvent>();
  channel.onmessage = (evt) => {
    if (evt.event !== "data") return;
    const text = decoder.decode(b64ToBytes(evt.data), { stream: true });
    for (const line of lines.push(text)) {
      const { chunks, suppressToolIds } = parseTranscriptLine(
        line,
        session.suppressedToolIds,
      );
      for (const id of suppressToolIds) session.suppressedToolIds.add(id);
      for (const chunk of chunks) {
        // Serialize writes so chunk seq ordering matches transcript order.
        session.chunkQueue = session.chunkQueue
          .then(() =>
            appendChunk({ runId: session.runId, kind: chunk.kind, text: chunk.text }),
          )
          .catch(() => {});
      }
    }
  };
  // From EOF: everything already in the file was either persisted by the
  // GUI driver (this run's prior turns) or is fork-seeded history — only
  // NEW entries belong to this live TUI session. Re-starting with the
  // same watchId atomically replaces a previous transcript tail (fork
  // follow-up), per the Rust side's insert-replaces semantics.
  await invoke("tail_file", {
    watchId: transcriptWatchId(session.runId),
    path,
    fromOffset: -1,
    onEvent: channel,
  });
}

function b64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
