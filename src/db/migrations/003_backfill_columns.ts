import { type Kysely, sql } from "kysely";

/**
 * Backfill migration: adds columns that may be missing from databases
 * created by the old src/db.ts before the Kysely migration.
 *
 * CREATE TABLE IF NOT EXISTS in migration 001 skips existing tables,
 * so columns added after the initial table creation are missing.
 * SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS,
 * so we catch "duplicate column" errors.
 */

async function addColumnSafe(db: Kysely<unknown>, ddl: string): Promise<void> {
  try {
    await sql.raw(ddl).execute(db);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (!msg.includes("duplicate column")) throw e;
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // --- page_views: UTM columns ---
  await addColumnSafe(db, "ALTER TABLE page_views ADD COLUMN utm_source TEXT");
  await addColumnSafe(db, "ALTER TABLE page_views ADD COLUMN utm_medium TEXT");
  await addColumnSafe(db, "ALTER TABLE page_views ADD COLUMN utm_campaign TEXT");

  // --- users: billing / Stripe columns ---
  await addColumnSafe(db, "ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free'");
  await addColumnSafe(db, "ALTER TABLE users ADD COLUMN stripe_customer_id TEXT");
  await addColumnSafe(db, "ALTER TABLE users ADD COLUMN plan_updated_at TEXT");

  // --- users: GitHub OAuth columns ---
  await addColumnSafe(db, "ALTER TABLE users ADD COLUMN github_id INTEGER");
  await addColumnSafe(db, "ALTER TABLE users ADD COLUMN github_token TEXT");
  await addColumnSafe(db, "ALTER TABLE users ADD COLUMN avatar_url TEXT");

  // --- sessions: columns added after initial schema ---
  await addColumnSafe(db, "ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)");
  await addColumnSafe(db, "ALTER TABLE sessions ADD COLUMN is_public INTEGER DEFAULT 0");
  await addColumnSafe(db, "ALTER TABLE sessions ADD COLUMN deploy_token TEXT");
  await addColumnSafe(db, "ALTER TABLE sessions ADD COLUMN interview_style TEXT DEFAULT 'depth'");
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // SQLite does not support DROP COLUMN before 3.35.0; no-op for safety
}
