import { db } from "../db.ts";

/**
 * 分析結果を upsert する。
 * 既存レコードがあれば更新、なければ挿入する。
 */
export function saveAnalysisResult(sessionId: string, type: string, data: unknown): void {
  const existing = db
    .prepare("SELECT id FROM analysis_results WHERE session_id = ? AND type = ?")
    .get(sessionId, type) as { id: number } | undefined;
  if (existing) {
    db.prepare("UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      JSON.stringify(data),
      existing.id,
    );
  } else {
    db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
      sessionId,
      type,
      JSON.stringify(data),
    );
  }
}
