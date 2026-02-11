import crypto from "node:crypto";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// node:sqlite でテスト用 DB を作成（ネイティブバイナリ不要）
vi.mock("../../db.ts", async () => {
  const { createTestDb } = await import("../helpers/test-db.ts");
  return { db: createTestDb() };
});

import { db } from "../../db.ts";
import { authMiddleware, requireAuth } from "../../middleware/auth.ts";

// Replicate sign logic for creating test cookies
const SESSION_SECRET = "dev-secret-change-me";
const COOKIE_NAME = "deepform_session";

function sign(value: string): string {
  return `${value}.${crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url")}`;
}

function createCookie(userId: string, expiry?: number): string {
  const payload = JSON.stringify({
    userId,
    expiry: expiry ?? Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  return encodeURIComponent(sign(payload));
}

const TEST_USER = {
  id: "test-user-auth-123",
  github_id: 99999,
  github_login: "testuser",
  avatar_url: null,
};

describe("認証ミドルウェア", () => {
  beforeEach(() => {
    db.exec("DELETE FROM users");
    db.prepare("INSERT INTO users (id, github_id, github_login, avatar_url) VALUES (?, ?, ?, ?)").run(
      TEST_USER.id,
      TEST_USER.github_id,
      TEST_USER.github_login,
      null,
    );
  });

  describe("署名の生成と検証", () => {
    it("正しく署名された Cookie からユーザーを取得できるべき", async () => {
      const app = new Hono();
      app.use("*", authMiddleware);
      app.get("/test", (c) => c.json({ user: (c as any).get("user") }));

      const cookie = createCookie(TEST_USER.id);
      const res = await app.request("/test", {
        headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user).not.toBeNull();
      expect(data.user.id).toBe(TEST_USER.id);
      expect(data.user.github_login).toBe("testuser");
    });

    it("改ざんされた署名の場合にユーザーを null にすべき", async () => {
      const app = new Hono();
      app.use("*", authMiddleware);
      app.get("/test", (c) => c.json({ user: (c as any).get("user") }));

      const payload = JSON.stringify({
        userId: TEST_USER.id,
        expiry: Date.now() + 100000,
      });
      const tampered = encodeURIComponent(`${payload}.invalid-signature`);

      const res = await app.request("/test", {
        headers: { Cookie: `${COOKIE_NAME}=${tampered}` },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user).toBeNull();
    });

    it("ドットを含まない Cookie 値の場合にユーザーを null にすべき", async () => {
      const app = new Hono();
      app.use("*", authMiddleware);
      app.get("/test", (c) => c.json({ user: (c as any).get("user") }));

      const res = await app.request("/test", {
        headers: { Cookie: `${COOKIE_NAME}=${encodeURIComponent("no-dot-here")}` },
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

    it("有効な Cookie がある場合にユーザー情報を設定すべき", async () => {
      const cookie = createCookie(TEST_USER.id);
      const res = await app.request("/test", {
        headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user.id).toBe(TEST_USER.id);
      expect(data.user.github_login).toBe("testuser");
    });

    it("Cookie がない場合にユーザーを null に設定すべき", async () => {
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user).toBeNull();
    });

    it("期限切れの Cookie の場合にユーザーを null に設定すべき", async () => {
      const cookie = createCookie(TEST_USER.id, Date.now() - 1000);
      const res = await app.request("/test", {
        headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user).toBeNull();
    });

    it("無効な署名の Cookie の場合にユーザーを null に設定すべき", async () => {
      const res = await app.request("/test", {
        headers: { Cookie: `${COOKIE_NAME}=${encodeURIComponent("invalid.cookie.value")}` },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user).toBeNull();
    });

    it("存在しないユーザー ID の Cookie の場合にユーザーを null に設定すべき", async () => {
      const cookie = createCookie("nonexistent-user-id");
      const res = await app.request("/test", {
        headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user).toBeNull();
    });

    it("不正な JSON ペイロードの Cookie の場合にユーザーを null に設定すべき", async () => {
      const badPayload = "not-valid-json";
      const cookie = encodeURIComponent(sign(badPayload));
      const res = await app.request("/test", {
        headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user).toBeNull();
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
      const cookie = createCookie(TEST_USER.id);
      const res = await app.request("/protected/resource", {
        headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
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

    it("期限切れ Cookie の場合に 401 を返すべき", async () => {
      const cookie = createCookie(TEST_USER.id, Date.now() - 1000);
      const res = await app.request("/protected/resource", {
        headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
      });

      expect(res.status).toBe(401);
    });
  });
});
