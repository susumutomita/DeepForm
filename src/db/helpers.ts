import { type RawBuilder, sql } from "kysely";

/**
 * Cross-dialect CURRENT_TIMESTAMP — works in both SQLite and PostgreSQL.
 */
export function now(): RawBuilder<string> {
  return sql<string>`CURRENT_TIMESTAMP`;
}

/**
 * Compute a past date as an ISO string.
 * Avoids dialect-specific SQL (SQLite: datetime('now', '-N days'), PG: NOW() - INTERVAL).
 * Instead, computes in JavaScript and passes as a plain parameter.
 */
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
