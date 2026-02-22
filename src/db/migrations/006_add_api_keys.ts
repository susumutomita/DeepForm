import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      last_used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `.execute(db);

  await sql`CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash)`.execute(db);
  await sql`CREATE INDEX idx_api_keys_user_id ON api_keys(user_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS api_keys`.execute(db);
}
