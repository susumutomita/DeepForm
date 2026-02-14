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
    return {
      "001_initial_schema": m001,
      "002_add_analysis_unique": m002,
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
