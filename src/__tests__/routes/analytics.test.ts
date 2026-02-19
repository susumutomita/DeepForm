import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => await next(),
}));

vi.mock("../../db/index.ts", async () => {
  const { createTestDb } = await import("../helpers/test-db.ts");
  return { db: createTestDb() };
});

vi.mock("../../llm.ts", () => ({
  MODEL_FAST: "claude-haiku-4-5-20250929",
  MODEL_SMART: "claude-sonnet-4-5-20250929",
  callClaude: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "モック LLM レスポンス" }],
  }),
  extractText: vi.fn().mockReturnValue("モック LLM レスポンス"),
}));

import { app } from "../../app.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
const ADMIN_EXE_USER_ID = "exe-admin-001";
const ADMIN_EMAIL = "oyster880@gmail.com"; // from ADMIN_EMAILS in constants.ts

const NON_ADMIN_EXE_USER_ID = "exe-user-001";
const NON_ADMIN_EMAIL = "regular@example.com";

async function adminRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", ADMIN_EXE_USER_ID);
  headers.set("x-exedev-email", ADMIN_EMAIL);
  return await app.request(path, { ...options, headers });
}

async function nonAdminRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", NON_ADMIN_EXE_USER_ID);
  headers.set("x-exedev-email", NON_ADMIN_EMAIL);
  return await app.request(path, { ...options, headers });
}

async function anonRequest(path: string, options: RequestInit = {}): Promise<Response> {
  return await app.request(path, options);
}

// ---------------------------------------------------------------------------
// Helper: insert page_view records
// ---------------------------------------------------------------------------
function insertPageView(overrides: Record<string, unknown> = {}): void {
  const defaults = {
    path: "/",
    method: "GET",
    status_code: 200,
    referer: null,
    user_agent: "test-ua",
    ip_address: "127.0.0.1",
    country: null,
    user_id: null,
    session_fingerprint: `fp-${Math.random().toString(36).slice(2, 10)}`,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    created_at: new Date().toISOString(),
  };
  const row = { ...defaults, ...overrides };
  rawDb
    .prepare(
      `INSERT INTO page_views (path, method, status_code, referer, user_agent, ip_address, country, user_id, session_fingerprint, utm_source, utm_medium, utm_campaign, created_at)
       VALUES (@path, @method, @status_code, @referer, @user_agent, @ip_address, @country, @user_id, @session_fingerprint, @utm_source, @utm_medium, @utm_campaign, @created_at)`,
    )
    .run(row);
}

