import { getDb } from "./client";
import {
  clearLiveText,
  emitChunkAppended,
  emitRunStatusChanged,
} from "./run-events";
import type { ChunkRow, RunStatus, RunSummary } from "$lib/types/run";

interface RunRecord {
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

export async function createRun(input: {
  id: string;
  conversationId: string;
  parentMessageId?: string;
  toolCallId?: string;
  /** Optional label for this run. Set via delegate_task's `name` field so
   *  the orchestrator can reference the delegate later by name rather than
   *  the generated run ID. */
  name?: string;
  title: string;
  delegateAdapterId?: string;
  delegateType?: string;
}): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.execute(
    `INSERT INTO runs (
       id, conversation_id, parent_message_id, tool_call_id, name, title,
       status, delegate_adapter_id, delegate_type, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9)`,
    [
      input.id,
      input.conversationId,
      input.parentMessageId ?? null,
      input.toolCallId ?? null,
      input.name ?? null,
      input.title,
      input.delegateAdapterId ?? null,
      input.delegateType ?? null,
      now,
    ],
  );
}

export async function updateRunStatus(
  runId: string,
  status: RunStatus,
  patch: {
    exitCode?: number;
    summary?: string;
    filesChanged?: string[];
  } = {},
): Promise<void> {
  const db = await getDb();
  const completed = status !== "PENDING" && status !== "RUNNING";
  await db.execute(
    `UPDATE runs SET
       status = $1,
       exit_code = COALESCE($2, exit_code),
       summary = COALESCE($3, summary),
       files_changed_json = COALESCE($4, files_changed_json),
       completed_at = CASE WHEN $5 = 1 THEN $6 ELSE completed_at END
     WHERE id = $7`,
    [
      status,
      patch.exitCode ?? null,
      patch.summary ?? null,
      patch.filesChanged ? JSON.stringify(patch.filesChanged) : null,
      completed ? 1 : 0,
      Date.now(),
      runId,
    ],
  );
  emitRunStatusChanged(runId, status);
}

export async function appendChunk(input: {
  runId: string;
  kind: ChunkRow["kind"];
  text: string;
}): Promise<void> {
  const db = await getDb();
  const seqRows = await db.select<{ next_seq: number }[]>(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM run_chunks WHERE run_id = $1`,
    [input.runId],
  );
  const seq = seqRows[0]?.next_seq ?? 0;
  await db.execute(
    `INSERT INTO run_chunks (run_id, seq, kind, text, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.runId, seq, input.kind, input.text, Date.now()],
  );
  // When an assistant_text segment lands, the canonical version is now
  // in the DB — drop the in-flight live-text buffer for this run so
  // passive viewers re-mounting after this point seed from the chunk
  // (via hydrate), not from the now-stale buffer. Cleared BEFORE
  // emitting so any subscriber whose onChunk triggers a `refresh()`
  // sees an empty live buffer in the next mount cycle. No-op for
  // other chunk kinds (tool_call, tool_result, user_message, stderr).
  if (input.kind === "assistant_text") {
    clearLiveText(input.runId);
  }
  emitChunkAppended(input.runId);
}

export async function listRuns(
  conversationId: string,
  opts: { limit?: number; statuses?: RunStatus[] } = {},
): Promise<RunSummary[]> {
  const db = await getDb();
  const limit = opts.limit ?? 50;
  let rows: RunRecord[];
  if (opts.statuses && opts.statuses.length > 0) {
    const placeholders = opts.statuses
      .map((_, i) => `$${i + 2}`)
      .join(",");
    rows = await db.select<RunRecord[]>(
      `SELECT * FROM runs
       WHERE conversation_id = $1 AND status IN (${placeholders})
       ORDER BY created_at DESC
       LIMIT ${limit}`,
      [conversationId, ...opts.statuses],
    );
  } else {
    rows = await db.select<RunRecord[]>(
      `SELECT * FROM runs
       WHERE conversation_id = $1
       ORDER BY created_at DESC
       LIMIT ${limit}`,
      [conversationId],
    );
  }
  return rows.map(recordToSummary);
}

/**
 * Fetch every run belonging to any of the given conversations, newest
 * first. Used by the sidebar to attach each session's delegate runs as
 * nested rows in one query rather than N. Group by `conversationId` in JS.
 */
