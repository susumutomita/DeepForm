import { now } from "../db/helpers.ts";
import { db } from "../db/index.ts";

/**
 * 分析結果を upsert する。
 * ON CONFLICT で session_id + type の組み合わせが重複する場合は更新する。
 */
export async function saveAnalysisResult(sessionId: string, type: string, data: unknown): Promise<void> {
  await db
    .insertInto("analysis_results")
    .values({
      session_id: sessionId,
      type,
      data: JSON.stringify(data),
    })
    .onConflict((oc) =>
      oc.columns(["session_id", "type"]).doUpdateSet({
        data: JSON.stringify(data),
        created_at: now(),
      }),
    )
    .execute();
}
