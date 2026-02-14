import crypto from "node:crypto";
import { Hono } from "hono";
import { ZodError } from "zod";
import { SESSION_STATUS } from "../../constants.ts";
import { db } from "../../db.ts";
import { formatZodError } from "../../helpers/format.ts";
import { getOwnedSession, isResponse } from "../../helpers/session-ownership.ts";
import type { AnalysisResult, AppEnv, Message, Session } from "../../types.ts";
import { createSessionSchema, visibilitySchema } from "../../validation.ts";

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
      const { count } = db.prepare("SELECT COUNT(*) as count FROM sessions WHERE user_id = ?").get(user.id) as {
        count: number;
      };
      if (count >= MAX_SESSIONS_PER_USER) {
        return c.json(
          { error: `セッション数の上限（${MAX_SESSIONS_PER_USER}件）に達しました。不要なセッションを削除してください。` },
          429,
        );
      }
    }

    const id = crypto.randomUUID();
    if (user) {
      db.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(id, theme.trim(), user.id);
    } else {
      db.prepare("INSERT INTO sessions (id, theme, user_id, is_public) VALUES (?, ?, NULL, 1)").run(id, theme.trim());
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
crudRoutes.get("/sessions", (c) => {
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
      if (s.status === SESSION_STATUS.RESPONDENT_DONE) s.display_status = "analyzed";
    });
    return c.json(sessions);
  } catch (e) {
    console.error("List sessions error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 3. GET /sessions/:id — Get session with messages & analysis (owner or public)
crudRoutes.get("/sessions/:id", (c) => {
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
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 4. DELETE /sessions/:id — Delete session + related data (owner only)
crudRoutes.delete("/sessions/:id", (c) => {
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
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 4b. PATCH /sessions/:id/visibility — Toggle public/private (owner only)
crudRoutes.patch("/sessions/:id/visibility", async (c) => {
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
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
