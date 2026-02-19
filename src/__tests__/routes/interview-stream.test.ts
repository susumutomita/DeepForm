import { Readable } from "node:stream";
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

// Mock LLM (including callClaudeStream for streaming tests)
vi.mock("../../llm.ts", () => ({
  MODEL_FAST: "claude-haiku-4-5-20250929",
  MODEL_SMART: "claude-sonnet-4-5-20250929",
  callClaude: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "モック LLM レスポンス" }],
  }),
  callClaudeStream: vi.fn(),
  extractText: vi.fn().mockReturnValue("モック LLM レスポンス"),
}));

import { app } from "../../app.ts";
import { callClaudeStream } from "../../llm.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

// ---------------------------------------------------------------------------
// Auth & DB helpers
// ---------------------------------------------------------------------------
const TEST_USER_ID = "test-user-001";
const TEST_EXE_USER_ID = "exe-stream-001";
const TEST_EMAIL = "stream@example.com";

async function authedRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", TEST_EXE_USER_ID);
  headers.set("x-exedev-email", TEST_EMAIL);
  return await app.request(path, { ...options, headers });
}

function insertSession(id: string, theme: string, userId: string, extra: Record<string, any> = {}): void {
  const cols = ["id", "theme", "user_id", ...Object.keys(extra)];
  const placeholders = cols.map(() => "?").join(", ");
  rawDb
    .prepare(`INSERT INTO sessions (${cols.join(", ")}) VALUES (${placeholders})`)
    .run(id, theme, userId, ...Object.values(extra));
}

function insertMessage(sessionId: string, role: string, content: string): void {
  rawDb.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(sessionId, role, content);
}

/**
 * Mock callClaudeStream to return a Readable that emits chunks then ends.
 * The getFullText callback returns the provided fullText string.
 */
function mockClaudeStream(fullText: string) {
  const readable = new Readable({ read() {} });
  vi.mocked(callClaudeStream).mockReturnValueOnce({
    stream: readable,
    getFullText: () => fullText,
  });
  // Emit data and end asynchronously so the ReadableStream controller can wire up listeners first
  process.nextTick(() => {
    readable.push("chunk");
    readable.push(null);
  });
}

