import { Hono } from "hono";
import type { User } from "../types.ts";

const auth = new Hono<{ Variables: { user: User | null } }>();

/**
 * GET /api/auth/me — 現在のユーザー情報を返す。
 * exe.dev プロキシが付与するヘッダーから authMiddleware がユーザーを解決済み。
 */
auth.get("/me", (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ user: null });
  }
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
    },
  });
});

/**
 * POST /api/auth/logout — exe.dev 側のログアウトはクライアントが
 * /__exe.dev/logout に POST する。ここは互換性のために残す。
 */
auth.post("/logout", (c) => {
  return c.json({ ok: true });
});

export { auth as authRoutes };
