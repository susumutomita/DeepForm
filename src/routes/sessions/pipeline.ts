/**
 * One-click analysis pipeline: facts → hypotheses → design (PRD+spec merged)
 * Returns SSE events so the frontend can render each stage as it completes.
 *
 * Events:
 *   event: stage\ndata: {"stage":"facts","data":{...}}\n\n
 *   event: stage\ndata: {"stage":"hypotheses","data":{...}}\n\n
 *   event: stage\ndata: {"stage":"design","data":{...}}\n\n
 *   event: done\ndata: {}\n\n
 *   event: error\ndata: {"stage":"facts","error":"..."}\n\n
 */
import { Hono } from "hono";
import { Writable } from "node:stream";
import { ANALYSIS_TYPE, SESSION_STATUS, requiresProForStep } from "../../constants.ts";
import { db } from "../../db.ts";
import { saveAnalysisResult } from "../../helpers/analysis-store.ts";
import { generatePRDMarkdown } from "../../helpers/format.ts";
import { getOwnedSession, isResponse } from "../../helpers/session-ownership.ts";
import { callClaude, extractText } from "../../llm.ts";
import type { AppEnv, Session } from "../../types.ts";

const PAYMENT_LINK = "https://buy.stripe.com/test_dRmcMXbrh3Q8ggx8DA48000";

export const pipelineRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const FACTS_SYSTEM = `あなたは定性調査の分析エキスパートです。以下のデプスインタビュー記録からファクトを抽出してください。

必ずJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "facts": [
    {
      "id": "F1",
      "type": "fact",
      "content": "抽出した内容",
      "evidence": "元の発話を引用",
      "severity": "high"
    }
  ]
}

typeは "fact"（事実）, "pain"（困りごと）, "frequency"（頻度）, "workaround"（回避策）のいずれか。
severityは "high", "medium", "low" のいずれか。

抽象的な表現は避け、具体的な事実のみ抽出してください。最低5つ、最大4個のファクトを抽出してください。`;

const HYPOTHESES_SYSTEM = `あなたはプロダクト仮説生成のエキスパートです。抽出されたファクトから仮説を生成してください。

必ずJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "hypotheses": [
    {
      "id": "H1",
      "title": "仮説タイトル",
      "description": "仮説の詳細説明",
      "supportingFacts": ["F1", "F3"],
      "counterEvidence": "この仮説が成り立たない可能性",
      "unverifiedPoints": ["未検証ポイント1"]
    }
  ]
}

3つの仮説を生成してください。各仮説に根拠となるファクトID、反証パターン、未検証ポイントを必ず含めてください。`;

const DESIGN_SYSTEM = `あなたはシニアプロダクトマネージャー兼テックリードです。
ファクトと仮説から、「要件定義（PRD）」と「実装仕様（spec）」を統合した設計書を生成してください。

必ず以下のJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "prd": {
    "problemDefinition": "解決する問題の具体的な定義",
    "targetUser": "対象ユーザーの具体的な描写",
    "jobsToBeDone": ["ジョブ1"],
    "coreFeatures": [
      {
        "name": "機能名",
        "description": "機能の説明",
        "priority": "must",
        "acceptanceCriteria": ["受け入れ基準1"],
        "edgeCases": ["エッジケース"]
      }
    ],
    "nonGoals": ["やらないこと1"],
    "userFlows": [
      { "name": "フロー名", "steps": ["ステップ1"] }
    ],
    "qualityRequirements": {
      "functionalSuitability": { "description": "", "criteria": [] },
      "performanceEfficiency": { "description": "", "criteria": [] },
      "compatibility": { "description": "", "criteria": [] },
      "usability": { "description": "", "criteria": [] },
      "reliability": { "description": "", "criteria": [] },
      "security": { "description": "", "criteria": [] },
      "maintainability": { "description": "", "criteria": [] },
      "portability": { "description": "", "criteria": [] }
    },
    "metrics": [
      { "name": "指標名", "definition": "計測方法", "target": "目標値" }
    ]
  },
  "spec": {
    "projectName": "プロジェクト名",
    "techStack": { "frontend": "", "backend": "", "database": "" },
    "apiEndpoints": [
      { "method": "GET", "path": "/api/xxx", "description": "", "request": {}, "response": {} }
    ],
    "dbSchema": "CREATE TABLE ...",
    "screens": [
      { "name": "画面名", "path": "/path", "components": [], "description": "" }
    ],
    "testCases": [
      {
        "category": "",
        "cases": [
          { "name": "", "given": "", "when": "", "then": "" }
        ]
      }
    ]
  }
}

ルール：
- 抽象語は禁止（「改善する」「最適化する」などNG）
- テスト可能な条件のみ記述
- MVP スコープに圧縮（コア機能は最大5つ）
- 各機能に受け入れ基準とエッジケースを必ず付ける
- qualityRequirements は ISO/IEC 25010 の8品質特性すべてを網羅
- spec には具体的な API 仕様、DB スキーマ、画面一覧、テストケースを含める
- コーディングエージェントがそのまま実装できるレベルの具体性

実装制約（CRITICAL）:
- モックデータ、ハードコードされた配列、スタブ API での実装は禁止
- 「UI が表示される」だけでは完成ではない。データ経路が実物であることが完了条件
- 未実装部分は UI 上で「未実装」と明示すること`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTranscript(sessionId: string): string {
  const messages = db
    .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at")
    .all(sessionId) as unknown as { role: string; content: string }[];
  return messages
    .map((m) => `${m.role === "user" ? "回答者" : "インタビュアー"}: ${m.content}`)
    .join("\n\n");
}

