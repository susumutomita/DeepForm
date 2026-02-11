import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "..", "data", "deepform.db");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    theme TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'interviewing',
    mode TEXT NOT NULL DEFAULT 'self',
    share_token TEXT UNIQUE,
    respondent_name TEXT,
    respondent_feedback TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    campaign_id TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS analysis_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    theme TEXT NOT NULL,
    owner_session_id TEXT,
    share_token TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    exe_user_id TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: ensure indexes exist
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_share_token ON sessions(share_token)");

try {
  db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)");
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : "";
  if (!msg.includes("duplicate column")) throw e;
}
try {
  db.exec("ALTER TABLE sessions ADD COLUMN is_public INTEGER DEFAULT 0");
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : "";
  if (!msg.includes("duplicate column")) throw e;
}

// Migration: github_id → exe_user_id
try {
  db.exec("ALTER TABLE users ADD COLUMN exe_user_id TEXT");
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : "";
  if (!msg.includes("duplicate column")) throw e;
}
try {
  db.exec("ALTER TABLE users ADD COLUMN email TEXT");
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : "";
  if (!msg.includes("duplicate column")) throw e;
}
try {
  db.exec("ALTER TABLE users ADD COLUMN display_name TEXT");
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : "";
  if (!msg.includes("duplicate column")) throw e;
}

// Backfill: populate exe_user_id for pre-existing rows (uses id as fallback)
db.prepare("UPDATE users SET exe_user_id = id WHERE exe_user_id IS NULL").run();
db.prepare("UPDATE users SET email = 'unknown@example.com' WHERE email IS NULL").run();

// Ensure unique index on exe_user_id for consistency with CREATE TABLE schema
try {
  db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_exe_user_id ON users(exe_user_id)").run();
} catch {
  /* index may already exist */
}

export { db };
