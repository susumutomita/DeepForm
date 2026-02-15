import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => await next(),
}));

vi.mock("../../db/index.ts", async () => {
  const { createTestDb } = await import("../helpers/test-db.ts");
  return { db: createTestDb() };
});

vi.mock("../../llm.ts", () => ({
  callClaude: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "test" }],
  }),
  callClaudeStream: vi.fn(),
  extractText: vi.fn().mockReturnValue("test"),
}));

import { app } from "../../app.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

function getPageViews(): any[] {
  return rawDb.prepare("SELECT * FROM page_views ORDER BY id").all() as any[];
}

describe("Analytics Middleware", () => {
  beforeEach(() => {
    rawDb.exec("DELETE FROM page_views");
    rawDb.exec("DELETE FROM auth_sessions");
    rawDb.exec("DELETE FROM users");
  });

  it("HTMLページのアクセスを記録すべき", async () => {
    await app.request("/", {
      headers: { "User-Agent": "TestBot/1.0", "X-Forwarded-For": "1.2.3.4" },
    });
    const views = getPageViews();
    expect(views.length).toBe(1);
    expect(views[0].path).toBe("/");
    expect(views[0].ip_address).toBe("1.2.3.4");
  });

  it("静的ファイルはスキップすべき", async () => {
    await app.request("/assets/index.js");
    await app.request("/style.css");
    await app.request("/logo.png");
    const views = getPageViews();
    expect(views.length).toBe(0);
  });

  it("APIパスはスキップすべき", async () => {
    await app.request("/api/sessions");
    const views = getPageViews();
    expect(views.length).toBe(0);
  });

  it("x-forwarded-for からIPを抽出すべき", async () => {
    await app.request("/page1", {
      headers: { "X-Forwarded-For": "10.0.0.1, 10.0.0.2", "User-Agent": "ua-ip1" },
    });
    const views = getPageViews();
    expect(views[0].ip_address).toBe("10.0.0.1");
  });

  it("x-real-ip をフォールバックとして使うべき", async () => {
    await app.request("/page2", {
      headers: { "X-Real-Ip": "192.168.1.1", "User-Agent": "ua-ip2" },
    });
    const views = getPageViews();
    expect(views[0].ip_address).toBe("192.168.1.1");
  });

  it("UTMパラメータを抽出すべき", async () => {
    await app.request("/landing?utm_source=google&utm_medium=cpc&utm_campaign=spring", {
      headers: { "User-Agent": "ua-utm", "X-Forwarded-For": "5.5.5.5" },
    });
    const views = getPageViews();
    expect(views[0].utm_source).toBe("google");
    expect(views[0].utm_medium).toBe("cpc");
    expect(views[0].utm_campaign).toBe("spring");
  });

  it("同じフィンガープリント+パスは5分以内に重複排除すべき", async () => {
    const headers = { "User-Agent": "dedup-ua", "X-Forwarded-For": "9.9.9.9" };
    await app.request("/dedup-page", { headers });
    await app.request("/dedup-page", { headers });
    await app.request("/dedup-page", { headers });
    const views = getPageViews();
    expect(views.length).toBe(1);
  });

  it("異なるパスは別々に記録すべき", async () => {
    const headers = { "User-Agent": "multi-ua", "X-Forwarded-For": "8.8.8.8" };
    await app.request("/page-a", { headers });
    await app.request("/page-b", { headers });
    const views = getPageViews();
    expect(views.length).toBe(2);
  });

  it("認証済みユーザーのuser_idを記録すべき", async () => {
    await app.request("/authed-page", {
      headers: {
        "User-Agent": "authed-ua",
        "X-Forwarded-For": "7.7.7.7",
        "x-exedev-userid": "exe-analytics-001",
        "x-exedev-email": "analytics@test.com",
      },
    });
    const views = getPageViews();
    expect(views[0].user_id).not.toBeNull();
  });
});
