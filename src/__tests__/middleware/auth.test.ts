import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// node:sqlite でテスト用 DB を作成（ネイティブバイナリ不要）
vi.mock("../../db.ts", async () => {
  const { createTestDb } = await import("../helpers/test-db.ts");
  return { db: createTestDb() };
});

import { db } from "../../db.ts";
import { authMiddleware, requireAuth } from "../../middleware/auth.ts";

const TEST_EXE_USER_ID = "exe-user-99999";
const TEST_EMAIL = "testuser@example.com";

function authHeaders(exeUserId: string = TEST_EXE_USER_ID, email: string = TEST_EMAIL): Record<string, string> {
  return {
    "x-exedev-userid": exeUserId,
    "x-exedev-email": email,
  };
}

describe("認証ミドルウェア", () => {
  beforeEach(() => {
    db.exec("DELETE FROM users");
  });

  describe("ヘッダーベース認証", () => {
    it("正しいヘッダーからユーザーを取得できるべき（自動作成）", async () => {
      const app = new Hono();
      app.use("*", authMiddleware);
      app.get("/test", (c) => c.json({ user: (c as any).get("user") }));

      const res = await app.request("/test", {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user).not.toBeNull();
      expect(data.user.exe_user_id).toBe(TEST_EXE_USER_ID);
      expect(data.user.email).toBe(TEST_EMAIL);
      expect(data.user.display_name).toBe("testuser");
    });

    it("ヘッダーがない場合にユーザーを null にすべき", async () => {
      const app = new Hono();
      app.use("*", authMiddleware);
      app.get("/test", (c) => c.json({ user: (c as any).get("user") }));

      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user).toBeNull();
    });

    it("x-exedev-userid のみでメールがない場合にユーザーを null にすべき", async () => {
      const app = new Hono();
      app.use("*", authMiddleware);
      app.get("/test", (c) => c.json({ user: (c as any).get("user") }));

      const res = await app.request("/test", {
        headers: { "x-exedev-userid": TEST_EXE_USER_ID },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user).toBeNull();
    });
  });

  describe("authMiddleware", () => {
    let app: InstanceType<typeof Hono>;

    beforeEach(() => {
      app = new Hono();
      app.use("*", authMiddleware);
      app.get("/test", (c) => c.json({ user: (c as any).get("user") }));
    });

    it("有効なヘッダーがある場合にユーザー情報を設定すべき", async () => {
      const res = await app.request("/test", {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user.exe_user_id).toBe(TEST_EXE_USER_ID);
      expect(data.user.email).toBe(TEST_EMAIL);
    });

    it("ヘッダーがない場合にユーザーを null に設定すべき", async () => {
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user).toBeNull();
    });

    it("既存ユーザーのメールアドレスを更新すべき", async () => {
      // First request creates the user
      await app.request("/test", { headers: authHeaders() });

      // Second request with updated email
      const res = await app.request("/test", {
        headers: authHeaders(TEST_EXE_USER_ID, "newemail@example.com"),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user.email).toBe("newemail@example.com");
      expect(data.user.exe_user_id).toBe(TEST_EXE_USER_ID);
    });

    it("異なるユーザー ID に対して別のユーザーを作成すべき", async () => {
      await app.request("/test", { headers: authHeaders() });

      const res = await app.request("/test", {
        headers: authHeaders("other-exe-user", "other@example.com"),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user.exe_user_id).toBe("other-exe-user");
      expect(data.user.email).toBe("other@example.com");

      // Should have 2 users in the DB
      const count = db.prepare("SELECT COUNT(*) as cnt FROM users").get() as any;
      expect(count.cnt).toBe(2);
    });
  });

  describe("requireAuth", () => {
    let app: InstanceType<typeof Hono>;

    beforeEach(() => {
      app = new Hono();
      app.use("*", authMiddleware);
      app.use("/protected/*", requireAuth);
      app.get("/protected/resource", (c) => c.json({ ok: true }));
    });

    it("認証済みユーザーの場合にアクセスを許可すべき", async () => {
      const res = await app.request("/protected/resource", {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
    });

    it("未認証の場合に 401 を返すべき", async () => {
      const res = await app.request("/protected/resource");

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error).toBe("ログインが必要です");
    });

    it("ヘッダーが不完全な場合に 401 を返すべき", async () => {
      const res = await app.request("/protected/resource", {
        headers: { "x-exedev-userid": TEST_EXE_USER_ID },
      });

      expect(res.status).toBe(401);
    });
  });
});
