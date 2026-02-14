import { Hono } from "hono";
import { ZodError } from "zod";
import { db } from "../db/index.ts";
import type { AppEnv } from "../types.ts";
import { appFeedbackSchema } from "../validation.ts";

const feedbackRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// In-memory rate limiting: 1 request per IP per 60 seconds
// ---------------------------------------------------------------------------
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_WINDOW_MS = 60_000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const lastRequest = rateLimitMap.get(ip);
  if (lastRequest && now - lastRequest < RATE_LIMIT_WINDOW_MS) {
    return true;
  }
  rateLimitMap.set(ip, now);
  return false;
}

/** テスト用: レートリミットマップをクリアする */
export function clearRateLimitMap(): void {
  rateLimitMap.clear();
}

// ---------------------------------------------------------------------------
// POST /api/feedback — Submit app feedback (auth optional)
// ---------------------------------------------------------------------------
feedbackRoutes.post("/", async (c) => {
  try {
    // Rate limit by IP
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    if (isRateLimited(ip)) {
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

export { feedbackRoutes };
