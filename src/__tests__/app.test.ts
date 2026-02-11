import { describe, expect, it, vi } from "vitest";

// node:sqlite でテスト用 DB を作成（ネイティブバイナリ不要）
vi.mock("../db.ts", async () => {
  const { createTestDb } = await import("./helpers/test-db.ts");
  return { db: createTestDb() };
});

// 静的ファイル配信のモック
vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => await next(),
}));

// LLM モック
vi.mock("../llm.ts", () => ({
  callClaude: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "モック応答" }],
  }),
  extractText: vi.fn().mockReturnValue("モック応答"),
}));

import { app } from "../app.ts";

describe("Hono アプリケーション", () => {
  it("未知の API パスに対して 404 を返すべき", async () => {
    const res = await app.request("/api/unknown-endpoint");
    expect(res.status).toBe(404);
  });

  it("ヘルスチェック的にルートにアクセスできるべき", async () => {
    const res = await app.request("/");
    // serveStatic をモックしているので 404 になりうるが、サーバーエラーではない
    expect(res.status).toBeLessThan(500);
  });

  it("API ルートが登録されているべき", async () => {
    // POST /api/sessions は認証が必要なので 401
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "テスト" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/sessions が公開セッション一覧を返すべき", async () => {
    const res = await app.request("/api/sessions");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });
});
