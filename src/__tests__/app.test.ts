import { describe, expect, it, vi } from "vitest";

// node:sqlite でテスト用 DB を作成（ネイティブバイナリ不要）
vi.mock("../db/index.ts", async () => {
  const { createTestDb } = await import("./helpers/test-db.ts");
  return { db: createTestDb() };
});

// 静的ファイル配信のモック――テストごとに挙動を切り替え可能
let serveStaticBehavior: (c: any, next: any) => Promise<any> = async (_c, next) => await next();
vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (c: any, next: any) => serveStaticBehavior(c, next),
}));

// LLM モック
vi.mock("../llm.ts", () => ({
  MODEL_FAST: "claude-haiku-4-5-20250929",
  MODEL_SMART: "claude-sonnet-4-5-20250929",
  callClaude: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "モック応答" }],
  }),
  extractText: vi.fn().mockReturnValue("モック応答"),
}));

import { app } from "../app.ts";

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
const authHeaders: Record<string, string> = {
  "x-exedev-userid": "test-user",
  "x-exedev-email": "test@example.com",
};

describe("Hono アプリケーション", () => {
  // -------------------------------------------------------------------------
  // ルーティング基本動作
  // -------------------------------------------------------------------------
  describe("ルーティング", () => {
    it("未知の API パスに対して 404 を返すべき", async () => {
      // Given: 存在しない API パス
      const path = "/api/unknown-endpoint";

      // When: リクエストを送信
      const res = await app.request(path);

      // Then: 404 が返る
      expect(res.status).toBe(404);
    });

    it("ルートにアクセスしてもサーバーエラーにならないこと", async () => {
      // Given: ルートパス
      const path = "/";

      // When: リクエストを送信
      const res = await app.request(path);

      // Then: 500 未満のステータスが返る
      expect(res.status).toBeLessThan(500);
    });

    it("API ルートが登録されているべき（POST /api/sessions は認証なしで 401）", async () => {
      // Given: 認証ヘッダーなしのリクエスト
      const options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "テスト" }),
      };

      // When: セッション作成 API を叩く
      const res = await app.request("/api/sessions", options);

      // Then: ゲストアクセスでセッション作成可能 (200)
      expect(res.status).toBe(200);
    });

    it("GET /api/sessions が公開セッション一覧を返すべき", async () => {
      // Given: 認証なし
      // When: セッション一覧を取得
      const res = await app.request("/api/sessions");

      // Then: 200 と配列が返る
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // onError ハンドラー
  // -------------------------------------------------------------------------
  describe("onError ハンドラー", () => {
    it("HTTPException が投げられた場合にそのステータスとメッセージを返すべき", async () => {
      // Given: bodyLimit を超える Content-Length ヘッダー（10MB 超）
      //        Content-Length があると bodyLimit が同期的に HTTPException(413) を投げる
      const oversizedLength = (10 * 1024 * 1024 + 1).toString();

      // When: /api/* に対して巨大 Content-Length を指定して POST
      const res = await app.request("/api/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": oversizedLength,
        },
        body: "x",
      });

      // Then: 413 (Payload Too Large) が onError 経由で返る
      expect(res.status).toBe(413);
      const data = (await res.json()) as any;
      expect(data).toHaveProperty("error");
    });

    it("一般的な Error が投げられた場合に 500 Internal Server Error を返すべき", async () => {
      // Given: serveStatic モックを一時的に変更し、一般エラーを投げるようにする
      const original = serveStaticBehavior;
      serveStaticBehavior = async () => {
        throw new Error("テスト用の内部エラー");
      };

      try {
        // When: 非 API ルートにアクセス（serveStatic を通過）
        const res = await app.request("/some-static-page");

        // Then: 500 と "Internal Server Error" が返る
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toBe("Internal Server Error");
      } finally {
        // teardown: 元の挙動に戻す
        serveStaticBehavior = original;
      }
    });
  });

  // -------------------------------------------------------------------------
  // 認証ルート (src/routes/auth.ts)
  // -------------------------------------------------------------------------
  describe("認証ルート", () => {
    describe("GET /api/auth/me", () => {
      it("未認証の場合に { user: null } を返すべき", async () => {
        // Given: 認証ヘッダーなし
        // When: /api/auth/me にアクセス
        const res = await app.request("/api/auth/me");

        // Then: user が null
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.user).toBeNull();
      });

      it("認証済みの場合にユーザー情報を返すべき", async () => {
        // Given: 認証ヘッダーあり
        // When: /api/auth/me にアクセス
        const res = await app.request("/api/auth/me", {
          headers: authHeaders,
        });

        // Then: ユーザー情報が返る
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.user).not.toBeNull();
        expect(data.user.id).toBeDefined();
        expect(data.user.email).toBe("test@example.com");
        expect(data.user.displayName).toBeDefined();
      });
    });

    describe("POST /api/auth/logout", () => {
      it("{ ok: true } を返すべき", async () => {
        // Given: logout エンドポイント
        // When: POST リクエストを送信
        const res = await app.request("/api/auth/logout", {
          method: "POST",
        });

        // Then: { ok: true } が返る
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);
      });
    });
  });
});
