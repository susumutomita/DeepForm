import crypto from "node:crypto";
import { Hono } from "hono";
import { ZodError } from "zod";
import { ANALYSIS_TYPE, SESSION_STATUS } from "../../constants.ts";
import { db } from "../../db.ts";
import { saveAnalysisResult } from "../../helpers/analysis-store.ts";
import { formatZodError } from "../../helpers/format.ts";
import { getOwnedCampaignById, getOwnedSession, isResponse } from "../../helpers/session-ownership.ts";
import { callClaude, extractText } from "../../llm.ts";
import type { AppEnv, Campaign, CampaignAnalytics, Session } from "../../types.ts";
import { chatMessageSchema, feedbackSchema, respondentNameSchema } from "../../validation.ts";

export const campaignRoutes = new Hono<AppEnv>();

// 17. POST /sessions/:id/campaign — Create campaign from session (owner only)
campaignRoutes.post("/sessions/:id/campaign", (c) => {
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
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 18. GET /campaigns/:token — Get campaign info
campaignRoutes.get("/campaigns/:token", (c) => {
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
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 19. POST /campaigns/:token/join — Join campaign, create respondent session
campaignRoutes.post("/campaigns/:token/join", async (c) => {
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
    const campaign = db.prepare("SELECT * FROM campaigns WHERE share_token = ?").get(token) as unknown as
      | Campaign
      | undefined;
    if (!campaign) return c.json({ error: "Campaign not found" }, 404);

    const session = db
      .prepare("SELECT * FROM sessions WHERE id = ? AND campaign_id = ?")
      .get(sessionId, campaign.id) as unknown as Session | undefined;
    if (!session) return c.json({ error: "Session not found" }, 404);

    if (session.status === SESSION_STATUS.RESPONDENT_DONE) {
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
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 21. POST /campaigns/:token/sessions/:sessionId/complete — Complete campaign session
campaignRoutes.post("/campaigns/:token/sessions/:sessionId/complete", async (c) => {
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

    saveAnalysisResult(session.id, ANALYSIS_TYPE.FACTS, facts);

    db.prepare("UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      SESSION_STATUS.RESPONDENT_DONE,
      session.id,
    );
    db.prepare("UPDATE campaigns SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaign.id);

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
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Helper: build campaign analytics from facts
// ---------------------------------------------------------------------------

function buildCampaignAnalytics(campaignId: string): CampaignAnalytics {
  const allSessions = db
    .prepare("SELECT id, status FROM sessions WHERE campaign_id = ?")
    .all(campaignId) as unknown as { id: string; status: string }[];

  const completedSessions = allSessions.filter((s) => s.status === SESSION_STATUS.RESPONDENT_DONE);

  const allFacts: Array<{ type: string; content: string; severity: string }> = [];
  for (const s of completedSessions) {
    const factsRow = db
      .prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?")
      .get(s.id, ANALYSIS_TYPE.FACTS) as unknown as { data: string } | undefined;
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
campaignRoutes.get("/campaigns/:id/analytics", (c) => {
  try {
    const result = getOwnedCampaignById(c);
    if (result instanceof Response) return result;
    const campaign = result;

    const analytics = buildCampaignAnalytics(campaign.id);
    return c.json(analytics);
  } catch (e) {
    console.error("Campaign analytics error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 25. POST /campaigns/:id/analytics/generate — AI cross-analysis (owner only)
campaignRoutes.post("/campaigns/:id/analytics/generate", async (c) => {
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
    saveAnalysisResult(sessionId, ANALYSIS_TYPE.CAMPAIGN_ANALYTICS, analysisData);

    return c.json(analysisData);
  } catch (e) {
    console.error("Campaign analytics generate error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 26. GET /campaigns/:id/export — Export analytics as JSON (owner only)
campaignRoutes.get("/campaigns/:id/export", (c) => {
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
        .get(campaign.owner_session_id, ANALYSIS_TYPE.CAMPAIGN_ANALYTICS) as unknown as { data: string } | undefined;
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
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 23. GET /campaigns/:token/aggregate — Aggregate all respondent facts
campaignRoutes.get("/campaigns/:token/aggregate", (c) => {
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
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
