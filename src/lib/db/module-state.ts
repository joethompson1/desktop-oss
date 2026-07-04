// Generic per-conversation, per-module state store — backs the optional
// AppModule.serializeState/hydrateState seam (see modules/types.ts) so a
// module's panel state can survive a reload without every module needing
// its own table.

import { getDb } from "./client";

interface ModuleStateRow {
  data: string;
}

export async function getModuleStateRow(
  conversationId: string,
  moduleId: string,
): Promise<unknown> {
  const db = await getDb();
  const rows = await db.select<ModuleStateRow[]>(
    "SELECT data FROM module_state WHERE conversation_id = $1 AND module_id = $2",
    [conversationId, moduleId],
  );
  if (rows.length === 0) return undefined;
  try {
    return JSON.parse(rows[0].data);
  } catch {
    return undefined;
  }
}

export async function setModuleStateRow(
  conversationId: string,
  moduleId: string,
  data: unknown,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO module_state (conversation_id, module_id, data, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(conversation_id, module_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [conversationId, moduleId, JSON.stringify(data), Date.now()],
  );
}
