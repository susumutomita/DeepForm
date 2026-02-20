import crypto from "node:crypto";
import { Hono } from "hono";
import { ZodError } from "zod";
import { SESSION_STATUS } from "../../constants.ts";
import { now } from "../../db/helpers.ts";
import { db } from "../../db/index.ts";
import { formatZodError } from "../../helpers/format.ts";
import { getOwnedSession, isResponse } from "../../helpers/session-ownership.ts";
import type { AnalysisResult, AppEnv, Message, Session } from "../../types.ts";
import { createSessionSchema, visibilitySchema } from "../../validation.ts";
import { extractJsonFromLLM } from "./analysis.ts";

export const crudRoutes = new Hono<AppEnv>();

// Session limit per user (configurable via env)
const MAX_SESSIONS_PER_USER = Number(process.env.MAX_SESSIONS_PER_USER) || 50;

// 1. POST /sessions — Create session with theme (requires login)
crudRoutes.post("/sessions", async (c) => {
  try {
    const user = c.get("user");
    const body = await c.req.json();
    const { theme } = createSessionSchema.parse(body);

    if (user) {
      // Enforce session limit per user
      const { count } = (await db
        .selectFrom("sessions")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("user_id", "=", user.id)
        .executeTakeFirstOrThrow()) as unknown as { count: number };
      if (count >= MAX_SESSIONS_PER_USER) {
        return c.json(
          {
            error: `セッション数の上限（${MAX_SESSIONS_PER_USER}件）に達しました。不要なセッションを削除してください。`,
          },
          429,
        );
      }
    }

    const id = crypto.randomUUID();
    if (user) {
      await db.insertInto("sessions").values({ id, theme: theme.trim(), user_id: user.id }).execute();
    } else {
      await db.insertInto("sessions").values({ id, theme: theme.trim(), user_id: null, is_public: 1 }).execute();
    }
    return c.json({ sessionId: id, theme: theme.trim() });
  } catch (e) {
    if (e instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Create session error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 2. GET /sessions — List sessions (own + public if logged in, public only otherwise)
crudRoutes.get("/sessions", async (c) => {
  try {
    const user = c.get("user");
    let sessions: (Session & { message_count: number; display_status?: string })[];
    if (user) {
      sessions = (await db
        .selectFrom("sessions as s")
        .leftJoin("messages as m", "s.id", "m.session_id")
        .selectAll("s")
        .select((eb) => eb.fn.count<number>("m.id").as("message_count"))
        .where((eb) => eb.or([eb("s.user_id", "=", user.id), eb("s.is_public", "=", 1)]))
        .groupBy("s.id")
        .orderBy("s.updated_at", "desc")
        .execute()) as unknown as (Session & { message_count: number; display_status?: string })[];
    } else {
      sessions = (await db
        .selectFrom("sessions as s")
        .leftJoin("messages as m", "s.id", "m.session_id")
        .selectAll("s")
        .select((eb) => eb.fn.count<number>("m.id").as("message_count"))
        .where("s.is_public", "=", 1)
        .groupBy("s.id")
        .orderBy("s.updated_at", "desc")
        .execute()) as unknown as (Session & { message_count: number; display_status?: string })[];
    }
    sessions.forEach((s) => {
      if (s.status === SESSION_STATUS.RESPONDENT_DONE) s.display_status = "analyzed";
    });
    return c.json(sessions);
  } catch (e) {
    console.error("List sessions error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 3. GET /sessions/:id — Get session with messages & analysis (owner or public)
crudRoutes.get("/sessions/:id", async (c) => {
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

    const messages = (await db
      .selectFrom("messages")
      .selectAll()
      .where("session_id", "=", id)
      .orderBy("created_at")
      .execute()) as unknown as Message[];
    const analyses = (await db
      .selectFrom("analysis_results")
      .selectAll()
      .where("session_id", "=", id)
      .orderBy("created_at")
      .execute()) as unknown as AnalysisResult[];

    const analysisMap: Record<string, unknown> = {};
    for (const a of analyses) {
      let parsed = JSON.parse(a.data);

      // 破損データの修復: problemDefinition に生 JSON が入っている場合は再パース
      if (parsed?.prd?.problemDefinition && /^```|^\{/.test(parsed.prd.problemDefinition.trim())) {
        const repaired = extractJsonFromLLM(parsed.prd.problemDefinition);
        if (repaired && typeof repaired === "object" && "prd" in (repaired as Record<string, unknown>)) {
          parsed = repaired;
          // 修復結果を DB に永続化（次回以降の修復を省略）
          db.updateTable("analysis_results")
            .set({ data: JSON.stringify(parsed) })
            .where("session_id", "=", a.session_id)
            .where("type", "=", a.type)
            .execute()
            .catch((err) => console.error("Failed to persist repaired data:", err));
        }
      }

      analysisMap[a.type] = parsed;
    }

    // Lookup campaign created from this session
    const campaign = await db
      .selectFrom("campaigns")
      .select(["id", "share_token"])
      .where("owner_session_id", "=", id)
      .executeTakeFirst();

    let campaignId: string | undefined;
    let campaignShareToken: string | undefined;
    let campaignRespondentCount: number | undefined;

    if (campaign) {
      campaignId = campaign.id;
      campaignShareToken = campaign.share_token;
      const { count } = (await db
        .selectFrom("sessions")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("campaign_id", "=", campaign.id)
        .executeTakeFirstOrThrow()) as unknown as { count: number };
      campaignRespondentCount = Number(count);
    }

    return c.json({
      ...session,
      messages,
      analysis: analysisMap,
      campaignId,
      campaignShareToken,
      campaignRespondentCount,
    });
  } catch (e) {
    console.error("Get session error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 4. DELETE /sessions/:id — Delete session + related data (owner only)
crudRoutes.delete("/sessions/:id", async (c) => {
  try {
    const result = await getOwnedSession(c);
    if (isResponse(result)) return result;

    const id = result.id;
    await db.deleteFrom("analysis_results").where("session_id", "=", id).execute();
    await db.deleteFrom("messages").where("session_id", "=", id).execute();
    await db.deleteFrom("sessions").where("id", "=", id).execute();
    return c.json({ ok: true });
  } catch (e) {
    console.error("Delete session error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 4b. PATCH /sessions/:id/visibility — Toggle public/private (owner only)
crudRoutes.patch("/sessions/:id/visibility", async (c) => {
  try {
    const result = await getOwnedSession(c);
    if (isResponse(result)) return result;

    const body = await c.req.json();
    const { is_public } = visibilitySchema.parse(body);
    const value = is_public ? 1 : 0;
    await db.updateTable("sessions").set({ is_public: value, updated_at: now() }).where("id", "=", result.id).execute();

    const updated = (await db
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", result.id)
      .executeTakeFirst()) as unknown as Session;
    return c.json(updated);
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Visibility toggle error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
