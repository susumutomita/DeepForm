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
import { ANALYSIS_TYPE, READINESS_SYSTEM, requiresProForStep, SESSION_STATUS } from "../../constants.ts";
import { now } from "../../db/helpers.ts";
import { db } from "../../db/index.ts";
import { saveAnalysisResult } from "../../helpers/analysis-store.ts";
import { generatePRDMarkdown } from "../../helpers/format.ts";
import { getOwnedSession, isResponse } from "../../helpers/session-ownership.ts";
import { callClaudeStream, MODEL_FAST, MODEL_SMART } from "../../llm.ts";
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
const PRD_SYSTEM = `You are a senior product manager. Generate a COMPACT PRD (Product Requirements Document) from the facts and hypotheses.

IMPORTANT: Respond in the SAME LANGUAGE as the input facts/hypotheses. If they are in Japanese, write the PRD in Japanese. If in English, write in English. If in Spanish, write in Spanish.

CRITICAL: Keep the output COMPACT. The total JSON must be under 6000 tokens. Be concise but specific.

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
    ],
    "apiIntegration": {
      "endpoints": [
        {
          "method": "GET|POST|PUT|DELETE",
          "path": "/api/resource",
          "description": "外部から呼び出せるAPIエンドポイントの説明",
          "auth": "APIキー認証 or OAuth2",
          "requestBody": "リクエスト形式（該当する場合）",
          "response": "レスポンス形式"
        }
      ],
      "webhooks": [
        {
          "event": "イベント名（例: resource.created）",
          "payload": "通知ペイロードの概要",
          "description": "外部サービスに通知するイベント"
        }
      ],
      "externalServices": ["連携可能な外部サービス例"]
    }
  }
}

ルール：
- 抽象語は禁止（「改善する」「最適化する」などNG）
- テスト可能な条件のみ記述
- MVP スコープに圧縮（コア機能は最大5つ）
- API連携は必須：すべてのプロダクトは外部から呼び出せるREST APIエンドポイントを必ず含むこと。他のサービスからデータを取得・操作できるAPIと、外部にイベントを通知するwebhookを設計に含める。これにより単体で完結せず、他のプロダクトと連携してエコシステムを構成できる設計にする
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
const SPEC_SYSTEM = `You are a tech lead. Generate a COMPACT implementation spec as Markdown for a coding agent.

IMPORTANT: Respond in the SAME LANGUAGE as the input PRD.

OUTPUT FORMAT: Return ONLY a JSON object with one field:
{"spec":{"raw":"<markdown text>"}}

The markdown inside "raw" MUST follow this exact template (fill in the blanks, keep it short):

# {Project Name} — Implementation Spec

## Tech Stack
- Frontend: {e.g. React + TypeScript + Vite}
- Backend: {e.g. Node.js + Hono + TypeScript}
- Database: {e.g. SQLite}

## API Endpoints (top 5 only)
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/xxx | 1-line desc |

## Database Schema
\`\`\`sql
CREATE TABLE xxx (...);
\`\`\`
Max 4 tables. Minimal columns.

## Screens (max 4)
| Screen | Path | Description |
|--------|------|-------------|
| Home | / | 1-line desc |

## Key Test Cases (max 5)
| Test | Given | When | Then |
|------|-------|------|------|
| Name | Setup | Action | Expected |

## Implementation Constraints
- Real DB/API connections only. No mock data, no hardcoded arrays.
- Backend-first: implement API before UI.
- Show "Not implemented" for unfinished features.
- All API endpoints must be callable by external services (API-first design).

SIZE RULES (HARD LIMITS):
- Total output MUST be under 2000 tokens.
- Max 5 API endpoints, 4 tables, 4 screens, 5 test cases.
- 1-line descriptions only. No paragraphs.
- No request/response type details in API table.
- No indexes, triggers, or constraints in SQL beyond PRIMARY KEY and NOT NULL.`;

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

/**
 * Stream an LLM call, forwarding text chunks as SSE events, and resolve with
 * the full accumulated text when the stream ends.
 */
function streamLLM(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  system: string,
  maxTokens: number,
  model: string,
  stage: string,
  send: (event: string, data: unknown) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stream, getFullText } = callClaudeStream(messages, system, maxTokens, model);
    stream.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      send("stream", { stage, text });
    });
    stream.on("end", () => resolve(getFullText()));
    stream.on("error", (err: Error) => reject(err));
  });
}

/**
 * Get campaign facts by their triage IDs (format: "sessionId:index").
 */
