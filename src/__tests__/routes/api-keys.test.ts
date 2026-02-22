import crypto from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/index.ts", async () => {
  const { createTestDb } = await import("../helpers/test-db.ts");
  return { db: createTestDb() };
});

import { authMiddleware, hashApiKey } from "../../middleware/auth.ts";
import { apiKeyRoutes } from "../../routes/api-keys.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

const TEST_USER_ID = "user-apikey-test";
const TEST_EXE_USER_ID = "exe-apikey-test";
const TEST_EMAIL = "apikey@example.com";

function createApp() {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.route("/api/auth/api-keys", apiKeyRoutes);
  return app;
}

function authHeaders(): Record<string, string> {
  return {
    "x-exedev-userid": TEST_EXE_USER_ID,
    "x-exedev-email": TEST_EMAIL,
  };
}

function seedUser() {
  rawDb.exec(`
    INSERT OR IGNORE INTO users (id, exe_user_id, email, display_name)
    VALUES ('${TEST_USER_ID}', '${TEST_EXE_USER_ID}', '${TEST_EMAIL}', 'apikey-tester')
  `);
}

describe("API キー管理", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    rawDb.exec("DELETE FROM api_keys");
    rawDb.exec("DELETE FROM auth_sessions");
    rawDb.exec("DELETE FROM users");
    seedUser();
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.NODE_ENV = "test";
  });

  describe("POST /api/auth/api-keys", () => {
    it("新しい API キーを作成して 201 を返すべき", async () => {
      const res = await app.request("/api/auth/api-keys", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ name: "CI キー" }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.key).toMatch(/^deepform_/);
      expect(data.key).toHaveLength(49); // "deepform_" (9) + 40 hex chars
      expect(data.name).toBe("CI キー");
      expect(data.key_prefix).toBe(data.key.slice(0, 12));
      expect(data.id).toBeDefined();
    });

    it("DB にハッシュが保存されるべき", async () => {
      const res = await app.request("/api/auth/api-keys", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      });

      const data = (await res.json()) as any;
      const row = rawDb.prepare("SELECT key_hash FROM api_keys WHERE id = ?").get(data.id) as any;
      expect(row.key_hash).toBe(hashApiKey(data.key));
    });

    it("名前が空の場合に 400 を返すべき", async () => {
      const res = await app.request("/api/auth/api-keys", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ name: "" }),
      });

      expect(res.status).toBe(400);
    });

    it("上限を超えた場合に 400 を返すべき", async () => {
      // 10 個のキーを作成
      for (let i = 0; i < 10; i++) {
        const rawKey = `deepform_${crypto.randomBytes(20).toString("hex")}`;
        rawDb
          .prepare("INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)")
          .run(`key-${i}`, TEST_USER_ID, `key ${i}`, hashApiKey(rawKey), rawKey.slice(0, 12));
      }

      const res = await app.request("/api/auth/api-keys", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ name: "11th key" }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain("10");
    });

    it("未認証の場合に 401 を返すべき", async () => {
      const res = await app.request("/api/auth/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/auth/api-keys", () => {
    it("自分のキーのみ返すべき", async () => {
      // 自分のキーを作成
      rawDb
        .prepare("INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)")
        .run("my-key-1", TEST_USER_ID, "My Key", "hash1", "deepform_abc");

      // 他ユーザーのキーを作成
      rawDb.exec(
        "INSERT OR IGNORE INTO users (id, exe_user_id, email) VALUES ('other-user', 'exe-other', 'other@example.com')",
      );
      rawDb
        .prepare("INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)")
        .run("other-key", "other-user", "Other Key", "hash2", "deepform_xyz");

      const res = await app.request("/api/auth/api-keys", {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.keys).toHaveLength(1);
      expect(data.keys[0].name).toBe("My Key");
    });

    it("レスポンスに key_hash を含まないべき", async () => {
      rawDb
        .prepare("INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)")
        .run("my-key-2", TEST_USER_ID, "Key", "secret-hash", "deepform_abc");

      const res = await app.request("/api/auth/api-keys", {
        headers: authHeaders(),
      });

      const data = (await res.json()) as any;
      expect(data.keys[0]).not.toHaveProperty("key_hash");
      expect(data.keys[0]).not.toHaveProperty("user_id");
    });

    it("無効化されたキーを返さないべき", async () => {
      rawDb
        .prepare("INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, is_active) VALUES (?, ?, ?, ?, ?, ?)")
        .run("revoked-key", TEST_USER_ID, "Revoked", "hash3", "deepform_zzz", 0);

      const res = await app.request("/api/auth/api-keys", {
        headers: authHeaders(),
      });

      const data = (await res.json()) as any;
      expect(data.keys).toHaveLength(0);
    });

    it("未認証の場合に 401 を返すべき", async () => {
      const res = await app.request("/api/auth/api-keys");
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /api/auth/api-keys/:id", () => {
    it("キーを無効化すべき (is_active=0)", async () => {
      rawDb
        .prepare("INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)")
        .run("del-key", TEST_USER_ID, "Delete Me", "hash-del", "deepform_del");

      const res = await app.request("/api/auth/api-keys/del-key", {
        method: "DELETE",
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const row = rawDb.prepare("SELECT is_active FROM api_keys WHERE id = ?").get("del-key") as any;
      expect(row.is_active).toBe(0);
    });

    it("他ユーザーのキーを削除できないべき (404)", async () => {
      rawDb.exec(
        "INSERT OR IGNORE INTO users (id, exe_user_id, email) VALUES ('other-user-2', 'exe-other-2', 'other2@example.com')",
      );
      rawDb
        .prepare("INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)")
        .run("other-key-2", "other-user-2", "Not Mine", "hash-other", "deepform_oth");

      const res = await app.request("/api/auth/api-keys/other-key-2", {
        method: "DELETE",
        headers: authHeaders(),
      });

      expect(res.status).toBe(404);
    });

    it("存在しないキー ID で 404 を返すべき", async () => {
      const res = await app.request("/api/auth/api-keys/nonexistent", {
        method: "DELETE",
        headers: authHeaders(),
      });

      expect(res.status).toBe(404);
    });

    it("未認証の場合に 401 を返すべき", async () => {
      const res = await app.request("/api/auth/api-keys/some-key", {
        method: "DELETE",
      });

      expect(res.status).toBe(401);
    });
  });
});