function parseJSON(text: string, fallback: unknown): unknown {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch![0]);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Pipeline endpoint
// ---------------------------------------------------------------------------

pipelineRoutes.post("/sessions/:id/pipeline", async (c) => {
  // Ownership check
  const result = getOwnedSession(c);
  if (isResponse(result)) return result;
  const session = result as Session;
  const id = session.id;

  // Pro gate — check the earliest gated step in the pipeline
  const pipelineSteps = ["analyze", "hypotheses", "prd", "spec"];
  for (const step of pipelineSteps) {
    if (requiresProForStep(step)) {
      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Login required for this feature", upgrade: true }, 401);
      }
      const row = db.prepare("SELECT plan FROM users WHERE id = ?").get(user.id) as { plan: string } | undefined;
      if (row?.plan !== "pro") {
        return c.json(
          { error: "Pro plan required", upgrade: true, upgradeUrl: `${PAYMENT_LINK}?client_reference_id=${user.id}` },
          402,
        );
      }
      break; // only need to check once — if earliest gated step passes, all pass
    }
  }

  // SSE response
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        // --- Stage 1: Facts ---
        send("stage", { stage: "facts", status: "running" });
        const transcript = buildTranscript(id);
        const factsResp = await callClaude(
          [{ role: "user", content: `以下のインタビュー記録を分析してください：\n\n${transcript}` }],
          FACTS_SYSTEM,
          4096,
        );
        const factsText = extractText(factsResp);
        const facts = parseJSON(factsText, {
          facts: [{ id: "F1", type: "fact", content: factsText, evidence: "", severity: "medium" }],
        });
        saveAnalysisResult(id, ANALYSIS_TYPE.FACTS, facts);
        db.prepare("UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
          SESSION_STATUS.ANALYZED, id,
        );
        send("stage", { stage: "facts", status: "done", data: facts });

        // --- Stage 2: Hypotheses ---
        send("stage", { stage: "hypotheses", status: "running" });
        const hypoResp = await callClaude(
          [{ role: "user", content: `以下のファクトから仮説を生成してください：\n\n${JSON.stringify(facts, null, 2)}` }],
          HYPOTHESES_SYSTEM,
          4096,
        );
        const hypoText = extractText(hypoResp);
        const hypotheses = parseJSON(hypoText, {
          hypotheses: [{ id: "H1", title: hypoText, description: "", supportingFacts: [], counterEvidence: "", unverifiedPoints: [] }],
        });
        saveAnalysisResult(id, ANALYSIS_TYPE.HYPOTHESES, hypotheses);
        db.prepare("UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
          SESSION_STATUS.HYPOTHESIZED, id,
        );
        send("stage", { stage: "hypotheses", status: "done", data: hypotheses });

        // --- Stage 3: Design (PRD + Spec merged) ---
        send("stage", { stage: "design", status: "running" });
        const designResp = await callClaude(
          [{
            role: "user",
            content: `以下のファクトと仮説から設計書を生成してください：\n\nテーマ: ${session.theme}\n\nファクト:\n${JSON.stringify(facts, null, 2)}\n\n仮説:\n${JSON.stringify(hypotheses, null, 2)}`,
          }],
          DESIGN_SYSTEM,
          8192,
        );
        const designText = extractText(designResp);
        const design = parseJSON(designText, { prd: { problemDefinition: designText }, spec: {} }) as any;

        // Save PRD and spec separately for backward compatibility
        const prdData = design.prd ? { prd: design.prd } : design;
        saveAnalysisResult(id, ANALYSIS_TYPE.PRD, prdData);
        db.prepare("UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
          SESSION_STATUS.PRD_GENERATED, id,
        );

        // Generate PRD markdown
        const prdMarkdown = generatePRDMarkdown(design.prd || design, session.theme);
        const specData = { ...(design.spec || {}), prdMarkdown };
        saveAnalysisResult(id, ANALYSIS_TYPE.SPEC, { spec: specData });
        db.prepare("UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
          SESSION_STATUS.SPEC_GENERATED, id,
        );

        send("stage", { stage: "design", status: "done", data: { prd: design.prd, spec: specData } });
        send("done", {});
      } catch (e: any) {
        console.error("Pipeline error:", e);
        send("error", { error: e.message || "Internal Server Error" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
