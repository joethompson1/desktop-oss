// Reads a captured orchestrator conversation directly from the
// Tauri-managed SQLite file. Works while the app is running — the DB is
// in WAL mode so a read-only connection sees a consistent snapshot
// without blocking app writers.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import type { UIChatTurn } from "$lib/types/chat";
import type { ChunkRow, RunStatus, RunSummary } from "$lib/types/run";
import type { AdapterConfig } from "$lib/types/adapter";

import type {
  CapturedSnapshot,
  CaptureOptions,
  RecordedDelegateResponse,
} from "./types.js";

/** Bundle identifier from `src-tauri/tauri.conf.json`. */
const TAURI_IDENTIFIER = "io.github.desktop-oss";
const DB_FILENAME = "desktop-oss.db";

/** Compute the default DB path for the current OS. */
export function defaultDbPath(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(
        home,
        "Library/Application Support",
        TAURI_IDENTIFIER,
        DB_FILENAME,
      );
    case "linux":
      return join(home, ".local/share", TAURI_IDENTIFIER, DB_FILENAME);
    case "win32":
      return join(
        process.env.APPDATA ?? join(home, "AppData/Roaming"),
        TAURI_IDENTIFIER,
        DB_FILENAME,
      );
    default:
      throw new Error(
        `Unsupported platform for default DB path: ${platform()}. Pass --db <path> explicitly.`,
      );
  }
}

const DEFAULT_CONVERSATION_ID = "orchestrator-main";

interface ConversationRow {
  id: string;
  title: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content_json: string;
  created_at: number;
}

interface RunRow {
  id: string;
  conversation_id: string;
  parent_message_id: string | null;
  tool_call_id: string | null;
  name: string | null;
  title: string;
  status: string;
  delegate_adapter_id: string | null;
  delegate_type: string | null;
  exit_code: number | null;
  summary: string | null;
  context_summary: string | null;
  adapter_session_id: string | null;
  files_changed_json: string | null;
  created_at: number;
  completed_at: number | null;
}

interface ChunkRecord {
  id: number;
  run_id: string;
  seq: number;
  kind: string;
  text: string | null;
  created_at: number;
}

interface SettingsRow {
  key: string;
  value: string;
}

export async function captureSnapshot(
  opts: CaptureOptions = {},
): Promise<CapturedSnapshot> {
  const dbPath = opts.dbPath ?? defaultDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(
      `SQLite file not found at ${dbPath}. Start the app once to create it, or pass --db <path>.`,
    );
  }
  const conversationId = opts.conversationId ?? DEFAULT_CONVERSATION_ID;

  // `readOnly: true` makes the open call non-blocking even while the app
  // is writing — SQLite's WAL mode is designed for this concurrency.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const convoRows = db
      .prepare("SELECT id, title FROM conversations WHERE id = ?")
      .all(conversationId) as unknown as ConversationRow[];
    if (convoRows.length === 0) {
      throw new Error(
        `No conversation with id "${conversationId}". Use --conversation-id to target a different one.`,
      );
    }
    const conversation = convoRows[0];

    const messages = readMessages(db, conversationId, opts);
    const runs = readRuns(db, conversationId, opts);
    const runChunks = readRunChunks(db, runs);
    const settings = readSettings(db);

    return {
      capturedAt: new Date().toISOString(),
      conversationId,
      conversationTitle: conversation.title,
      messages,
      runs,
      runChunks,
      orchestratorPromptOverride: settings["prompts.orchestrator"] ?? null,
      delegatePromptOverride: settings["prompts.delegate"] ?? null,
      adapterConfigs: extractAdapterConfigs(settings),
      recordedDelegateResponses: extractDelegateResponses(runs, runChunks),
    };
  } finally {
    db.close();
  }
}

