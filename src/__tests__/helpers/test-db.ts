/**
 * テスト用データベースヘルパー
 * node:sqlite の DatabaseSync を使い、better-sqlite3 互換の API を提供する。
 * ネイティブバイナリ不要で動作する。
 */
import { DatabaseSync } from "node:sqlite";

export const FULL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    exe_user_id TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    is_public INTEGER DEFAULT 0
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
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id),
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    page TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

export function createTestDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(FULL_SCHEMA);
  return db;
}