export async function listRunsForConversations(
  conversationIds: string[],
): Promise<RunSummary[]> {
  if (conversationIds.length === 0) return [];
  const db = await getDb();
  const placeholders = conversationIds.map((_, i) => `$${i + 1}`).join(",");
  const rows = await db.select<RunRecord[]>(
    `SELECT * FROM runs
     WHERE conversation_id IN (${placeholders})
     ORDER BY created_at DESC`,
    conversationIds,
  );
  return rows.map(recordToSummary);
}

export async function getRun(runId: string): Promise<RunSummary | null> {
  const db = await getDb();
  const rows = await db.select<RunRecord[]>(
    "SELECT * FROM runs WHERE id = $1",
    [runId],
  );
  return rows[0] ? recordToSummary(rows[0]) : null;
}

export async function getRunChunks(runId: string): Promise<ChunkRow[]> {
  const db = await getDb();
  const rows = await db.select<ChunkRecord[]>(
    "SELECT * FROM run_chunks WHERE run_id = $1 ORDER BY seq ASC",
    [runId],
  );
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    seq: r.seq,
    kind: r.kind as ChunkRow["kind"],
    text: r.text ?? "",
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

function recordToSummary(r: RunRecord): RunSummary {
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
 * Persist an adapter-provided session token for this run. Used by the
 * claude-code adapter (SDK's `session_id`) and the codex adapter
 * (`threadId` from the MCP `codex` tool) — captured on the first turn
 * so subsequent turns can pass it back as the `resume` / `threadId`
 * option and continue the same provider-side session (preserving tool
 * state, scratchpad, file checkpointing). Idempotent: writing the same
 * ID again is a no-op.
 */
export async function updateAdapterSessionId(
  runId: string,
  adapterSessionId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE runs SET adapter_session_id = $1 WHERE id = $2",
    [adapterSessionId, runId],
  );
}

/**
 * Persist a freshly generated rolling context summary for a run.
 * Called by maybeUpdateContextSummary in delegate.ts after each turn
 * once the run exceeds SUMMARY_THRESHOLD messages.
 */
export async function updateContextSummary(
  runId: string,
  contextSummary: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE runs SET context_summary = $1 WHERE id = $2",
    [contextSummary, runId],
  );
}

/**
 * Look up a run by its orchestrator-assigned name within a conversation.
 * Used by message_delegate and get_delegate_history to resolve a
 * human-readable name to a concrete run ID.
 */
export async function getRunByName(
  conversationId: string,
  name: string,
): Promise<RunSummary | null> {
  const db = await getDb();
  const rows = await db.select<RunRecord[]>(
    "SELECT * FROM runs WHERE conversation_id = $1 AND name = $2 ORDER BY created_at DESC LIMIT 1",
    [conversationId, name],
  );
  return rows[0] ? recordToSummary(rows[0]) : null;
}

/**
 * Hard-delete a run and all its chunks. Used by the sidebar's per-row
 * × button so the user can clean up stuck / abandoned runs.
 */
export async function deleteRun(runId: string): Promise<void> {
  const db = await getDb();
  // run_chunks has ON DELETE CASCADE on the foreign key, so this single
  // statement removes both the run row and every chunk row tied to it.
  await db.execute("DELETE FROM runs WHERE id = $1", [runId]);
}

/**
 * Hard-delete every run belonging to a conversation. Used by the
 * Settings → About "Clear chat history" action so the sidebar's
 * Running / Recent groups are wiped alongside the orchestrator's
 * messages. run_chunks rows cascade away via the FK.
 */
export async function deleteRunsForConversation(
  conversationId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM runs WHERE conversation_id = $1", [
    conversationId,
  ]);
}

/**
 * Mark any run still in PENDING/RUNNING state as CANCELLED with an
 * "abandoned by app restart" summary. Called once on app hydrate — a
 * previous Tauri dev session's child processes were killed when the app
 * closed, but their DB rows still claim they're running. This stops the
 * sidebar from showing zombies.
 */
export async function markStaleRunsAbandoned(): Promise<number> {
  const db = await getDb();
  const now = Date.now();
  const result = await db.execute(
    `UPDATE runs
       SET status = 'CANCELLED',
           summary = COALESCE(summary, 'Abandoned — app restarted before this run finished.'),
           completed_at = $1
     WHERE status IN ('PENDING', 'RUNNING')`,
    [now],
  );
  return result.rowsAffected ?? 0;
}
