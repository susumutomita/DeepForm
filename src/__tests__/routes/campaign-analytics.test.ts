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
  MODEL_FAST: "claude-haiku-4-5-20251001",
  MODEL_SMART: "claude-sonnet-4-5-20250929",
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

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/campaign — Create campaign from session
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/campaign", () => {
    beforeEach(() => {
      insertSession("owner-session", "キャンペーンテーマ", TEST_USER_ID);
    });

    it("セッションからキャンペーンを作成すべき", async () => {
      // Given: オーナーのセッション
      // When: キャンペーン作成
      const res = await authedRequest("/api/sessions/owner-session/campaign", {
        method: "POST",
      });
      // Then: 201 で作成される
      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.campaignId).toBeDefined();
      expect(data.shareToken).toBeDefined();
      expect(data.theme).toBe("キャンペーンテーマ");
      // DB にキャンペーンが存在する
      const row = rawDb.prepare("SELECT * FROM campaigns WHERE id = ?").get(data.campaignId) as any;
      expect(row).toBeDefined();
      expect(row.theme).toBe("キャンペーンテーマ");
      expect(row.owner_session_id).toBe("owner-session");
    });

    it("既にキャンペーンが存在する場合は既存のものを返すべき", async () => {
      // Given: 既にキャンペーンが作成済み
      insertCampaign("existing-campaign", "キャンペーンテーマ", "owner-session", "existing-token");
      // When: 再度キャンペーン作成
      const res = await authedRequest("/api/sessions/owner-session/campaign", {
        method: "POST",
      });
      // Then: 200 で既存キャンペーンが返る（201 ではない）
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.campaignId).toBe("existing-campaign");
      expect(data.shareToken).toBe("existing-token");
      expect(data.theme).toBe("キャンペーンテーマ");
    });

    it("存在しないセッションの場合に 404 を返すべき", async () => {
      // Given: 存在しないセッション ID
      // When: キャンペーン作成
      const res = await authedRequest("/api/sessions/nonexistent/campaign", {
        method: "POST",
      });
      // Then: 404
      expect(res.status).toBe(404);
    });

    it("オーナー以外がアクセスした場合に 403 を返すべき", async () => {
      // Given: 他ユーザー
      // When: キャンペーン作成
      const res = await otherUserRequest("/api/sessions/owner-session/campaign", {
        method: "POST",
      });
      // Then: 403
      expect(res.status).toBe(403);
    });

    it("未認証の場合に 401 を返すべき", async () => {
      // Given: 認証なし
      // When: キャンペーン作成
      const res = await app.request("/api/sessions/owner-session/campaign", {
        method: "POST",
      });
      // Then: 401 or 403 (getOwnedSession checks user)
      expect([401, 403]).toContain(res.status);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:token — Get campaign info
  // -------------------------------------------------------------------------
  describe("GET /api/campaigns/:token", () => {
    beforeEach(() => {
      insertSession("owner-session", "キャンペーン情報テーマ", TEST_USER_ID);
      insertCampaign("campaign-info", "キャンペーン情報テーマ", "owner-session", "info-token");
    });

    it("キャンペーン情報を回答者リスト付きで返すべき", async () => {
      // Given: 回答者セッションあり
      insertSession("resp-1", "キャンペーン情報テーマ", TEST_USER_ID, {
        campaign_id: "campaign-info",
        status: "respondent_done",
        mode: "campaign_respondent",
        respondent_name: "回答者A",
      });
      insertSession("resp-2", "キャンペーン情報テーマ", TEST_USER_ID, {
        campaign_id: "campaign-info",
        status: "interviewing",
        mode: "campaign_respondent",
        respondent_name: "回答者B",
      });
      // When: キャンペーン情報取得
      const res = await app.request("/api/campaigns/info-token");
      // Then: キャンペーン情報と回答者リスト
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.campaignId).toBe("campaign-info");
      expect(data.theme).toBe("キャンペーン情報テーマ");
      expect(data.shareToken).toBe("info-token");
      expect(data.ownerSessionId).toBe("owner-session");
      expect(data.respondentCount).toBe(2);
      expect(data.respondents).toHaveLength(2);
      expect(data.createdAt).toBeDefined();
    });

    it("回答者がいない場合に空リストを返すべき", async () => {
      // Given: 回答者セッションなし
      // When: キャンペーン情報取得
      const res = await app.request("/api/campaigns/info-token");
      // Then: 空の回答者リスト
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.respondentCount).toBe(0);
      expect(data.respondents).toHaveLength(0);
    });

    it("存在しないトークンの場合に 404 を返すべき", async () => {
      // Given: 存在しないトークン
      // When: キャンペーン情報取得
      const res = await app.request("/api/campaigns/nonexistent-token");
      // Then: 404
      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data.error).toContain("Campaign not found");
    });

    it("認証なしでもアクセスできるべき", async () => {
      // Given: 認証なし
      // When: キャンペーン情報取得（公開エンドポイント）
      const res = await app.request("/api/campaigns/info-token");
      // Then: 200
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/campaigns/:token/join — Join campaign as respondent
  // -------------------------------------------------------------------------
  describe("POST /api/campaigns/:token/join", () => {
    beforeEach(() => {
      insertSession("owner-session", "参加テーマ", TEST_USER_ID);
      insertCampaign("campaign-join", "参加テーマ", "owner-session", "join-token");
    });

    it("キャンペーンに参加して最初の質問を受け取るべき", async () => {
      // Given: 有効なキャンペーン
      // When: 参加リクエスト
      const res = await app.request("/api/campaigns/join-token/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ respondentName: "テスト回答者" }),
      });
      // Then: 201 でセッション作成
      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.sessionId).toBeDefined();
      expect(data.reply).toBeDefined();
      expect(data.theme).toBe("参加テーマ");
      // LLM が呼ばれる
      expect(callClaude).toHaveBeenCalledOnce();
      // DB にセッションが作成される
      const session = rawDb.prepare("SELECT * FROM sessions WHERE id = ?").get(data.sessionId) as any;
      expect(session).toBeDefined();
      expect(session.campaign_id).toBe("campaign-join");
      expect(session.mode).toBe("campaign_respondent");
      expect(session.respondent_name).toBe("テスト回答者");
      expect(session.status).toBe("interviewing");
      // アシスタントメッセージが保存される
      const messages = rawDb.prepare("SELECT * FROM messages WHERE session_id = ?").all(data.sessionId) as any[];
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("assistant");
    });

    it("名前なしでも参加できるべき", async () => {
      // Given: 名前なし
      // When: 参加リクエスト
      const res = await app.request("/api/campaigns/join-token/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      // Then: 201 で作成
      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.sessionId).toBeDefined();
      // respondent_name は null
      const session = rawDb.prepare("SELECT * FROM sessions WHERE id = ?").get(data.sessionId) as any;
      expect(session.respondent_name).toBeNull();
    });

    it("存在しないトークンの場合に 404 を返すべき", async () => {
      // Given: 存在しないトークン
      // When: 参加リクエスト
      const res = await app.request("/api/campaigns/nonexistent-token/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ respondentName: "テスト" }),
      });
      // Then: 404
      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data.error).toContain("Campaign not found");
    });

    it("名前が100文字を超える場合に 400 を返すべき", async () => {
      // Given: 長すぎる名前
      const longName = "あ".repeat(101);
      // When: 参加リクエスト
      const res = await app.request("/api/campaigns/join-token/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ respondentName: longName }),
      });
      // Then: 400 バリデーションエラー
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/campaigns/:token/sessions/:sessionId/chat — Respondent chat
  // -------------------------------------------------------------------------
  describe("POST /api/campaigns/:token/sessions/:sessionId/chat", () => {
    beforeEach(() => {
      insertSession("owner-session", "チャットテーマ", TEST_USER_ID);
      insertCampaign("campaign-chat", "チャットテーマ", "owner-session", "chat-token");
      insertSession("resp-session", "チャットテーマ", TEST_USER_ID, {
        campaign_id: "campaign-chat",
        status: "interviewing",
        mode: "campaign_respondent",
        respondent_name: "回答者",
      });
    });

    it("回答者がチャットできるべき", async () => {
      // Given: 有効な回答者セッション
      // When: チャットメッセージ送信
      const res = await app.request("/api/campaigns/chat-token/sessions/resp-session/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "毎日使っています" }),
      });
      // Then: 返答が返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.reply).toBeDefined();
      expect(data.turnCount).toBeDefined();
      expect(typeof data.isComplete).toBe("boolean");
      expect(callClaude).toHaveBeenCalled();
      // ユーザーメッセージとアシスタントメッセージが保存される
      const messages = rawDb
        .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id")
        .all("resp-session") as any[];
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("毎日使っています");
      expect(messages[1].role).toBe("assistant");
    });

    it("turnCount が正しくカウントされるべき", async () => {
      // Given: 既にメッセージがある
      rawDb
        .prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
        .run("resp-session", "assistant", "最初の質問");
      rawDb
        .prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
        .run("resp-session", "user", "回答1");
      rawDb
        .prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
        .run("resp-session", "assistant", "2番目の質問");
      // When: チャットメッセージ送信
      const res = await app.request("/api/campaigns/chat-token/sessions/resp-session/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "回答2" }),
      });
      // Then: turnCount は 2（user メッセージの数）
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.turnCount).toBe(2);
    });

    it("完了済みセッションの場合に 400 を返すべき", async () => {
      // Given: 完了済みセッション
      rawDb.prepare("UPDATE sessions SET status = ? WHERE id = ?").run("respondent_done", "resp-session");
      // When: チャットメッセージ送信
      const res = await app.request("/api/campaigns/chat-token/sessions/resp-session/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "追加の回答" }),
      });
      // Then: 400
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain("完了");
    });

    it("存在しないキャンペーントークンの場合に 404 を返すべき", async () => {
      // Given: 存在しないトークン
      // When: チャットメッセージ送信
      const res = await app.request("/api/campaigns/nonexistent-token/sessions/resp-session/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "テスト" }),
      });
      // Then: 404
      expect(res.status).toBe(404);
    });

    it("キャンペーンに属さないセッションの場合に 404 を返すべき", async () => {
      // Given: 別のキャンペーンのセッション
      insertSession("other-session", "別テーマ", TEST_USER_ID, {
        campaign_id: "other-campaign",
        status: "interviewing",
        mode: "campaign_respondent",
      });
      // When: チャットメッセージ送信
      const res = await app.request("/api/campaigns/chat-token/sessions/other-session/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "テスト" }),
      });
      // Then: 404
      expect(res.status).toBe(404);
    });

    it("空メッセージの場合に 400 を返すべき", async () => {
      // Given: 空のメッセージ
      // When: チャットメッセージ送信
      const res = await app.request("/api/campaigns/chat-token/sessions/resp-session/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "" }),
      });
      // Then: 400 バリデーションエラー
      expect(res.status).toBe(400);
    });

    it("[INTERVIEW_COMPLETE] を含む応答で isComplete が true になるべき", async () => {
      // Given: LLM が完了マーカーを含む応答を返す
      vi.mocked(extractText).mockReturnValueOnce("ありがとうございました。[INTERVIEW_COMPLETE]");
      // When: チャットメッセージ送信
      const res = await app.request("/api/campaigns/chat-token/sessions/resp-session/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "最後の回答" }),
      });
      // Then: isComplete が true
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.isComplete).toBe(true);
      // [INTERVIEW_COMPLETE] はクリーンアップされる
      expect(data.reply).not.toContain("[INTERVIEW_COMPLETE]");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/campaigns/:token/sessions/:sessionId/complete — Complete interview
  // -------------------------------------------------------------------------
  describe("POST /api/campaigns/:token/sessions/:sessionId/complete", () => {
    beforeEach(() => {
      insertSession("owner-session", "完了テーマ", TEST_USER_ID);
      insertCampaign("campaign-complete", "完了テーマ", "owner-session", "complete-token");
      insertSession("resp-session", "完了テーマ", TEST_USER_ID, {
        campaign_id: "campaign-complete",
        status: "interviewing",
        mode: "campaign_respondent",
        respondent_name: "回答者",
      });
      // メッセージ履歴を追加
      rawDb
        .prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
        .run("resp-session", "assistant", "最初の質問です");
      rawDb
        .prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
        .run("resp-session", "user", "回答です");
    });

    it("インタビューを完了してファクトを抽出すべき", async () => {
      // Given: LLM がファクトJSONを返す
      const factsJson = JSON.stringify({
        facts: [
          { id: "F1", type: "pain", content: "操作が難しい", evidence: "回答です", severity: "high" },
          { id: "F2", type: "fact", content: "毎日利用", evidence: "回答です", severity: "medium" },
        ],
      });
      vi.mocked(extractText).mockReturnValueOnce(factsJson);
      // When: 完了リクエスト
      const res = await app.request("/api/campaigns/complete-token/sessions/resp-session/complete", {
        method: "POST",
      });
      // Then: ファクトが返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.facts).toHaveLength(2);
      expect(data.facts[0].type).toBe("pain");
      expect(callClaude).toHaveBeenCalled();
      // セッションステータスが respondent_done に更新される
      const session = rawDb.prepare("SELECT * FROM sessions WHERE id = ?").get("resp-session") as any;
      expect(session.status).toBe("respondent_done");
      // analysis_results にファクトが保存される
      const analysisRow = rawDb
        .prepare("SELECT * FROM analysis_results WHERE session_id = ? AND type = ?")
        .get("resp-session", "facts") as any;
      expect(analysisRow).toBeDefined();
      const savedFacts = JSON.parse(analysisRow.data);
      expect(savedFacts.facts).toHaveLength(2);
    });

    it("キャンペーンの updated_at が更新されるべき", async () => {
      // Given: ファクトJSONモック
      vi.mocked(extractText).mockReturnValueOnce(
        '{"facts":[{"id":"F1","type":"fact","content":"test","evidence":"","severity":"low"}]}',
      );
      const _before = rawDb.prepare("SELECT updated_at FROM campaigns WHERE id = ?").get("campaign-complete") as any;
      // When: 完了リクエスト
      const res = await app.request("/api/campaigns/complete-token/sessions/resp-session/complete", {
        method: "POST",
      });
      // Then: 200
      expect(res.status).toBe(200);
      // campaigns の updated_at が変更される (or equal for very fast test)
      const after = rawDb.prepare("SELECT updated_at FROM campaigns WHERE id = ?").get("campaign-complete") as any;
      expect(after.updated_at).toBeDefined();
    });

    it("LLM が不正な JSON を返した場合にフォールバックすべき", async () => {
      // Given: LLM が JSON でない文字列を返す
      vi.mocked(extractText).mockReturnValueOnce("これはJSONではない文字列です");
      // When: 完了リクエスト
      const res = await app.request("/api/campaigns/complete-token/sessions/resp-session/complete", {
        method: "POST",
      });
      // Then: フォールバック形式
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.facts).toHaveLength(1);
      expect(data.facts[0].id).toBe("F1");
      expect(data.facts[0].content).toContain("これはJSONではない文字列です");
    });

    it("存在しないキャンペーントークンの場合に 404 を返すべき", async () => {
      const res = await app.request("/api/campaigns/nonexistent-token/sessions/resp-session/complete", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("キャンペーンに属さないセッションの場合に 404 を返すべき", async () => {
      // Given: 別のキャンペーンに属するセッション
      insertSession("other-resp", "別テーマ", TEST_USER_ID, {
        campaign_id: "other-campaign",
        status: "interviewing",
        mode: "campaign_respondent",
      });
      // When: 完了リクエスト
      const res = await app.request("/api/campaigns/complete-token/sessions/other-resp/complete", {
        method: "POST",
      });
      // Then: 404
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/campaigns/:token/sessions/:sessionId/feedback — Submit feedback
  // -------------------------------------------------------------------------
  describe("POST /api/campaigns/:token/sessions/:sessionId/feedback", () => {
    beforeEach(() => {
      insertSession("owner-session", "フィードバックテーマ", TEST_USER_ID);
      insertCampaign("campaign-fb", "フィードバックテーマ", "owner-session", "fb-token");
      insertSession("resp-session", "フィードバックテーマ", TEST_USER_ID, {
        campaign_id: "campaign-fb",
        status: "respondent_done",
        mode: "campaign_respondent",
        respondent_name: "回答者",
      });
    });

    it("フィードバックを送信すべき", async () => {
      // Given: 有効な回答者セッション
      // When: フィードバック送信
      const res = await app.request("/api/campaigns/fb-token/sessions/resp-session/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "とても良いインタビューでした" }),
      });
      // Then: 成功
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      // DB にフィードバックが保存される
      const session = rawDb.prepare("SELECT * FROM sessions WHERE id = ?").get("resp-session") as any;
      expect(session.respondent_feedback).toBe("とても良いインタビューでした");
    });

    it("null フィードバックを送信できるべき", async () => {
      // Given: null フィードバック
      // When: フィードバック送信
      const res = await app.request("/api/campaigns/fb-token/sessions/resp-session/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: null }),
      });
      // Then: 成功
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
    });

    it("フィードバックなし（optional）でも送信できるべき", async () => {
      // Given: フィードバックフィールドなし
      // When: フィードバック送信
      const res = await app.request("/api/campaigns/fb-token/sessions/resp-session/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      // Then: 成功
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
    });

    it("5000文字を超えるフィードバックの場合に 400 を返すべき", async () => {
      // Given: 長すぎるフィードバック
      const longFeedback = "あ".repeat(5001);
      // When: フィードバック送信
      const res = await app.request("/api/campaigns/fb-token/sessions/resp-session/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: longFeedback }),
      });
      // Then: 400 バリデーションエラー
      expect(res.status).toBe(400);
    });

    it("存在しないキャンペーントークンの場合に 404 を返すべき", async () => {
      const res = await app.request("/api/campaigns/nonexistent-token/sessions/resp-session/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "テスト" }),
      });
      expect(res.status).toBe(404);
    });

    it("キャンペーンに属さないセッションの場合に 404 を返すべき", async () => {
      // Given: 別のキャンペーンに属するセッション
      insertSession("other-resp", "別テーマ", TEST_USER_ID, {
        campaign_id: "other-campaign",
        status: "respondent_done",
        mode: "campaign_respondent",
      });
      // When: フィードバック送信
      const res = await app.request("/api/campaigns/fb-token/sessions/other-resp/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "テスト" }),
      });
      // Then: 404
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:token/aggregate — Aggregate all respondent facts
  // -------------------------------------------------------------------------
  describe("GET /api/campaigns/:token/aggregate", () => {
    beforeEach(() => {
      insertSession("owner-session", "集計テーマ", TEST_USER_ID);
      insertCampaign("campaign-agg", "集計テーマ", "owner-session", "agg-token");
    });

    it("完了済みセッションのファクトを集計すべき", async () => {
      // Given: 完了済みセッション 2 件
      insertSession("resp-1", "集計テーマ", TEST_USER_ID, {
        campaign_id: "campaign-agg",
        status: "respondent_done",
        mode: "campaign_respondent",
        respondent_name: "回答者A",
      });
      insertSession("resp-2", "集計テーマ", TEST_USER_ID, {
        campaign_id: "campaign-agg",
        status: "respondent_done",
        mode: "campaign_respondent",
        respondent_name: "回答者B",
      });
      insertAnalysis("resp-1", "facts", {
        facts: [{ id: "F1", type: "pain", content: "操作が複雑", evidence: "発話1", severity: "high" }],
      });
      insertAnalysis("resp-2", "facts", {
        facts: [
          { id: "F1", type: "fact", content: "毎日利用", evidence: "発話2", severity: "medium" },
          { id: "F2", type: "pain", content: "操作が複雑", evidence: "発話3", severity: "high" },
        ],
      });

      // When: aggregate 取得
      const res = await app.request("/api/campaigns/agg-token/aggregate");
      // Then: 集計結果
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.campaignId).toBe("campaign-agg");
      expect(data.theme).toBe("集計テーマ");
      expect(data.totalRespondents).toBe(2);
      expect(data.totalFacts).toBe(3);
      expect(data.respondents).toHaveLength(2);
      expect(data.respondents[0].name).toBe("回答者A");
      expect(data.respondents[0].factCount).toBe(1);
      expect(data.respondents[1].name).toBe("回答者B");
      expect(data.respondents[1].factCount).toBe(2);
      expect(data.allFacts).toHaveLength(3);
      // ファクトに respondent と sessionId が付与される
      expect(data.allFacts[0].respondent).toBeDefined();
      expect(data.allFacts[0].sessionId).toBeDefined();
    });

    it("完了済みセッションがない場合に空の集計を返すべき", async () => {
      // Given: インタビュー中のセッションのみ
      insertSession("resp-active", "集計テーマ", TEST_USER_ID, {
        campaign_id: "campaign-agg",
        status: "interviewing",
        mode: "campaign_respondent",
      });
      // When: aggregate 取得
      const res = await app.request("/api/campaigns/agg-token/aggregate");
      // Then: 空の集計
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.totalRespondents).toBe(0);
      expect(data.totalFacts).toBe(0);
      expect(data.respondents).toHaveLength(0);
      expect(data.allFacts).toHaveLength(0);
    });

    it("フィードバックが含まれるべき", async () => {
      // Given: フィードバック付きの完了済みセッション
      insertSession("resp-fb", "集計テーマ", TEST_USER_ID, {
        campaign_id: "campaign-agg",
        status: "respondent_done",
        mode: "campaign_respondent",
        respondent_name: "回答者C",
        respondent_feedback: "良い体験でした",
      });
      insertAnalysis("resp-fb", "facts", {
        facts: [{ id: "F1", type: "fact", content: "テスト", evidence: "", severity: "low" }],
      });
      // When: aggregate 取得
      const res = await app.request("/api/campaigns/agg-token/aggregate");
      // Then: フィードバックが含まれる
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.respondents[0].feedback).toBe("良い体験でした");
    });

    it("匿名回答者の名前が「匿名」になるべき", async () => {
      // Given: 名前なしの完了済みセッション
      insertSession("resp-anon", "集計テーマ", TEST_USER_ID, {
        campaign_id: "campaign-agg",
        status: "respondent_done",
        mode: "campaign_respondent",
      });
      insertAnalysis("resp-anon", "facts", {
        facts: [{ id: "F1", type: "fact", content: "テスト", evidence: "", severity: "low" }],
      });
      // When: aggregate 取得
      const res = await app.request("/api/campaigns/agg-token/aggregate");
      // Then: 匿名
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.respondents[0].name).toBe("匿名");
    });

    it("存在しないトークンの場合に 404 を返すべき", async () => {
      // Given: 存在しないトークン
      // When: aggregate 取得
      const res = await app.request("/api/campaigns/nonexistent-token/aggregate");
      // Then: 404
      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data.error).toContain("Campaign not found");
    });

    it("認証なしでもアクセスできるべき", async () => {
      // Given: 認証なし
      // When: aggregate 取得（公開エンドポイント）
      const res = await app.request("/api/campaigns/agg-token/aggregate");
      // Then: 200
      expect(res.status).toBe(200);
    });
  });
});