function cleanTables(): void {
  rawDb.prepare("DELETE FROM page_views").run();
  rawDb.prepare("DELETE FROM users").run();
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("アナリティクス API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanTables();
  });

  // -------------------------------------------------------------------------
  // Admin middleware
  // -------------------------------------------------------------------------
  describe("Admin ミドルウェア", () => {
    it("未認証ユーザーは 403 を返すこと", async () => {
      const res = await anonRequest("/api/admin/analytics/stats");
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Forbidden");
    });

    it("非管理者ユーザーは 403 を返すこと", async () => {
      const res = await nonAdminRequest("/api/admin/analytics/stats");
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Forbidden");
    });
  });

  // -------------------------------------------------------------------------
  // GET /stats
  // -------------------------------------------------------------------------
  describe("GET /api/admin/analytics/stats", () => {
    it("デフォルトで 7d 期間のデータを返すこと", async () => {
      // Insert a view within 7 days
      insertPageView({ created_at: daysAgoISO(3), session_fingerprint: "fp-a" });
      // Insert a view older than 7 days (should be excluded)
      insertPageView({ created_at: daysAgoISO(10), session_fingerprint: "fp-old" });

      const res = await adminRequest("/api/admin/analytics/stats");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.period).toBe("7d");
      expect(Number(data.totalViews)).toBe(1);
    });

    it("period=24h で24時間以内のデータのみ返すこと", async () => {
      insertPageView({ created_at: hoursAgo(12), session_fingerprint: "fp-recent" });
      insertPageView({ created_at: daysAgoISO(3), session_fingerprint: "fp-old" });

      const res = await adminRequest("/api/admin/analytics/stats?period=24h");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.period).toBe("24h");
      expect(Number(data.totalViews)).toBe(1);
    });

    it("period=30d で30日以内のデータを返すこと", async () => {
      insertPageView({ created_at: daysAgoISO(20), session_fingerprint: "fp-20d" });
      insertPageView({ created_at: daysAgoISO(5), session_fingerprint: "fp-5d" });
      insertPageView({ created_at: daysAgoISO(40), session_fingerprint: "fp-40d" });

      const res = await adminRequest("/api/admin/analytics/stats?period=30d");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.period).toBe("30d");
      expect(Number(data.totalViews)).toBe(2);
    });

    it("totalViews がページビュー総数を返すこと", async () => {
      insertPageView({ session_fingerprint: "fp-1" });
      insertPageView({ session_fingerprint: "fp-2" });
      insertPageView({ session_fingerprint: "fp-3" });

      const res = await adminRequest("/api/admin/analytics/stats");
      const data = (await res.json()) as any;
      expect(Number(data.totalViews)).toBe(3);
    });

    it("uniqueVisitors がユニークフィンガープリント数を返すこと", async () => {
      insertPageView({ session_fingerprint: "fp-same" });
      insertPageView({ session_fingerprint: "fp-same" });
      insertPageView({ session_fingerprint: "fp-diff" });

      const res = await adminRequest("/api/admin/analytics/stats");
      const data = (await res.json()) as any;
      expect(Number(data.uniqueVisitors)).toBe(2);
    });

    it("uniqueUsers がユニークユーザーID数を返すこと", async () => {
      insertPageView({ user_id: "user-a", session_fingerprint: "fp-1" });
      insertPageView({ user_id: "user-a", session_fingerprint: "fp-2" });
      insertPageView({ user_id: "user-b", session_fingerprint: "fp-3" });
      insertPageView({ user_id: null, session_fingerprint: "fp-4" });

      const res = await adminRequest("/api/admin/analytics/stats");
      const data = (await res.json()) as any;
      expect(Number(data.uniqueUsers)).toBe(2);
    });

    it("viewsByDay が日別集計を返すこと", async () => {
      const today = new Date().toISOString().slice(0, 10);
      insertPageView({ session_fingerprint: "fp-1" });
      insertPageView({ session_fingerprint: "fp-2" });

      const res = await adminRequest("/api/admin/analytics/stats");
      const data = (await res.json()) as any;
      expect(Array.isArray(data.viewsByDay)).toBe(true);
      expect(data.viewsByDay.length).toBeGreaterThanOrEqual(1);
      const todayEntry = data.viewsByDay.find((d: any) => d.day === today);
      expect(todayEntry).toBeTruthy();
      expect(Number(todayEntry.views)).toBe(2);
    });

    it("topPages がパス別集計を返すこと", async () => {
      insertPageView({ path: "/page-a", session_fingerprint: "fp-1" });
      insertPageView({ path: "/page-a", session_fingerprint: "fp-2" });
      insertPageView({ path: "/page-b", session_fingerprint: "fp-3" });

      const res = await adminRequest("/api/admin/analytics/stats");
      const data = (await res.json()) as any;
      expect(Array.isArray(data.topPages)).toBe(true);
      const pageA = data.topPages.find((p: any) => p.path === "/page-a");
      expect(pageA).toBeTruthy();
      expect(Number(pageA.views)).toBe(2);
    });

    it("topReferers がリファラー別集計を返すこと", async () => {
      insertPageView({ referer: "https://google.com", session_fingerprint: "fp-1" });
      insertPageView({ referer: "https://google.com", session_fingerprint: "fp-2" });
      insertPageView({ referer: "https://twitter.com", session_fingerprint: "fp-3" });
      insertPageView({ referer: null, session_fingerprint: "fp-4" });

      const res = await adminRequest("/api/admin/analytics/stats");
      const data = (await res.json()) as any;
      expect(Array.isArray(data.topReferers)).toBe(true);
      const google = data.topReferers.find((r: any) => r.referer === "https://google.com");
      expect(google).toBeTruthy();
      expect(Number(google.count)).toBe(2);
    });

    it("utmSources が UTM パラメータ別集計を返すこと", async () => {
      insertPageView({
        utm_source: "newsletter",
        utm_medium: "email",
        utm_campaign: "launch",
        session_fingerprint: "fp-1",
      });
      insertPageView({
        utm_source: "newsletter",
        utm_medium: "email",
        utm_campaign: "launch",
        session_fingerprint: "fp-2",
      });
      insertPageView({ utm_source: null, session_fingerprint: "fp-3" });

      const res = await adminRequest("/api/admin/analytics/stats");
      const data = (await res.json()) as any;
      expect(Array.isArray(data.utmSources)).toBe(true);
      expect(data.utmSources.length).toBe(1);
      expect(data.utmSources[0].utm_source).toBe("newsletter");
      expect(Number(data.utmSources[0].views)).toBe(2);
    });

    it("recentVisitors が最近の訪問者一覧を返すこと", async () => {
      insertPageView({ session_fingerprint: "fp-visitor", ip_address: "1.2.3.4", user_agent: "Mozilla/5.0" });

      const res = await adminRequest("/api/admin/analytics/stats");
      const data = (await res.json()) as any;
      expect(Array.isArray(data.recentVisitors)).toBe(true);
      expect(data.recentVisitors.length).toBeGreaterThanOrEqual(1);
      const visitor = data.recentVisitors.find((v: any) => v.session_fingerprint === "fp-visitor");
      expect(visitor).toBeTruthy();
      expect(visitor.ip_address).toBe("1.2.3.4");
    });
  });

  // -------------------------------------------------------------------------
  // GET /log
  // -------------------------------------------------------------------------
  describe("GET /api/admin/analytics/log", () => {
    it("デフォルトで limit=100, offset=0 を返すこと", async () => {
      insertPageView({ session_fingerprint: "fp-1" });

      const res = await adminRequest("/api/admin/analytics/log");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.limit).toBe(100);
      expect(data.offset).toBe(0);
      expect(Array.isArray(data.rows)).toBe(true);
    });

    it("カスタム limit と offset を受け付けること", async () => {
      for (let i = 0; i < 10; i++) {
        insertPageView({ session_fingerprint: `fp-${i}` });
      }

      const res = await adminRequest("/api/admin/analytics/log?limit=3&offset=2");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.limit).toBe(3);
      expect(data.offset).toBe(2);
      expect(data.rows.length).toBe(3);
    });

    it("limit が 500 を超える場合は 500 に制限されること", async () => {
      const res = await adminRequest("/api/admin/analytics/log?limit=999");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.limit).toBe(500);
    });

    it("total がページビュー総件数を返すこと", async () => {
      for (let i = 0; i < 5; i++) {
        insertPageView({ session_fingerprint: `fp-${i}` });
      }

      const res = await adminRequest("/api/admin/analytics/log?limit=2");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.rows.length).toBe(2);
      expect(Number(data.total)).toBe(5);
    });

    it("ページネーションが正しく動作すること", async () => {
      for (let i = 0; i < 5; i++) {
        insertPageView({ path: `/page-${i}`, session_fingerprint: `fp-${i}` });
      }

      const res1 = await adminRequest("/api/admin/analytics/log?limit=2&offset=0");
      const data1 = (await res1.json()) as any;
      expect(data1.rows.length).toBe(2);

      const res2 = await adminRequest("/api/admin/analytics/log?limit=2&offset=2");
      const data2 = (await res2.json()) as any;
      expect(data2.rows.length).toBe(2);

      // Ensure no overlap between pages
      const ids1 = data1.rows.map((r: any) => r.id);
      const ids2 = data2.rows.map((r: any) => r.id);
      const overlap = ids1.filter((id: number) => ids2.includes(id));
      expect(overlap.length).toBe(0);
    });
  });
});
