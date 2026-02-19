import type { Kysely } from "kysely";
import { sql } from "kysely";

async function addColumnSafe(db: Kysely<unknown>, ddl: string): Promise<void> {
  try {
    await sql.raw(ddl).execute(db);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (!msg.includes("duplicate column")) throw e;
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await addColumnSafe(db, "ALTER TABLE sessions ADD COLUMN github_repo_url TEXT");
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // SQLite does not support DROP COLUMN before 3.35.0; no-op for safety
}
