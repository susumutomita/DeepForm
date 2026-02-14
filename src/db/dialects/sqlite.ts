import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type Kysely, SqliteDialect } from "kysely";
import type { Database as DB } from "../types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createSqliteDialect(): SqliteDialect {
  const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "..", "..", "..", "data", "deepform.db");
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  return new SqliteDialect({ database });
}

/** Run PRAGMA statements after Kysely is initialized (SQLite-only). */
export async function initSqlite(_db: Kysely<DB>): Promise<void> {
  // PRAGMAs are set at connection level in createSqliteDialect.
  // This hook exists for any post-migration SQLite-specific setup.
}
