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

// Mock LLM
vi.mock("../../llm.ts", () => ({
  callClaude: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: '{"summary":"テスト分析","patterns":[],"insights":[],"recommendations":[]}' }],
  }),
  extractText: vi.fn().mockReturnValue('{"summary":"テスト分析","patterns":[],"insights":[],"recommendations":[]}'),
}));

import { app } from "../../app.ts";
import { callClaude, extractText } from "../../llm.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
const TEST_USER_ID = "test-user-001";
const TEST_EXE_USER_ID = "exe-test-001";
const TEST_EMAIL = "testuser@example.com";
const OTHER_USER_ID = "test-user-002";
const OTHER_EXE_USER_ID = "exe-test-002";
const OTHER_EMAIL = "otheruser@example.com";

async function authedRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", TEST_EXE_USER_ID);
  headers.set("x-exedev-email", TEST_EMAIL);
  return await app.request(path, { ...options, headers });
}

async function otherUserRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", OTHER_EXE_USER_ID);
  headers.set("x-exedev-email", OTHER_EMAIL);
  return await app.request(path, { ...options, headers });
}

type SQLInputValue = null | number | bigint | string;

function insertSession(id: string, theme: string, userId: string, extra: Record<string, SQLInputValue> = {}): void {
  const cols = ["id", "theme", "user_id", ...Object.keys(extra)];
  const placeholders = cols.map(() => "?").join(", ");
  rawDb
    .prepare(`INSERT INTO sessions (${cols.join(", ")}) VALUES (${placeholders})`)
    .run(id, theme, userId, ...Object.values(extra));
}

function insertCampaign(id: string, theme: string, ownerSessionId: string, shareToken: string): void {
  rawDb
    .prepare("INSERT INTO campaigns (id, theme, owner_session_id, share_token) VALUES (?, ?, ?, ?)")
    .run(id, theme, ownerSessionId, shareToken);
}

function insertAnalysis(sessionId: string, type: string, data: unknown): void {
  rawDb
    .prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)")
    .run(sessionId, type, JSON.stringify(data));
}

