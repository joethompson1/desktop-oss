// Settings table acts as a JSON key/value store for adapter configs,
// system prompts, and any other small preferences.

import { getDb } from "./client";

interface SettingsRow {
  key: string;
  value: string;
}

export async function getSetting<T>(key: string): Promise<T | null> {
  const db = await getDb();
  const rows = await db.select<SettingsRow[]>(
    "SELECT value FROM settings WHERE key = $1",
    [key],
  );
  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0].value) as T;
  } catch {
    return null;
  }
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}

export async function deleteSetting(key: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM settings WHERE key = $1", [key]);
}
