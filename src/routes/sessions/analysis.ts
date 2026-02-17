import crypto from "node:crypto";
import type { Context } from "hono";
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

/**
 * Pro ゲートチェック。requiresProForStep() が true の場合のみ課金壁を適用する。
 * PRO_GATE 環境変数で制御: "none"(default) | "prd" | "spec" | "readiness" | "analyze" | "hypotheses"
 */
// biome-ignore lint/suspicious/noExplicitAny: Hono の Context 型パラメータ制約
async function requireProForStep(c: Context<AppEnv, any>, step: string): Promise<Response | null> {
  if (!requiresProForStep(step)) return null;

  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Login required for this feature", upgrade: true }, 401);
  }

  const row = await db.selectFrom("users").select("plan").where("id", "=", user.id).executeTakeFirst();
  if (row?.plan !== "pro") {
    return c.json(
      {
        error: "Pro plan required",
        upgrade: true,
        upgradeUrl: `${PAYMENT_LINK}?client_reference_id=${user.id}`,
      },
      402,
    );
  }
  return null;
}

export const analysisRoutes = new Hono<AppEnv>();

// 7. POST /sessions/:id/analyze — Extract facts from transcript (owner only)
analysisRoutes.post("/sessions/:id/analyze", async (c) => {
  try {
    const blocked = await requireProForStep(c, "analyze");
    if (blocked) return blocked;
    const result = await getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;

    const messages = await db
      .selectFrom("messages")
      .select(["role", "content"])
      .where("session_id", "=", id)
      .orderBy("created_at")
      .execute();
    const transcript = messages
      .map((m) => `${m.role === "user" ? "回答者" : "インタビュアー"}: ${m.content}`)
      .join("\n\n");

    const systemPrompt = `You are a qualitative research analysis expert. Extract facts from the depth interview transcript below.

IMPORTANT: Respond in the SAME LANGUAGE as the interview transcript.

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
  ]
}

typeは "fact"（事実）, "pain"（困りごと）, "frequency"（頻度）, "workaround"（回避策）のいずれか。
severityは "high", "medium", "low" のいずれか。

抽象的な表現は避け、具体的な事実のみ抽出してください。最低5つ、最大15個のファクトを抽出してください。`;

    const response = await callClaude(
      [{ role: "user", content: `以下のインタビュー記録を分析してください：\n\n${transcript}` }],
      systemPrompt,
      4096,
    );
    const text = extractText(response);

    let facts: unknown;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      facts = JSON.parse(jsonMatch?.[0] as string);
    } catch {
      facts = { facts: [{ id: "F1", type: "fact", content: text, evidence: "", severity: "medium" }] };
    }

    // Save analysis
    await saveAnalysisResult(id, ANALYSIS_TYPE.FACTS, facts);

    await db
      .updateTable("sessions")
      .set({ status: SESSION_STATUS.ANALYZED, updated_at: now() })
      .where("id", "=", id)
      .execute();
    return c.json(facts);
  } catch (e) {
    console.error("Analyze error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 8. POST /sessions/:id/hypotheses — Generate hypotheses from facts (owner only)
analysisRoutes.post("/sessions/:id/hypotheses", async (c) => {
  try {
    const blocked = await requireProForStep(c, "hypotheses");
    if (blocked) return blocked;
    const result = await getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;

    const factsRow = await db
      .selectFrom("analysis_results")
      .select("data")
      .where("session_id", "=", id)
      .where("type", "=", ANALYSIS_TYPE.FACTS)
      .executeTakeFirst();
    if (!factsRow) return c.json({ error: "ファクト抽出を先に実行してください" }, 400);

    const facts = JSON.parse(factsRow.data);

    const systemPrompt = `You are a hypothesis generation expert. Generate hypotheses from the extracted facts.

IMPORTANT: Respond in the SAME LANGUAGE as the input facts.

必ず以下のJSON形式で返してください。JSON以外のテキストは含めないでください。

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

3つの仮説を生成してください。各仮説に：
- 根拠となるファクトID
- 反証パターン
- 未検証ポイント
を必ず含めてください。`;

    const response = await callClaude(
      [{ role: "user", content: `以下のファクトから仮説を生成してください：\n\n${JSON.stringify(facts, null, 2)}` }],
      systemPrompt,
      4096,
    );
    const text = extractText(response);

    let hypotheses: unknown;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      hypotheses = JSON.parse(jsonMatch?.[0] as string);
    } catch {
      hypotheses = {
        hypotheses: [
          { id: "H1", title: text, description: "", supportingFacts: [], counterEvidence: "", unverifiedPoints: [] },
        ],
      };
    }

    await saveAnalysisResult(id, ANALYSIS_TYPE.HYPOTHESES, hypotheses);

    await db
      .updateTable("sessions")
      .set({ status: SESSION_STATUS.HYPOTHESIZED, updated_at: now() })
      .where("id", "=", id)
      .execute();
    return c.json(hypotheses);
  } catch (e) {
    console.error("Hypotheses error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 9. POST /sessions/:id/prd — Generate PRD from facts & hypotheses (owner only)
analysisRoutes.post("/sessions/:id/prd", async (c) => {
  try {
    const blocked = await requireProForStep(c, "prd");
    if (blocked) return blocked;
    const result = await getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;

    const factsRow = await db
      .selectFrom("analysis_results")
      .select("data")
      .where("session_id", "=", id)
      .where("type", "=", ANALYSIS_TYPE.FACTS)
      .executeTakeFirst();
    const hypothesesRow = await db
      .selectFrom("analysis_results")
      .select("data")
      .where("session_id", "=", id)
      .where("type", "=", ANALYSIS_TYPE.HYPOTHESES)
      .executeTakeFirst();
    if (!factsRow || !hypothesesRow) return c.json({ error: "先にファクト抽出と仮説生成を実行してください" }, 400);

    const facts = JSON.parse(factsRow.data);
    const hypotheses = JSON.parse(hypothesesRow.data);

    const systemPrompt = `You are a senior product manager. Generate a PRD from the facts and hypotheses.

IMPORTANT: Respond in the SAME LANGUAGE as the input data.

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

    const response = await callClaude(
      [
        {
          role: "user",
          content: `以下のファクトと仮説からPRDを生成してください：\n\nテーマ: ${session.theme}\n\nファクト:\n${JSON.stringify(facts, null, 2)}\n\n仮説:\n${JSON.stringify(hypotheses, null, 2)}`,
        },
      ],
      systemPrompt,
      8192,
    );
    const text = extractText(response);

    let prd: any;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      prd = JSON.parse(jsonMatch?.[0] as string);
    } catch {
      prd = {
        prd: {
          problemDefinition: text,
          targetUser: "",
          jobsToBeDone: [],
          coreFeatures: [],
          nonGoals: [],
          userFlows: [],
          metrics: [],
        },
      };
    }

    await saveAnalysisResult(id, ANALYSIS_TYPE.PRD, prd);

    await db
      .updateTable("sessions")
      .set({ status: SESSION_STATUS.PRD_GENERATED, updated_at: now() })
      .where("id", "=", id)
      .execute();
    return c.json(prd);
  } catch (e) {
    console.error("PRD error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 10. POST /sessions/:id/spec — Generate spec from PRD (owner only)
analysisRoutes.post("/sessions/:id/spec", async (c) => {
  try {
    const blocked = await requireProForStep(c, "spec");
    if (blocked) return blocked;
    const result = await getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;

    const prdRow = await db
      .selectFrom("analysis_results")
      .select("data")
      .where("session_id", "=", id)
      .where("type", "=", ANALYSIS_TYPE.PRD)
      .executeTakeFirst();
    if (!prdRow) return c.json({ error: "先にPRD生成を実行してください" }, 400);

    const prd = JSON.parse(prdRow.data);

    const systemPrompt = `You are a tech lead. Generate a COMPACT implementation spec as Markdown for a coding agent.

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
- Real DB/API connections only. No mock data.
- Backend-first: implement API before UI.
- Show "Not implemented" for unfinished features.
- All API endpoints must be callable by external services (API-first design).

SIZE RULES (HARD LIMITS):
- Total output MUST be under 2000 tokens.
- Max 5 API endpoints, 4 tables, 4 screens, 5 test cases.
- 1-line descriptions only. No paragraphs.`;

    const response = await callClaude(
      [{ role: "user", content: `以下のPRDから実装仕様を生成してください：\n\n${JSON.stringify(prd, null, 2)}` }],
      systemPrompt,
      4096,
    );
    const text = extractText(response);

    let spec: any;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      spec = JSON.parse(jsonMatch?.[0] as string);
    } catch {
      spec = { spec: { raw: text } };
    }

    // Also generate PRD markdown
    const prdData = prd.prd || prd;
    const prdMarkdown = generatePRDMarkdown(prdData, session.theme);
    spec.prdMarkdown = prdMarkdown;

    await saveAnalysisResult(id, ANALYSIS_TYPE.SPEC, spec);

    await db
      .updateTable("sessions")
      .set({ status: SESSION_STATUS.SPEC_GENERATED, updated_at: now() })
      .where("id", "=", id)
      .execute();
    return c.json(spec);
  } catch (e) {
    console.error("Spec error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 10b. POST /sessions/:id/readiness — Generate production readiness checklist (owner only)
analysisRoutes.post("/sessions/:id/readiness", async (c) => {
  try {
    const blocked = await requireProForStep(c, "readiness");
    if (blocked) return blocked;
    const result = await getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
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

    const systemPrompt = `You are a production quality review expert. Generate a pre-launch readiness checklist based on ISO/IEC 25010 quality characteristics from the PRD and implementation spec.

IMPORTANT: Respond in the SAME LANGUAGE as the input data.

必ず以下のJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "readiness": {
    "categories": [
      {
        "id": "functionalSuitability",
        "label": "機能適合性",
        "items": [
          {
            "id": "FS-1",
            "description": "チェック項目の説明",
            "priority": "must",
            "rationale": "なぜこのチェックが必要か"
          }
        ]
      }
    ]
  }
}

ルール：
- ISO/IEC 25010 の8品質特性すべてを網羅すること:
  1. functionalSuitability（機能適合性）
  2. performanceEfficiency（性能効率性）
  3. compatibility（互換性）
  4. usability（使用性）
  5. reliability（信頼性）
  6. security（セキュリティ）
  7. maintainability（保守性）
  8. portability（移植性）
- 各カテゴリに2〜4個の具体的なチェック項目を生成
- priority は "must"（必須）, "should"（推奨）, "could"（任意）のいずれか
- PRDの非機能要件と実装仕様に基づいた具体的な項目にすること
- 抽象的な表現は避け、テスト可能な条件を記述すること`;

    const response = await callClaude(
      [
        {
          role: "user",
          content: `以下のPRDと実装仕様に基づいてプロダクションレディネスチェックリストを生成してください：\n\nPRD:\n${JSON.stringify(prd, null, 2)}\n\n実装仕様:\n${JSON.stringify(spec, null, 2)}`,
        },
      ],
      systemPrompt,
      8192,
    );
    const text = extractText(response);

    let readiness: unknown;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      readiness = JSON.parse(jsonMatch?.[0] as string);
    } catch {
      readiness = {
        readiness: {
          categories: [
            {
              id: "functionalSuitability",
              label: "機能適合性",
              items: [{ id: "FS-1", description: text, priority: "must", rationale: "" }],
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
    return c.json(readiness);
  } catch (e) {
    console.error("Readiness error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// GET /sessions/:id/deploy-bundle — Public endpoint for exe.dev Shelley to fetch spec + PRD
analysisRoutes.get("/sessions/:id/deploy-bundle", async (c) => {
  try {
    const id = c.req.param("id");
    const token = c.req.query("token");
    const session = (await db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst()) as unknown as
      | Session
      | undefined;
    if (!session) return c.json({ error: "Not found" }, 404);

    // Verify deploy token or allow public sessions
    if (!session.is_public && session.deploy_token !== token) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const specResult = (await db
      .selectFrom("analysis_results")
      .select("data")
      .where("session_id", "=", id)
      .where("type", "=", "spec")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst()) as { data: string } | undefined;
    const prdResult = (await db
      .selectFrom("analysis_results")
      .select("data")
      .where("session_id", "=", id)
      .where("type", "=", "prd")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst()) as { data: string } | undefined;

    const format = c.req.query("format");
    if (format === "text") {
      let text = `# DeepForm Deploy Bundle\n# Theme: ${session.theme}\n\n`;
      if (specResult) text += `## spec.json\n\n${specResult.data}\n\n`;
      if (prdResult) text += `## PRD\n\n${prdResult.data}\n`;
      return c.text(text);
    }

    return c.json({
      theme: session.theme,
      spec: specResult ? JSON.parse(specResult.data) : null,
      prd: prdResult ? JSON.parse(prdResult.data) : null,
    });
  } catch (e) {
    console.error("Deploy bundle error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// POST /sessions/:id/deploy-token — Generate a deploy token for the session
analysisRoutes.post("/sessions/:id/deploy-token", async (c) => {
  try {
    const id = c.req.param("id");
    const session = (await db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst()) as unknown as
      | Session
      | undefined;
    if (!session) return c.json({ error: "Not found" }, 404);

    const token = crypto.randomUUID();
    await db.updateTable("sessions").set({ deploy_token: token }).where("id", "=", id).execute();

    const baseUrl = process.env.BASE_URL || "https://deepform.exe.xyz:8000";
    const deployUrl = `${baseUrl}/api/sessions/${id}/deploy-bundle?token=${token}&format=text`;

    // Extract projectName from spec if available
    let projectName = "";
    const specResult = (await db
      .selectFrom("analysis_results")
      .select("data")
      .where("session_id", "=", id)
      .where("type", "=", "spec")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst()) as { data: string } | undefined;
    if (specResult) {
      try {
        const parsed = JSON.parse(specResult.data);
        // Try direct access first, then parse from raw markdown code block
        projectName = parsed?.spec?.projectName || parsed?.projectName || "";
        if (!projectName && parsed?.spec?.raw) {
          const rawMatch = parsed.spec.raw.match(/"projectName"\s*:\s*"([^"]+)"/);
          if (rawMatch) projectName = rawMatch[1];
        }
      } catch {}
    }

    return c.json({ deployUrl, theme: session.theme, projectName });
  } catch (e) {
    console.error("Deploy token error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// GET /sessions/:id/spec-export — Return formatted spec.json for external tools
analysisRoutes.get("/sessions/:id/spec-export", async (c) => {
  try {
    const id = c.req.param("id");
    const user = c.get("user");
    const session = (await db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst()) as unknown as
      | Session
      | undefined;
    if (!session) return c.json({ error: "Session not found" }, 404);

    // Access control: owner or public
    const isOwner = user && session.user_id === user.id;
    const isPublic = session.is_public === 1;
    if (!isOwner && !isPublic) return c.json({ error: "アクセス権限がありません" }, 403);

    const specRow = await db
      .selectFrom("analysis_results")
      .select("data")
      .where("session_id", "=", id)
      .where("type", "=", ANALYSIS_TYPE.SPEC)
      .executeTakeFirst();
    if (!specRow) return c.json({ error: "Spec が未生成です。先に実装仕様を生成してください" }, 400);

    const spec = JSON.parse(specRow.data);
    return c.json({
      theme: session.theme,
      spec: spec.spec || spec,
      prdMarkdown: spec.prdMarkdown || null,
      exportedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("Spec export error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