function readMessages(
  db: DatabaseSync,
  conversationId: string,
  opts: CaptureOptions,
): UIChatTurn[] {
  const where = ["conversation_id = ?"];
  const params: (string | number)[] = [conversationId];
  if (opts.before) {
    const cutoff = Date.parse(opts.before);
    if (Number.isNaN(cutoff)) {
      throw new Error(`--before value is not a valid ISO date: ${opts.before}`);
    }
    where.push("created_at < ?");
    params.push(cutoff);
  }
  const limit = opts.limit ?? 200;
  const rows = db
    .prepare(
      `SELECT id, conversation_id, role, content_json, created_at
         FROM messages
        WHERE ${where.join(" AND ")}
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as MessageRow[];
  return rows.map((row) => JSON.parse(row.content_json) as UIChatTurn);
}

function readRuns(
  db: DatabaseSync,
  conversationId: string,
  opts: CaptureOptions,
): RunSummary[] {
  const where = ["conversation_id = ?"];
  const params: (string | number)[] = [conversationId];
  if (opts.before) {
    const cutoff = Date.parse(opts.before);
    where.push("created_at < ?");
    params.push(cutoff);
  }
  const rows = db
    .prepare(
      `SELECT * FROM runs
        WHERE ${where.join(" AND ")}
        ORDER BY created_at ASC`,
    )
    .all(...params) as unknown as RunRow[];
  return rows.map(rowToRunSummary);
}

function readRunChunks(
  db: DatabaseSync,
  runs: RunSummary[],
): Record<string, ChunkRow[]> {
  const out: Record<string, ChunkRow[]> = {};
  for (const run of runs) {
    const rows = db
      .prepare("SELECT * FROM run_chunks WHERE run_id = ? ORDER BY seq ASC")
      .all(run.id) as unknown as ChunkRecord[];
    if (rows.length === 0) continue;
    out[run.id] = rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      seq: r.seq,
      kind: r.kind as ChunkRow["kind"],
      text: r.text ?? "",
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  return out;
}

function readSettings(db: DatabaseSync): Record<string, string> {
  const rows = db
    .prepare("SELECT key, value FROM settings")
    .all() as unknown as SettingsRow[];
  const out: Record<string, string> = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value) as string;
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}

/**
 * Adapter configs land in the `settings.adapters` blob as an array of
 * `AdapterConfig`. Other apps store them per-key — we accept both shapes
 * so the function survives a future refactor.
 *
 * API keys are NEVER in the settings table (they live in plugin-store's
 * encrypted credentials file), so this is already credential-safe.
 */
function extractAdapterConfigs(
  settings: Record<string, unknown>,
): AdapterConfig[] {
  const blob = settings["adapters"];
  if (Array.isArray(blob)) return blob as AdapterConfig[];
  // Per-key shape: settings.adapter:<id> → AdapterConfig
  const out: AdapterConfig[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith("adapter:") && value && typeof value === "object") {
      out.push(value as AdapterConfig);
    }
  }
  return out;
}

/**
 * Re-derive delegate responses from each run's chunk log. Walks the chunks,
 * coalesces every `assistant_text` chunk into one reply string, and keys
 * the result by a hash of the spawning tool call's input.
 *
 * Replay uses this map to answer the orchestrator's `delegate_task` calls
 * without contacting a real delegate.
 */
function extractDelegateResponses(
  runs: RunSummary[],
  runChunks: Record<string, ChunkRow[]>,
): Record<string, RecordedDelegateResponse> {
  const out: Record<string, RecordedDelegateResponse> = {};
  for (const run of runs) {
    const chunks = runChunks[run.id];
    if (!chunks) continue;
    const replyParts: string[] = [];
    let briefText: string | null = null;
    for (const c of chunks) {
      if (c.kind === "assistant_text") replyParts.push(c.text);
      else if (c.kind === "user_message" && briefText === null) briefText = c.text;
    }
    // The orchestrator's delegate_task input hash is the (sanitised) task
    // brief. We index on the brief text so the replay mock can match
    // whatever delegate_task input the model emits this run.
    const key = briefText ?? run.title;
    out[stableHash(key)] = {
      reply: replyParts.join("").trim() || run.summary || "",
      status: run.status as RunStatus,
      filesChanged: run.filesChanged ?? [],
      durationMs:
        run.completedAt && run.createdAt
          ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.createdAt))
          : 0,
      adapterName: run.delegateAdapterId ?? null,
      adapterType: run.delegateType ?? null,
    };
  }
  return out;
}

function rowToRunSummary(r: RunRow): RunSummary {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    parentMessageId: r.parent_message_id ?? undefined,
    toolCallId: r.tool_call_id ?? undefined,
    name: r.name ?? undefined,
    title: r.title,
    status: r.status as RunStatus,
    delegateAdapterId: r.delegate_adapter_id ?? undefined,
    delegateType: r.delegate_type ?? undefined,
    exitCode: r.exit_code ?? undefined,
    summary: r.summary ?? undefined,
    contextSummary: r.context_summary ?? undefined,
    adapterSessionId: r.adapter_session_id ?? undefined,
    filesChanged: r.files_changed_json
      ? (JSON.parse(r.files_changed_json) as string[])
      : undefined,
    createdAt: new Date(r.created_at).toISOString(),
    completedAt: r.completed_at
      ? new Date(r.completed_at).toISOString()
      : undefined,
  };
}

/**
 * Stable, dependency-free hash. Not cryptographic — just a fingerprint
 * good enough to key a small Map. FNV-1a, 32-bit.
 */
export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) | 0).toString(16).padStart(8, "0");
}
