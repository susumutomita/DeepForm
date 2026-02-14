import crypto from "node:crypto";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { now } from "../db/helpers.ts";
import { db } from "../db/index.ts";
import type { User } from "../types.ts";

/**
 * Authentication middleware with 3-tier fallback:
 * 1. Cookie session (deepform_session) → auth_sessions table → user
 * 2. exe.dev proxy headers (X-ExeDev-UserID / X-ExeDev-Email)
 * 3. Dev env var fallback (EXEDEV_DEV_USER)
 */

async function upsertUser(exeUserId: string, email: string): Promise<User> {
  const existing = (await db
    .selectFrom("users")
    .selectAll()
    .where("exe_user_id", "=", exeUserId)
    .executeTakeFirst()) as unknown as User | undefined;

  if (existing) {
    await db.updateTable("users").set({ email, updated_at: now() }).where("id", "=", existing.id).execute();
    return (await db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", existing.id)
      .executeTakeFirst()) as unknown as User;
  }

  const id = crypto.randomUUID();
  const displayName = email.split("@")[0];
  await db.insertInto("users").values({ id, exe_user_id: exeUserId, email, display_name: displayName }).execute();

  return {
    id,
    exe_user_id: exeUserId,
    email,
    display_name: displayName,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function getUserFromSession(sessionId: string): Promise<User | null> {
  const row = (await db
    .selectFrom("users as u")
    .innerJoin("auth_sessions as s", "s.user_id", "u.id")
    .selectAll("u")
    .where("s.id", "=", sessionId)
    .where("s.expires_at", ">", new Date().toISOString())
    .executeTakeFirst()) as unknown as User | undefined;
  return row ?? null;
}

// Middleware: attach user info to Context (not required)
export const authMiddleware = createMiddleware<{
  Variables: { user: User | null };
}>(async (c, next) => {
  // 1. Cookie-based session
  const sessionId = getCookie(c, "deepform_session");
  if (sessionId) {
    try {
      const user = await getUserFromSession(sessionId);
      if (user) {
        c.set("user", user);
        return next();
      }
    } catch (e) {
      console.error("Session lookup error:", e);
    }
  }

  // 2. exe.dev proxy headers
  let exeUserId = c.req.header("x-exedev-userid");
  let email = c.req.header("x-exedev-email");

  // 3. Local dev fallback (any non-production environment)
  if (!exeUserId && process.env.NODE_ENV !== "production") {
    exeUserId = process.env.EXEDEV_DEV_USER ?? undefined;
    email = process.env.EXEDEV_DEV_EMAIL ?? undefined;
  }

  if (exeUserId && email) {
    try {
      const user = await upsertUser(exeUserId, email);
      c.set("user", user);
    } catch (e) {
      console.error("Auth upsert error:", e);
      c.set("user", null);
    }
  } else {
    c.set("user", null);
  }

  return next();
});

// Middleware: require authentication
export const requireAuth = createMiddleware<{
  Variables: { user: User };
}>(async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "ログインが必要です" }, 401);
  }
  return next();
});
