/**
 * One-click analysis pipeline: facts+hypotheses → PRD → spec
 * Returns SSE events so the frontend can render each stage as it completes.
 *
 * Events:
 *   event: stage\ndata: {"stage":"facts","status":"done","data":{...}}\n\n
 *   event: stage\ndata: {"stage":"hypotheses","status":"done","data":{...}}\n\n
 *   event: stage\ndata: {"stage":"prd","status":"done","data":{...}}\n\n
 *   event: stage\ndata: {"stage":"spec","status":"done","data":{...}}\n\n
 *   event: done\ndata: {}\n\n
 *   event: error\ndata: {"error":"..."}\n\n
 */

import { Hono } from "hono";
import { ANALYSIS_TYPE, requiresProForStep, SESSION_STATUS } from "../../constants.ts";
import { now } from "../../db/helpers.ts";
import { db } from "../../db/index.ts";
import { saveAnalysisResult } from "../../helpers/analysis-store.ts";
import { generatePRDMarkdown } from "../../helpers/format.ts";
import { getOwnedSession, isResponse } from "../../helpers/session-ownership.ts";
import { callClaude, extractText } from "../../llm.ts";
import type { AppEnv, Session } from "../../types.ts";

const PAYMENT_LINK = "https://buy.stripe.com/test_dRmcMXbrh3Q8ggx8DA48000";

export const pipelineRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Prompts — same as analysis.ts individual endpoints
// ---------------------------------------------------------------------------

// Facts + Hypotheses combined (1 LLM call instead of 2)
const ANALYSIS_SYSTEM = `You are a qualitative research analysis expert. Extract facts and generate hypotheses simultaneously from the depth interview transcript below.

IMPORTANT: Respond in the SAME LANGUAGE as the interview transcript. If the transcript is in Japanese, respond in Japanese. If in English, respond in English. If in Spanish, respond in Spanish.

必ず以下のJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "facts": [
    {
      "id": "F1",
      "type": "fact",
      "content": "抽出した内容",
      "evidence": "元の発話を引用",
      "severity": "high"
    }
  ],
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

ファクトのルール:
- type: "fact"（事実), "pain"（困りごと), "frequency"（頻度), "workaround"（回避策)
- severity: "high", "medium", "low"
- 抽象的な表現は避け、具体的な事実のみ抽出。最低5つ、最大15個

仮説のルール:
- 3つの仮説を生成
- 各仮説に根拠となるファクトID、反証パターン、未検証ポイントを必ず含める`;

// PRD prompt — identical to analysis.ts
const PRD_SYSTEM = `You are a senior product manager. Generate a PRD (Product Requirements Document) from the facts and hypotheses.

IMPORTANT: Respond in the SAME LANGUAGE as the input facts/hypotheses. If they are in Japanese, write the PRD in Japanese. If in English, write in English. If in Spanish, write in Spanish.

必ず以下のJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "prd": {
    "problemDefinition": "解決する問題の具体的な定義",
    "targetUser": "対象ユーザーの具体的な描写",
    "jobsToBeDone": ["ジョブ1", "ジョブ2"],
    "coreFeatures": [
      {
        "name": "機能名",
        "description": "機能の説明",
        "priority": "must",
        "acceptanceCriteria": ["受け入れ基準1"],
        "edgeCases": ["エッジケース: 入力が空の場合はエラーメッセージを表示"]
      }
    ],
    "nonGoals": ["やらないこと1"],
    "userFlows": [
      {
        "name": "フロー名",
        "steps": ["ステップ1", "ステップ2"]
      }
    ],
    "qualityRequirements": {
      "functionalSuitability": {
        "description": "機能適合性に関する要件",
        "criteria": ["主要ユースケースの全パスが正常に完了すること"]
      },
      "performanceEfficiency": {
        "description": "性能効率性に関する要件",
        "criteria": ["API応答は95パーセンタイルで2秒以内"]
      },
      "compatibility": {
        "description": "互換性に関する要件",
        "criteria": ["Chrome/Safari/Firefox最新版で動作"]
      },
      "usability": {
        "description": "使用性に関する要件",
        "criteria": ["初回ユーザーが説明なしで主要操作を完了できる"]
      },
      "reliability": {
        "description": "信頼性に関する要件",
        "criteria": ["月間稼働率99.5%以上"]
      },
      "security": {
        "description": "セキュリティに関する要件",
        "criteria": ["入力値はすべてサーバーサイドで検証"]
      },
      "maintainability": {
        "description": "保守性に関する要件",
        "criteria": ["主要モジュールのユニットテストカバレッジ80%以上"]
      },
      "portability": {
        "description": "移植性に関する要件",
        "criteria": ["Docker Composeで環境を再現可能"]
      }
    },
    "metrics": [
      {
        "name": "指標名",
        "definition": "計測方法",
        "target": "目標値"
      }
    ]
  }
}

ルール：
- 抽象語は禁止（「改善する」「最適化する」などNG）
- テスト可能な条件のみ記述
- MVP スコープに圧縮（コア機能は最大5つ）
- 各機能に受け入れ基準を必ず付ける
- 各機能にエッジケース（異常入力、境界値、同時操作、権限不足、ネットワーク断など）を必ず列挙する
- qualityRequirements は ISO/IEC 25010 の8品質特性すべてを網羅し、テーマに合った具体的な基準を書く
  1. functionalSuitability（機能適合性）: 機能完全性、正確性、適切性
  2. performanceEfficiency（性能効率性）: 時間効率性、資源効率性、容量
  3. compatibility（互換性）: 共存性、相互運用性
  4. usability（使用性）: 認識性、習得性、操作性、エラー防止、UI美観、アクセシビリティ
  5. reliability（信頼性）: 成熟性、可用性、障害許容性、回復性
  6. security（セキュリティ）: 機密性、完全性、否認防止、責任追跡性、真正性
  7. maintainability（保守性）: モジュール性、再利用性、解析性、修正性、試験性
  8. portability（移植性）: 適応性、設置性、置換性

実装制約（CRITICAL — この PRD を実装するエージェントへの必須指示）:
- 各機能の acceptanceCriteria には「データ経路が実物（本物の DB/API 接続）であること」を含める
- モックデータ、ハードコードされた配列、スタブ API での実装は完了とみなさない
- 「UI が表示される」だけでは受け入れ基準を満たさない。バックエンドからの実データ取得・保存が動作して初めて完了
- バックエンド未完成の場合、先にバックエンド側の最小実装（仮でも本物の I/O）を作ること
- 未実装部分は UI 上で明示的に「未実装」と表示し、モックで補完してはならない`;

