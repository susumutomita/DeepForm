/**
 * テスト用データベースヘルパー
 * better-sqlite3 + Kysely でインメモリテストDBを作成する。
 * - createTestDb() → Kysely<Database> インスタンス（vi.mockで使用）
 * - getRawDb() → better-sqlite3 Database インスタンス（テストのsetup/assertion用）
 */

import type { Database as RawDatabase } from "better-sqlite3";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Database as DB } from "../../db/types.ts";

export const FULL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    exe_user_id TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT,
    github_id INTEGER,
    github_token TEXT,
    avatar_url TEXT,
    plan TEXT DEFAULT 'free',
    stripe_customer_id TEXT,
    plan_updated_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  );
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
    campaign_id TEXT,
    user_id TEXT REFERENCES users(id),
    is_public INTEGER DEFAULT 0,
    interview_style TEXT DEFAULT 'depth',
    deploy_token TEXT,
    github_repo_url TEXT,
    ip_hash TEXT
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
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    UNIQUE(session_id, type)
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
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id),
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    page TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    method TEXT DEFAULT 'GET',
    status_code INTEGER,
    referer TEXT,
    user_agent TEXT,
    ip_address TEXT,
    country TEXT,
    user_id TEXT,
    session_fingerprint TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    last_used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
  CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
`;

let _rawDb: RawDatabase | null = null;

export function createTestDb(): Kysely<DB> {
  const rawDb = new Database(":memory:");
  rawDb.pragma("foreign_keys = ON");
  rawDb.exec(FULL_SCHEMA);
  _rawDb = rawDb;

  return new Kysely<DB>({
    dialect: new SqliteDialect({ database: rawDb }),
  });
}

/** テストのsetup/cleanup/assertionで直接SQLを実行するためのraw DB */
export function getRawDb(): RawDatabase {
  if (!_rawDb) throw new Error("createTestDb() must be called first");
  return _rawDb;
}
