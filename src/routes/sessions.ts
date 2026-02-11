import crypto from "node:crypto";
import { type Context, Hono } from "hono";
import { ZodError } from "zod";
import { db } from "../db.ts";
import { callClaude, callClaudeStream, extractText } from "../llm.ts";
import type { AnalysisResult, Campaign, CampaignAnalytics, Message, Session, User } from "../types.ts";
import {
  chatMessageSchema,
  createSessionSchema,
  feedbackSchema,
  respondentNameSchema,
  visibilitySchema,
} from "../validation.ts";

type AppEnv = { Variables: { user: User | null } };
const sessionRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Helper: format Zod validation errors
// ---------------------------------------------------------------------------

function formatZodError(error: ZodError): string {
  return error.issues.map((e) => e.message).join(", ");
}

// ---------------------------------------------------------------------------
// Helper: ownership check for session-specific endpoints
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getOwnedSession(c: Context<AppEnv, any>): Session | Response {
  const user = c.get("user");
  if (!user) return c.json({ error: "ログインが必要です" }, 401);
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(c.req.param("id")) as unknown as
    | Session
    | undefined;
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (session.user_id !== user.id) return c.json({ error: "アクセス権限がありません" }, 403);
  return session;
}

function isResponse(result: Session | Response): result is Response {
  return result instanceof Response;
}

// ---------------------------------------------------------------------------
// Helper: generate PRD markdown
// ---------------------------------------------------------------------------