// Spec prompt — identical to analysis.ts
const SPEC_SYSTEM = `You are a tech lead. Generate an implementation spec for a coding agent from the PRD.

IMPORTANT: Respond in the SAME LANGUAGE as the input PRD. If it is in Japanese, write in Japanese. If in English, write in English. If in Spanish, write in Spanish.

必ず以下のJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "spec": {
    "projectName": "プロジェクト名",
    "techStack": {
      "frontend": "技術スタック",
      "backend": "技術スタック",
      "database": "データベース"
    },
    "apiEndpoints": [
      {
        "method": "GET",
        "path": "/api/xxx",
        "description": "説明",
        "request": {},
        "response": {}
      }
    ],
    "dbSchema": "CREATE TABLE ...",
    "screens": [
      {
        "name": "画面名",
        "path": "/path",
        "components": ["コンポーネント1"],
        "description": "画面の説明"
      }
    ],
    "testCases": [
      {
        "category": "カテゴリ",
        "cases": [
          {
            "name": "テスト名",
            "given": "前提条件",
            "when": "操作",
            "then": "期待結果"
          }
        ]
      }
    ]
  }
}

ルール：
- 具体的なAPI仕様（メソッド、パス、リクエスト/レスポンス形式）
- 具体的なDBスキーマ（CREATE TABLE文）
- 画面一覧と主要コンポーネント
- テストケース（Given-When-Then形式）
- コーディングエージェントがそのまま実装に着手できるレベルの具体性

実装制約（CRITICAL — コーディングエージェントへの必須ルール）：
- モックデータ、ハードコードされた配列、スタブ API での実装は禁止。すべてのデータは実際の DB/API から取得・保存すること
- 「見た目が動く」を完成扱いにしない。データ経路が実物であることが完了条件
- バックエンド API が未実装の場合、UI より先にバックエンドの最小実装を作ること
- 未実装の機能は UI 上で「未実装」と明示表示し、モックで補完してはならない
- テストケースの then（期待結果）には「DB にレコードが保存される」「API から実データが返る」等のデータ経路検証を含めること`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildTranscript(sessionId: string): Promise<string> {
  const messages = await db
    .selectFrom("messages")
    .select(["role", "content"])
    .where("session_id", "=", sessionId)
    .orderBy("created_at")
    .execute();
  return messages.map((m) => `${m.role === "user" ? "回答者" : "インタビュアー"}: ${m.content}`).join("\n\n");
}

