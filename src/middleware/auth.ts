import crypto from "node:crypto";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { now } from "../db/helpers.ts";
import { db } from "../db/index.ts";
import type { User } from "../types.ts";

/**
 * Authentication middleware with 4-tier fallback:
 * 1. Cookie session (deepform_session) → auth_sessions table → user
 * 2. API Key (Authorization: Bearer deepform_... or X-API-Key: deepform_...)
 * 3. exe.dev proxy headers (X-ExeDev-UserID / X-ExeDev-Email)
 * 4. Dev env var fallback (EXEDEV_DEV_USER)
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

/** Hash a raw API key with SHA-256 */
export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

async function getUserFromApiKey(rawKey: string): Promise<User | null> {
  const keyHash = hashApiKey(rawKey);
  const row = (await db
    .selectFrom("users as u")
    .innerJoin("api_keys as ak", "ak.user_id", "u.id")
    .selectAll("u")
    .where("ak.key_hash", "=", keyHash)
    .where("ak.is_active", "=", 1)
    .executeTakeFirst()) as unknown as User | undefined;

  if (row) {
    // Update last_used_at asynchronously (fire-and-forget)
    db.updateTable("api_keys")
      .set({ last_used_at: new Date().toISOString() })
      .where("key_hash", "=", keyHash)
      .execute()
      .catch(() => {});
  }

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

  // 2. API Key (Bearer deepform_... or X-API-Key: deepform_...)
  const authHeader = c.req.header("authorization");
  const xApiKey = c.req.header("x-api-key");
  const rawKey = authHeader?.startsWith("Bearer deepform_")
    ? authHeader.slice(7)
    : xApiKey?.startsWith("deepform_")
      ? xApiKey
      : null;

  if (rawKey) {
    try {
      const user = await getUserFromApiKey(rawKey);
      if (user) {
        c.set("user", user);
        return next();
      }
    } catch (e) {
      console.error("API key lookup error:", e);
    }
  }

  // 3. exe.dev proxy headers
  let exeUserId = c.req.header("x-exedev-userid");
  let email = c.req.header("x-exedev-email");

  // 4. Local dev fallback (any non-production environment)
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