async function getCampaignFactsByIds(
  campaignId: string,
  selectedIds: string[],
): Promise<Array<{ type: string; content: string; respondentName: string }>> {
  const respondentSessions = (await db
    .selectFrom("sessions as s")
    .leftJoin("analysis_results as ar", (join) => join.onRef("ar.session_id", "=", "s.id").on("ar.type", "=", "facts"))
    .select(["s.id", "s.respondent_name", "ar.data as facts_data"])
    .where("s.campaign_id", "=", campaignId)
    .where("s.status", "=", SESSION_STATUS.RESPONDENT_DONE)
    .execute()) as unknown as {
    id: string;
    respondent_name: string | null;
    facts_data: string | null;
  }[];

  const result: Array<{ type: string; content: string; respondentName: string }> = [];
  for (const s of respondentSessions) {
    if (!s.facts_data) continue;
    const parsed = JSON.parse(s.facts_data);
    const factList = (parsed.facts || parsed) as Array<Record<string, unknown>>;
    for (let i = 0; i < factList.length; i++) {
      const factId = `${s.id}:${i}`;
      if (selectedIds.includes(factId)) {
        result.push({
          type: (factList[i].type as string) || "fact",
          content: (factList[i].content as string) || "",
          respondentName: s.respondent_name || "匿名",
        });
      }
    }
  }
  return result;
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
        const analysisText = await streamLLM(
          [{ role: "user", content: `以下のインタビュー記録を分析してください：\n\n${transcript}` }],
          ANALYSIS_SYSTEM,
          4096,
          MODEL_FAST,
          "analysis",
          send,
        );
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

        // --- Stage 2: PRD (uses MODEL_SMART / Opus for quality) ---
        send("stage", { stage: "prd", status: "running" });

        // Inject campaign triage facts if available
        let campaignFactsSection = "";
        const triageRow = (await db
          .selectFrom("analysis_results")
          .select("data")
          .where("session_id", "=", id)
          .where("type", "=", ANALYSIS_TYPE.CAMPAIGN_TRIAGE)
          .executeTakeFirst()) as unknown as { data: string } | undefined;
        if (triageRow) {
          // biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
          const triage = JSON.parse(triageRow.data) as any;
          const selectedIds: string[] = triage.selectedFactIds || [];
          if (selectedIds.length > 0) {
            const campaign = (await db
              .selectFrom("campaigns")
              .select("id")
              .where("owner_session_id", "=", id)
              .executeTakeFirst()) as unknown as { id: string } | undefined;
            if (campaign) {
              const campaignFacts = await getCampaignFactsByIds(campaign.id, selectedIds);
              if (campaignFacts.length > 0) {
                campaignFactsSection = `\n\n## Campaign Feedback (from ${campaignFacts.length} selected facts)\n${campaignFacts.map((f) => `- [${f.type}] ${f.content} (${f.respondentName})`).join("\n")}`;
              }
            }
          }
        }

        const prdText = await streamLLM(
          [
            {
              role: "user",
              content: `以下のファクトと仮説からPRDを生成してください：\n\nテーマ: ${session.theme}\n\nファクト:\n${JSON.stringify(facts, null, 2)}\n\n仮説:\n${JSON.stringify(hypotheses, null, 2)}${campaignFactsSection}`,
            },
          ],
          PRD_SYSTEM,
          8192,
          MODEL_SMART,
          "prd",
          send,
        );
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
          // biome-ignore lint/suspicious/noExplicitAny: dynamic LLM JSON output
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
        const specText = await streamLLM(
          [
            {
              role: "user",
              content: `以下のPRDから実装仕様を生成してください：\n\n${JSON.stringify(prd, null, 2)}`,
            },
          ],
          SPEC_SYSTEM,
          4096,
          MODEL_FAST,
          "spec",
          send,
        );
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

// ---------------------------------------------------------------------------
// POST /sessions/:id/readiness-stream — SSE streaming readiness check
// ---------------------------------------------------------------------------
pipelineRoutes.post("/sessions/:id/readiness-stream", async (c) => {
  // Pro gate
  if (requiresProForStep("readiness")) {
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
  }

  const result = await getOwnedSession(c);
  if (isResponse(result)) return result;
  const session = result as Session;
  const id = session.id;

  const specRow = await db
    .selectFrom("analysis_results")
    .select("data")
    .where("session_id", "=", id)
    .where("type", "=", ANALYSIS_TYPE.SPEC)
    .executeTakeFirst();
  if (!specRow) return c.json({ error: "先に実装仕様の生成を実行してください" }, 400);

  const spec = JSON.parse(specRow.data);
  const prdRow = await db
    .selectFrom("analysis_results")
    .select("data")
    .where("session_id", "=", id)
    .where("type", "=", ANALYSIS_TYPE.PRD)
    .executeTakeFirst();
  const prd = prdRow ? JSON.parse(prdRow.data) : {};

  const sseStream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        send("stage", { stage: "readiness", status: "running" });
        const readinessText = await streamLLM(
          [
            {
              role: "user",
              content: `以下のPRDと実装仕様に基づいてプロダクションレディネスチェックリストを生成してください：\n\nPRD:\n${JSON.stringify(prd, null, 2)}\n\n実装仕様:\n${JSON.stringify(spec, null, 2)}`,
            },
          ],
          READINESS_SYSTEM,
          8192,
          MODEL_SMART,
          "readiness",
          send,
        );

        let readiness: unknown = parseJSON(readinessText, null);
        if (!readiness) {
          readiness = {
            readiness: {
              categories: [
                {
                  id: "functionalSuitability",
                  label: "機能適合性",
                  items: [{ id: "FS-1", description: readinessText, priority: "must", rationale: "" }],
                },
              ],
            },
          };
        }

        await saveAnalysisResult(id, ANALYSIS_TYPE.READINESS, readiness);
        await db
          .updateTable("sessions")
          .set({ status: SESSION_STATUS.READINESS_CHECKED, updated_at: now() })
          .where("id", "=", id)
          .execute();

        send("stage", { stage: "readiness", status: "done", data: readiness });
        send("done", {});
        // biome-ignore lint/suspicious/noExplicitAny: error handling
      } catch (e: any) {
        console.error("Readiness stream error:", e);
        send("error", { error: e.message || "Internal Server Error" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
