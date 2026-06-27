import { getDb } from "./client";
import { homeDir } from "$lib/skills/rust";
import type {
  UIAssistantMessage,
  UIChatTurn,
  UIUserMessage,
} from "$lib/types/chat";

// Legacy singleton id. Predates multi-session support; kept as the
// fallback conversation for `runDelegate` (when a caller doesn't thread a
// conversationId) and for the eval harness. New sessions get random ids.
const ORCHESTRATOR_CONVERSATION_ID = "orchestrator-main";

interface ConversationRow {
  id: string;
  title: string | null;
  working_directory: string | null;
  created_at: number;
  updated_at: number;
  archived: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content_json: string;
  created_at: number;
}

/** A session: one orchestrator conversation rooted in a working directory. */
export interface Conversation {
  id: string;
  title: string | null;
  workingDirectory: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

function rowToConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    title: r.title,
    workingDirectory: r.working_directory,
    archived: r.archived === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createConversation(input: {
  title?: string;
  workingDirectory: string;
}): Promise<string> {
  const db = await getDb();
  const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  await db.execute(
    `INSERT INTO conversations (id, title, working_directory, created_at, updated_at, archived)
     VALUES ($1, $2, $3, $4, $5, 0)`,
    [id, input.title ?? null, input.workingDirectory, now, now],
  );
  return id;
}

export async function listConversations(): Promise<Conversation[]> {
  const db = await getDb();
  const rows = await db.select<ConversationRow[]>(
    `SELECT id, title, working_directory, created_at, updated_at, archived
     FROM conversations
     ORDER BY updated_at DESC`,
  );
  return rows.map(rowToConversation);
}

export async function getConversation(
  id: string,
): Promise<Conversation | null> {
  const db = await getDb();
  const rows = await db.select<ConversationRow[]>(
    `SELECT id, title, working_directory, created_at, updated_at, archived
     FROM conversations WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToConversation(rows[0]) : null;
}

export async function updateConversationTitle(
  id: string,
  title: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3",
    [title, Date.now(), id],
  );
}

export async function updateConversationWorkingDirectory(
  id: string,
  workingDirectory: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE conversations SET working_directory = $1 WHERE id = $2",
    [workingDirectory, id],
  );
}

/** Hard-delete a session and everything under it: its messages, its
 *  delegate runs, and those runs' chunks. Explicit cascade (rather than
 *  relying on the FK PRAGMA being on) so deletion is reliable. */
export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM run_chunks WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = $1)",
    [id],
  );
  await db.execute("DELETE FROM runs WHERE conversation_id = $1", [id]);
  await db.execute("DELETE FROM messages WHERE conversation_id = $1", [id]);
  await db.execute("DELETE FROM conversations WHERE id = $1", [id]);
}

/**
 * Ensure at least one session exists and return the id to open. Backfills
 * any pre-existing row that predates the working_directory column (notably
 * the legacy "orchestrator-main" conversation) to the user's home dir, so
 * old chat history is preserved as a home-rooted session. Returns the
 * most-recently-updated session.
 */
export async function ensureDefaultSession(): Promise<string> {
  const db = await getDb();
  const home = (await homeDir()) ?? "/";
  await db.execute(
    "UPDATE conversations SET working_directory = $1 WHERE working_directory IS NULL OR working_directory = ''",
    [home],
  );
  const rows = await db.select<ConversationRow[]>(
    "SELECT id FROM conversations ORDER BY updated_at DESC LIMIT 1",
  );
  if (rows[0]) return rows[0].id;
  return createConversation({ title: "Chat with Clive", workingDirectory: home });
}

/** Legacy fallback id for delegate runs spawned without an explicit
 *  conversationId, and for the eval harness. */
export function getOrchestratorConversationId(): string {
  return ORCHESTRATOR_CONVERSATION_ID;
}

/** Ensure the legacy singleton conversation row exists. Touches only the
 *  original (0001) columns so it works against the eval harness's
 *  in-memory shim, which applies only the initial migration. The app
 *  proper uses `ensureDefaultSession` instead. */
export async function ensureOrchestratorConversation(): Promise<string> {
  const db = await getDb();
  const existing = await db.select<{ id: string }[]>(
    "SELECT id FROM conversations WHERE id = $1",
    [ORCHESTRATOR_CONVERSATION_ID],
  );
  if (existing.length === 0) {
    const now = Date.now();
    await db.execute(
      "INSERT INTO conversations (id, title, created_at, updated_at, archived) VALUES ($1, $2, $3, $4, 0)",
      [ORCHESTRATOR_CONVERSATION_ID, "Chat with Clive", now, now],
    );
  }
  return ORCHESTRATOR_CONVERSATION_ID;
}

export async function loadMessages(
  conversationId: string,
  limit = 100,
): Promise<UIChatTurn[]> {
  const db = await getDb();
  const rows = await db.select<MessageRow[]>(
    `SELECT * FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC, id ASC
     LIMIT $2`,
    [conversationId, limit],
  );
  return rows.map(rowToTurn);
}

export async function appendMessage(
  conversationId: string,
  turn: UIChatTurn,
): Promise<void> {
  const db = await getDb();
  const createdAt = Date.parse(turn.createdAt) || Date.now();
  await db.execute(
    `INSERT INTO messages (id, conversation_id, role, content_json, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [turn.id, conversationId, turn.role, JSON.stringify(turn), createdAt],
  );
  await db.execute(
    "UPDATE conversations SET updated_at = $1 WHERE id = $2",
    [Date.now(), conversationId],
  );
}

export async function clearMessages(conversationId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM messages WHERE conversation_id = $1",
    [conversationId],
  );
}

function rowToTurn(row: MessageRow): UIChatTurn {
  const parsed = JSON.parse(row.content_json) as UIChatTurn;
  if (parsed.role === "assistant") {
    return parsed satisfies UIAssistantMessage;
  }
  return parsed satisfies UIUserMessage;
}