function parseJSON(text: string, fallback: unknown): unknown {
  try {
    // Strip markdown code fences (```json ... ```)
    const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "");
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Pipeline endpoint
// ---------------------------------------------------------------------------

pipelineRoutes.post("/sessions/:id/pipeline", async (c) => {
  // Ownership check
  const result = await getOwnedSession(c);
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
      const row = await db.selectFrom("users").select("plan").where("id", "=", user.id).executeTakeFirst();
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
        // --- Stage 1: Analysis (facts + hypotheses in one call) ---
        send("stage", { stage: "facts", status: "running" });
        const transcript = await buildTranscript(id);
        const analysisResp = await callClaude(
          [{ role: "user", content: `以下のインタビュー記録を分析してください：\n\n${transcript}` }],
          ANALYSIS_SYSTEM,
          4096,
        );
        const analysisText = extractText(analysisResp);
        const analysis = parseJSON(analysisText, {
          facts: [{ id: "F1", type: "fact", content: analysisText, evidence: "", severity: "medium" }],
          hypotheses: [
            {
              id: "H1",
              title: "parse error",
              description: analysisText,
              supportingFacts: [],
              counterEvidence: "",
              unverifiedPoints: [],
            },
          ],
          // biome-ignore lint/suspicious/noExplicitAny: dynamic LLM JSON output
        }) as any;

        const facts = { facts: analysis.facts || [] };
        const hypotheses = { hypotheses: analysis.hypotheses || [] };

        // Save facts
        await saveAnalysisResult(id, ANALYSIS_TYPE.FACTS, facts);
        await db
          .updateTable("sessions")
          .set({ status: SESSION_STATUS.ANALYZED, updated_at: now() })
          .where("id", "=", id)
          .execute();
        send("stage", { stage: "facts", status: "done", data: facts });

        // Save hypotheses
        await saveAnalysisResult(id, ANALYSIS_TYPE.HYPOTHESES, hypotheses);
        await db
          .updateTable("sessions")
          .set({ status: SESSION_STATUS.HYPOTHESIZED, updated_at: now() })
          .where("id", "=", id)
          .execute();
        send("stage", { stage: "hypotheses", status: "done", data: hypotheses });

        // --- Stage 2: PRD ---
        send("stage", { stage: "prd", status: "running" });
        const prdResp = await callClaude(
          [
            {
              role: "user",
              content: `以下のファクトと仮説からPRDを生成してください：\n\nテーマ: ${session.theme}\n\nファクト:\n${JSON.stringify(facts, null, 2)}\n\n仮説:\n${JSON.stringify(hypotheses, null, 2)}`,
            },
          ],
          PRD_SYSTEM,
          8192,
        );
        const prdText = extractText(prdResp);
        // biome-ignore lint/suspicious/noExplicitAny: dynamic LLM JSON output
        const prd = parseJSON(prdText, {
          prd: {
            problemDefinition: prdText,
            targetUser: "",
            jobsToBeDone: [],
            coreFeatures: [],
            nonGoals: [],
            userFlows: [],
            metrics: [],
          },
        }) as any;

        await saveAnalysisResult(id, ANALYSIS_TYPE.PRD, prd);
        await db
          .updateTable("sessions")
          .set({ status: SESSION_STATUS.PRD_GENERATED, updated_at: now() })
          .where("id", "=", id)
          .execute();
        send("stage", { stage: "prd", status: "done", data: prd });

        // --- Stage 3: Spec ---
        send("stage", { stage: "spec", status: "running" });
        const specResp = await callClaude(
          [
            {
              role: "user",
              content: `以下のPRDから実装仕様を生成してください：\n\n${JSON.stringify(prd, null, 2)}`,
            },
          ],
          SPEC_SYSTEM,
          8192,
        );
        const specText = extractText(specResp);
        // biome-ignore lint/suspicious/noExplicitAny: dynamic LLM JSON output
        let spec = parseJSON(specText, { spec: { raw: specText } }) as any;

        // Generate PRD markdown
        const prdData = prd.prd || prd;
        const prdMarkdown = generatePRDMarkdown(prdData, session.theme);
        if (spec.spec) {
          spec.spec.prdMarkdown = prdMarkdown;
        } else {
          spec = { spec: { ...spec, prdMarkdown } };
        }

        await saveAnalysisResult(id, ANALYSIS_TYPE.SPEC, spec);
        await db
          .updateTable("sessions")
          .set({ status: SESSION_STATUS.SPEC_GENERATED, updated_at: now() })
          .where("id", "=", id)
          .execute();
        send("stage", { stage: "spec", status: "done", data: spec });

        send("done", {});
        // biome-ignore lint/suspicious/noExplicitAny: error handling
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
