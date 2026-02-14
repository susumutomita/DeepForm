import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // --- sessions ---
  await db.schema
    .createTable("sessions")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("theme", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("interviewing"))
    .addColumn("mode", "text", (col) => col.notNull().defaultTo("self"))
    .addColumn("share_token", "text", (col) => col.unique())
    .addColumn("respondent_name", "text")
    .addColumn("respondent_feedback", "text")
    .addColumn("created_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("campaign_id", "text")
    .addColumn("user_id", "text", (col) => col.references("users.id"))
    .addColumn("is_public", "integer", (col) => col.defaultTo(0))
    .addColumn("interview_style", "text", (col) => col.defaultTo("depth"))
    .addColumn("deploy_token", "text")
    .execute();

  // --- messages ---
  await db.schema
    .createTable("messages")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("session_id", "text", (col) => col.notNull().references("sessions.id"))
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  // --- analysis_results ---
  await db.schema
    .createTable("analysis_results")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("session_id", "text", (col) => col.notNull().references("sessions.id"))
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("data", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  // --- campaigns ---
  await db.schema
    .createTable("campaigns")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("theme", "text", (col) => col.notNull())
    .addColumn("owner_session_id", "text", (col) => col.references("sessions.id"))
    .addColumn("share_token", "text", (col) => col.unique().notNull())
    .addColumn("created_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  // --- users ---
  await db.schema
    .createTable("users")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("exe_user_id", "text", (col) => col.unique().notNull())
    .addColumn("email", "text", (col) => col.notNull())
    .addColumn("display_name", "text")
    .addColumn("github_id", "integer")
    .addColumn("github_token", "text")
    .addColumn("avatar_url", "text")
    .addColumn("plan", "text", (col) => col.defaultTo("free"))
    .addColumn("stripe_customer_id", "text")
    .addColumn("plan_updated_at", "text")
    .addColumn("created_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  // --- auth_sessions ---
  await db.schema
    .createTable("auth_sessions")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id"))
    .addColumn("created_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("expires_at", "text", (col) => col.notNull())
    .execute();

  // --- feedback ---
  await db.schema
    .createTable("feedback")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("user_id", "text", (col) => col.references("users.id"))
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("message", "text", (col) => col.notNull())
    .addColumn("page", "text")
    .addColumn("ip_address", "text")
    .addColumn("created_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  // --- page_views ---
  await db.schema
    .createTable("page_views")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("path", "text", (col) => col.notNull())
    .addColumn("method", "text", (col) => col.notNull().defaultTo("GET"))
    .addColumn("status_code", "integer")
    .addColumn("referer", "text")
    .addColumn("user_agent", "text")
    .addColumn("ip_address", "text")
    .addColumn("country", "text")
    .addColumn("user_id", "text")
    .addColumn("session_fingerprint", "text")
    .addColumn("utm_source", "text")
    .addColumn("utm_medium", "text")
    .addColumn("utm_campaign", "text")
    .addColumn("created_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  // --- Indexes ---
  await db.schema
    .createIndex("idx_sessions_share_token")
    .unique()
    .ifNotExists()
    .on("sessions")
    .column("share_token")
    .execute();
  await db.schema
    .createIndex("idx_users_exe_user_id")
    .unique()
    .ifNotExists()
    .on("users")
    .column("exe_user_id")
    .execute();
  await db.schema
    .createIndex("idx_page_views_created_at")
    .ifNotExists()
    .on("page_views")
    .column("created_at")
    .execute();
  await db.schema.createIndex("idx_page_views_path").ifNotExists().on("page_views").column("path").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Reverse order to respect foreign key constraints
  await db.schema.dropTable("page_views").ifExists().execute();
  await db.schema.dropTable("feedback").ifExists().execute();
  await db.schema.dropTable("auth_sessions").ifExists().execute();
  await db.schema.dropTable("analysis_results").ifExists().execute();
  await db.schema.dropTable("messages").ifExists().execute();
  await db.schema.dropTable("campaigns").ifExists().execute();
  await db.schema.dropTable("sessions").ifExists().execute();
  await db.schema.dropTable("users").ifExists().execute();
}
