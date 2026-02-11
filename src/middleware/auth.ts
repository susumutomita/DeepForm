import crypto from "node:crypto";
import { createMiddleware } from "hono/factory";
import { db } from "../db.ts";
import type { User } from "../types.ts";

/**
 * exe.dev Login 認証ミドルウェア。
 *
 * exe.dev のリバースプロキシが認証済みユーザーに対して
 * X-ExeDev-UserID / X-ExeDev-Email ヘッダーを付与する。
 * ローカル開発では EXEDEV_DEV_USER / EXEDEV_DEV_EMAIL 環境変数で代替可能。
 */

function upsertUser(exeUserId: string, email: string): User {
  const existing = db.prepare("SELECT * FROM users WHERE exe_user_id = ?").get(exeUserId) as unknown as
    | User
    | undefined;

  if (existing) {
    db.prepare("UPDATE users SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(email, existing.id);
    return { ...existing, email };
  }

  const id = crypto.randomUUID();
  const displayName = email.split("@")[0];
  db.prepare("INSERT INTO users (id, exe_user_id, email, display_name) VALUES (?, ?, ?, ?)").run(
    id,
    exeUserId,
    email,
    displayName,
  );

  return {
    id,
    exe_user_id: exeUserId,
    email,
    display_name: displayName,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// Middleware: attach user info to Context (not required)
export const authMiddleware = createMiddleware<{
  Variables: { user: User | null };
}>(async (c, next) => {
  // exe.dev proxy headers
  let exeUserId = c.req.header("x-exedev-userid");
  let email = c.req.header("x-exedev-email");

  // Local dev fallback
  if (!exeUserId && process.env.NODE_ENV !== "production") {
    exeUserId = process.env.EXEDEV_DEV_USER ?? undefined;
    email = process.env.EXEDEV_DEV_EMAIL ?? undefined;
  }

  if (exeUserId && email) {
    try {
      const user = upsertUser(exeUserId, email);
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
