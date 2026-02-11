import crypto from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    db.exec("DELETE FROM auth_sessions");
    db.exec("DELETE FROM users");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // NODE_ENV をテスト環境に戻す
    process.env.NODE_ENV = "test";
    delete process.env.EXEDEV_DEV_USER;
    delete process.env.EXEDEV_DEV_EMAIL;
  });

  describe("authMiddleware", () => {
    let app: InstanceType<typeof Hono>;

    beforeEach(() => {
      app = new Hono();
      app.use("*", authMiddleware);
      app.get("/test", (c) => c.json({ user: (c as any).get("user") }));
    });

    it("有効なヘッダーがある場合に新規ユーザーを作成すべき", async () => {
      // Given: 認証ヘッダーが付与されたリクエスト
      const headers = authHeaders();

      // When: リクエストを送信する
      const res = await app.request("/test", { headers });

      // Then: ユーザーが作成されて返される
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user).not.toBeNull();
      expect(data.user.exe_user_id).toBe(TEST_EXE_USER_ID);
      expect(data.user.email).toBe(TEST_EMAIL);
      expect(data.user.display_name).toBe("testuser");
    });

    it("既存ユーザーのメールアドレスを更新すべき", async () => {
      // Given: 既にユーザーが存在する
      await app.request("/test", { headers: authHeaders() });

      // When: 同じユーザーIDで異なるメールアドレスのリクエストを送信する
      const res = await app.request("/test", {
        headers: authHeaders(TEST_EXE_USER_ID, "newemail@example.com"),
      });

      // Then: メールアドレスが更新される
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user.email).toBe("newemail@example.com");
      expect(data.user.exe_user_id).toBe(TEST_EXE_USER_ID);
    });

    it("ヘッダーがない場合にユーザーを null に設定すべき", async () => {
      // Given: ヘッダーなしのリクエスト

      // When: リクエストを送信する
      const res = await app.request("/test");

      // Then: user は null になる
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.user).toBeNull();
    });

    it("x-exedev-userid のみでメールがない場合にユーザーを null にすべき", async () => {
      // Given: userid ヘッダーのみ付与されたリクエスト
      const headers = { "x-exedev-userid": TEST_EXE_USER_ID };

      // When: リクエストを送信する
      const res = await app.request("/test", { headers });

      // Then: user は null になる
      const data = (await res.json()) as any;
      expect(data.user).toBeNull();
    });

    it("x-exedev-email のみで userid がない場合にユーザーを null にすべき", async () => {
      // Given: email ヘッダーのみ付与されたリクエスト
      const headers = { "x-exedev-email": TEST_EMAIL };

      // When: リクエストを送信する
      const res = await app.request("/test", { headers });

      // Then: user は null になる
      const data = (await res.json()) as any;
      expect(data.user).toBeNull();
    });

    it("異なるユーザー ID に対して別のユーザーを作成すべき", async () => {
      // Given: 1人目のユーザーが既に作成済み
      await app.request("/test", { headers: authHeaders() });

      // When: 別のユーザーIDでリクエストを送信する
      const res = await app.request("/test", {
        headers: authHeaders("other-exe-user", "other@example.com"),
      });

      // Then: 別のユーザーが作成され、合計2人になる
      const data = (await res.json()) as any;
      expect(data.user.exe_user_id).toBe("other-exe-user");
      const count = db.prepare("SELECT COUNT(*) as cnt FROM users").get() as any;
      expect(count.cnt).toBe(2);
    });

    describe("開発モードフォールバック", () => {
      it("NODE_ENV=development で環境変数からユーザー情報を取得すべき", async () => {
        // Given: 開発モードで環境変数が設定されている
        process.env.NODE_ENV = "development";
        process.env.EXEDEV_DEV_USER = "dev-user-001";
        process.env.EXEDEV_DEV_EMAIL = "devuser@example.com";

        // When: ヘッダーなしでリクエストを送信する
        const res = await app.request("/test");

        // Then: 環境変数からユーザーが作成される
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.user).not.toBeNull();
        expect(data.user.exe_user_id).toBe("dev-user-001");
        expect(data.user.email).toBe("devuser@example.com");
      });

      it("NODE_ENV=development でも環境変数がない場合にユーザーを null にすべき", async () => {
        // Given: 開発モードだが環境変数が未設定
        process.env.NODE_ENV = "development";
        delete process.env.EXEDEV_DEV_USER;
        delete process.env.EXEDEV_DEV_EMAIL;

        // When: ヘッダーなしでリクエストを送信する
        const res = await app.request("/test");

        // Then: user は null になる
        const data = (await res.json()) as any;
        expect(data.user).toBeNull();
      });

      it("ヘッダーがある場合は開発モードフォールバックを使用しないこと", async () => {
        // Given: 開発モードで環境変数があるが、ヘッダーも付与されている
        process.env.NODE_ENV = "development";
        process.env.EXEDEV_DEV_USER = "dev-user-001";
        process.env.EXEDEV_DEV_EMAIL = "devuser@example.com";

        // When: ヘッダー付きでリクエストを送信する
        const res = await app.request("/test", { headers: authHeaders() });

        // Then: ヘッダーのユーザー情報が使用される
        const data = (await res.json()) as any;
        expect(data.user.exe_user_id).toBe(TEST_EXE_USER_ID);
      });
    });

    describe("upsert エラーハンドリング", () => {
      it("DB エラー発生時にユーザーを null に設定しエラーをログ出力すべき", async () => {
        // Given: db.prepare が例外をスローするように設定する
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const originalPrepare = db.prepare.bind(db);
        vi.spyOn(db, "prepare").mockImplementation(() => {
          throw new Error("DB error");
        });

        // When: 有効なヘッダー付きでリクエストを送信する
        const res = await app.request("/test", { headers: authHeaders() });

        // Then: user は null になり、エラーがログ出力される
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.user).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith("Auth upsert error:", expect.any(Error));

        // クリーンアップ
        vi.mocked(db.prepare).mockImplementation(originalPrepare);
      });
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
      // Given: 認証ヘッダーが付与されたリクエスト
      const headers = authHeaders();

      // When: 保護リソースにアクセスする
      const res = await app.request("/protected/resource", { headers });

      // Then: 200 が返り、リソースにアクセスできる
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
    });

    it("未認証の場合に 401 を返すべき", async () => {
      // Given: ヘッダーなしのリクエスト

      // When: 保護リソースにアクセスする
      const res = await app.request("/protected/resource");

      // Then: 401 エラーが返る
      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error).toBe("ログインが必要です");
    });

    it("ヘッダーが不完全な場合に 401 を返すべき", async () => {
      // Given: userid ヘッダーのみ（email なし）のリクエスト
      const headers = { "x-exedev-userid": TEST_EXE_USER_ID };

      // When: 保護リソースにアクセスする
      const res = await app.request("/protected/resource", { headers });

      // Then: 401 エラーが返る
      expect(res.status).toBe(401);
    });
  });
});
