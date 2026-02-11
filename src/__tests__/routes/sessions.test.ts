import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock static file serving to avoid filesystem access in tests
vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => await next(),
}));

// node:sqlite でテスト用 DB を作成（ネイティブバイナリ不要）
vi.mock("../../db.ts", async () => {
  const { createTestDb } = await import("../helpers/test-db.ts");
  return { db: createTestDb() };
});

// Mock LLM
vi.mock("../../llm.ts", () => ({
  callClaude: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "モック LLM レスポンス" }],
  }),
  extractText: vi.fn().mockReturnValue("モック LLM レスポンス"),
}));

import { app } from "../../app.ts";
import { db } from "../../db.ts";
import { callClaude, extractText } from "../../llm.ts";

// ---------------------------------------------------------------------------
// Auth helpers — exe.dev proxy header authentication
// ---------------------------------------------------------------------------
const TEST_USER_ID = "test-user-001";
const TEST_EXE_USER_ID = "exe-test-001";
const TEST_EMAIL = "testuser@example.com";
const OTHER_USER_ID = "test-user-002";
const OTHER_EXE_USER_ID = "exe-test-002";
const OTHER_EMAIL = "otheruser@example.com";

function authHeaders(exeUserId: string = TEST_EXE_USER_ID, email: string = TEST_EMAIL): Record<string, string> {
  return {
    "x-exedev-userid": exeUserId,
    "x-exedev-email": email,
  };
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("セッション API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean all tables (order matters for foreign keys)
    db.exec("DELETE FROM analysis_results");
    db.exec("DELETE FROM messages");
    db.exec("DELETE FROM campaigns");
    db.exec("DELETE FROM sessions");
    db.exec("DELETE FROM users");
    // Insert test users
    db.prepare("INSERT INTO users (id, exe_user_id, email, display_name) VALUES (?, ?, ?, ?)").run(
      TEST_USER_ID,
      TEST_EXE_USER_ID,
      TEST_EMAIL,
      "testuser",
    );
    db.prepare("INSERT INTO users (id, exe_user_id, email, display_name) VALUES (?, ?, ?, ?)").run(
      OTHER_USER_ID,
      OTHER_EXE_USER_ID,
      OTHER_EMAIL,
      "otheruser",
    );
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions
  // -------------------------------------------------------------------------
  describe("POST /api/sessions", () => {
    it("テーマを指定してセッションを作成できるべき", async () => {
      const res = await authedRequest("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "テストテーマ" }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.sessionId).toBeDefined();
      expect(data.theme).toBe("テストテーマ");

      const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(data.sessionId) as any;
      expect(row).toBeDefined();
      expect(row.theme).toBe("テストテーマ");
      expect(row.user_id).toBe(TEST_USER_ID);
    });

    it("テーマが空の場合に 400 を返すべき", async () => {
      const res = await authedRequest("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "" }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain("テーマ");
    });

    it("テーマが空白のみの場合でも作成できるべき", async () => {
      const res = await authedRequest("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "   " }),
      });

      expect(res.status).toBe(200);
    });

    it("未認証の場合に 401 を返すべき", async () => {
      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "テスト" }),
      });

      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/sessions
  // -------------------------------------------------------------------------
  describe("GET /api/sessions", () => {
    beforeEach(() => {
      db.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(
        "session-1",
        "テーマ1",
        TEST_USER_ID,
      );
      db.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(
        "session-2",
        "テーマ2",
        TEST_USER_ID,
      );
      db.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(
        "session-3",
        "テーマ3",
        OTHER_USER_ID,
      );
      db.prepare("INSERT INTO sessions (id, theme, user_id, is_public) VALUES (?, ?, ?, ?)").run(
        "session-4",
        "公開テーマ",
        OTHER_USER_ID,
        1,
      );
    });

    it("認証済みユーザーの場合に自分のセッションと公開セッションを返すべき", async () => {
      const res = await authedRequest("/api/sessions");

      expect(res.status).toBe(200);
      const data = (await res.json()) as any[];
      expect(data.length).toBe(3);
      const ids = data.map((s) => s.id);
      expect(ids).toContain("session-1");
      expect(ids).toContain("session-2");
      expect(ids).toContain("session-4");
      expect(ids).not.toContain("session-3");
    });

    it("未認証の場合に公開セッションのみ返すべき", async () => {
      const res = await app.request("/api/sessions");

      expect(res.status).toBe(200);
      const data = (await res.json()) as any[];
      expect(data.length).toBe(1);
      expect(data[0].id).toBe("session-4");
    });

    it("メッセージ数を含むべき", async () => {
      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
        "session-1",
        "assistant",
        "質問1",
      );
      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run("session-1", "user", "回答1");

      const res = await authedRequest("/api/sessions");
      const data = (await res.json()) as any[];
      const s1 = data.find((s) => s.id === "session-1");
      expect(s1.message_count).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/sessions/:id
  // -------------------------------------------------------------------------
  describe("GET /api/sessions/:id", () => {
    beforeEach(() => {
      db.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(
        "session-detail",
        "テーマ詳細",
        TEST_USER_ID,
      );
      db.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(
        "session-other",
        "テーマ他",
        OTHER_USER_ID,
      );
      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
        "session-detail",
        "assistant",
        "最初の質問",
      );
    });

    it("自分のセッションの詳細を取得できるべき", async () => {
      const res = await authedRequest("/api/sessions/session-detail");

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.id).toBe("session-detail");
      expect(data.theme).toBe("テーマ詳細");
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].role).toBe("assistant");
      expect(data.analysis).toBeDefined();
    });

    it("他人の非公開セッションにアクセスした場合に 403 を返すべき", async () => {
      const res = await authedRequest("/api/sessions/session-other");

      expect(res.status).toBe(403);
    });

    it("存在しないセッションの場合に 404 を返すべき", async () => {
      const res = await authedRequest("/api/sessions/nonexistent");

      expect(res.status).toBe(404);
    });

    it("公開セッションには未認証でもアクセスできるべき", async () => {
      db.prepare("UPDATE sessions SET is_public = 1 WHERE id = ?").run("session-other");

      const res = await app.request("/api/sessions/session-other");

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.id).toBe("session-other");
    });

    it("分析結果を含むべき", async () => {
      const factsData = JSON.stringify({
        facts: [{ id: "F1", type: "fact", content: "テスト" }],
      });
      db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
        "session-detail",
        "facts",
        factsData,
      );

      const res = await authedRequest("/api/sessions/session-detail");
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
      db.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(
        "session-del",
        "テーマ削除",
        TEST_USER_ID,
      );
      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
        "session-del",
        "user",
        "テストメッセージ",
      );
      db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
        "session-del",
        "facts",
        "{}",
      );
      db.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(
        "session-other-del",
        "テーマ他",
        OTHER_USER_ID,
      );
    });

    it("自分のセッションと関連データを削除できるべき", async () => {
      const res = await authedRequest("/api/sessions/session-del", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);

      const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get("session-del");
      expect(session).toBeUndefined();
      const messages = db.prepare("SELECT * FROM messages WHERE session_id = ?").all("session-del");
      expect(messages).toHaveLength(0);
      const analyses = db.prepare("SELECT * FROM analysis_results WHERE session_id = ?").all("session-del");
      expect(analyses).toHaveLength(0);
    });

    it("他人のセッションは削除できないべき", async () => {
      const res = await authedRequest("/api/sessions/session-other-del", {
        method: "DELETE",
      });

      expect(res.status).toBe(403);
    });

    it("未認証の場合に 401 を返すべき", async () => {
      const res = await app.request("/api/sessions/session-del", {
        method: "DELETE",
      });

      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/start
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/start", () => {
    beforeEach(() => {
      db.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(
        "session-start",
        "インタビューテーマ",
        TEST_USER_ID,
      );
    });

    it("インタビューを開始して LLM の回答を返すべき", async () => {
      const res = await authedRequest("/api/sessions/session-start/start", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.reply).toBeDefined();
      expect(callClaude).toHaveBeenCalledTimes(1);
      expect(extractText).toHaveBeenCalledTimes(1);

      const messages = db.prepare("SELECT * FROM messages WHERE session_id = ?").all("session-start");
      expect(messages).toHaveLength(1);
      expect((messages[0] as any).role).toBe("assistant");
    });

    it("既に開始済みの場合に alreadyStarted フラグを返すべき", async () => {
      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
        "session-start",
        "assistant",
        "既存の質問",
      );

      const res = await authedRequest("/api/sessions/session-start/start", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.alreadyStarted).toBe(true);
      expect(callClaude).not.toHaveBeenCalled();
    });

    it("未認証の場合に 401 を返すべき", async () => {
      const res = await app.request("/api/sessions/session-start/start", {
        method: "POST",
      });

      expect(res.status).toBe(401);
    });

    it("他人のセッションのインタビューは開始できないべき", async () => {
      const res = await otherUserRequest("/api/sessions/session-start/start", { method: "POST" });

      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/chat
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/chat", () => {
    beforeEach(() => {
      db.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(
        "session-chat",
        "チャットテーマ",
        TEST_USER_ID,
      );
      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
        "session-chat",
        "assistant",
        "最初の質問です",
      );
    });

    it("メッセージを送信して LLM の回答を受け取れるべき", async () => {
      const res = await authedRequest("/api/sessions/session-chat/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "テスト回答です" }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.reply).toBeDefined();
      expect(data.turnCount).toBeDefined();
      expect(data.readyForAnalysis).toBeDefined();
      expect(callClaude).toHaveBeenCalledTimes(1);

      const messages = db.prepare("SELECT * FROM messages WHERE session_id = ?").all("session-chat");
      expect(messages).toHaveLength(3);
    });

    it("ターン数を正しくカウントすべき", async () => {
      const res = await authedRequest("/api/sessions/session-chat/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "ユーザーメッセージ" }),
      });

      const data = (await res.json()) as any;
      expect(data.turnCount).toBe(1);
    });

    it("未認証の場合に 401 を返すべき", async () => {
      const res = await app.request("/api/sessions/session-chat/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "テスト" }),
      });

      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/analyze
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/analyze", () => {
    beforeEach(() => {
      db.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(
        "session-analyze",
        "分析テーマ",
        TEST_USER_ID,
      );
      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
        "session-analyze",
        "assistant",
        "質問です",
      );
      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
        "session-analyze",
        "user",
        "回答です",
      );

      vi.mocked(extractText).mockReturnValue(
        '{"facts":[{"id":"F1","type":"fact","content":"テストファクト","evidence":"テスト証拠","severity":"high"}]}',
      );
    });

    it("ファクトを抽出して保存すべき", async () => {
      const res = await authedRequest("/api/sessions/session-analyze/analyze", { method: "POST" });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.facts).toBeDefined();
      expect(data.facts[0].id).toBe("F1");
      expect(callClaude).toHaveBeenCalledTimes(1);

      const analysis = db
        .prepare("SELECT * FROM analysis_results WHERE session_id = ? AND type = ?")
        .get("session-analyze", "facts") as any;
      expect(analysis).toBeDefined();

      const session = db.prepare("SELECT status FROM sessions WHERE id = ?").get("session-analyze") as any;
      expect(session.status).toBe("analyzed");
    });

    it("既存の分析結果がある場合に上書きすべき", async () => {
      db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
        "session-analyze",
        "facts",
        '{"facts":[]}',
      );

      const res = await authedRequest("/api/sessions/session-analyze/analyze", { method: "POST" });

      expect(res.status).toBe(200);

      const analyses = db
        .prepare("SELECT * FROM analysis_results WHERE session_id = ? AND type = ?")
        .all("session-analyze", "facts");
      expect(analyses).toHaveLength(1);
    });

    it("LLM が不正な JSON を返した場合にフォールバックすべき", async () => {
      vi.mocked(extractText).mockReturnValue("これは JSON ではない");

      const res = await authedRequest("/api/sessions/session-analyze/analyze", { method: "POST" });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.facts).toBeDefined();
      expect(data.facts[0].id).toBe("F1");
    });

    it("未認証の場合に 401 を返すべき", async () => {
      const res = await app.request("/api/sessions/session-analyze/analyze", { method: "POST" });

      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/share
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/share", () => {
    beforeEach(() => {
      db.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(
        "session-share",
        "共有テーマ",
        TEST_USER_ID,
      );
    });

    it("共有トークンを生成すべき", async () => {
      const res = await authedRequest("/api/sessions/session-share/share", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.shareToken).toBeDefined();
      expect(data.theme).toBe("共有テーマ");

      const session = db.prepare("SELECT share_token, mode FROM sessions WHERE id = ?").get("session-share") as any;
      expect(session.share_token).toBe(data.shareToken);
      expect(session.mode).toBe("shared");
    });

    it("既に共有トークンがある場合に既存のトークンを返すべき", async () => {
      db.prepare("UPDATE sessions SET share_token = ? WHERE id = ?").run("existing-token", "session-share");

      const res = await authedRequest("/api/sessions/session-share/share", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.shareToken).toBe("existing-token");
    });

    it("未認証の場合に 401 を返すべき", async () => {
      const res = await app.request("/api/sessions/session-share/share", {
        method: "POST",
      });

      expect(res.status).toBe(401);
    });

    it("他人のセッションの共有トークンは生成できないべき", async () => {
      const res = await otherUserRequest("/api/sessions/session-share/share", { method: "POST" });

      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/shared/:token
  // -------------------------------------------------------------------------
  describe("GET /api/shared/:token", () => {
    beforeEach(() => {
      db.prepare("INSERT INTO sessions (id, theme, user_id, share_token, status) VALUES (?, ?, ?, ?, ?)").run(
        "session-shared",
        "共有テーマ",
        TEST_USER_ID,
        "share-abc",
        "interviewing",
      );
    });

    it("共有トークンでセッション情報を取得できるべき", async () => {
      const res = await app.request("/api/shared/share-abc");

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.theme).toBe("共有テーマ");
      expect(data.status).toBe("interviewing");
      expect(data.messageCount).toBe(0);
    });

    it("メッセージ数とファクトを含むべき", async () => {
      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
        "session-shared",
        "assistant",
        "質問",
      );
      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
        "session-shared",
        "user",
        "回答",
      );

      const factsData = JSON.stringify({ facts: [{ id: "F1" }] });
      db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
        "session-shared",
        "facts",
        factsData,
      );

      const res = await app.request("/api/shared/share-abc");
      const data = (await res.json()) as any;
      expect(data.messageCount).toBe(2);
      expect(data.facts).toBeDefined();
      expect(data.facts.facts[0].id).toBe("F1");
    });

    it("存在しないトークンの場合に 404 を返すべき", async () => {
      const res = await app.request("/api/shared/nonexistent");

      expect(res.status).toBe(404);
    });
  });
});
