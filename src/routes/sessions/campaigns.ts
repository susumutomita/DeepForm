import crypto from "node:crypto";
import { Hono } from "hono";
import { ZodError } from "zod";
import { ANALYSIS_TYPE, SESSION_STATUS } from "../../constants.ts";
import { now } from "../../db/helpers.ts";
import { db } from "../../db/index.ts";
import { saveAnalysisResult } from "../../helpers/analysis-store.ts";
import { formatZodError } from "../../helpers/format.ts";
import { getOwnedCampaignById, getOwnedSession, isResponse } from "../../helpers/session-ownership.ts";
import { callClaude, extractText, MODEL_FAST } from "../../llm.ts";
import type { AppEnv, Campaign, CampaignAnalytics, Session } from "../../types.ts";
import { chatMessageSchema, feedbackSchema, respondentNameSchema } from "../../validation.ts";
import { extractChoices } from "./interview.ts";

export const campaignRoutes = new Hono<AppEnv>();

// 17. POST /sessions/:id/campaign — Create campaign from session (owner only)
campaignRoutes.post("/sessions/:id/campaign", async (c) => {
  try {
    const result = await getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;

    // Check if campaign already exists for this session
    const existing = (await db
      .selectFrom("campaigns")
      .selectAll()
      .where("owner_session_id", "=", session.id)
      .executeTakeFirst()) as unknown as Campaign | undefined;
    if (existing) {
      return c.json({
        campaignId: existing.id,
        shareToken: existing.share_token,
        theme: existing.theme,
      });
    }

    const campaignId = crypto.randomUUID();
    const token = crypto.randomUUID();
    await db
      .insertInto("campaigns")
      .values({
        id: campaignId,
        theme: session.theme,
        owner_session_id: session.id,
        share_token: token,
      })
      .execute();

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
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 18. GET /campaigns/:token — Get campaign info
campaignRoutes.get("/campaigns/:token", async (c) => {
  try {
    const token = c.req.param("token");
    const campaign = (await db
      .selectFrom("campaigns")
      .selectAll()
      .where("share_token", "=", token)
      .executeTakeFirst()) as unknown as Campaign | undefined;
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    const respondents = (await db
      .selectFrom("sessions as s")
      .select(["s.id", "s.respondent_name", "s.status", "s.created_at"])
      .select((eb) =>
        eb
          .selectFrom("messages")
          .select((eb2) => eb2.fn.countAll().as("count"))
          .whereRef("messages.session_id", "=", "s.id")
          .where("messages.role", "=", "user")
          .as("message_count"),
      )
      .where("s.campaign_id", "=", campaign.id)
      .orderBy("s.created_at", "desc")
      .execute()) as unknown as {
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
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 19. POST /campaigns/:token/join — Join campaign, create respondent session
campaignRoutes.post("/campaigns/:token/join", async (c) => {
  try {
    const token = c.req.param("token");
    const body = await c.req.json();
    const { respondentName } = respondentNameSchema.parse(body);
    const campaign = (await db
      .selectFrom("campaigns")
      .selectAll()
      .where("share_token", "=", token)
      .executeTakeFirst()) as unknown as Campaign | undefined;
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    // Create a new session for this respondent
    const sessionId = crypto.randomUUID();
    await db
      .insertInto("sessions")
      .values({
        id: sessionId,
        theme: campaign.theme,
        status: "interviewing",
        mode: "campaign_respondent",
        respondent_name: respondentName || null,
        campaign_id: campaign.id,
      })
      .execute();

    // Generate first interview question
    const systemPrompt = `あなたは熟練のデプスインタビュアーです。これからユーザーの課題テーマについて深掘りインタビューを開始します。

テーマ: 「${campaign.theme}」
${respondentName ? `回答者: ${respondentName}さん` : ""}

最初の質問を1つだけ聞いてください。テーマについて、まず現状の状況を理解するための質問をしてください。
共感的で親しみやすいトーンで、日本語で話してください。200文字以内で。

重要: 質問の後に、ユーザーが選択できる3〜5個の回答選択肢を提示してください。
以下のフォーマットで:
[CHOICES]
選択肢1
選択肢2
選択肢3
その他（自分で入力）
[/CHOICES]

選択肢は具体的に、異なる状況やパターンをカバーしてください。
最後の選択肢は必ず「その他（自分で入力）」にしてください。`;

    const response = await callClaude(
      [{ role: "user", content: `テーマ「${campaign.theme}」についてインタビューを始めてください。` }],
      systemPrompt,
      512,
      MODEL_FAST,
    );
    const rawReply = extractText(response);
    const { text: reply, choices } = extractChoices(rawReply);

    await db.insertInto("messages").values({ session_id: sessionId, role: "assistant", content: reply }).execute();

    return c.json({ sessionId, reply, theme: campaign.theme, choices }, 201);
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Join campaign error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 20. POST /campaigns/:token/sessions/:sessionId/chat — Chat in campaign
campaignRoutes.post("/campaigns/:token/sessions/:sessionId/chat", async (c) => {
  try {
    const token = c.req.param("token");
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json();
    const { message } = chatMessageSchema.parse(body);
    const campaign = (await db
      .selectFrom("campaigns")
      .selectAll()
      .where("share_token", "=", token)
      .executeTakeFirst()) as unknown as Campaign | undefined;
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    const session = (await db
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .where("campaign_id", "=", campaign.id)
      .executeTakeFirst()) as unknown as Session | undefined;
    if (!session) return c.json({ error: "Session not found" }, 404);

    if (session.status === SESSION_STATUS.RESPONDENT_DONE) {
      return c.json({ error: "このインタビューは既に完了しています" }, 400);
    }

    await db.insertInto("messages").values({ session_id: session.id, role: "user", content: message }).execute();
    await db.updateTable("sessions").set({ updated_at: now() }).where("id", "=", session.id).execute();

    const allMessages = (await db
      .selectFrom("messages")
      .select(["role", "content"])
      .where("session_id", "=", session.id)
      .orderBy("created_at")
      .execute()) as unknown as { role: string; content: string }[];
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

重要: 質問の後に、ユーザーが選択できる3〜5個の回答選択肢を提示してください。
以下のフォーマットで:
[CHOICES]
選択肢1
選択肢2
選択肢3
その他（自分で入力）
[/CHOICES]

選択肢は具体的に、異なる状況やパターンをカバーしてください。
最後の選択肢は必ず「その他（自分で入力）」にしてください。

${turnCount >= 5 ? "十分な情報が集まりました。最後にまとめの質問をして、回答の最後に「[INTERVIEW_COMPLETE]」タグを付けてください。" : ""}`;

    const response = await callClaude(chatMessages, systemPrompt, 1024, MODEL_FAST);
    const rawReply = extractText(response);
    const { text: parsedReply, choices } = extractChoices(rawReply);

    const isComplete = parsedReply.includes("[INTERVIEW_COMPLETE]") || turnCount >= 8;
    const cleanReply = parsedReply.replace("[INTERVIEW_COMPLETE]", "").trim();

    await db
      .insertInto("messages")
      .values({ session_id: session.id, role: "assistant", content: cleanReply })
      .execute();

    return c.json({ reply: cleanReply, turnCount, isComplete, choices });
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Campaign chat error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 21. POST /campaigns/:token/sessions/:sessionId/complete — Complete campaign session
campaignRoutes.post("/campaigns/:token/sessions/:sessionId/complete", async (c) => {
  try {
    const token = c.req.param("token");
    const sessionId = c.req.param("sessionId");
    const campaign = (await db
      .selectFrom("campaigns")
      .selectAll()
      .where("share_token", "=", token)
      .executeTakeFirst()) as unknown as Campaign | undefined;
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    const session = (await db
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .where("campaign_id", "=", campaign.id)
      .executeTakeFirst()) as unknown as Session | undefined;
    if (!session) return c.json({ error: "Session not found" }, 404);

    const messages = (await db
      .selectFrom("messages")
      .select(["role", "content"])
      .where("session_id", "=", session.id)
      .orderBy("created_at")
      .execute()) as unknown as { role: string; content: string }[];
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
      MODEL_FAST,
    );
    const text = extractText(response);

    let facts: unknown;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      facts = JSON.parse(jsonMatch?.[0] ?? "");
    } catch {
      facts = { facts: [{ id: "F1", type: "fact", content: text, evidence: "", severity: "medium" }] };
    }

    await saveAnalysisResult(session.id, ANALYSIS_TYPE.FACTS, facts);

    await db
      .updateTable("sessions")
      .set({ status: SESSION_STATUS.RESPONDENT_DONE, updated_at: now() })
      .where("id", "=", session.id)
      .execute();
    await db.updateTable("campaigns").set({ updated_at: now() }).where("id", "=", campaign.id).execute();

    return c.json(facts);
  } catch (e) {
    console.error("Campaign complete error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 22. POST /campaigns/:token/sessions/:sessionId/feedback — Campaign feedback
campaignRoutes.post("/campaigns/:token/sessions/:sessionId/feedback", async (c) => {
  try {
    const token = c.req.param("token");
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json();
    const { feedback } = feedbackSchema.parse(body);
    const campaign = (await db
      .selectFrom("campaigns")
      .selectAll()
      .where("share_token", "=", token)
      .executeTakeFirst()) as unknown as Campaign | undefined;
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    const session = (await db
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .where("campaign_id", "=", campaign.id)
      .executeTakeFirst()) as unknown as Session | undefined;
    if (!session) return c.json({ error: "Session not found" }, 404);

    await db
      .updateTable("sessions")
      .set({ respondent_feedback: feedback ?? null, updated_at: now() })
      .where("id", "=", session.id)
      .execute();

    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Campaign feedback error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Helper: build campaign analytics from facts
// ---------------------------------------------------------------------------

async function buildCampaignAnalytics(campaignId: string): Promise<CampaignAnalytics> {
  const allSessions = (await db
    .selectFrom("sessions")
    .select(["id", "status"])
    .where("campaign_id", "=", campaignId)
    .execute()) as unknown as { id: string; status: string }[];

  const completedSessions = allSessions.filter((s) => s.status === SESSION_STATUS.RESPONDENT_DONE);

  const allFacts: Array<{ type: string; content: string; severity: string }> = [];
  for (const s of completedSessions) {
    const factsRow = (await db
      .selectFrom("analysis_results")
      .select("data")
      .where("session_id", "=", s.id)
      .where("type", "=", ANALYSIS_TYPE.FACTS)
      .executeTakeFirst()) as unknown as { data: string } | undefined;
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
campaignRoutes.get("/campaigns/:id/analytics", async (c) => {
  try {
    const result = await getOwnedCampaignById(c);
    if (result instanceof Response) return result;
    const campaign = result;

    const analytics = await buildCampaignAnalytics(campaign.id);
    return c.json(analytics);
  } catch (e) {
    console.error("Campaign analytics error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 25. POST /campaigns/:id/analytics/generate — AI cross-analysis (owner only)
campaignRoutes.post("/campaigns/:id/analytics/generate", async (c) => {
  try {
    const result = await getOwnedCampaignById(c);
    if (result instanceof Response) return result;
    const campaign = result;

    const analytics = await buildCampaignAnalytics(campaign.id);

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
      MODEL_FAST,
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
    await saveAnalysisResult(sessionId, ANALYSIS_TYPE.CAMPAIGN_ANALYTICS, analysisData);

    return c.json(analysisData);
  } catch (e) {
    console.error("Campaign analytics generate error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 26. GET /campaigns/:id/export — Export analytics as JSON (owner only)
campaignRoutes.get("/campaigns/:id/export", async (c) => {
  try {
    const result = await getOwnedCampaignById(c);
    if (result instanceof Response) return result;
    const campaign = result;

    const analytics = await buildCampaignAnalytics(campaign.id);

    // Include AI-generated analysis if available
    let aiAnalysis: unknown = null;
    if (campaign.owner_session_id) {
      const aiRow = (await db
        .selectFrom("analysis_results")
        .select("data")
        .where("session_id", "=", campaign.owner_session_id)
        .where("type", "=", ANALYSIS_TYPE.CAMPAIGN_ANALYTICS)
        .executeTakeFirst()) as unknown as { data: string } | undefined;
      if (aiRow) {
        aiAnalysis = JSON.parse(aiRow.data);
      }
    }

    // Collect respondent details
    const respondents = (await db
      .selectFrom("sessions as s")
      .leftJoin("analysis_results as ar", (join) =>
        join.onRef("ar.session_id", "=", "s.id").on("ar.type", "=", "facts"),
      )
      .select([
        "s.id",
        "s.respondent_name",
        "s.status",
        "s.respondent_feedback",
        "s.created_at",
        "ar.data as facts_data",
      ])
      .where("s.campaign_id", "=", campaign.id)
      .orderBy("s.created_at")
      .execute()) as unknown as {
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
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 23. GET /campaigns/:token/aggregate — Aggregate all respondent facts
campaignRoutes.get("/campaigns/:token/aggregate", async (c) => {
  try {
    const token = c.req.param("token");
    const campaign = (await db
      .selectFrom("campaigns")
      .selectAll()
      .where("share_token", "=", token)
      .executeTakeFirst()) as unknown as Campaign | undefined;
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    const sessions = (await db
      .selectFrom("sessions as s")
      .leftJoin("analysis_results as ar", (join) =>
        join.onRef("ar.session_id", "=", "s.id").on("ar.type", "=", "facts"),
      )
      .select(["s.id", "s.respondent_name", "s.status", "s.respondent_feedback", "ar.data as facts_data"])
      .where("s.campaign_id", "=", campaign.id)
      .where("s.status", "=", "respondent_done")
      .orderBy("s.created_at")
      .execute()) as unknown as {
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
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