/** Helper: clean all tables (SQLite DatabaseSync.exec — not child_process) */
function cleanTables(): void {
  rawDb.prepare("DELETE FROM analysis_results").run();
  rawDb.prepare("DELETE FROM messages").run();
  rawDb.prepare("DELETE FROM campaigns").run();
  rawDb.prepare("DELETE FROM sessions").run();
  rawDb.prepare("DELETE FROM users").run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("キャンペーン分析 API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanTables();
    rawDb
      .prepare("INSERT INTO users (id, exe_user_id, email, display_name) VALUES (?, ?, ?, ?)")
      .run(TEST_USER_ID, TEST_EXE_USER_ID, TEST_EMAIL, "testuser");
    rawDb
      .prepare("INSERT INTO users (id, exe_user_id, email, display_name) VALUES (?, ?, ?, ?)")
      .run(OTHER_USER_ID, OTHER_EXE_USER_ID, OTHER_EMAIL, "otheruser");
  });

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:id/analytics
  // -------------------------------------------------------------------------
  describe("GET /api/campaigns/:id/analytics", () => {
    beforeEach(() => {
      insertSession("owner-session", "分析テーマ", TEST_USER_ID);
      insertCampaign("campaign-1", "分析テーマ", "owner-session", "share-token-1");
    });

    it("セッションなしの場合に空の分析結果を返すべき", async () => {
      // Given: キャンペーンにセッションがない
      // When: analytics 取得
      const res = await authedRequest("/api/campaigns/campaign-1/analytics");
      // Then: 空結果
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.totalSessions).toBe(0);
      expect(data.completedSessions).toBe(0);
      expect(data.commonFacts).toHaveLength(0);
      expect(data.painPoints).toHaveLength(0);
      expect(data.keywordCounts).toEqual({});
    });

    it("複数セッションのファクトを集計すべき", async () => {
      // Given: 完了済みセッション 2 件（ファクト付き）
      insertSession("resp-1", "分析テーマ", TEST_USER_ID, {
        campaign_id: "campaign-1",
        status: "respondent_done",
        mode: "campaign_respondent",
      });
      insertSession("resp-2", "分析テーマ", TEST_USER_ID, {
        campaign_id: "campaign-1",
        status: "respondent_done",
        mode: "campaign_respondent",
      });
      insertAnalysis("resp-1", "facts", {
        facts: [
          { id: "F1", type: "pain", content: "操作が複雑", evidence: "発話1", severity: "high" },
          { id: "F2", type: "fact", content: "毎日使用", evidence: "発話2", severity: "medium" },
        ],
      });
      insertAnalysis("resp-2", "facts", {
        facts: [
          { id: "F1", type: "pain", content: "操作が複雑", evidence: "発話3", severity: "high" },
          { id: "F3", type: "frequency", content: "週3回以上", evidence: "発話4", severity: "low" },
        ],
      });

      // When: analytics 取得
      const res = await authedRequest("/api/campaigns/campaign-1/analytics");
      // Then: 集計結果
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.totalSessions).toBe(2);
      expect(data.completedSessions).toBe(2);
      expect(data.commonFacts.length).toBeGreaterThan(0);
      expect(data.commonFacts[0].content).toBe("操作が複雑");
      expect(data.commonFacts[0].count).toBe(2);
      expect(data.painPoints.length).toBeGreaterThan(0);
      expect(data.painPoints[0].content).toBe("操作が複雑");
      expect(Object.keys(data.keywordCounts).length).toBeGreaterThan(0);
    });

    it("interviewing ステータスのセッションはカウントするが完了には含めないべき", async () => {
      // Given: interviewing セッション 1 件
      insertSession("resp-active", "分析テーマ", TEST_USER_ID, {
        campaign_id: "campaign-1",
        status: "interviewing",
        mode: "campaign_respondent",
      });

      // When: analytics 取得
      const res = await authedRequest("/api/campaigns/campaign-1/analytics");
      // Then: totalSessions=1, completedSessions=0
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.totalSessions).toBe(1);
      expect(data.completedSessions).toBe(0);
    });

    it("オーナー以外がアクセスした場合に 403 を返すべき", async () => {
      // Given: 他ユーザー
      // When: analytics 取得
      const res = await otherUserRequest("/api/campaigns/campaign-1/analytics");
      // Then: 403
      expect(res.status).toBe(403);
    });

    it("未認証の場合に 401 を返すべき", async () => {
      // Given: 認証なし
      // When: analytics 取得
      const res = await app.request("/api/campaigns/campaign-1/analytics");
      // Then: 401
      expect(res.status).toBe(401);
    });

    it("存在しないキャンペーンの場合に 404 を返すべき", async () => {
      // Given: 存在しない ID
      // When: analytics 取得
      const res = await authedRequest("/api/campaigns/nonexistent/analytics");
      // Then: 404
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/campaigns/:id/analytics/generate
  // -------------------------------------------------------------------------
  describe("POST /api/campaigns/:id/analytics/generate", () => {
    beforeEach(() => {
      insertSession("owner-session", "分析テーマ", TEST_USER_ID);
      insertCampaign("campaign-1", "分析テーマ", "owner-session", "share-token-1");
    });

    it("完了セッションがある場合に AI 横断分析を生成すべき", async () => {
      // Given: 完了済みセッション
      insertSession("resp-1", "分析テーマ", TEST_USER_ID, {
        campaign_id: "campaign-1",
        status: "respondent_done",
        mode: "campaign_respondent",
      });
      insertAnalysis("resp-1", "facts", {
        facts: [{ id: "F1", type: "pain", content: "テストファクト", evidence: "", severity: "high" }],
      });

      // When: AI 分析生成
      const res = await authedRequest("/api/campaigns/campaign-1/analytics/generate", {
        method: "POST",
      });
      // Then: 分析結果が返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.summary).toBe("テスト分析");
      expect(callClaude).toHaveBeenCalledOnce();
      // analysis_results に保存される
      const row = rawDb
        .prepare("SELECT * FROM analysis_results WHERE session_id = ? AND type = ?")
        .get("owner-session", "campaign_analytics") as any;
      expect(row).toBeDefined();
    });

    it("完了セッションがない場合に 400 を返すべき", async () => {
      // Given: セッションなし
      // When: AI 分析生成
      const res = await authedRequest("/api/campaigns/campaign-1/analytics/generate", {
        method: "POST",
      });
      // Then: 400
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain("完了済みセッション");
    });

    it("既存の AI 分析を上書き更新すべき", async () => {
      // Given: 既に分析結果がある
      insertSession("resp-1", "分析テーマ", TEST_USER_ID, {
        campaign_id: "campaign-1",
        status: "respondent_done",
        mode: "campaign_respondent",
      });
      insertAnalysis("resp-1", "facts", {
        facts: [{ id: "F1", type: "fact", content: "テスト", evidence: "", severity: "medium" }],
      });
      insertAnalysis("owner-session", "campaign_analytics", { summary: "古い分析" });

      // When: 再度 AI 分析生成
      const res = await authedRequest("/api/campaigns/campaign-1/analytics/generate", {
        method: "POST",
      });
      // Then: 上書きされる
      expect(res.status).toBe(200);
      const rows = rawDb
        .prepare("SELECT * FROM analysis_results WHERE session_id = ? AND type = ?")
        .all("owner-session", "campaign_analytics") as any[];
      expect(rows).toHaveLength(1);
    });

    it("オーナー以外がアクセスした場合に 403 を返すべき", async () => {
      const res = await otherUserRequest("/api/campaigns/campaign-1/analytics/generate", {
        method: "POST",
      });
      expect(res.status).toBe(403);
    });

    it("LLM が不正な JSON を返した場合にフォールバックすべき", async () => {
      // Given: LLM が JSON でない文字列を返す
      insertSession("resp-1", "分析テーマ", TEST_USER_ID, {
        campaign_id: "campaign-1",
        status: "respondent_done",
        mode: "campaign_respondent",
      });
      insertAnalysis("resp-1", "facts", {
        facts: [{ id: "F1", type: "fact", content: "テスト", evidence: "", severity: "medium" }],
      });
      vi.mocked(extractText).mockReturnValueOnce("これは JSON ではありません");

      // When: AI 分析生成
      const res = await authedRequest("/api/campaigns/campaign-1/analytics/generate", {
        method: "POST",
      });
      // Then: フォールバック形式
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.summary).toContain("JSON");
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:id/export
  // -------------------------------------------------------------------------
  describe("GET /api/campaigns/:id/export", () => {
    beforeEach(() => {
      insertSession("owner-session", "エクスポートテーマ", TEST_USER_ID);
      insertCampaign("campaign-1", "エクスポートテーマ", "owner-session", "share-token-1");
    });

    it("キャンペーンの集計結果を JSON エクスポートすべき", async () => {
      // Given: 完了済みセッション
      insertSession("resp-1", "エクスポートテーマ", TEST_USER_ID, {
        campaign_id: "campaign-1",
        status: "respondent_done",
        mode: "campaign_respondent",
        respondent_name: "テスト回答者",
      });
      insertAnalysis("resp-1", "facts", {
        facts: [{ id: "F1", type: "fact", content: "テスト", evidence: "", severity: "medium" }],
      });

      // When: export 取得
      const res = await authedRequest("/api/campaigns/campaign-1/export");
      // Then: エクスポートデータ
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.campaign.id).toBe("campaign-1");
      expect(data.campaign.theme).toBe("エクスポートテーマ");
      expect(data.campaign.exportedAt).toBeDefined();
      expect(data.analytics.totalSessions).toBe(1);
      expect(data.analytics.completedSessions).toBe(1);
      expect(data.respondents).toHaveLength(1);
      expect(data.respondents[0].name).toBe("テスト回答者");
      expect(data.respondents[0].facts).toBeDefined();
      expect(res.headers.get("content-disposition")).toContain("campaign-campaign-1-analytics.json");
    });

    it("AI 分析結果がある場合にエクスポートに含めるべき", async () => {
      // Given: AI 分析結果
      insertAnalysis("owner-session", "campaign_analytics", { summary: "AI 分析結果" });

      // When: export 取得
      const res = await authedRequest("/api/campaigns/campaign-1/export");
      // Then: aiAnalysis が含まれる
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.aiAnalysis).toBeDefined();
      expect(data.aiAnalysis.summary).toBe("AI 分析結果");
    });

    it("セッションなしの場合に空のエクスポートを返すべき", async () => {
      // Given: セッションなし
      // When: export 取得
      const res = await authedRequest("/api/campaigns/campaign-1/export");
      // Then: 空のエクスポート
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.analytics.totalSessions).toBe(0);
      expect(data.respondents).toHaveLength(0);
      expect(data.aiAnalysis).toBeNull();
    });

    it("オーナー以外がアクセスした場合に 403 を返すべき", async () => {
      const res = await otherUserRequest("/api/campaigns/campaign-1/export");
      expect(res.status).toBe(403);
    });

    it("未認証の場合に 401 を返すべき", async () => {
      const res = await app.request("/api/campaigns/campaign-1/export");
      expect(res.status).toBe(401);
    });

    it("存在しないキャンペーンの場合に 404 を返すべき", async () => {
      const res = await authedRequest("/api/campaigns/nonexistent/export");
      expect(res.status).toBe(404);
    });
  });
});
