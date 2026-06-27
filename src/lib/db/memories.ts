import { getDb } from "./client";

export interface MemoryRow {
  id: string;
  scope: string;
  content: string;
  createdAt: string;
}

interface MemoryRecord {
  id: string;
  scope: string;
  content: string;
  created_at: number;
}

export async function saveMemory(input: {
  content: string;
  scope?: string;
}): Promise<MemoryRow> {
  const db = await getDb();
  const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  await db.execute(
    `INSERT INTO memories (id, scope, content, created_at)
     VALUES ($1, $2, $3, $4)`,
    [id, input.scope ?? "personal", input.content, now],
  );
  return {
    id,
    scope: input.scope ?? "personal",
    content: input.content,
    createdAt: new Date(now).toISOString(),
  };
}

export async function searchMemories(query: string, limit = 10): Promise<MemoryRow[]> {
  const db = await getDb();
  const like = `%${query.replace(/[%_]/g, "")}%`;
  const rows = await db.select<MemoryRecord[]>(
    `SELECT * FROM memories WHERE content LIKE $1 ORDER BY created_at DESC LIMIT $2`,
    [like, limit],
  );
  return rows.map(recordToRow);
}

export async function listMemories(limit = 50): Promise<MemoryRow[]> {
  const db = await getDb();
  const rows = await db.select<MemoryRecord[]>(
    `SELECT * FROM memories ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(recordToRow);
}

export async function clearMemories(): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM memories");
}

function recordToRow(r: MemoryRecord): MemoryRow {
  return {
    id: r.id,
    scope: r.scope,
    content: r.content,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
