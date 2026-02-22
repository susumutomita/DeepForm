import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sessions ADD COLUMN ip_hash TEXT`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // SQLite doesn't support DROP COLUMN easily
}
