import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add unique constraint on (session_id, type) to support ON CONFLICT upsert
  await db.schema
    .createIndex("idx_analysis_results_session_type")
    .unique()
    .ifNotExists()
    .on("analysis_results")
    .columns(["session_id", "type"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_analysis_results_session_type").ifExists().execute();
}
