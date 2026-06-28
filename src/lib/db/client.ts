// Lazy SQLite handle. Migrations are declared on the Rust side via
// tauri-plugin-sql; opening the database here applies any pending ones.
import Database from "@tauri-apps/plugin-sql";

const DB_URL = "sqlite:desktop-oss.db";

let dbPromise: Promise<Database> | null = null;

export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL);
  }
  return dbPromise;
}
