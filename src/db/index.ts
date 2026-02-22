import { Kysely, Migrator } from "kysely";
import type { Database } from "./types.ts";

// ---------------------------------------------------------------------------
// Dialect selection — controlled by DB_TYPE env var
// ---------------------------------------------------------------------------

async function createDialect() {
  const dbType = process.env.DB_TYPE || "sqlite";
  if (dbType === "postgresql") {
    const { createPostgresDialect } = await import("./dialects/postgres.ts");
    return createPostgresDialect();
  }
  const { createSqliteDialect } = await import("./dialects/sqlite.ts");
  return createSqliteDialect();
}

// ---------------------------------------------------------------------------
// Migration provider — loads all migrations from the migrations directory
// ---------------------------------------------------------------------------

class StaticMigrationProvider {
  async getMigrations() {
    const m001 = await import("./migrations/001_initial_schema.ts");
    const m002 = await import("./migrations/002_add_analysis_unique.ts");
    const m003 = await import("./migrations/003_backfill_columns.ts");
    const m004 = await import("./migrations/004_add_github_repo_url.ts");
    const m005 = await import("./migrations/005_add_session_ip.ts");
    const m006 = await import("./migrations/006_add_api_keys.ts");
    return {
      "001_initial_schema": m001,
      "002_add_analysis_unique": m002,
      "003_backfill_columns": m003,
      "004_add_github_repo_url": m004,
      "005_add_session_ip": m005,
      "006_add_api_keys": m006,
    };
  }
}

// ---------------------------------------------------------------------------
// Initialize database + run migrations
// ---------------------------------------------------------------------------

const dialect = await createDialect();
const db = new Kysely<Database>({ dialect });

// Run migrations on startup
const migrator = new Migrator({ db, provider: new StaticMigrationProvider() });
const { error } = await migrator.migrateToLatest();
if (error) {
  console.error("Migration failed:", error);
  throw error;
}

export { db };
export type { Database };
