import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock static file serving to avoid filesystem access in tests
vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => await next(),
}));

// node:sqlite でテスト用 DB を作成（ネイティブバイナリ不要）
vi.mock("../../db/index.ts", async () => {
  const { createTestDb } = await import("../helpers/test-db.ts");
  return { db: createTestDb() };
});

// Mock LLM (feedbackルートでは使わないが、app.ts の依存で必要)
vi.mock("../../llm.ts", () => ({
  MODEL_FAST: "claude-haiku-4-5-20250929",
  MODEL_SMART: "claude-sonnet-4-5-20250929",
  callClaude: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "モック LLM レスポンス" }],
  }),
  extractText: vi.fn().mockReturnValue("モック LLM レスポンス"),
}));

import { app } from "../../app.ts";
import { clearRateLimitMap } from "../../routes/feedback.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
const TEST_EXE_USER_ID = "exe-fb-001";
const TEST_EMAIL = "feedback-test@example.com";

async function authedRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", TEST_EXE_USER_ID);
  headers.set("x-exedev-email", TEST_EMAIL);
  return await app.request(path, { ...options, headers });
}

async function anonRequest(path: string, options: RequestInit = {}): Promise<Response> {
  return await app.request(path, options);
}

function postFeedback(
  body: Record<string, unknown>,
  options: { authed?: boolean; headers?: Record<string, string> } = {},
): Promise<Response> {
  const reqOptions: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify(body),
  };
  if (options.authed) {
    return authedRequest("/api/feedback", reqOptions);
  }
  return anonRequest("/api/feedback", reqOptions);
}

// ---------------------------------------------------------------------------
// Helper: clean tables using parameterized DELETE (not exec)
// ---------------------------------------------------------------------------
function cleanTables(): void {
  rawDb.prepare("DELETE FROM feedback").run();
  rawDb.prepare("DELETE FROM users").run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("フィードバック API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRateLimitMap();
    cleanTables();
  });

  // -------------------------------------------------------------------------
  // 正常系
  // -------------------------------------------------------------------------
  describe("POST /api/feedback — 正常送信", () => {
    it("未認証ユーザーがフィードバックを送信できること", async () => {
      // Given: 未認証ユーザー
      // When: フィードバックを送信
      const res = await postFeedback({
        type: "bug",
        message: "ボタンが動きません",
        page: "/session/abc",
      });

      // Then: 201で保存される
      expect(res.status).toBe(201);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(true);

      // DB に保存されていることを確認
      const row = rawDb.prepare("SELECT * FROM feedback").get() as any;
      expect(row.type).toBe("bug");
      expect(row.message).toBe("ボタンが動きません");
      expect(row.page).toBe("/session/abc");
      expect(row.user_id).toBeNull();
    });

    it("認証済みユーザーがフィードバックを送信すると user_id が記録されること", async () => {
      // Given: 認証済みユーザー
      // When: フィードバックを送信
      const res = await postFeedback({ type: "feature", message: "ダークモードが欲しい" }, { authed: true });

      // Then: 201で user_id 付きで保存される
      expect(res.status).toBe(201);
      const row = rawDb.prepare("SELECT * FROM feedback").get() as any;
      expect(row.type).toBe("feature");
      expect(row.message).toBe("ダークモードが欲しい");
      expect(row.user_id).toBeTruthy();
    });

    it("type が 'other' でも正常に送信できること", async () => {
      const res = await postFeedback({
        type: "other",
        message: "その他のフィードバック",
      });
      expect(res.status).toBe(201);
    });

    it("page が省略された場合 null で保存されること", async () => {
      const res = await postFeedback({
        type: "bug",
        message: "ページ指定なし",
      });
      expect(res.status).toBe(201);
      const row = rawDb.prepare("SELECT * FROM feedback").get() as any;
      expect(row.page).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // バリデーションエラー
  // -------------------------------------------------------------------------
  describe("POST /api/feedback — バリデーションエラー", () => {
    it("メッセージが空の場合 400 を返すこと", async () => {
      const res = await postFeedback({
        type: "bug",
        message: "",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain("メッセージを入力してください");
    });

    it("メッセージが5001文字を超える場合 400 を返すこと", async () => {
      const longMessage = "あ".repeat(5001);
      const res = await postFeedback({
        type: "bug",
        message: longMessage,
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain("5000文字以内");
    });

    it("type が不正な場合 400 を返すこと", async () => {
      const res = await postFeedback({
        type: "invalid",
        message: "テスト",
      });
      expect(res.status).toBe(400);
    });

    it("type が省略された場合 400 を返すこと", async () => {
      const res = await postFeedback({
        message: "テスト",
      });
      expect(res.status).toBe(400);
    });

    it("message が省略された場合 400 を返すこと", async () => {
      const res = await postFeedback({
        type: "bug",
      });
      expect(res.status).toBe(400);
    });

    it("不正な JSON の場合 400 を返すこと", async () => {
      const res = await anonRequest("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // レート制限
  // -------------------------------------------------------------------------
  describe("POST /api/feedback — レート制限", () => {
    it("同一IPから60秒以内に2回送信すると429を返すこと", async () => {
      // Given: 1回目の送信が成功
      const res1 = await postFeedback(
        { type: "bug", message: "1回目" },
        { headers: { "x-forwarded-for": "192.168.1.100" } },
      );
      expect(res1.status).toBe(201);

      // When: 同一IPから2回目を送信
      const res2 = await postFeedback(
        { type: "bug", message: "2回目" },
        { headers: { "x-forwarded-for": "192.168.1.100" } },
      );

      // Then: レート制限で拒否
      expect(res2.status).toBe(429);
      const data = (await res2.json()) as { error: string };
      expect(data.error).toContain("60秒");
    });

    it("異なるIPからの送信はレート制限されないこと", async () => {
      const res1 = await postFeedback({ type: "bug", message: "IP A" }, { headers: { "x-forwarded-for": "10.0.0.1" } });
      expect(res1.status).toBe(201);

      const res2 = await postFeedback({ type: "bug", message: "IP B" }, { headers: { "x-forwarded-for": "10.0.0.2" } });
      expect(res2.status).toBe(201);
    });
  });
});
