// Drop-in shim for `@tauri-apps/plugin-sql` so the orchestrator's DB
// layer (conversations, runs, memories, settings) runs unchanged under
// `node:test`. Backed by the built-in `node:sqlite` module (stable as of
// Node 22.5+) so there's no native dependency to install.
//
// The shim is wired in via `mock.module()` from the eval setup helpers —
// see `setup.ts`. Each eval test process gets a fresh in-memory database;
// `resetDatabase()` lets a scenario wipe and re-seed between iterations.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/lib/agent/evals → repo root → src-tauri/migrations
const MIGRATIONS_DIR = join(__dirname, "../../../../src-tauri/migrations");

let _migrationSql: string | null = null;
function getMigrationSql(): string {
  if (_migrationSql !== null) return _migrationSql;
  // Apply every migration in lexical order — schema must match production
  // so writes from the orchestrator's DB layer (which uses columns added
  // by 0002+) succeed against the shim.
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const sql = files.map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf-8")).join("\n\n");
  _migrationSql = sql;
  return sql;
}

interface ExecuteResult {
  rowsAffected: number;
  lastInsertId?: number;
}

/**
 * Single in-memory SQLite handle shared across all `Database.load()` calls
 * within one process. The real `@tauri-apps/plugin-sql` likewise hands out
 * one connection per URL — the orchestrator's `getDb()` caches the promise.
 */
let _activeDb: DatabaseSync | null = null;

function getOrCreateInner(): DatabaseSync {
  if (!_activeDb) {
    _activeDb = new DatabaseSync(":memory:");
    _activeDb.exec(getMigrationSql());
  }
  return _activeDb;
}

/**
 * The class deliberately does NOT cache the underlying SQLite handle:
 * `resetDatabase()` swaps the in-memory database between iterations, and
 * the orchestrator's `getDb()` caches one `Database` instance forever.
 * Looking up `_activeDb` on every call lets the same `Database` instance
 * transparently follow the swap.
 */
export class Database {
  private constructor() {}

  static async load(_url: string): Promise<Database> {
    getOrCreateInner();
    return new Database();
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    const inner = getOrCreateInner();
    const stmt = inner.prepare(translatePlaceholders(sql));
    const result = stmt.run(...bindParams(params));
    return {
      rowsAffected: Number(result.changes),
      lastInsertId:
        typeof result.lastInsertRowid === "bigint"
          ? Number(result.lastInsertRowid)
          : result.lastInsertRowid,
    };
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T> {
    const inner = getOrCreateInner();
    const stmt = inner.prepare(translatePlaceholders(sql));
    return stmt.all(...bindParams(params)) as unknown as T;
  }

  async close(): Promise<void> {
    if (_activeDb) {
      _activeDb.close();
      _activeDb = null;
    }
  }
}

export default Database;

/**
 * Truncate every table and re-apply the migration. Use from a `beforeEach`
 * hook in scenarios that run multiple iterations against the same process.
 */
export function resetDatabase(): void {
  if (_activeDb) {
    _activeDb.close();
    _activeDb = null;
  }
  getOrCreateInner();
}

/**
 * Convert `tauri-plugin-sql`-style `$1`/`$2` placeholders to SQLite `?`.
 * Every query in the orchestrator's DB layer uses sequential numbering,
 * so positional replacement is safe.
 */
function translatePlaceholders(sql: string): string {
  return sql.replace(/\$\d+/g, "?");
}

function bindParams(params: unknown[]): (string | number | bigint | null | Uint8Array)[] {
  return params.map((p) => {
    if (p === null || p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (typeof p === "string" || typeof p === "number" || typeof p === "bigint")
      return p;
    if (p instanceof Uint8Array) return p;
    return String(p);
  });
}