/** Parse SSE text into an array of parsed data objects */
function parseSSEEvents(text: string): any[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("インタビュー ストリーミング API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rawDb.exec("DELETE FROM analysis_results");
    rawDb.exec("DELETE FROM messages");
    rawDb.exec("DELETE FROM campaigns");
    rawDb.exec("DELETE FROM sessions");
    rawDb.exec("DELETE FROM users");
    rawDb
      .prepare("INSERT INTO users (id, exe_user_id, email, display_name, plan) VALUES (?, ?, ?, ?, ?)")
      .run(TEST_USER_ID, TEST_EXE_USER_ID, TEST_EMAIL, "streamuser", "pro");
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/start — SSE streaming
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/start (streaming)", () => {
    it("Accept: text/event-stream で SSE レスポンスを返すこと", async () => {
      // Given: メッセージなしのセッション
      insertSession("sstream-start", "ストリームテーマ", TEST_USER_ID);
      mockClaudeStream("テスト質問\n[CHOICES]\n選択肢A\n選択肢B\n[/CHOICES]");

      // When: Accept: text/event-stream で start
      const res = await authedRequest("/api/sessions/sstream-start/start", {
        method: "POST",
        headers: { Accept: "text/event-stream" },
      });

      // Then: SSE content-type で返る
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");

      const text = await res.text();
      const events = parseSSEEvents(text);

      // delta イベントが含まれる
      const deltas = events.filter((e) => e.type === "delta");
      expect(deltas.length).toBeGreaterThanOrEqual(1);

      // done イベントに choices が含まれる
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect(done.choices).toEqual(["選択肢A", "選択肢B"]);
    });

    it("callClaudeStream が呼ばれること", async () => {
      // Given
      insertSession("sstream-start2", "テーマ2", TEST_USER_ID);
      mockClaudeStream("質問です");

      // When
      await authedRequest("/api/sessions/sstream-start2/start", {
        method: "POST",
        headers: { Accept: "text/event-stream" },
      });

      // Then
      expect(callClaudeStream).toHaveBeenCalledOnce();
    });

    it("[CHOICES] がない場合は空の choices 配列を done に含むこと", async () => {
      // Given
      insertSession("sstream-nochoice", "選択肢なし", TEST_USER_ID);
      mockClaudeStream("選択肢のない質問です。");

      // When
      const res = await authedRequest("/api/sessions/sstream-nochoice/start", {
        method: "POST",
        headers: { Accept: "text/event-stream" },
      });

      // Then
      const events = parseSSEEvents(await res.text());
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect(done.choices).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/sessions/:id/chat — SSE streaming
  // -------------------------------------------------------------------------
  describe("POST /api/sessions/:id/chat (streaming)", () => {
    it("SSE レスポンスに meta (turnCount), delta, done イベントが含まれること", async () => {
      // Given: 開始済みセッション
      insertSession("sstream-chat", "チャットストリーム", TEST_USER_ID);
      insertMessage("sstream-chat", "assistant", "最初の質問です");
      mockClaudeStream("次の質問です");

      // When: Accept: text/event-stream で chat
      const res = await authedRequest("/api/sessions/sstream-chat/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ message: "テスト回答" }),
      });

      // Then: SSE content-type
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");

      const events = parseSSEEvents(await res.text());

      // meta イベントに turnCount が含まれる
      const meta = events.find((e) => e.type === "meta");
      expect(meta).toBeDefined();
      expect(meta.turnCount).toBe(1);

      // delta イベントが含まれる
      const deltas = events.filter((e) => e.type === "delta");
      expect(deltas.length).toBeGreaterThanOrEqual(1);

      // done イベント
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect(done.turnCount).toBe(1);
      expect(done.readyForAnalysis).toBe(false);
    });

    it("8 ターン以上で done の readyForAnalysis が true になること", async () => {
      // Given: 8 ターン分のメッセージを挿入
      insertSession("sstream-ready", "分析準備", TEST_USER_ID);
      insertMessage("sstream-ready", "assistant", "最初の質問");
      for (let i = 0; i < 8; i++) {
        insertMessage("sstream-ready", "user", `回答${i}`);
        insertMessage("sstream-ready", "assistant", `質問${i}`);
      }
      mockClaudeStream("まとめの質問です");

      // When: さらにメッセージ送信
      const res = await authedRequest("/api/sessions/sstream-ready/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ message: "最後の回答" }),
      });

      // Then: readyForAnalysis が true
      const events = parseSSEEvents(await res.text());
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect(done.readyForAnalysis).toBe(true);
    });

    it("[READY_FOR_ANALYSIS] タグで readyForAnalysis が true になること", async () => {
      // Given
      insertSession("sstream-tag", "タグテスト", TEST_USER_ID);
      insertMessage("sstream-tag", "assistant", "最初の質問");
      mockClaudeStream("まとめです[READY_FOR_ANALYSIS]");

      // When
      const res = await authedRequest("/api/sessions/sstream-tag/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ message: "テスト" }),
      });

      // Then
      const events = parseSSEEvents(await res.text());
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect(done.readyForAnalysis).toBe(true);
    });

    it("[CHOICES] ブロックが done イベントの choices に含まれること", async () => {
      // Given
      insertSession("sstream-choices", "選択肢ストリーム", TEST_USER_ID);
      insertMessage("sstream-choices", "assistant", "最初の質問");
      mockClaudeStream("次の質問です\n[CHOICES]\n選択肢1\n選択肢2\nその他（自分で入力）\n[/CHOICES]");

      // When
      const res = await authedRequest("/api/sessions/sstream-choices/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ message: "テスト回答" }),
      });

      // Then
      const events = parseSSEEvents(await res.text());
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect(done.choices).toEqual(["選択肢1", "選択肢2", "その他（自分で入力）"]);
    });

    it("メッセージが空の場合に 400 を返すべき（ZodError パス）", async () => {
      // Given: 開始済みセッション
      insertSession("sstream-zod", "バリデーション", TEST_USER_ID);
      insertMessage("sstream-zod", "assistant", "質問");

      // When: 空メッセージで chat
      const res = await authedRequest("/api/sessions/sstream-zod/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ message: "" }),
      });

      // Then: 400 (ZodError catch)
      expect(res.status).toBe(400);
    });
  });
});
