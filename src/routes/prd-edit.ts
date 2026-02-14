import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.ts";
import { getOwnedSession, isResponse } from "../helpers/session-ownership.ts";
import { callClaude, extractText } from "../llm.ts";
import type { AppEnv } from "../types.ts";

const prdEditRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const sectionTypeEnum = z.enum(["qualityRequirements", "acceptanceCriteria", "metrics", "edgeCases", "other"]);

const suggestSchema = z.object({
  selectedText: z.string().min(1, "選択テキストは必須です"),
  context: z.string().min(1, "コンテキストは必須です"),
  sectionType: sectionTypeEnum,
});

const applySchema = z.object({
  selectedText: z.string().min(1, "選択テキストは必須です"),
  newText: z.string().min(1, "新しいテキストは必須です"),
  context: z.string().min(1, "コンテキストは必須です"),
  sectionType: sectionTypeEnum,
  isCustomInput: z.boolean(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECTION_LABELS: Record<string, string> = {
  qualityRequirements: "品質要件",
  acceptanceCriteria: "受け入れ基準",
  metrics: "メトリクス",
  edgeCases: "エッジケース",
  other: "その他",
};

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/prd/suggest
// ---------------------------------------------------------------------------

prdEditRoutes.post("/api/sessions/:id/prd/suggest", async (c) => {
  const result = await getOwnedSession(c);
  if (isResponse(result)) return result;

  let body: z.infer<typeof suggestSchema>;
  try {
    body = suggestSchema.parse(await c.req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: err.issues.map((e) => e.message).join(", ") }, 400);
    }
    return c.json({ error: "リクエストの解析に失敗しました" }, 400);
  }

  const { selectedText, context, sectionType } = body;
  const sectionLabel = SECTION_LABELS[sectionType] ?? sectionType;

  const systemPrompt = [
    "あなたはPRD（製品要求仕様書）の編集を支援するアシスタントです。",
    "ユーザーがPRD内のテキストを選択しました。選択されたテキストに対して、文脈に適した代替案を正確に3つ提案してください。",
    "",
    "ルール:",
    "- 必ず3つの代替案を提案すること",
    "- 各代替案は簡潔で、選択されたテキストと同じ粒度・形式にすること",
    "- 代替案は文脈上意味が通るものにすること",
    "- 元のテキストとは異なる値や表現にすること",
    '- JSON配列形式で回答すること（例: ["案1", "案2", "案3"]）',
    "- JSON以外のテキストは一切出力しないこと",
  ].join("\n");

  const userMessage = [
    `セクション: ${sectionLabel}`,
    `文脈: 「${context}」`,
    `選択テキスト: 「${selectedText}」`,
    "",
    "上記の選択テキストに対する代替案を3つ、JSON配列で提案してください。",
  ].join("\n");

  try {
    const response = await callClaude([{ role: "user", content: userMessage }], systemPrompt, 1024);
    const text = extractText(response);

    // Parse the JSON array from Claude's response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return c.json({ error: "AIからの応答を解析できませんでした" }, 500);
    }

    const suggestions: string[] = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      return c.json({ error: "AIからの応答を解析できませんでした" }, 500);
    }

    // Ensure exactly 3 suggestions
    const finalSuggestions = suggestions.slice(0, 3);
    while (finalSuggestions.length < 3) {
      finalSuggestions.push(selectedText);
    }

    return c.json({ suggestions: finalSuggestions });
  } catch (err) {
    console.error("PRD suggest error:", err);
    return c.json({ error: "提案の生成に失敗しました" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/prd/apply
// ---------------------------------------------------------------------------

prdEditRoutes.post("/api/sessions/:id/prd/apply", async (c) => {
  const sessionResult = await getOwnedSession(c);
  if (isResponse(sessionResult)) return sessionResult;
  const session = sessionResult;

  let body: z.infer<typeof applySchema>;
  try {
    body = applySchema.parse(await c.req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: err.issues.map((e) => e.message).join(", ") }, 400);
    }
    return c.json({ error: "リクエストの解析に失敗しました" }, 400);
  }

  const { selectedText, newText, context, sectionType, isCustomInput } = body;
  const sectionLabel = SECTION_LABELS[sectionType] ?? sectionType;

  try {
    // -----------------------------------------------------------------------
    // Custom input: validate relevance first
    // -----------------------------------------------------------------------
    if (isCustomInput) {
      const validationSystemPrompt = [
        "あなたはPRD（製品要求仕様書）の編集バリデーターです。",
        "ユーザーが要件テキストの一部を独自の入力で置き換えようとしています。",
        "入力内容が要件の文脈に関連しているかを判定してください。",
        "",
        "ルール:",
        "- 入力が文脈と全く関連性がない場合は却下すること",
        "- 入力が技術的に意味不明な場合は却下すること",
        "- 多少の変更や異なるアプローチでも、文脈に関連していれば許可すること",
        '- JSON形式で回答: {"relevant": true} または {"relevant": false, "reason": "却下理由"}',
        "- JSON以外のテキストは一切出力しないこと",
      ].join("\n");

      const validationMessage = [
        `セクション: ${sectionLabel}`,
        `元の文脈: 「${context}」`,
        `選択テキスト: 「${selectedText}」`,
        `ユーザー入力: 「${newText}」`,
        "",
        "このユーザー入力は要件の文脈に関連していますか？JSON形式で回答してください。",
      ].join("\n");

      const validationResponse = await callClaude(
        [{ role: "user", content: validationMessage }],
        validationSystemPrompt,
        512,
      );
      const validationText = extractText(validationResponse);
      const validationMatch = validationText.match(/\{[\s\S]*\}/);

      if (!validationMatch) {
        // Claude の応答を解析できない場合は安全側に倒して却下
        return c.json({
          applied: false,
          reason: "入力内容の検証に失敗しました。もう一度お試しください。",
        });
      }

      const validation = JSON.parse(validationMatch[0]);
      if (!validation.relevant) {
        return c.json({
          applied: false,
          reason: validation.reason ?? "入力された内容は要件の文脈と関連性がありません。",
        });
      }

      // Relevant custom input: use Claude to rewrite naturally
      const rewriteSystemPrompt = [
        "あなたはPRD（製品要求仕様書）のテキスト編集アシスタントです。",
        "ユーザーが要件テキストの一部を新しい内容に置き換えたいと考えています。",
        "新しい内容を自然に組み込んだ文を生成してください。",
        "",
        "ルール:",
        "- 元の文の構造やトーンを維持すること",
        "- 新しい内容を自然に組み込むこと",
        "- 書き換えた文のみを出力すること（説明や装飾は不要）",
      ].join("\n");

      const rewriteMessage = [
        `セクション: ${sectionLabel}`,
        `元の文: 「${context}」`,
        `置き換え対象: 「${selectedText}」`,
        `新しい内容: 「${newText}」`,
        "",
        `上記の元の文で「${selectedText}」を「${newText}」の意味を反映させて自然に書き換えた文を出力してください。`,
      ].join("\n");

      const rewriteResponse = await callClaude([{ role: "user", content: rewriteMessage }], rewriteSystemPrompt, 1024);
      const updatedText = extractText(rewriteResponse)
        .trim()
        .replace(/^[「『]|[」』]$/g, "");

      // Persist the change
      await updatePrdInDb(session.id, sectionType, context, updatedText);

      return c.json({ updatedText, applied: true });
    }

    // -----------------------------------------------------------------------
    // Non-custom input: simple text replacement
    // -----------------------------------------------------------------------
    const updatedText = context.replace(selectedText, newText);

    // Persist the change
    await updatePrdInDb(session.id, sectionType, context, updatedText);

    return c.json({ updatedText, applied: true });
  } catch (err) {
    console.error("PRD apply error:", err);
    return c.json({ error: "変更の適用に失敗しました" }, 500);
  }
});

// ---------------------------------------------------------------------------
// DB helper: update PRD content in analysis_results
// ---------------------------------------------------------------------------

async function updatePrdInDb(
  sessionId: string,
  _sectionType: string,
  oldContext: string,
  newContext: string,
): Promise<void> {
  // Try to find existing PRD data
  const prdRow = await db
    .selectFrom("analysis_results")
    .select(["id", "data"])
    .where("session_id", "=", sessionId)
    .where("type", "=", "prd")
    .executeTakeFirst();

  if (!prdRow) {
    // No PRD record exists; nothing to update
    return;
  }

  try {
    const prdData = JSON.parse(prdRow.data);

    // Walk through the PRD data and replace the old context with the new one
    const updated = replaceInObject(prdData, oldContext, newContext);

    await db
      .updateTable("analysis_results")
      .set({ data: JSON.stringify(updated) })
      .where("id", "=", prdRow.id)
      .execute();
  } catch {
    // If parsing fails, try a raw string replacement
    const updatedData = prdRow.data.replace(
      JSON.stringify(oldContext).slice(1, -1),
      JSON.stringify(newContext).slice(1, -1),
    );
    await db.updateTable("analysis_results").set({ data: updatedData }).where("id", "=", prdRow.id).execute();
  }
}

/**
 * Recursively replace oldText with newText in all string values of an object.
 */
function replaceInObject(obj: unknown, oldText: string, newText: string): unknown {
  if (typeof obj === "string") {
    return obj.replace(oldText, newText);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => replaceInObject(item, oldText, newText));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = replaceInObject(value, oldText, newText);
    }
    return result;
  }
  return obj;
}

export { prdEditRoutes };
