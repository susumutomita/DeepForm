/**
 * Post-release feedback collection.
 *
 * Extends the campaign concept: after a feature is built from a DeepForm spec,
 * the owner can create a "feedback campaign" that collects structured post-release
 * feedback. The feedback is then used to refine the spec for the next iteration.
 *
 * Reuses the existing campaign infrastructure (share_token, respondent sessions)
 * but with structured feedback questions instead of open-ended interviews.
 */

import { Hono } from "hono";
import { ZodError, z } from "zod";
import { ANALYSIS_TYPE } from "../../constants.ts";
import { now } from "../../db/helpers.ts";
import { db } from "../../db/index.ts";
import { saveAnalysisResult } from "../../helpers/analysis-store.ts";
import { formatZodError } from "../../helpers/format.ts";
import { getOwnedSession, isResponse } from "../../helpers/session-ownership.ts";
import { callClaude, extractText, MODEL_FAST } from "../../llm.ts";
import type { AppEnv, Session } from "../../types.ts";

export const postReleaseFeedbackRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Structured feedback questions — fixed set, not AI-generated
// ---------------------------------------------------------------------------

const FEEDBACK_QUESTIONS = [
  {
    id: "usage",
    question: "このツール/機能を実際に使っていますか？",
    type: "multiple_choice" as const,
    choices: ["毎日使っている", "週に数回使う", "たまに使う", "ほとんど使っていない", "一度も使っていない"],
  },
  {
    id: "stuck_points",
    question: "使っていて困った点や詰まった場所はありますか？",
    type: "multiple_choice" as const,
    choices: [
      "操作方法が分かりにくい",
      "エラーが発生した",
      "処理が遅い",
      "欲しい機能が足りない",
      "特に困っていない",
      "その他（自由記述）",
    ],
  },
  {
    id: "stuck_detail",
    question: "具体的にどこで困りましたか？（任意）",
    type: "text" as const,
  },
  {
    id: "workaround",
    question: "不便な点を回避するために手作業でやっていることはありますか？",
    type: "text" as const,
  },
  {
    id: "reliability",
    question: "信頼性・パフォーマンスはどうですか？",
    type: "multiple_choice" as const,
    choices: ["問題なし", "たまに遅い", "たまにエラーが出る", "頻繁に問題がある", "使い物にならない"],
  },
  {
    id: "top_fix",
    question: "一番直してほしいことは何ですか？",
    type: "text" as const,
  },
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const feedbackEntrySchema = z.object({
  questionId: z.string().max(100),
  answer: z.string().max(2000),
});

const submitFeedbackSchema = z.object({
  entries: z.array(feedbackEntrySchema).min(1).max(20),
  respondentName: z.string().max(100).optional(),
});

// ---------------------------------------------------------------------------
// GET /sessions/:id/post-release-feedback/questions — Get feedback questions
// ---------------------------------------------------------------------------

postReleaseFeedbackRoutes.get("/sessions/:id/post-release-feedback/questions", async (c) => {
  try {
    const id = c.req.param("id");
    const session = (await db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst()) as unknown as
      | Session
      | undefined;
    if (!session) return c.json({ error: "Session not found" }, 404);

    return c.json({
      theme: session.theme,
      questions: FEEDBACK_QUESTIONS,
    });
  } catch (e) {
    console.error("Get feedback questions error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /sessions/:id/post-release-feedback — Submit structured feedback
// ---------------------------------------------------------------------------

postReleaseFeedbackRoutes.post("/sessions/:id/post-release-feedback", async (c) => {
  try {
    const id = c.req.param("id");
    const session = (await db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst()) as unknown as
      | Session
      | undefined;
    if (!session) return c.json({ error: "Session not found" }, 404);

    const body = await c.req.json();
    const { entries, respondentName } = submitFeedbackSchema.parse(body);

    // Store feedback in feedback table
    const feedbackContent = entries
      .map((e) => {
        const q = FEEDBACK_QUESTIONS.find((fq) => fq.id === e.questionId);
        return `Q: ${q?.question || e.questionId}\nA: ${e.answer}`;
      })
      .join("\n\n");

    await db
      .insertInto("feedback")
      .values({
        user_id: null,
        type: "post_release",
        message: `[Post-release feedback]\nSession: ${id}\nTheme: ${session.theme}\n${respondentName ? `Respondent: ${respondentName}\n` : ""}\n${feedbackContent}`,
        page: `/session/${id}`,
        ip_address: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null,
      })
      .execute();

    return c.json({ ok: true }, 201);
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Submit post-release feedback error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /sessions/:id/post-release-feedback — List all feedback for a session
// ---------------------------------------------------------------------------

postReleaseFeedbackRoutes.get("/sessions/:id/post-release-feedback", async (c) => {
  try {
    const result = await getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result as Session;
    const id = session.id;

    const feedbackRows = await db
      .selectFrom("feedback")
      .selectAll()
      .where("type", "=", "post_release")
      .where("page", "=", `/session/${id}`)
      .orderBy("created_at", "desc")
      .execute();

    return c.json({
      sessionId: id,
      theme: session.theme,
      feedbackCount: feedbackRows.length,
      feedback: feedbackRows.map((r) => ({
        id: r.id,
        message: r.message,
        createdAt: r.created_at,
      })),
    });
  } catch (e) {
    console.error("Get post-release feedback error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /sessions/:id/post-release-feedback/refine — Refine spec from feedback
// ---------------------------------------------------------------------------

postReleaseFeedbackRoutes.post("/sessions/:id/post-release-feedback/refine", async (c) => {
  try {
    const result = await getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result as Session;
    const id = session.id;

    // Load existing Claude Code prompt
    const exportRow = await db
      .selectFrom("analysis_results")
      .select("data")
      .where("session_id", "=", id)
      .where("type", "=", ANALYSIS_TYPE.CLAUDE_CODE_PROMPT)
      .executeTakeFirst();

    if (!exportRow) {
      return c.json({ error: "Claude Code プロンプトを先に生成してください" }, 400);
    }

    // Load feedback
    const feedbackRows = await db
      .selectFrom("feedback")
      .select("message")
      .where("type", "=", "post_release")
      .where("page", "=", `/session/${id}`)
      .orderBy("created_at", "desc")
      .limit(20)
      .execute();

    if (feedbackRows.length === 0) {
      return c.json({ error: "フィードバックがまだ収集されていません" }, 400);
    }

    const existingExport = JSON.parse(exportRow.data);
    const feedbackText = feedbackRows.map((r) => r.message).join("\n---\n");

    // Use LLM to generate refinement suggestions
    const systemPrompt = `You are a product refinement expert. Based on post-release user feedback,
generate a refined version of the implementation instructions.

IMPORTANT: Respond in the SAME LANGUAGE as the input data.

You will receive:
1. The original implementation prompt
2. Post-release user feedback

Your job:
- Identify the most impactful issues from feedback
- Generate a "refinement patch" — additional instructions that address the feedback
- Prioritize: bugs > usability > missing features > nice-to-haves
- Keep the output concise and actionable

Return a JSON object:
{
  "refinedPrompt": "The original prompt plus feedback-informed additions",
  "changesSummary": ["Change 1 description", "Change 2 description"],
  "topPriority": "The single most important thing to fix"
}`;

    const response = await callClaude(
      [
        {
          role: "user",
          content: `Original prompt:\n${existingExport.prompt}\n\nPost-release feedback (${feedbackRows.length} responses):\n${feedbackText}`,
        },
      ],
      systemPrompt,
      8192,
      MODEL_FAST,
    );
    const text = extractText(response);

    let refinement: { refinedPrompt?: string; changesSummary?: string[]; topPriority?: string };
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      refinement = JSON.parse(jsonMatch?.[0] ?? "{}");
    } catch {
      refinement = { refinedPrompt: text, changesSummary: [], topPriority: "" };
    }

    // Update the stored Claude Code prompt with the refined version
    if (refinement.refinedPrompt) {
      await saveAnalysisResult(id, ANALYSIS_TYPE.CLAUDE_CODE_PROMPT, {
        prompt: refinement.refinedPrompt,
        exportedAt: new Date().toISOString(),
        refinedFromFeedback: true,
        feedbackCount: feedbackRows.length,
        changesSummary: refinement.changesSummary,
        topPriority: refinement.topPriority,
      });
    }

    // Update session timestamp
    await db.updateTable("sessions").set({ updated_at: now() }).where("id", "=", id).execute();

    return c.json({
      refinedPrompt: refinement.refinedPrompt || existingExport.prompt,
      changesSummary: refinement.changesSummary || [],
      topPriority: refinement.topPriority || "",
      feedbackCount: feedbackRows.length,
    });
  } catch (e) {
    console.error("Refine from feedback error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