function generatePRDMarkdown(prd: any, theme: string): string {
  const qrLabels: Record<string, string> = {
    functionalSuitability: "機能適合性",
    performanceEfficiency: "性能効率性",
    compatibility: "互換性",
    usability: "使用性",
    reliability: "信頼性",
    security: "セキュリティ",
    maintainability: "保守性",
    portability: "移植性",
  };
  const qrSection = prd.qualityRequirements
    ? Object.entries(qrLabels)
        .map(([key, label]) => {
          const item = prd.qualityRequirements[key];
          if (!item) return "";
          return `### ${label}\n${item.description || ""}\n${(item.criteria || []).map((c: string) => `- ${c}`).join("\n")}`;
        })
        .filter(Boolean)
        .join("\n\n")
    : "";

  return `# PRD: ${theme}

## 問題定義
${prd.problemDefinition || ""}

## 対象ユーザー
${prd.targetUser || ""}

## Jobs to be Done
${(prd.jobsToBeDone || []).map((j: string, i: number) => `${i + 1}. ${j}`).join("\n")}

## コア機能（MVP）
${(prd.coreFeatures || []).map((f: any) => `### ${f.name}\n${f.description}\n\n**優先度**: ${f.priority}\n\n**受け入れ基準**:\n${(f.acceptanceCriteria || []).map((a: string) => `- ${a}`).join("\n")}\n\n**エッジケース**:\n${(f.edgeCases || []).map((e: string) => `- ${e}`).join("\n")}`).join("\n\n")}

## Non-Goals（やらないこと）
${(prd.nonGoals || []).map((n: string) => `- ${n}`).join("\n")}

## ユーザーフロー
${(prd.userFlows || []).map((f: any) => `### ${f.name}\n${(f.steps || []).map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`).join("\n\n")}

## 非機能要件（ISO/IEC 25010）
${qrSection}

## 計測指標
| 指標 | 定義 | 目標 |
|------|------|------|
${(prd.metrics || []).map((m: any) => `| ${m.name} | ${m.definition} | ${m.target} |`).join("\n")}
`;
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

// 1. POST /sessions — Create session with theme (requires login)
// Session limit per user (configurable via env)
const MAX_SESSIONS_PER_USER = Number(process.env.MAX_SESSIONS_PER_USER) || 50;

sessionRoutes.post("/sessions", async (c) => {
  try {
    const user = c.get("user");
    if (!user) return c.json({ error: "ログインが必要です" }, 401);

    const body = await c.req.json();
    const { theme } = createSessionSchema.parse(body);

    // Enforce session limit per user
    const { count } = db.prepare("SELECT COUNT(*) as count FROM sessions WHERE user_id = ?").get(user.id) as {
      count: number;
    };
    if (count >= MAX_SESSIONS_PER_USER) {
      return c.json(
        { error: `セッション数の上限（${MAX_SESSIONS_PER_USER}件）に達しました。不要なセッションを削除してください。` },
        429,
      );
    }

    const id = crypto.randomUUID();
    db.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(id, theme.trim(), user.id);
    return c.json({ sessionId: id, theme: theme.trim() });
  } catch (e) {
    if (e instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Create session error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 2. GET /sessions — List sessions (own + public if logged in, public only otherwise)
sessionRoutes.get("/sessions", (c) => {
  try {
    const user = c.get("user");
    let sessions: (Session & { message_count: number; display_status?: string })[];
    if (user) {
      sessions = db
        .prepare(
          "SELECT s.*, COUNT(m.id) as message_count FROM sessions s LEFT JOIN messages m ON s.id = m.session_id WHERE s.user_id = ? OR s.is_public = 1 GROUP BY s.id ORDER BY s.updated_at DESC",
        )
        .all(user.id) as unknown as (Session & { message_count: number; display_status?: string })[];
    } else {
      sessions = db
        .prepare(
          "SELECT s.*, COUNT(m.id) as message_count FROM sessions s LEFT JOIN messages m ON s.id = m.session_id WHERE s.is_public = 1 GROUP BY s.id ORDER BY s.updated_at DESC",
        )
        .all() as unknown as (Session & { message_count: number; display_status?: string })[];
    }
    sessions.forEach((s) => {
      if (s.status === "respondent_done") s.display_status = "analyzed";
    });
    return c.json(sessions);
  } catch (e) {
    console.error("List sessions error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 3. GET /sessions/:id — Get session with messages & analysis (owner or public)
sessionRoutes.get("/sessions/:id", (c) => {
  try {
    const id = c.req.param("id");
    const user = c.get("user");
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as unknown as Session | undefined;
    if (!session) return c.json({ error: "Session not found" }, 404);

    // Access control: owner or public
    const isOwner = user && session.user_id === user.id;
    const isPublic = session.is_public === 1;
    if (!isOwner && !isPublic) return c.json({ error: "アクセス権限がありません" }, 403);

    const messages = db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at")
      .all(id) as unknown as Message[];
    const analyses = db
      .prepare("SELECT * FROM analysis_results WHERE session_id = ? ORDER BY created_at")
      .all(id) as unknown as AnalysisResult[];

    const analysisMap: Record<string, unknown> = {};
    for (const a of analyses) {
      analysisMap[a.type] = JSON.parse(a.data);
    }

    return c.json({ ...session, messages, analysis: analysisMap });
  } catch (e) {
    console.error("Get session error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 4. DELETE /sessions/:id — Delete session + related data (owner only)
sessionRoutes.delete("/sessions/:id", (c) => {
  try {
    const result = getOwnedSession(c);
    if (isResponse(result)) return result;

    const id = result.id;
    db.prepare("DELETE FROM analysis_results WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return c.json({ ok: true });
  } catch (e) {
    console.error("Delete session error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 4b. PATCH /sessions/:id/visibility — Toggle public/private (owner only)
sessionRoutes.patch("/sessions/:id/visibility", async (c) => {
  try {
    const result = getOwnedSession(c);
    if (isResponse(result)) return result;

    const body = await c.req.json();
    const { is_public } = visibilitySchema.parse(body);
    const value = is_public ? 1 : 0;
    db.prepare("UPDATE sessions SET is_public = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(value, result.id);

    const updated = db.prepare("SELECT * FROM sessions WHERE id = ?").get(result.id) as unknown as Session;
    return c.json(updated);
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Visibility toggle error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Interview Flow
// ---------------------------------------------------------------------------

// 5. POST /sessions/:id/start — Get first interview question from LLM (owner only)
sessionRoutes.post("/sessions/:id/start", async (c) => {
  try {
    const result = getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;

    const existingMessages = db
      .prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?")
      .get(id) as unknown as {
      count: number;
    };
    if (existingMessages.count > 0) {
      return c.json({ reply: "インタビューは既に開始されています。", alreadyStarted: true });
    }

    const systemPrompt = `あなたは熟練のデプスインタビュアーです。これからユーザーの課題テーマについて深掘りインタビューを開始します。

テーマ: 「${session.theme}」

最初の質問を1つだけ聞いてください。テーマについて、まず現状の状況を理解するための質問をしてください。
共感的で親しみやすいトーンで、日本語で話してください。200文字以内で。`;

    const startMessages = [
      { role: "user" as const, content: `テーマ「${session.theme}」についてインタビューを始めてください。` },
    ];

    // Streaming response
    const wantsStream = c.req.header("accept")?.includes("text/event-stream");

    if (wantsStream) {
      const { stream, getFullText } = callClaudeStream(startMessages, systemPrompt, 512);

      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            stream.on("data", (chunk: Buffer | string) => {
              const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text })}\n\n`));
            });
            stream.on("end", () => {
              const fullText = getFullText();
              db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
                id,
                "assistant",
                fullText,
              );
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
              controller.close();
            });
            stream.on("error", (err: Error) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`));
              controller.close();
            });
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        },
      );
    }

    // Non-streaming fallback
    const response = await callClaude(startMessages, systemPrompt, 512);
    const reply = extractText(response);

    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(id, "assistant", reply);

    return c.json({ reply });
  } catch (e) {
    console.error("Start interview error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 6. POST /sessions/:id/chat — Send message, get AI reply (owner only)
sessionRoutes.post("/sessions/:id/chat", async (c) => {
  try {
    const result = getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;
    const body = await c.req.json();
    const { message } = chatMessageSchema.parse(body);

    // Save user message
    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(id, "user", message);
    db.prepare("UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);

    // Build conversation history
    const allMessages = db
      .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at")
      .all(id) as unknown as { role: string; content: string }[];
    const chatMessages = allMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const turnCount = allMessages.filter((m) => m.role === "user").length;

    const systemPrompt = `あなたは熟練のデプスインタビュアーです。ユーザーの課題テーマについて深掘りインタビューを行います。

テーマ: 「${session.theme}」

ルール：
1. 一度に1つの質問だけ聞く
2. 具体的なエピソードを引き出す（「最近あった具体例を教えてください」）
3. 頻度・困り度・現在の回避策を必ず聞く
4. 抽象的な回答には「具体的には？」で掘り下げる
5. 共感を示しながら深掘りする
6. 日本語で回答する
7. 回答は簡潔に、200文字以内で

${turnCount >= 5 ? "十分な情報が集まりました。最後にまとめの質問をして、回答の最後に「[READY_FOR_ANALYSIS]」タグを付けてください。ただし、ユーザーがまだ話したそうなら続けてください。" : ""}`;

    // Streaming response
    const wantsStream = c.req.header("accept")?.includes("text/event-stream");

    if (wantsStream) {
      const { stream, getFullText } = callClaudeStream(chatMessages, systemPrompt, 1024);

      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            // Send turnCount metadata first
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "meta", turnCount })}\n\n`));

            stream.on("data", (chunk: Buffer | string) => {
              const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text })}\n\n`));
            });
            stream.on("end", () => {
              const fullText = getFullText();
              // Save to DB
              db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
                id,
                "assistant",
                fullText,
              );
              const readyForAnalysis = fullText.includes("[READY_FOR_ANALYSIS]") || turnCount >= 8;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "done", readyForAnalysis, turnCount })}\n\n`),
              );
              controller.close();
            });
            stream.on("error", (err: Error) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`));
              controller.close();
            });
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        },
      );
    }

    // Non-streaming fallback
    const response = await callClaude(chatMessages, systemPrompt, 1024);
    const reply = extractText(response);

    // Save assistant message
    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(id, "assistant", reply);

    const readyForAnalysis = reply.includes("[READY_FOR_ANALYSIS]") || turnCount >= 8;
    const cleanReply = reply.replace("[READY_FOR_ANALYSIS]", "").trim();

    return c.json({ reply: cleanReply, turnCount, readyForAnalysis });
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Chat error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 7. POST /sessions/:id/analyze — Extract facts from transcript (owner only)
sessionRoutes.post("/sessions/:id/analyze", async (c) => {
  try {
    const result = getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;

    const messages = db
      .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at")
      .all(id) as unknown as { role: string; content: string }[];
    const transcript = messages
      .map((m) => `${m.role === "user" ? "回答者" : "インタビュアー"}: ${m.content}`)
      .join("\n\n");

    const systemPrompt = `あなたは定性調査の分析エキスパートです。以下のデプスインタビュー記録からファクトを抽出してください。

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
      facts = JSON.parse(jsonMatch![0]);
    } catch {
      facts = { facts: [{ id: "F1", type: "fact", content: text, evidence: "", severity: "medium" }] };
    }

    // Save analysis
    const existing = db
      .prepare("SELECT id FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(id, "facts") as unknown as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?").run(
        JSON.stringify(facts),
        existing.id,
      );
    } else {
      db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
        id,
        "facts",
        JSON.stringify(facts),
      );
    }

    db.prepare("UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run("analyzed", id);
    return c.json(facts);
  } catch (e) {
    console.error("Analyze error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 8. POST /sessions/:id/hypotheses — Generate hypotheses from facts (owner only)
sessionRoutes.post("/sessions/:id/hypotheses", async (c) => {
  try {
    const result = getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;

    const factsRow = db
      .prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(id, "facts") as unknown as { data: string } | undefined;
    if (!factsRow) return c.json({ error: "ファクト抽出を先に実行してください" }, 400);

    const facts = JSON.parse(factsRow.data);

    const systemPrompt = `あなたはプロダクト仮説生成のエキスパートです。抽出されたファクトから仮説を生成してください。

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
      hypotheses = JSON.parse(jsonMatch![0]);
    } catch {
      hypotheses = {
        hypotheses: [
          { id: "H1", title: text, description: "", supportingFacts: [], counterEvidence: "", unverifiedPoints: [] },
        ],
      };
    }

    const existing = db
      .prepare("SELECT id FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(id, "hypotheses") as unknown as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?").run(
        JSON.stringify(hypotheses),
        existing.id,
      );
    } else {
      db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
        id,
        "hypotheses",
        JSON.stringify(hypotheses),
      );
    }

    db.prepare("UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run("hypothesized", id);
    return c.json(hypotheses);
  } catch (e) {
    console.error("Hypotheses error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 9. POST /sessions/:id/prd — Generate PRD from facts & hypotheses (owner only)
sessionRoutes.post("/sessions/:id/prd", async (c) => {
  try {
    const result = getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;

    const factsRow = db
      .prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(id, "facts") as unknown as { data: string } | undefined;
    const hypothesesRow = db
      .prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(id, "hypotheses") as unknown as { data: string } | undefined;
    if (!factsRow || !hypothesesRow) return c.json({ error: "先にファクト抽出と仮説生成を実行してください" }, 400);

    const facts = JSON.parse(factsRow.data);
    const hypotheses = JSON.parse(hypothesesRow.data);

    const systemPrompt = `あなたはシニアプロダクトマネージャーです。ファクトと仮説からPRD（プロダクト要件定義書）を生成してください。

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
  8. portability（移植性）: 適応性、設置性、置換性`;

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
      prd = JSON.parse(jsonMatch![0]);
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

    const existing = db
      .prepare("SELECT id FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(id, "prd") as unknown as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?").run(
        JSON.stringify(prd),
        existing.id,
      );
    } else {
      db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
        id,
        "prd",
        JSON.stringify(prd),
      );
    }

    db.prepare("UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run("prd_generated", id);
    return c.json(prd);
  } catch (e) {
    console.error("PRD error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 10. POST /sessions/:id/spec — Generate spec from PRD (owner only)
sessionRoutes.post("/sessions/:id/spec", async (c) => {
  try {
    const result = getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;

    const prdRow = db
      .prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(id, "prd") as unknown as { data: string } | undefined;
    if (!prdRow) return c.json({ error: "先にPRD生成を実行してください" }, 400);

    const prd = JSON.parse(prdRow.data);

    const systemPrompt = `あなたはテックリードです。PRDからコーディングエージェント向けの実装仕様を生成してください。

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
- コーディングエージェントがそのまま実装に着手できるレベルの具体性`;

    const response = await callClaude(
      [{ role: "user", content: `以下のPRDから実装仕様を生成してください：\n\n${JSON.stringify(prd, null, 2)}` }],
      systemPrompt,
      8192,
    );
    const text = extractText(response);

    let spec: any;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      spec = JSON.parse(jsonMatch![0]);
    } catch {
      spec = { spec: { raw: text } };
    }

    // Also generate PRD markdown
    const prdData = prd.prd || prd;
    const prdMarkdown = generatePRDMarkdown(prdData, session.theme);
    spec.prdMarkdown = prdMarkdown;

    const existing = db
      .prepare("SELECT id FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(id, "spec") as unknown as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?").run(
        JSON.stringify(spec),
        existing.id,
      );
    } else {
      db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
        id,
        "spec",
        JSON.stringify(spec),
      );
    }

    db.prepare("UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run("spec_generated", id);
    return c.json(spec);
  } catch (e) {
    console.error("Spec error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 10b. POST /sessions/:id/readiness — Generate production readiness checklist (owner only)
sessionRoutes.post("/sessions/:id/readiness", async (c) => {
  try {
    const result = getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;

    const specRow = db
      .prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(id, "spec") as unknown as { data: string } | undefined;
    if (!specRow) return c.json({ error: "先に実装仕様の生成を実行してください" }, 400);

    const spec = JSON.parse(specRow.data);
    const prdRow = db
      .prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(id, "prd") as unknown as { data: string } | undefined;
    const prd = prdRow ? JSON.parse(prdRow.data) : {};

    const systemPrompt = `あなたはプロダクション品質のレビューエキスパートです。PRDと実装仕様に基づいて、ISO/IEC 25010 の8品質特性に沿った本番リリース前チェックリストを生成してください。

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

    const existing = db
      .prepare("SELECT id FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(id, "readiness") as unknown as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?").run(
        JSON.stringify(readiness),
        existing.id,
      );
    } else {
      db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
        id,
        "readiness",
        JSON.stringify(readiness),
      );
    }

    db.prepare("UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      "readiness_checked",
      id,
    );
    return c.json(readiness);
  } catch (e) {
    console.error("Readiness error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Spec Export (for exe.dev integration)
// ---------------------------------------------------------------------------

// GET /sessions/:id/spec-export — Return formatted spec.json for external tools
sessionRoutes.get("/sessions/:id/spec-export", (c) => {
  try {
    const id = c.req.param("id");
    const user = c.get("user");
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as unknown as Session | undefined;
    if (!session) return c.json({ error: "Session not found" }, 404);

    // Access control: owner or public
    const isOwner = user && session.user_id === user.id;
    const isPublic = session.is_public === 1;
    if (!isOwner && !isPublic) return c.json({ error: "アクセス権限がありません" }, 403);

    const specRow = db
      .prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(id, "spec") as unknown as { data: string } | undefined;
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
    return c.json({ error: (e as Error).message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

// 11. POST /sessions/:id/share — Generate share token (owner only)
sessionRoutes.post("/sessions/:id/share", (c) => {
  try {
    const result = getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;

    if (session.share_token) {
      return c.json({ shareToken: session.share_token, theme: session.theme });
    }

    const token = crypto.randomUUID();
    db.prepare("UPDATE sessions SET share_token = ?, mode = ? WHERE id = ?").run(token, "shared", session.id);

    return c.json({ shareToken: token, theme: session.theme });
  } catch (e) {
    console.error("Share error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 12. GET /shared/:token — Get shared session info
sessionRoutes.get("/shared/:token", (c) => {
  try {
    const token = c.req.param("token");
    const session = db
      .prepare("SELECT id, theme, status, share_token, respondent_name FROM sessions WHERE share_token = ?")
      .get(token) as unknown as
      | { id: string; theme: string; status: string; share_token: string; respondent_name: string | null }
      | undefined;
    if (!session) return c.json({ error: "Interview not found" }, 404);

    const messageCount = (
      db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").get(session.id) as unknown as {
        count: number;
      }
    ).count;
    const factsRow = db
      .prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(session.id, "facts") as unknown as { data: string } | undefined;

    return c.json({
      theme: session.theme,
      status: session.status,
      respondentName: session.respondent_name,
      messageCount,
      facts: factsRow ? JSON.parse(factsRow.data) : null,
    });
  } catch (e) {
    console.error("Get shared error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 13. POST /shared/:token/start — Start shared interview
sessionRoutes.post("/shared/:token/start", async (c) => {
  try {
    const token = c.req.param("token");
    const body = await c.req.json();
    const { respondentName } = respondentNameSchema.parse(body);
    const session = db.prepare("SELECT * FROM sessions WHERE share_token = ?").get(token) as unknown as
      | Session
      | undefined;
    if (!session) return c.json({ error: "Interview not found" }, 404);

    // Save respondent name if provided
    if (respondentName) {
      db.prepare("UPDATE sessions SET respondent_name = ? WHERE id = ?").run(respondentName.trim(), session.id);
    }

    // Check if already started
    const existing = db
      .prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?")
      .get(session.id) as unknown as {
      count: number;
    };
    if (existing.count > 0) {
      const messages = db
        .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at")
        .all(session.id) as unknown as { role: string; content: string }[];
      return c.json({ reply: messages[0]?.content || "", alreadyStarted: true, messages });
    }

    const systemPrompt = `あなたは熟練のデプスインタビュアーです。これからユーザーの課題テーマについて深掘りインタビューを開始します。

テーマ: 「${session.theme}」
${respondentName ? `回答者: ${respondentName}さん` : ""}

最初の質問を1つだけ聞いてください。テーマについて、まず現状の状況を理解するための質問をしてください。
共感的で親しみやすいトーンで、日本語で話してください。200文字以内で。`;

    const response = await callClaude(
      [{ role: "user", content: `テーマ「${session.theme}」についてインタビューを始めてください。` }],
      systemPrompt,
      512,
    );
    const reply = extractText(response);

    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(session.id, "assistant", reply);
    db.prepare("UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      "interviewing",
      session.id,
    );

    return c.json({ reply });
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Start shared interview error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 14. POST /shared/:token/chat — Chat in shared interview
sessionRoutes.post("/shared/:token/chat", async (c) => {
  try {
    const token = c.req.param("token");
    const body = await c.req.json();
    const { message } = chatMessageSchema.parse(body);
    const session = db.prepare("SELECT * FROM sessions WHERE share_token = ?").get(token) as unknown as
      | Session
      | undefined;
    if (!session) return c.json({ error: "Interview not found" }, 404);

    // Don't allow chat after completion
    if (session.status === "respondent_done") {
      return c.json({ error: "このインタビューは既に完了しています" }, 400);
    }

    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(session.id, "user", message);
    db.prepare("UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(session.id);

    const allMessages = db
      .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at")
      .all(session.id) as unknown as { role: string; content: string }[];
    const chatMessages = allMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    const turnCount = allMessages.filter((m) => m.role === "user").length;

    const systemPrompt = `あなたは熟練のデプスインタビュアーです。ユーザーの課題テーマについて深掘りインタビューを行います。

テーマ: 「${session.theme}」

ルール：
1. 一度に1つの質問だけ聞く
2. 具体的なエピソードを引き出す（「最近あった具体例を教えてください」）
3. 頻度・困り度・現在の回避策を必ず聞く
4. 抽象的な回答には「具体的には？」で掘り下げる
5. 共感を示しながら深掘りする
6. 日本語で回答する
7. 回答は簡潔に、200文字以内で

${turnCount >= 5 ? "十分な情報が集まりました。最後にまとめの質問をして、回答の最後に「[INTERVIEW_COMPLETE]」タグを付けてください。ただし、ユーザーがまだ話したそうなら続けてください。" : ""}`;

    const response = await callClaude(chatMessages, systemPrompt, 1024);
    const reply = extractText(response);

    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(session.id, "assistant", reply);

    const isComplete = reply.includes("[INTERVIEW_COMPLETE]") || turnCount >= 8;
    const cleanReply = reply.replace("[INTERVIEW_COMPLETE]", "").trim();

    return c.json({ reply: cleanReply, turnCount, isComplete });
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Shared chat error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 15. POST /shared/:token/complete — Complete shared interview + extract facts
sessionRoutes.post("/shared/:token/complete", async (c) => {
  try {
    const token = c.req.param("token");
    const session = db.prepare("SELECT * FROM sessions WHERE share_token = ?").get(token) as unknown as
      | Session
      | undefined;
    if (!session) return c.json({ error: "Interview not found" }, 404);

    const messages = db
      .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at")
      .all(session.id) as unknown as { role: string; content: string }[];
    const transcript = messages
      .map((m) => `${m.role === "user" ? "回答者" : "インタビュアー"}: ${m.content}`)
      .join("\n\n");

    const systemPrompt = `あなたは定性調査の分析エキスパートです。以下のデプスインタビュー記録からファクトを抽出してください。

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
      facts = JSON.parse(jsonMatch![0]);
    } catch {
      facts = { facts: [{ id: "F1", type: "fact", content: text, evidence: "", severity: "medium" }] };
    }

    // Save facts
    const existing = db
      .prepare("SELECT id FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(session.id, "facts") as unknown as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?").run(
        JSON.stringify(facts),
        existing.id,
      );
    } else {
      db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
        session.id,
        "facts",
        JSON.stringify(facts),
      );
    }

    db.prepare("UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      "respondent_done",
      session.id,
    );

    return c.json(facts);
  } catch (e) {
    console.error("Complete shared error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 16. POST /shared/:token/feedback — Save respondent feedback
sessionRoutes.post("/shared/:token/feedback", async (c) => {
  try {
    const token = c.req.param("token");
    const body = await c.req.json();
    const { feedback } = feedbackSchema.parse(body);
    const session = db.prepare("SELECT * FROM sessions WHERE share_token = ?").get(token) as unknown as
      | Session
      | undefined;
    if (!session) return c.json({ error: "Interview not found" }, 404);

    db.prepare(
      "UPDATE sessions SET respondent_feedback = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(feedback ?? null, "respondent_done", session.id);

    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Feedback error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

// 17. POST /sessions/:id/campaign — Create campaign from session (owner only)
sessionRoutes.post("/sessions/:id/campaign", (c) => {
  try {
    const result = getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;

    // Check if campaign already exists for this session
    const existing = db.prepare("SELECT * FROM campaigns WHERE owner_session_id = ?").get(session.id) as unknown as
      | Campaign
      | undefined;
    if (existing) {
      return c.json({
        campaignId: existing.id,
        shareToken: existing.share_token,
        theme: existing.theme,
      });
    }

    const campaignId = crypto.randomUUID();
    const token = crypto.randomUUID();
    db.prepare("INSERT INTO campaigns (id, theme, owner_session_id, share_token) VALUES (?, ?, ?, ?)").run(
      campaignId,
      session.theme,
      session.id,
      token,
    );

    return c.json(
      {
        campaignId,
        shareToken: token,
        theme: session.theme,
      },
      201,
    );
  } catch (e) {
    console.error("Create campaign error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 18. GET /campaigns/:token — Get campaign info
sessionRoutes.get("/campaigns/:token", (c) => {
  try {
    const token = c.req.param("token");
    const campaign = db.prepare("SELECT * FROM campaigns WHERE share_token = ?").get(token) as unknown as
      | Campaign
      | undefined;
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    const respondents = db
      .prepare(`
      SELECT s.id, s.respondent_name, s.status, s.created_at,
        (SELECT COUNT(*) FROM messages WHERE session_id = s.id AND role = 'user') as message_count
      FROM sessions s WHERE s.campaign_id = ? ORDER BY s.created_at DESC
    `)
      .all(campaign.id) as unknown as {
      id: string;
      respondent_name: string | null;
      status: string;
      created_at: string;
      message_count: number;
    }[];

    return c.json({
      campaignId: campaign.id,
      theme: campaign.theme,
      shareToken: campaign.share_token,
      ownerSessionId: campaign.owner_session_id,
      respondentCount: respondents.length,
      respondents,
      createdAt: campaign.created_at,
    });
  } catch (e) {
    console.error("Get campaign error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 19. POST /campaigns/:token/join — Join campaign, create respondent session
sessionRoutes.post("/campaigns/:token/join", async (c) => {
  try {
    const token = c.req.param("token");
    const body = await c.req.json();
    const { respondentName } = respondentNameSchema.parse(body);
    const campaign = db.prepare("SELECT * FROM campaigns WHERE share_token = ?").get(token) as unknown as
      | Campaign
      | undefined;
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    // Create a new session for this respondent
    const sessionId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO sessions (id, theme, status, mode, respondent_name, campaign_id)
      VALUES (?, ?, 'interviewing', 'campaign_respondent', ?, ?)
    `).run(sessionId, campaign.theme, respondentName || null, campaign.id);

    // Generate first interview question
    const systemPrompt = `あなたは熟練のデプスインタビュアーです。これからユーザーの課題テーマについて深掘りインタビューを開始します。

テーマ: 「${campaign.theme}」
${respondentName ? `回答者: ${respondentName}さん` : ""}

最初の質問を1つだけ聞いてください。テーマについて、まず現状の状況を理解するための質問をしてください。
共感的で親しみやすいトーンで、日本語で話してください。200文字以内で。`;

    const response = await callClaude(
      [{ role: "user", content: `テーマ「${campaign.theme}」についてインタビューを始めてください。` }],
      systemPrompt,
      512,
    );
    const reply = extractText(response);

    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(sessionId, "assistant", reply);

    return c.json({ sessionId, reply, theme: campaign.theme }, 201);
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Join campaign error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 20. POST /campaigns/:token/sessions/:sessionId/chat — Chat in campaign
sessionRoutes.post("/campaigns/:token/sessions/:sessionId/chat", async (c) => {
  try {
    const token = c.req.param("token");
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json();
    const { message } = chatMessageSchema.parse(body);
    const campaign = db.prepare("SELECT * FROM campaigns WHERE share_token = ?").get(token) as unknown as
      | Campaign
      | undefined;
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    const session = db
      .prepare("SELECT * FROM sessions WHERE id = ? AND campaign_id = ?")
      .get(sessionId, campaign.id) as unknown as Session | undefined;
    if (!session) return c.json({ error: "Session not found" }, 404);

    if (session.status === "respondent_done") {
      return c.json({ error: "このインタビューは既に完了しています" }, 400);
    }

    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(session.id, "user", message);
    db.prepare("UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(session.id);

    const allMessages = db
      .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at")
      .all(session.id) as unknown as { role: string; content: string }[];
    const chatMessages = allMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    const turnCount = allMessages.filter((m) => m.role === "user").length;

    const systemPrompt = `あなたは熟練のデプスインタビュアーです。ユーザーの課題テーマについて深掘りインタビューを行います。

テーマ: 「${campaign.theme}」

ルール：
1. 一度に1つの質問だけ聞く
2. 具体的なエピソードを引き出す
3. 頻度・困り度・現在の回避策を必ず聞く
4. 抽象的な回答には「具体的には？」で掘り下げる
5. 共感を示しながら深掘りする
6. 日本語で回答する
7. 回答は簡潔に、200文字以内で

${turnCount >= 5 ? "十分な情報が集まりました。最後にまとめの質問をして、回答の最後に「[INTERVIEW_COMPLETE]」タグを付けてください。" : ""}`;

    const response = await callClaude(chatMessages, systemPrompt, 1024);
    const reply = extractText(response);

    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(session.id, "assistant", reply);

    const isComplete = reply.includes("[INTERVIEW_COMPLETE]") || turnCount >= 8;
    const cleanReply = reply.replace("[INTERVIEW_COMPLETE]", "").trim();

    return c.json({ reply: cleanReply, turnCount, isComplete });
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Campaign chat error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 21. POST /campaigns/:token/sessions/:sessionId/complete — Complete campaign session
sessionRoutes.post("/campaigns/:token/sessions/:sessionId/complete", async (c) => {
  try {
    const token = c.req.param("token");
    const sessionId = c.req.param("sessionId");
    const campaign = db.prepare("SELECT * FROM campaigns WHERE share_token = ?").get(token) as unknown as
      | Campaign
      | undefined;
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    const session = db
      .prepare("SELECT * FROM sessions WHERE id = ? AND campaign_id = ?")
      .get(sessionId, campaign.id) as unknown as Session | undefined;
    if (!session) return c.json({ error: "Session not found" }, 404);

    const messages = db
      .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at")
      .all(session.id) as unknown as { role: string; content: string }[];
    const transcript = messages
      .map((m) => `${m.role === "user" ? "回答者" : "インタビュアー"}: ${m.content}`)
      .join("\n\n");

    const systemPrompt = `あなたは定性調査の分析エキスパートです。以下のデプスインタビュー記録からファクトを抽出してください。

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
最低5つ、最大15個のファクトを抽出してください。`;

    const response = await callClaude(
      [{ role: "user", content: `以下のインタビュー記録を分析してください：\n\n${transcript}` }],
      systemPrompt,
      4096,
    );
    const text = extractText(response);

    let facts: unknown;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      facts = JSON.parse(jsonMatch![0]);
    } catch {
      facts = { facts: [{ id: "F1", type: "fact", content: text, evidence: "", severity: "medium" }] };
    }

    const existingAnalysis = db
      .prepare("SELECT id FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(session.id, "facts") as unknown as { id: number } | undefined;
    if (existingAnalysis) {
      db.prepare("UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?").run(
        JSON.stringify(facts),
        existingAnalysis.id,
      );
    } else {
      db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
        session.id,
        "facts",
        JSON.stringify(facts),
      );
    }

    db.prepare("UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      "respondent_done",
      session.id,
    );
    db.prepare("UPDATE campaigns SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaign.id);

    return c.json(facts);
  } catch (e) {
    console.error("Campaign complete error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 22. POST /campaigns/:token/sessions/:sessionId/feedback — Campaign feedback
sessionRoutes.post("/campaigns/:token/sessions/:sessionId/feedback", async (c) => {
  try {
    const token = c.req.param("token");
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json();
    const { feedback } = feedbackSchema.parse(body);
    const campaign = db.prepare("SELECT * FROM campaigns WHERE share_token = ?").get(token) as unknown as
      | Campaign
      | undefined;
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    const session = db
      .prepare("SELECT * FROM sessions WHERE id = ? AND campaign_id = ?")
      .get(sessionId, campaign.id) as unknown as Session | undefined;
    if (!session) return c.json({ error: "Session not found" }, 404);

    db.prepare("UPDATE sessions SET respondent_feedback = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      feedback ?? null,
      session.id,
    );

    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Campaign feedback error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Helper: ownership check for campaign-by-id endpoints
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getOwnedCampaignById(c: Context<AppEnv, any>): Campaign | Response {
  const user = c.get("user");
  if (!user) return c.json({ error: "ログインが必要です" }, 401);
  const campaignId = c.req.param("id");
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId) as unknown as
    | Campaign
    | undefined;
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  // Check ownership via owner_session_id
  if (campaign.owner_session_id) {
    const ownerSession = db
      .prepare("SELECT user_id FROM sessions WHERE id = ?")
      .get(campaign.owner_session_id) as unknown as { user_id: string | null } | undefined;
    if (!ownerSession || ownerSession.user_id !== user.id) {
      return c.json({ error: "アクセス権限がありません" }, 403);
    }
  } else {
    return c.json({ error: "アクセス権限がありません" }, 403);
  }
  return campaign;
}

// ---------------------------------------------------------------------------
// Helper: build campaign analytics from facts
// ---------------------------------------------------------------------------

function buildCampaignAnalytics(campaignId: string): CampaignAnalytics {
  const allSessions = db
    .prepare("SELECT id, status FROM sessions WHERE campaign_id = ?")
    .all(campaignId) as unknown as { id: string; status: string }[];

  const completedSessions = allSessions.filter((s) => s.status === "respondent_done");

  const allFacts: Array<{ type: string; content: string; severity: string }> = [];
  for (const s of completedSessions) {
    const factsRow = db
      .prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(s.id, "facts") as unknown as { data: string } | undefined;
    if (factsRow) {
      const parsed = JSON.parse(factsRow.data);
      const factList = (parsed.facts || parsed) as Array<Record<string, unknown>>;
      for (const f of factList) {
        allFacts.push({
          type: (f.type as string) || "fact",
          content: (f.content as string) || "",
          severity: (f.severity as string) || "medium",
        });
      }
    }
  }

  // Common facts: group by content similarity (exact match for simplicity)
  const contentMap = new Map<string, { count: number; type: string; severity: string }>();
  for (const f of allFacts) {
    const key = f.content.toLowerCase().trim();
    const existing = contentMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      contentMap.set(key, { count: 1, type: f.type, severity: f.severity });
    }
  }
  const commonFacts = Array.from(contentMap.entries())
    .map(([content, v]) => ({ content, count: v.count, type: v.type, severity: v.severity }))
    .sort((a, b) => b.count - a.count);

  // Pain points: filter by type === "pain"
  const painPoints = allFacts
    .filter((f) => f.type === "pain")
    .reduce(
      (acc, f) => {
        const key = f.content.toLowerCase().trim();
        const existing = acc.find((p) => p.content === key);
        if (existing) {
          existing.count++;
        } else {
          acc.push({ content: key, count: 1, severity: f.severity });
        }
        return acc;
      },
      [] as Array<{ content: string; count: number; severity: string }>,
    )
    .sort((a, b) => b.count - a.count);

  // Frequency analysis: filter by type === "frequency"
  const frequencyAnalysis = allFacts
    .filter((f) => f.type === "frequency")
    .reduce(
      (acc, f) => {
        const key = f.content.toLowerCase().trim();
        const existing = acc.find((p) => p.content === key);
        if (existing) {
          existing.count++;
        } else {
          acc.push({ content: key, count: 1 });
        }
        return acc;
      },
      [] as Array<{ content: string; count: number }>,
    )
    .sort((a, b) => b.count - a.count);

  // Keyword counts: simple word frequency across all fact contents
  const keywordCounts: Record<string, number> = {};
  for (const f of allFacts) {
    const words = f.content
      .replace(/[。、！？（）「」\s]+/g, " ")
      .split(" ")
      .filter((w) => w.length >= 2);
    for (const word of words) {
      const key = word.toLowerCase();
      keywordCounts[key] = (keywordCounts[key] || 0) + 1;
    }
  }

  return {
    totalSessions: allSessions.length,
    completedSessions: completedSessions.length,
    commonFacts,
    painPoints,
    frequencyAnalysis,
    keywordCounts,
  };
}

// ---------------------------------------------------------------------------
// Campaign Analytics
// ---------------------------------------------------------------------------

// 24. GET /campaigns/:id/analytics — Aggregate analytics (owner only)
sessionRoutes.get("/campaigns/:id/analytics", (c) => {
  try {
    const result = getOwnedCampaignById(c);
    if (result instanceof Response) return result;
    const campaign = result;

    const analytics = buildCampaignAnalytics(campaign.id);
    return c.json(analytics);
  } catch (e) {
    console.error("Campaign analytics error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 25. POST /campaigns/:id/analytics/generate — AI cross-analysis (owner only)
sessionRoutes.post("/campaigns/:id/analytics/generate", async (c) => {
  try {
    const result = getOwnedCampaignById(c);
    if (result instanceof Response) return result;
    const campaign = result;

    const analytics = buildCampaignAnalytics(campaign.id);

    if (analytics.completedSessions === 0) {
      return c.json({ error: "完了済みセッションがありません" }, 400);
    }

    const systemPrompt = `あなたは定性調査の横断分析エキスパートです。複数のデプスインタビューから抽出されたファクトを分析し、パターンを検出してください。

必ず以下のJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "summary": "全体の傾向サマリー（200文字以内）",
  "patterns": [
    {
      "id": "P1",
      "title": "パターンタイトル",
      "description": "パターンの説明",
      "frequency": "該当セッション数/全セッション数",
      "severity": "high"
    }
  ],
  "insights": [
    {
      "id": "I1",
      "content": "横断的インサイト",
      "supportingPatterns": ["P1"]
    }
  ],
  "recommendations": [
    "アクション推奨1",
    "アクション推奨2"
  ]
}

ルール：
- 複数インタビューに共通するパターンを優先的に抽出
- 具体的な数値や頻度に基づいた分析
- 抽象的な表現は避け、アクショナブルな推奨を記述`;

    const factsInput = JSON.stringify({
      totalSessions: analytics.totalSessions,
      completedSessions: analytics.completedSessions,
      commonFacts: analytics.commonFacts.slice(0, 30),
      painPoints: analytics.painPoints.slice(0, 20),
      keywordCounts: analytics.keywordCounts,
    });

    const response = await callClaude(
      [{ role: "user", content: `以下のキャンペーン横断データを分析してください：\n\n${factsInput}` }],
      systemPrompt,
      4096,
    );
    const text = extractText(response);

    let analysisData: unknown;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      analysisData = JSON.parse(jsonMatch?.[0] as string);
    } catch {
      analysisData = { summary: text, patterns: [], insights: [], recommendations: [] };
    }

    // Save to analysis_results using campaign's owner_session_id
    // owner_session_id is guaranteed non-null here because getOwnedCampaignById checks it
    const sessionId = campaign.owner_session_id as string;
    const existing = db
      .prepare("SELECT id FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(sessionId, "campaign_analytics") as unknown as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?").run(
        JSON.stringify(analysisData),
        existing.id,
      );
    } else {
      db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
        sessionId,
        "campaign_analytics",
        JSON.stringify(analysisData),
      );
    }

    return c.json(analysisData);
  } catch (e) {
    console.error("Campaign analytics generate error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 26. GET /campaigns/:id/export — Export analytics as JSON (owner only)
sessionRoutes.get("/campaigns/:id/export", (c) => {
  try {
    const result = getOwnedCampaignById(c);
    if (result instanceof Response) return result;
    const campaign = result;

    const analytics = buildCampaignAnalytics(campaign.id);

    // Include AI-generated analysis if available
    let aiAnalysis: unknown = null;
    if (campaign.owner_session_id) {
      const aiRow = db
        .prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?")
        .get(campaign.owner_session_id, "campaign_analytics") as unknown as { data: string } | undefined;
      if (aiRow) {
        aiAnalysis = JSON.parse(aiRow.data);
      }
    }

    // Collect respondent details
    const respondents = db
      .prepare(`
      SELECT s.id, s.respondent_name, s.status, s.respondent_feedback, s.created_at,
        ar.data as facts_data
      FROM sessions s
      LEFT JOIN analysis_results ar ON ar.session_id = s.id AND ar.type = 'facts'
      WHERE s.campaign_id = ?
      ORDER BY s.created_at
    `)
      .all(campaign.id) as unknown as {
      id: string;
      respondent_name: string | null;
      status: string;
      respondent_feedback: string | null;
      created_at: string;
      facts_data: string | null;
    }[];

    const exportData = {
      campaign: {
        id: campaign.id,
        theme: campaign.theme,
        createdAt: campaign.created_at,
        exportedAt: new Date().toISOString(),
      },
      analytics,
      aiAnalysis,
      respondents: respondents.map((r) => ({
        sessionId: r.id,
        name: r.respondent_name || "匿名",
        status: r.status,
        feedback: r.respondent_feedback,
        createdAt: r.created_at,
        facts: r.facts_data ? JSON.parse(r.facts_data) : null,
      })),
    };

    c.header("Content-Type", "application/json");
    c.header("Content-Disposition", `attachment; filename="campaign-${campaign.id}-analytics.json"`);
    return c.json(exportData);
  } catch (e) {
    console.error("Campaign export error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 23. GET /campaigns/:token/aggregate — Aggregate all respondent facts
sessionRoutes.get("/campaigns/:token/aggregate", (c) => {
  try {
    const token = c.req.param("token");
    const campaign = db.prepare("SELECT * FROM campaigns WHERE share_token = ?").get(token) as unknown as
      | Campaign
      | undefined;
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    const sessions = db
      .prepare(`
      SELECT s.id, s.respondent_name, s.status, s.respondent_feedback,
        ar.data as facts_data
      FROM sessions s
      LEFT JOIN analysis_results ar ON ar.session_id = s.id AND ar.type = 'facts'
      WHERE s.campaign_id = ? AND s.status = 'respondent_done'
      ORDER BY s.created_at
    `)
      .all(campaign.id) as unknown as {
      id: string;
      respondent_name: string | null;
      status: string;
      respondent_feedback: string | null;
      facts_data: string | null;
    }[];

    const allFacts: Array<Record<string, unknown>> = [];
    const respondents: Array<{ sessionId: string; name: string; factCount: number; feedback: string | null }> = [];
    for (const s of sessions) {
      const facts = s.facts_data ? JSON.parse(s.facts_data) : { facts: [] };
      const factList = (facts.facts || facts) as Array<Record<string, unknown>>;
      respondents.push({
        sessionId: s.id,
        name: s.respondent_name || "匿名",
        factCount: factList.length,
        feedback: s.respondent_feedback,
      });
      for (const f of factList) {
        allFacts.push({ ...f, respondent: s.respondent_name || "匿名", sessionId: s.id });
      }
    }

    return c.json({
      campaignId: campaign.id,
      theme: campaign.theme,
      totalRespondents: sessions.length,
      totalFacts: allFacts.length,
      respondents,
      allFacts,
    });
  } catch (e) {
    console.error("Aggregate error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

export { sessionRoutes };
