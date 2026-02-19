import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  MODEL_FAST: "claude-sonnet-4-6",
  MODEL_SMART: "claude-opus-4-6",
  callClaude: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "モック LLM レスポンス" }],
  }),
  extractText: vi.fn().mockReturnValue("モック LLM レスポンス"),
}));

import { app } from "../../app.ts";
import { callClaude, extractText } from "../../llm.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

// ---------------------------------------------------------------------------
// Auth helpers — exe.dev proxy header authentication
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

/** セッションを作成して ID を返すヘルパー */
function insertSession(id: string, theme: string, userId: string, extra: Record<string, SQLInputValue> = {}): void {
  const cols = ["id", "theme", "user_id", ...Object.keys(extra)];
  const placeholders = cols.map(() => "?").join(", ");
  rawDb
    .prepare(`INSERT INTO sessions (${cols.join(", ")}) VALUES (${placeholders})`)
    .run(id, theme, userId, ...Object.values(extra));
}

function insertMessage(sessionId: string, role: string, content: string): void {
  rawDb.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(sessionId, role, content);
}

function insertAnalysis(sessionId: string, type: string, data: unknown): void {
  rawDb
    .prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)")
    .run(sessionId, type, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("セッション API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean all tables (order matters for foreign keys)
    rawDb.exec("DELETE FROM analysis_results");
    rawDb.exec("DELETE FROM messages");
    rawDb.exec("DELETE FROM campaigns");
    rawDb.exec("DELETE FROM sessions");
    rawDb.exec("DELETE FROM users");
    // Insert test users
    rawDb
      .prepare("INSERT INTO users (id, exe_user_id, email, display_name, plan) VALUES (?, ?, ?, ?, ?)")
      .run(TEST_USER_ID, TEST_EXE_USER_ID, TEST_EMAIL, "testuser", "pro");
    rawDb
      .prepare("INSERT INTO users (id, exe_user_id, email, display_name, plan) VALUES (?, ?, ?, ?, ?)")
      .run(OTHER_USER_ID, OTHER_EXE_USER_ID, OTHER_EMAIL, "otheruser", "pro");
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions
  // -------------------------------------------------------------------------
  describe("POST /api/sessions", () => {
    it("テーマを指定してセッションを作成できること", async () => {
      // Given: 認証済みユーザー
      // When: テーマを指定して POST
      const res = await authedRequest("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "テストテーマ" }),
      });
      // Then: セッションが作成される
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.sessionId).toBeDefined();
      expect(data.theme).toBe("テストテーマ");
      const row = rawDb.prepare("SELECT * FROM sessions WHERE id = ?").get(data.sessionId) as any;
      expect(row).toBeDefined();
      expect(row.user_id).toBe(TEST_USER_ID);
    });

    it("セッション数が上限に達した場合に 429 を返すべき", async () => {
      // Given: 50 件のセッションが既に存在
      for (let i = 0; i < 50; i++) {
        insertSession(`limit-${i}`, `テーマ${i}`, TEST_USER_ID);
      }
      // When: 51 件目を作成
      const res = await authedRequest("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "超過テーマ" }),
      });
      // Then: 429 で拒否
      expect(res.status).toBe(429);
      const data = (await res.json()) as any;
      expect(data.error).toContain("上限");
    });

    it("テーマが空の場合に 400 を返すべき", async () => {
      // Given: 認証済みユーザー
      // When: 空テーマで POST
      const res = await authedRequest("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "" }),
      });
      // Then: Zod バリデーションエラー
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain("テーマ");
    });

    it("テーマが501文字以上の場合に 400 を返すべき", async () => {
      // Given: 認証済みユーザー
      // When: 501文字のテーマで POST
      const res = await authedRequest("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "a".repeat(501) }),
      });
      // Then: Zod バリデーションエラー
      expect(res.status).toBe(400);
    });

    it("未認証の場合に 401 を返すべき", async () => {
      // Given: 認証なし
      // When: POST
      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "テスト" }),
      });
      // Then: ゲストアクセスでセッション作成可能 (201)
      expect(res.status).toBe(200);
    });

    it("不正な JSON の場合に 400 を返すべき", async () => {
      // Given: 認証済みユーザー
      // When: 不正な JSON で POST
      const res = await authedRequest("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ invalid json",
      });
      // Then: SyntaxError → 400
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toBe("Invalid JSON");
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/sessions
  // -------------------------------------------------------------------------
  describe("GET /api/sessions", () => {
    beforeEach(() => {
      insertSession("s1", "テーマ1", TEST_USER_ID);
      insertSession("s2", "テーマ2", TEST_USER_ID);
      insertSession("s3", "テーマ3", OTHER_USER_ID);
      insertSession("s4", "公開テーマ", OTHER_USER_ID, { is_public: 1 });
    });

    it("認証済みユーザーの場合に自分のセッションと公開セッションを返すこと", async () => {
      // Given: 自分のセッション 2 件 + 他人の公開セッション 1 件
      // When: GET
      const res = await authedRequest("/api/sessions");
      // Then: 3 件返る（自分2 + 公開1）
      expect(res.status).toBe(200);
      const data = (await res.json()) as any[];
      expect(data.length).toBe(3);
      const ids = data.map((s) => s.id);
      expect(ids).toContain("s1");
      expect(ids).toContain("s2");
      expect(ids).toContain("s4");
      expect(ids).not.toContain("s3");
    });

    it("未認証の場合に公開セッションのみ返すこと", async () => {
      // Given: 公開セッション 1 件
      // When: 認証なしで GET
      const res = await app.request("/api/sessions");
      // Then: 公開セッションのみ
      expect(res.status).toBe(200);
      const data = (await res.json()) as any[];
      expect(data.length).toBe(1);
      expect(data[0].id).toBe("s4");
    });

    it("メッセージ数を含むべき", async () => {
      // Given: セッションにメッセージ 2 件
      insertMessage("s1", "assistant", "質問1");
      insertMessage("s1", "user", "回答1");
      // When: GET
      const res = await authedRequest("/api/sessions");
      // Then: message_count = 2
      const data = (await res.json()) as any[];
      const s1 = data.find((s) => s.id === "s1");
      expect(s1.message_count).toBe(2);
    });

    it("respondent_done ステータスを display_status: analyzed として返すこと", async () => {
      // Given: respondent_done ステータスの公開セッション
      rawDb.prepare("UPDATE sessions SET status = 'respondent_done', is_public = 1 WHERE id = ?").run("s1");
      // When: GET
      const res = await authedRequest("/api/sessions");
      // Then: display_status = "analyzed"
      const data = (await res.json()) as any[];
      const s1 = data.find((s) => s.id === "s1");
      expect(s1.display_status).toBe("analyzed");
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/sessions/:id
  // -------------------------------------------------------------------------
  describe("GET /api/sessions/:id", () => {
    beforeEach(() => {
      insertSession("sd", "テーマ詳細", TEST_USER_ID);
      insertSession("so", "テーマ他", OTHER_USER_ID);
      insertMessage("sd", "assistant", "最初の質問");
    });

    it("自分のセッションの詳細を取得できること", async () => {
      // Given: 自分のセッション
      // When: GET
      const res = await authedRequest("/api/sessions/sd");
      // Then: 詳細が返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.id).toBe("sd");
      expect(data.theme).toBe("テーマ詳細");
      expect(data.messages).toHaveLength(1);
      expect(data.analysis).toBeDefined();
    });

    it("他人の非公開セッションにアクセスした場合に 403 を返すべき", async () => {
      // Given: 他人の非公開セッション
      // When: GET
      const res = await authedRequest("/api/sessions/so");
      // Then: 403
      expect(res.status).toBe(403);
    });

    it("存在しないセッションの場合に 404 を返すべき", async () => {
      // Given: 存在しない ID
      // When: GET
      const res = await authedRequest("/api/sessions/nonexistent");
      // Then: 404
      expect(res.status).toBe(404);
    });

    it("公開セッションには未認証でもアクセスできること", async () => {
      // Given: 公開セッション
      rawDb.prepare("UPDATE sessions SET is_public = 1 WHERE id = ?").run("so");
      // When: 認証なしで GET
      const res = await app.request("/api/sessions/so");
      // Then: 200
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.id).toBe("so");
    });

    it("分析結果を含むべき", async () => {
      // Given: facts 分析結果
      insertAnalysis("sd", "facts", { facts: [{ id: "F1", type: "fact", content: "テスト" }] });
      // When: GET
      const res = await authedRequest("/api/sessions/sd");
      // Then: analysis.facts が含まれる
      const data = (await res.json()) as any;
      expect(data.analysis.facts).toBeDefined();
      expect(data.analysis.facts.facts[0].id).toBe("F1");
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/sessions/:id
  // -------------------------------------------------------------------------
  describe("DELETE /api/sessions/:id", () => {
    beforeEach(() => {
      insertSession("sdel", "テーマ削除", TEST_USER_ID);
      insertMessage("sdel", "user", "テストメッセージ");
      insertAnalysis("sdel", "facts", {});
      insertSession("sodel", "テーマ他", OTHER_USER_ID);
    });

    it("自分のセッションと関連データを削除できること", async () => {
      // Given: 自分のセッション + メッセージ + 分析結果
      // When: DELETE
      const res = await authedRequest("/api/sessions/sdel", { method: "DELETE" });
      // Then: 全て削除される
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).ok).toBe(true);
      expect(rawDb.prepare("SELECT * FROM sessions WHERE id = ?").get("sdel")).toBeUndefined();
      expect(rawDb.prepare("SELECT * FROM messages WHERE session_id = ?").all("sdel")).toHaveLength(0);
      expect(rawDb.prepare("SELECT * FROM analysis_results WHERE session_id = ?").all("sdel")).toHaveLength(0);
    });

    it("他人のセッションは削除できないべき", async () => {
      // Given: 他人のセッション
      // When: DELETE
      const res = await authedRequest("/api/sessions/sodel", { method: "DELETE" });
      // Then: 403
      expect(res.status).toBe(403);
    });

    it("未認証の場合に 401 を返すべき", async () => {
      // Given: 認証なし
      // When: DELETE
      const res = await app.request("/api/sessions/sdel", { method: "DELETE" });
      // Then: 403 (ゲストではオーナー以外のセッション削除不可)
      expect(res.status).toBe(403);
    });

    it("存在しないセッションの場合に 404 を返すべき", async () => {
      // Given: 存在しない ID
      // When: DELETE
      const res = await authedRequest("/api/sessions/nonexistent", { method: "DELETE" });
      // Then: 404
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/sessions/:id/visibility
  // -------------------------------------------------------------------------
  describe("PATCH /api/sessions/:id/visibility", () => {
    beforeEach(() => {
      insertSession("svis", "公開テスト", TEST_USER_ID);
    });

    it("セッションを公開に変更できること", async () => {
      // Given: 非公開セッション
      // When: is_public: true で PATCH
      const res = await authedRequest("/api/sessions/svis/visibility", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_public: true }),
      });
      // Then: is_public = 1
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.is_public).toBe(1);
    });

    it("セッションを非公開に変更できること", async () => {
      // Given: 公開セッション
      rawDb.prepare("UPDATE sessions SET is_public = 1 WHERE id = ?").run("svis");
      // When: is_public: false で PATCH
      const res = await authedRequest("/api/sessions/svis/visibility", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_public: false }),
      });
      // Then: is_public = 0
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.is_public).toBe(0);
    });

    it("不正なボディの場合に 400 を返すべき", async () => {
      // Given: 認証済み
      // When: is_public がブーリアンでない
      const res = await authedRequest("/api/sessions/svis/visibility", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_public: "yes" }),
      });
      // Then: 400
      expect(res.status).toBe(400);
    });

    it("未認証の場合に 401 を返すべき", async () => {
      // Given: 認証なし
      // When: PATCH
      const res = await app.request("/api/sessions/svis/visibility", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_public: true }),
      });
      // Then: 403 (ゲストではオーナー以外のセッション変更不可)
      expect(res.status).toBe(403);
    });

    it("他人のセッションは変更できないべき", async () => {
      // Given: 他人のセッション
      // When: PATCH
      const res = await otherUserRequest("/api/sessions/svis/visibility", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_public: true }),
      });
      // Then: 403
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/start
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/start", () => {
    beforeEach(() => {
      insertSession("sstart", "インタビューテーマ", TEST_USER_ID);
    });

    it("インタビューを開始して最初の質問を返すべき", async () => {
      // Given: メッセージなしのセッション
      // When: start
      const res = await authedRequest("/api/sessions/sstart/start", { method: "POST" });
      // Then: LLM の返答が返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.reply).toBe("モック LLM レスポンス");
      expect(callClaude).toHaveBeenCalledOnce();
      // メッセージが DB に保存される
      const msgs = rawDb.prepare("SELECT * FROM messages WHERE session_id = ?").all("sstart") as any[];
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe("assistant");
    });

    it("既にメッセージがある場合は alreadyStarted を返すべき", async () => {
      // Given: 既にメッセージあり
      insertMessage("sstart", "assistant", "最初の質問");
      // When: start
      const res = await authedRequest("/api/sessions/sstart/start", { method: "POST" });
      // Then: alreadyStarted = true
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.alreadyStarted).toBe(true);
      expect(callClaude).not.toHaveBeenCalled();
    });

    it("他人のセッションでは開始できないべき", async () => {
      // Given: 他人のセッション
      insertSession("sstart-other", "他テーマ", OTHER_USER_ID);
      // When: start
      const res = await authedRequest("/api/sessions/sstart-other/start", { method: "POST" });
      // Then: 403
      expect(res.status).toBe(403);
    });

    it("未認証でもセッションオーナー以外は 403 を返すべき", async () => {
      const res = await app.request("/api/sessions/sstart/start", { method: "POST" });
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/chat
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/chat", () => {
    beforeEach(() => {
      insertSession("schat", "チャットテーマ", TEST_USER_ID);
      insertMessage("schat", "assistant", "最初の質問です");
    });

    it("メッセージを送信して AI の返答を受け取れること", async () => {
      // Given: 開始済みセッション
      // When: メッセージ送信
      const res = await authedRequest("/api/sessions/schat/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "テスト回答" }),
      });
      // Then: 返答が返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.reply).toBeDefined();
      expect(data.turnCount).toBe(1);
      expect(callClaude).toHaveBeenCalledOnce();
      // ユーザーと AI のメッセージが DB に保存
      const msgs = rawDb
        .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at")
        .all("schat") as any[];
      expect(msgs).toHaveLength(3); // assistant + user + assistant
    });

    it("メッセージが空の場合に 400 を返すべき", async () => {
      const res = await authedRequest("/api/sessions/schat/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "" }),
      });
      expect(res.status).toBe(400);
    });

    it("8 ターン以上で readyForAnalysis が true になること", async () => {
      // Given: 8 ターン分のメッセージを挿入
      for (let i = 0; i < 8; i++) {
        insertMessage("schat", "user", `回答${i}`);
        insertMessage("schat", "assistant", `質問${i}`);
      }
      // When: さらにメッセージ送信
      const res = await authedRequest("/api/sessions/schat/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "最後の回答" }),
      });
      // Then: readyForAnalysis が true
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.readyForAnalysis).toBe(true);
    });

    it("READY_FOR_ANALYSIS タグが返答から除去されること", async () => {
      // Given: LLM が [READY_FOR_ANALYSIS] を含む返答を返す
      vi.mocked(extractText).mockReturnValueOnce("まとめです[READY_FOR_ANALYSIS]");
      // When: chat
      const res = await authedRequest("/api/sessions/schat/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "テスト" }),
      });
      // Then: タグが除去される
      const data = (await res.json()) as any;
      expect(data.reply).toBe("まとめです");
      expect(data.readyForAnalysis).toBe(true);
    });

    it("他人のセッションにはチャットできないべき", async () => {
      const res = await otherUserRequest("/api/sessions/schat/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "テスト" }),
      });
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/analyze
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/analyze", () => {
    const mockFacts = {
      facts: [{ id: "F1", type: "fact", content: "テスト事実", evidence: "発話", severity: "high" }],
    };

    beforeEach(() => {
      insertSession("sanalyze", "分析テーマ", TEST_USER_ID);
      insertMessage("sanalyze", "assistant", "質問");
      insertMessage("sanalyze", "user", "回答");
      vi.mocked(extractText).mockReturnValue(JSON.stringify(mockFacts));
    });

    it("インタビュー記録からファクトを抽出できること", async () => {
      // When: analyze
      const res = await authedRequest("/api/sessions/sanalyze/analyze", { method: "POST" });
      // Then: ファクトが返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.facts).toBeDefined();
      expect(data.facts[0].id).toBe("F1");
      // DB に保存される
      const row = rawDb
        .prepare("SELECT * FROM analysis_results WHERE session_id = ? AND type = ?")
        .get("sanalyze", "facts") as any;
      expect(row).toBeDefined();
      // ステータスが updated
      const session = rawDb.prepare("SELECT status FROM sessions WHERE id = ?").get("sanalyze") as any;
      expect(session.status).toBe("analyzed");
    });

    it("既存のファクト分析を上書き更新できること", async () => {
      // Given: 既にファクト分析がある
      insertAnalysis("sanalyze", "facts", { facts: [{ id: "OLD" }] });
      // When: 再度 analyze
      const res = await authedRequest("/api/sessions/sanalyze/analyze", { method: "POST" });
      // Then: 上書きされる
      expect(res.status).toBe(200);
      const rows = rawDb
        .prepare("SELECT * FROM analysis_results WHERE session_id = ? AND type = ?")
        .all("sanalyze", "facts") as any[];
      expect(rows).toHaveLength(1);
      const parsed = JSON.parse(rows[0].data);
      expect(parsed.facts[0].id).toBe("F1");
    });

    it("LLM が不正な JSON を返した場合にフォールバックすること", async () => {
      // Given: LLM が JSON でない文字列を返す
      vi.mocked(extractText).mockReturnValueOnce("これは JSON ではありません");
      // When: analyze
      const res = await authedRequest("/api/sessions/sanalyze/analyze", { method: "POST" });
      // Then: フォールバック形式で返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.facts).toBeDefined();
      expect(data.facts[0].id).toBe("F1");
      expect(data.facts[0].content).toContain("JSON");
    });

    it("他人のセッションは分析できないべき", async () => {
      const res = await otherUserRequest("/api/sessions/sanalyze/analyze", { method: "POST" });
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/hypotheses
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/hypotheses", () => {
    const mockHypotheses = {
      hypotheses: [
        {
          id: "H1",
          title: "仮説1",
          description: "説明",
          supportingFacts: ["F1"],
          counterEvidence: "反証",
          unverifiedPoints: ["未検証"],
        },
      ],
    };

    beforeEach(() => {
      insertSession("shyp", "仮説テーマ", TEST_USER_ID);
      insertAnalysis("shyp", "facts", { facts: [{ id: "F1" }] });
      vi.mocked(extractText).mockReturnValue(JSON.stringify(mockHypotheses));
    });

    it("ファクトから仮説を生成できること", async () => {
      // When: hypotheses
      const res = await authedRequest("/api/sessions/shyp/hypotheses", { method: "POST" });
      // Then: 仮説が返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.hypotheses).toBeDefined();
      expect(data.hypotheses[0].id).toBe("H1");
      // ステータスが更新される
      const session = rawDb.prepare("SELECT status FROM sessions WHERE id = ?").get("shyp") as any;
      expect(session.status).toBe("hypothesized");
    });

    it("ファクトが未抽出の場合に 400 を返すべき", async () => {
      // Given: ファクトなし
      insertSession("shyp-nofact", "テーマ", TEST_USER_ID);
      // When: hypotheses
      const res = await authedRequest("/api/sessions/shyp-nofact/hypotheses", { method: "POST" });
      // Then: 400
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain("ファクト");
    });

    it("既存の仮説を上書き更新できること", async () => {
      // Given: 既に仮説あり
      insertAnalysis("shyp", "hypotheses", { hypotheses: [{ id: "OLD" }] });
      // When: 再度 hypotheses
      const res = await authedRequest("/api/sessions/shyp/hypotheses", { method: "POST" });
      // Then: 上書きされる
      expect(res.status).toBe(200);
      const rows = rawDb
        .prepare("SELECT * FROM analysis_results WHERE session_id = ? AND type = ?")
        .all("shyp", "hypotheses") as any[];
      expect(rows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/prd
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/prd", () => {
    const mockPrd = {
      prd: {
        problemDefinition: "問題定義",
        targetUser: "ターゲット",
        jobsToBeDone: ["ジョブ1"],
        coreFeatures: [],
        nonGoals: [],
        userFlows: [],
        metrics: [],
      },
    };

    beforeEach(() => {
      insertSession("sprd", "PRD テーマ", TEST_USER_ID);
      insertAnalysis("sprd", "facts", { facts: [{ id: "F1" }] });
      insertAnalysis("sprd", "hypotheses", { hypotheses: [{ id: "H1" }] });
      vi.mocked(extractText).mockReturnValue(JSON.stringify(mockPrd));
    });

    it("ファクトと仮説から PRD を生成できること", async () => {
      // When: prd
      const res = await authedRequest("/api/sessions/sprd/prd", { method: "POST" });
      // Then: PRD が返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.prd).toBeDefined();
      expect(data.prd.problemDefinition).toBe("問題定義");
      // ステータスが更新される
      const session = rawDb.prepare("SELECT status FROM sessions WHERE id = ?").get("sprd") as any;
      expect(session.status).toBe("prd_generated");
    });

    it("ファクトまたは仮説が未生成の場合に 400 を返すべき", async () => {
      // Given: ファクトのみ
      insertSession("sprd-nohyp", "テーマ", TEST_USER_ID);
      insertAnalysis("sprd-nohyp", "facts", { facts: [] });
      // When: prd
      const res = await authedRequest("/api/sessions/sprd-nohyp/prd", { method: "POST" });
      // Then: 400
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/spec
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/spec", () => {
    const mockSpec = {
      spec: {
        projectName: "テストプロジェクト",
        techStack: { frontend: "React", backend: "Hono", database: "SQLite" },
        apiEndpoints: [],
        dbSchema: "CREATE TABLE test (id TEXT)",
        screens: [],
        testCases: [],
      },
    };

    beforeEach(() => {
      insertSession("sspec", "Spec テーマ", TEST_USER_ID);
      insertAnalysis("sspec", "facts", { facts: [] });
      insertAnalysis("sspec", "hypotheses", { hypotheses: [] });
      insertAnalysis("sspec", "prd", { prd: { problemDefinition: "問題", coreFeatures: [] } });
      vi.mocked(extractText).mockReturnValue(JSON.stringify(mockSpec));
    });

    it("PRD から実装仕様を生成できること", async () => {
      // When: spec
      const res = await authedRequest("/api/sessions/sspec/spec", { method: "POST" });
      // Then: spec が返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.spec).toBeDefined();
      expect(data.spec.projectName).toBe("テストプロジェクト");
      expect(data.prdMarkdown).toBeDefined();
      // ステータスが更新される
      const session = rawDb.prepare("SELECT status FROM sessions WHERE id = ?").get("sspec") as any;
      expect(session.status).toBe("spec_generated");
    });

    it("PRD が未生成の場合に 400 を返すべき", async () => {
      // Given: PRD なし
      insertSession("sspec-noprd", "テーマ", TEST_USER_ID);
      // When: spec
      const res = await authedRequest("/api/sessions/sspec-noprd/spec", { method: "POST" });
      // Then: 400
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain("PRD");
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/sessions/:id/spec-export
  // -------------------------------------------------------------------------
  describe("GET /api/sessions/:id/spec-export", () => {
    const mockSpecData = {
      spec: {
        projectName: "テストプロジェクト",
        techStack: { frontend: "React", backend: "Hono" },
        apiEndpoints: [],
      },
      prdMarkdown: "# PRD\n\nテスト",
    };

    beforeEach(() => {
      insertSession("sexport", "エクスポートテーマ", TEST_USER_ID);
      insertAnalysis("sexport", "spec", mockSpecData);
    });

    it("自分のセッションの spec をエクスポートできること", async () => {
      // Given: spec 生成済みの自分のセッション
      // When: GET spec-export
      const res = await authedRequest("/api/sessions/sexport/spec-export");
      // Then: フォーマットされた spec が返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.theme).toBe("エクスポートテーマ");
      expect(data.spec.projectName).toBe("テストプロジェクト");
      expect(data.prdMarkdown).toBe("# PRD\n\nテスト");
      expect(data.exportedAt).toBeDefined();
    });

    it("公開セッションの spec を未認証でエクスポートできること", async () => {
      // Given: 公開セッション
      rawDb.prepare("UPDATE sessions SET is_public = 1 WHERE id = ?").run("sexport");
      // When: 認証なしで GET
      const res = await app.request("/api/sessions/sexport/spec-export");
      // Then: 200
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.spec.projectName).toBe("テストプロジェクト");
    });

    it("他人の非公開セッションにはアクセスできないべき", async () => {
      // Given: 他人の非公開セッション
      // When: GET
      const res = await otherUserRequest("/api/sessions/sexport/spec-export");
      // Then: 403
      expect(res.status).toBe(403);
    });

    it("存在しないセッションの場合に 404 を返すべき", async () => {
      // Given: 存在しない ID
      // When: GET
      const res = await authedRequest("/api/sessions/nonexistent/spec-export");
      // Then: 404
      expect(res.status).toBe(404);
    });

    it("spec が未生成の場合に 400 を返すべき", async () => {
      // Given: spec なしのセッション
      insertSession("sexport-nospec", "テーマ", TEST_USER_ID);
      // When: GET
      const res = await authedRequest("/api/sessions/sexport-nospec/spec-export");
      // Then: 400
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain("Spec");
    });

    it("未認証で非公開セッションにはアクセスできないべき", async () => {
      // Given: 非公開セッション（認証なし）
      // When: GET
      const res = await app.request("/api/sessions/sexport/spec-export");
      // Then: 403
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/readiness
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/readiness", () => {
    const mockReadiness = {
      readiness: {
        categories: [
          {
            id: "functionalSuitability",
            label: "機能適合性",
            items: [
              {
                id: "FS-1",
                description: "主要ユースケースの全パスが正常に完了すること",
                priority: "must",
                rationale: "基本機能が動作しないとリリースできない",
              },
            ],
          },
          {
            id: "security",
            label: "セキュリティ",
            items: [
              {
                id: "SEC-1",
                description: "入力値はすべてサーバーサイドで検証されていること",
                priority: "must",
                rationale: "XSS・SQLi 対策",
              },
            ],
          },
        ],
      },
    };

    beforeEach(() => {
      insertSession("sready", "Readiness テーマ", TEST_USER_ID);
      insertAnalysis("sready", "facts", { facts: [] });
      insertAnalysis("sready", "hypotheses", { hypotheses: [] });
      insertAnalysis("sready", "prd", { prd: { problemDefinition: "問題" } });
      insertAnalysis("sready", "spec", { spec: { projectName: "テスト" } });
      vi.mocked(extractText).mockReturnValue(JSON.stringify(mockReadiness));
    });

    it("spec 生成後にレディネスチェックリストを生成できること", async () => {
      // When: readiness
      const res = await authedRequest("/api/sessions/sready/readiness", { method: "POST" });
      // Then: レディネスデータが返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.readiness).toBeDefined();
      expect(data.readiness.categories).toHaveLength(2);
      expect(data.readiness.categories[0].id).toBe("functionalSuitability");
      expect(data.readiness.categories[0].items[0].id).toBe("FS-1");
      // DB に保存される
      const row = rawDb
        .prepare("SELECT * FROM analysis_results WHERE session_id = ? AND type = ?")
        .get("sready", "readiness") as any;
      expect(row).toBeDefined();
      // ステータスが更新される
      const session = rawDb.prepare("SELECT status FROM sessions WHERE id = ?").get("sready") as any;
      expect(session.status).toBe("readiness_checked");
    });

    it("spec が未生成の場合に 400 を返すべき", async () => {
      // Given: spec なし
      insertSession("sready-nospec", "テーマ", TEST_USER_ID);
      // When: readiness
      const res = await authedRequest("/api/sessions/sready-nospec/readiness", { method: "POST" });
      // Then: 400
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain("実装仕様");
    });

    it("GET で readiness データを取得できること", async () => {
      // Given: readiness 分析結果がある
      insertAnalysis("sready", "readiness", mockReadiness);
      // When: GET session
      const res = await authedRequest("/api/sessions/sready");
      // Then: analysis.readiness が含まれる
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.analysis.readiness).toBeDefined();
      expect(data.analysis.readiness.readiness.categories).toHaveLength(2);
    });

    it("他人のセッションではレディネスチェックを実行できないべき", async () => {
      const res = await otherUserRequest("/api/sessions/sready/readiness", { method: "POST" });
      expect(res.status).toBe(403);
    });

    it("未認証の場合にアクセス拒否されるべき", async () => {
      const res = await app.request("/api/sessions/sready/readiness", { method: "POST" });
      // PRO_GATE=none: Pro gate をスキップし、オーナーシップチェックで 403
      expect(res.status).toBe(403);
    });

    it("既存のレディネスを上書き更新できること", async () => {
      // Given: 既にレディネスあり
      insertAnalysis("sready", "readiness", { readiness: { categories: [{ id: "OLD" }] } });
      // When: 再度 readiness
      const res = await authedRequest("/api/sessions/sready/readiness", { method: "POST" });
      // Then: 上書きされる
      expect(res.status).toBe(200);
      const rows = rawDb
        .prepare("SELECT * FROM analysis_results WHERE session_id = ? AND type = ?")
        .all("sready", "readiness") as any[];
      expect(rows).toHaveLength(1);
      const parsed = JSON.parse(rows[0].data);
      expect(parsed.readiness.categories[0].id).toBe("functionalSuitability");
    });
  });

  // -------------------------------------------------------------------------
  // Interview choices extraction (extractChoices)
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/start - choices extraction", () => {
    it("[CHOICES] ブロックから選択肢を抽出して choices 配列を返すこと", async () => {
      // Given: LLM が [CHOICES] ブロック付きの返答を返す
      insertSession("schoice-start", "選択肢テスト", TEST_USER_ID);
      vi.mocked(extractText).mockReturnValueOnce(
        "テーマについて教えてください。\n[CHOICES]\nオプションA\nオプションB\nオプションC\n[/CHOICES]",
      );
      // When: start
      const res = await authedRequest("/api/sessions/schoice-start/start", { method: "POST" });
      // Then: choices が返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.choices).toEqual(["オプションA", "オプションB", "オプションC"]);
      expect(data.reply).toBe("テーマについて教えてください。");
      expect(data.reply).not.toContain("[CHOICES]");
    });

    it("[CHOICES] ブロックがない場合は空の choices 配列を返すこと", async () => {
      // Given: LLM が [CHOICES] ブロックなしの返答を返す
      insertSession("schoice-none", "選択肢なしテスト", TEST_USER_ID);
      vi.mocked(extractText).mockReturnValueOnce("選択肢のない質問です。");
      // When: start
      const res = await authedRequest("/api/sessions/schoice-none/start", { method: "POST" });
      // Then: 空の choices
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.choices).toEqual([]);
      expect(data.reply).toBe("選択肢のない質問です。");
    });
  });

  // -------------------------------------------------------------------------
  // Chat choices extraction
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/chat - choices extraction", () => {
    it("chat レスポンスに [CHOICES] ブロックがある場合 choices を返すこと", async () => {
      // Given: LLM が [CHOICES] 付きの返答を返す
      insertSession("schat-choice", "チャット選択肢", TEST_USER_ID);
      insertMessage("schat-choice", "assistant", "最初の質問");
      vi.mocked(extractText).mockReturnValueOnce(
        "次の質問です。\n[CHOICES]\n選択肢1\n選択肢2\nその他（自分で入力）\n[/CHOICES]",
      );
      // When: chat
      const res = await authedRequest("/api/sessions/schat-choice/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "テスト回答" }),
      });
      // Then: choices が含まれる
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.choices).toEqual(["選択肢1", "選択肢2", "その他（自分で入力）"]);
      expect(data.reply).not.toContain("[CHOICES]");
      expect(data.reply).not.toContain("[/CHOICES]");
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/sessions/:id/deploy-bundle
  // -------------------------------------------------------------------------
  describe("GET /api/sessions/:id/deploy-bundle", () => {
    const specData = { spec: { projectName: "デプロイプロジェクト" } };
    const prdData = { prd: { problemDefinition: "デプロイ問題" } };

    beforeEach(() => {
      insertSession("sdeploy-pub", "デプロイテーマ", TEST_USER_ID, { is_public: 1 });
      insertAnalysis("sdeploy-pub", "spec", specData);
      insertAnalysis("sdeploy-pub", "prd", prdData);
      insertSession("sdeploy-priv", "非公開デプロイ", TEST_USER_ID);
      insertAnalysis("sdeploy-priv", "spec", specData);
      insertAnalysis("sdeploy-priv", "prd", prdData);
    });

    it("公開セッションの spec と prd を返すこと", async () => {
      // Given: 公開セッション + spec + prd
      // When: GET deploy-bundle
      const res = await app.request("/api/sessions/sdeploy-pub/deploy-bundle");
      // Then: spec と prd が返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.theme).toBe("デプロイテーマ");
      expect(data.spec).toEqual(specData);
      expect(data.prd).toEqual(prdData);
    });

    it("非公開セッションで token なしの場合 403 を返すこと", async () => {
      // Given: 非公開セッション
      // When: token なしで GET
      const res = await app.request("/api/sessions/sdeploy-priv/deploy-bundle");
      // Then: 403
      expect(res.status).toBe(403);
    });

    it("非公開セッションでも有効な deploy_token があればアクセスできること", async () => {
      // Given: deploy_token が設定された非公開セッション
      rawDb.prepare("UPDATE sessions SET deploy_token = ? WHERE id = ?").run("valid-deploy-token", "sdeploy-priv");
      // When: 正しい token で GET
      const res = await app.request("/api/sessions/sdeploy-priv/deploy-bundle?token=valid-deploy-token");
      // Then: 200
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.spec).toEqual(specData);
      expect(data.prd).toEqual(prdData);
    });

    it("非公開セッションで無効な token の場合 403 を返すこと", async () => {
      // Given: deploy_token が設定された非公開セッション
      rawDb.prepare("UPDATE sessions SET deploy_token = ? WHERE id = ?").run("correct-token", "sdeploy-priv");
      // When: 不正な token で GET
      const res = await app.request("/api/sessions/sdeploy-priv/deploy-bundle?token=wrong-token");
      // Then: 403
      expect(res.status).toBe(403);
    });

    it("存在しないセッションの場合 404 を返すこと", async () => {
      const res = await app.request("/api/sessions/nonexistent/deploy-bundle");
      expect(res.status).toBe(404);
    });

    it("format=text の場合テキスト形式で返すこと", async () => {
      // Given: 公開セッション
      // When: format=text で GET
      const res = await app.request("/api/sessions/sdeploy-pub/deploy-bundle?format=text");
      // Then: テキスト形式のレスポンス
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("# DeepForm Deploy Bundle");
      expect(text).toContain("デプロイテーマ");
      expect(text).toContain("## spec.json");
      expect(text).toContain("## PRD");
    });

    it("spec/prd が未生成の場合 null を返すこと", async () => {
      // Given: 分析結果のない公開セッション
      insertSession("sdeploy-empty", "空テーマ", TEST_USER_ID, { is_public: 1 });
      // When: GET deploy-bundle
      const res = await app.request("/api/sessions/sdeploy-empty/deploy-bundle");
      // Then: spec/prd は null
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.spec).toBeNull();
      expect(data.prd).toBeNull();
      expect(data.theme).toBe("空テーマ");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/deploy-token
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/deploy-token", () => {
    beforeEach(() => {
      insertSession("stoken", "トークンテーマ", TEST_USER_ID);
      insertAnalysis("stoken", "spec", { spec: { projectName: "トークンプロジェクト" } });
    });

    it("deploy token を生成して deployUrl を返すこと", async () => {
      // When: deploy-token
      const res = await authedRequest("/api/sessions/stoken/deploy-token", { method: "POST" });
      // Then: deployUrl, theme, projectName が返る
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.deployUrl).toBeDefined();
      expect(data.deployUrl).toContain("stoken");
      expect(data.deployUrl).toContain("token=");
      expect(data.deployUrl).toContain("format=text");
      expect(data.theme).toBe("トークンテーマ");
      expect(data.projectName).toBe("トークンプロジェクト");
      // DB に token が保存されること
      const session = rawDb.prepare("SELECT deploy_token FROM sessions WHERE id = ?").get("stoken") as any;
      expect(session.deploy_token).toBeDefined();
      expect(session.deploy_token).not.toBeNull();
    });

    it("存在しないセッションの場合 404 を返すこと", async () => {
      const res = await authedRequest("/api/sessions/nonexistent/deploy-token", { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("spec がない場合でも token を生成できること（projectName は空文字）", async () => {
      // Given: spec なしのセッション
      insertSession("stoken-nospec", "テーマ", TEST_USER_ID);
      // When: deploy-token
      const res = await authedRequest("/api/sessions/stoken-nospec/deploy-token", { method: "POST" });
      // Then: projectName は空文字
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.projectName).toBe("");
      expect(data.deployUrl).toBeDefined();
    });

    it("生成された token で deploy-bundle にアクセスできること", async () => {
      // Given: deploy-token を生成
      const tokenRes = await authedRequest("/api/sessions/stoken/deploy-token", { method: "POST" });
      await tokenRes.json();
      // DB から直接 token を取得
      const session = rawDb.prepare("SELECT deploy_token FROM sessions WHERE id = ?").get("stoken") as any;
      const token = session.deploy_token;
      expect(token).toBeDefined();
      // When: 生成された token で deploy-bundle にアクセス
      const bundleRes = await app.request(`/api/sessions/stoken/deploy-bundle?token=${token}`);
      // Then: 200
      expect(bundleRes.status).toBe(200);
      const bundleData = (await bundleRes.json()) as any;
      expect(bundleData.theme).toBe("トークンテーマ");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions - ゲストセッション作成
  // -------------------------------------------------------------------------
  describe("POST /api/sessions - ゲストセッション作成", () => {
    it("未認証の場合 is_public=1 かつ user_id=null でセッションが作成されること", async () => {
      // Given: 認証なし
      // When: テーマを指定して POST
      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "ゲストテーマ" }),
      });
      // Then: セッションが is_public=1, user_id=null で作成される
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.sessionId).toBeDefined();
      expect(data.theme).toBe("ゲストテーマ");
      const row = rawDb.prepare("SELECT * FROM sessions WHERE id = ?").get(data.sessionId) as any;
      expect(row.is_public).toBe(1);
      expect(row.user_id).toBeNull();
    });

    it("ゲストセッションにはセッション上限が適用されないこと", async () => {
      // Given: 認証なし（上限チェックはスキップされる）
      // When: 複数のゲストセッションを作成
      const res1 = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "ゲスト1" }),
      });
      const res2 = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "ゲスト2" }),
      });
      // Then: 両方とも成功
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Pro ゲートのエッジケース
  // -------------------------------------------------------------------------
  describe("Pro ゲートのエッジケース", () => {
    const FREE_USER_ID = "free-user-001";
    const FREE_EXE_USER_ID = "exe-free-001";
    const FREE_EMAIL = "freeuser@example.com";

    async function freeUserRequest(path: string, options: RequestInit = {}): Promise<Response> {
      const headers = new Headers(options.headers);
      headers.set("x-exedev-userid", FREE_EXE_USER_ID);
      headers.set("x-exedev-email", FREE_EMAIL);
      return await app.request(path, { ...options, headers });
    }

    beforeEach(() => {
      // Enable Pro gate for these tests (default is "none")
      process.env.PRO_GATE = "prd";
      rawDb
        .prepare("INSERT INTO users (id, exe_user_id, email, display_name, plan) VALUES (?, ?, ?, ?, ?)")
        .run(FREE_USER_ID, FREE_EXE_USER_ID, FREE_EMAIL, "freeuser", "free");
    });

    afterEach(() => {
      delete process.env.PRO_GATE;
    });

    it("無料ユーザーが PRD 生成しようとした場合 402 を返すこと", async () => {
      // Given: 無料ユーザーのセッション + ファクト + 仮説
      insertSession("spro-prd", "PRDテスト", FREE_USER_ID);
      insertAnalysis("spro-prd", "facts", { facts: [] });
      insertAnalysis("spro-prd", "hypotheses", { hypotheses: [] });
      // When: PRD 生成
      const res = await freeUserRequest("/api/sessions/spro-prd/prd", { method: "POST" });
      // Then: 402 Pro plan required
      expect(res.status).toBe(402);
      const data = (await res.json()) as any;
      expect(data.error).toContain("Pro plan required");
      expect(data.upgrade).toBe(true);
      expect(data.upgradeUrl).toBeDefined();
      expect(data.upgradeUrl).toContain(FREE_USER_ID);
    });

    it("無料ユーザーが spec 生成しようとした場合 402 を返すこと", async () => {
      // Given: 無料ユーザーのセッション
      insertSession("spro-spec", "Specテスト", FREE_USER_ID);
      // When: spec 生成
      const res = await freeUserRequest("/api/sessions/spro-spec/spec", { method: "POST" });
      // Then: 402
      expect(res.status).toBe(402);
      const data = (await res.json()) as any;
      expect(data.upgrade).toBe(true);
    });

    it("未認証ユーザーが PRD 生成しようとした場合 401 を返すこと", async () => {
      // Given: セッション（認証なしでアクセス）
      insertSession("spro-unauth-prd", "未認証PRD", TEST_USER_ID, { is_public: 1 });
      // When: 認証なしで PRD 生成
      const res = await app.request("/api/sessions/spro-unauth-prd/prd", { method: "POST" });
      // Then: 401 Login required
      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error).toContain("Login required");
      expect(data.upgrade).toBe(true);
    });

    it("未認証ユーザーが spec 生成しようとした場合 401 を返すこと", async () => {
      // Given: 公開セッション
      insertSession("spro-unauth-spec", "未認証Spec", TEST_USER_ID, { is_public: 1 });
      // When: 認証なしで spec 生成
      const res = await app.request("/api/sessions/spro-unauth-spec/spec", { method: "POST" });
      // Then: 401
      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.upgrade).toBe(true);
    });

    it("無料ユーザーでも analyze（Pro 不要）は実行できること", async () => {
      // Given: 無料ユーザーのセッション + メッセージ
      insertSession("spro-analyze", "分析テスト", FREE_USER_ID);
      insertMessage("spro-analyze", "assistant", "質問");
      insertMessage("spro-analyze", "user", "回答");
      const mockFacts = { facts: [{ id: "F1", type: "fact", content: "テスト", evidence: "", severity: "high" }] };
      vi.mocked(extractText).mockReturnValueOnce(JSON.stringify(mockFacts));
      // When: analyze
      const res = await freeUserRequest("/api/sessions/spro-analyze/analyze", { method: "POST" });
      // Then: 200（Pro 不要なので成功）
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.facts).toBeDefined();
    });

    it("無料ユーザーでも hypotheses（Pro 不要）は実行できること", async () => {
      // Given: 無料ユーザーのセッション + ファクト
      insertSession("spro-hyp", "仮説テスト", FREE_USER_ID);
      insertAnalysis("spro-hyp", "facts", { facts: [{ id: "F1" }] });
      const mockHyp = {
        hypotheses: [
          { id: "H1", title: "仮説", description: "", supportingFacts: [], counterEvidence: "", unverifiedPoints: [] },
        ],
      };
      vi.mocked(extractText).mockReturnValueOnce(JSON.stringify(mockHyp));
      // When: hypotheses
      const res = await freeUserRequest("/api/sessions/spro-hyp/hypotheses", { method: "POST" });
      // Then: 200（Pro 不要なので成功）
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.hypotheses).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // CRUD エラーハンドリング
  // -------------------------------------------------------------------------
  describe("CRUD エラーハンドリング", () => {
    it("GET /api/sessions/:id で不正な analysis_results データがあっても 500 を返すこと", async () => {
      // Given: 不正な JSON を持つ分析結果
      insertSession("serr-detail", "エラーテスト", TEST_USER_ID);
      rawDb
        .prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)")
        .run("serr-detail", "facts", "invalid-json{{{");
      // When: GET
      const res = await authedRequest("/api/sessions/serr-detail");
      // Then: JSON パースエラーで 500
      expect(res.status).toBe(500);
      const data = (await res.json()) as any;
      expect(data.error).toBe("Internal Server Error");
    });

    it("PATCH /api/sessions/:id/visibility で不正な JSON の場合 500 を返すこと（SyntaxError は catch で 500）", async () => {
      // Given: 自分のセッション
      insertSession("serr-vis", "エラーテスト", TEST_USER_ID);
      // When: 不正な JSON で PATCH
      const res = await authedRequest("/api/sessions/serr-vis/visibility", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{ invalid json",
      });
      // Then: 500（visibility の catch は ZodError のみ特別処理、SyntaxError は汎用 500）
      expect(res.status).toBe(500);
      const data = (await res.json()) as any;
      expect(data.error).toBe("Internal Server Error");
    });
  });
});
