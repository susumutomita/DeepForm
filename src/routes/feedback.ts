import { Hono } from "hono";
import { ZodError } from "zod";
import { db } from "../db/index.ts";
import { processFeedbackAsync } from "../helpers/feedback-to-issue.ts";
import { callClaude, extractText, MODEL_FAST } from "../llm.ts";
import type { AppEnv } from "../types.ts";
import { appFeedbackSchema } from "../validation.ts";

const feedbackRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// In-memory rate limiting
// ---------------------------------------------------------------------------
const feedbackRateLimitMap = new Map<string, number>();
const deepdiveRateLimitMap = new Map<string, number>();
const FEEDBACK_RATE_LIMIT_MS = 60_000; // 60s for feedback submission
const DEEPDIVE_RATE_LIMIT_MS = 5_000; // 5s for deepdive (conversational)

function isRateLimited(ip: string, map: Map<string, number>, windowMs: number): boolean {
  const now = Date.now();
  const lastRequest = map.get(ip);
  if (lastRequest && now - lastRequest < windowMs) {
    return true;
  }
  map.set(ip, now);
  return false;
}

/** テスト用: レートリミットマップをクリアする */
export function clearRateLimitMap(): void {
  feedbackRateLimitMap.clear();
  deepdiveRateLimitMap.clear();
}

// ---------------------------------------------------------------------------
// POST /api/feedback — Submit app feedback (auth optional)
// ---------------------------------------------------------------------------
feedbackRoutes.post("/", async (c) => {
  try {
    // Rate limit by IP
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    if (isRateLimited(ip, feedbackRateLimitMap, FEEDBACK_RATE_LIMIT_MS)) {
      return c.json({ error: "送信は60秒に1回までです。しばらく待ってから再度お試しください。" }, 429);
    }

    const body = await c.req.json();
    const { type, message, page } = appFeedbackSchema.parse(body);

    // Auth is optional — attach user_id if logged in
    const user = c.get("user");
    const userId = user?.id ?? null;

    await db
      .insertInto("feedback")
      .values({ user_id: userId, type, message, page: page ?? null, ip_address: ip })
      .execute();

    // Fire-and-forget: AI analysis + GitHub Issue creation
    processFeedbackAsync(type, message);

    return c.json({ ok: true }, 201);
  } catch (e) {
    if (e instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
    if (e instanceof ZodError) {
      const msg = e.issues.map((i) => i.message).join(", ");
      return c.json({ error: msg }, 400);
    }
    console.error("Feedback submission error:", e);
    return c.json({ error: "フィードバックの送信に失敗しました" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/feedback/deepdive — AI deep-dive on feedback (3 turns max)
// ---------------------------------------------------------------------------
feedbackRoutes.post("/deepdive", async (c) => {
  try {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    if (isRateLimited(ip, deepdiveRateLimitMap, DEEPDIVE_RATE_LIMIT_MS)) {
      return c.json({ error: "少し待ってから送信してください。" }, 429);
    }

    const body = await c.req.json();
    const { message, history } = body as {
      message: string;
      history?: Array<{ role: "user" | "assistant"; content: string }>;
    };

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return c.json({ error: "メッセージが必要です" }, 400);
    }

    const messages = history && Array.isArray(history) ? [...history] : [];
    messages.push({ role: "user", content: message });

    const turnCount = messages.filter((m) => m.role === "user").length;

    const systemPrompt = `You are a feedback interviewer for DeepForm (AI interview tool that helps organize thinking for software development).
Your job is to deep-dive into the user's feedback to understand the real issue or need.

Rules:
- Ask ONE focused follow-up question per turn
- Focus on: Why is this important? When did this happen? What did you try?
- Keep responses SHORT (2-3 sentences max)
- After ${turnCount >= 3 ? "this response" : "3 exchanges"}, wrap up with a summary of what you understood
- Respond in the SAME LANGUAGE as the user
${turnCount >= 3 ? "\nThis is the final turn. Summarize the feedback concisely and thank the user. Start your summary with [SUMMARY]" : ""}`;

    const response = await callClaude(messages, systemPrompt, 512, MODEL_FAST);
    const reply = extractText(response);

    const isFinal = turnCount >= 3 || reply.includes("[SUMMARY]");
    const cleanReply = reply.replace("[SUMMARY]", "").trim();

    // Save to DB if final
    if (isFinal) {
      const user = c.get("user");
      const fullConversation = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
      await db
        .insertInto("feedback")
        .values({
          user_id: user?.id ?? null,
          type: "deepdive",
          message: `[AI Deep-dive]\n${fullConversation}\n\nAI Summary: ${cleanReply}`,
          page: "feedback-deepdive",
          ip_address: ip,
        })
        .execute();
    }

    // Fire-and-forget: create issue from final deepdive summary
    if (isFinal) {
      const fullConvo = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
      processFeedbackAsync("deepdive", `[AI Deep-dive]\n${fullConvo}\n\nAI Summary: ${cleanReply}`);
    }

    return c.json({ reply: cleanReply, done: isFinal });
  } catch (e) {
    console.error("Feedback deepdive error:", e);
    return c.json({ error: "エラーが発生しました" }, 500);
  }
});

export { feedbackRoutes };
