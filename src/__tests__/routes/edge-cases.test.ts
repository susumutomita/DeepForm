import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => await next(),
}));

vi.mock("../../db/index.ts", async () => {
  const { createTestDb } = await import("../helpers/test-db.ts");
  return { db: createTestDb() };
});

vi.mock("../../llm.ts", () => ({
  MODEL_FAST: "claude-sonnet-4-6",
  MODEL_SMART: "claude-opus-4-6",
  callClaude: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "test" }],
  }),
  callClaudeStream: vi.fn(),
  extractText: vi.fn().mockReturnValue("test"),
}));

import { app } from "../../app.ts";
import { extractText } from "../../llm.ts";
import { clearRateLimitMap } from "../../routes/feedback.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

// ---------------------------------------------------------------------------
// Auth & DB helpers
// ---------------------------------------------------------------------------
const TEST_USER_ID = "test-user-001";
const TEST_EXE_USER_ID = "exe-edge-001";
const TEST_EMAIL = "edge@example.com";

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

function insertAnalysis(sessionId: string, type: string, data: unknown): void {
  rawDb
    .prepare("INSERT OR REPLACE INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)")
    .run(sessionId, type, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Setup & Cleanup
// ---------------------------------------------------------------------------
beforeEach(() => {
  rawDb.prepare("DELETE FROM analysis_results").run();
  rawDb.prepare("DELETE FROM messages").run();
  rawDb.prepare("DELETE FROM feedback").run();
  rawDb.prepare("DELETE FROM sessions").run();
  rawDb.prepare("DELETE FROM users").run();
  vi.clearAllMocks();
  clearRateLimitMap();

  // Pre-insert the test user so insertSession can reference it
  rawDb
    .prepare("INSERT INTO users (id, exe_user_id, email, display_name) VALUES (?, ?, ?, ?)")
    .run(TEST_USER_ID, TEST_EXE_USER_ID, TEST_EMAIL, "edgeuser");
});

// ---------------------------------------------------------------------------
// PRD Edit edge-case tests
// ---------------------------------------------------------------------------
describe("PRD Edit", () => {
  describe("POST /api/sessions/:id/prd/suggest", () => {
    it("提案を3つ返すべき", async () => {
      insertSession("sprd-sug", "PRDテーマ", TEST_USER_ID);
      vi.mocked(extractText).mockReturnValueOnce('["候補A", "候補B", "候補C"]');

      const res = await authedRequest("/api/sessions/sprd-sug/prd/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedText: "テスト基準",
          context: "テスト基準を満たすこと",
          sectionType: "qualityRequirements",
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.suggestions).toHaveLength(3);
    });

    it("不正なJSONボディの場合 400 を返すべき", async () => {
      insertSession("sprd-sug-err", "PRDテーマ", TEST_USER_ID);
      const res = await authedRequest("/api/sessions/sprd-sug-err/prd/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid json {{",
      });
      expect(res.status).toBe(400);
    });

    it("バリデーションエラーの場合 400 を返すべき", async () => {
      insertSession("sprd-sug-zod", "PRDテーマ", TEST_USER_ID);
      const res = await authedRequest("/api/sessions/sprd-sug-zod/prd/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedText: "", context: "", sectionType: "invalid" }),
      });
      expect(res.status).toBe(400);
    });

    it("AIが配列を返さない場合 500 を返すべき", async () => {
      insertSession("sprd-sug-no-arr", "PRDテーマ", TEST_USER_ID);
      vi.mocked(extractText).mockReturnValueOnce("これはJSONではありません");
      const res = await authedRequest("/api/sessions/sprd-sug-no-arr/prd/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedText: "テスト",
          context: "テストコンテキスト",
          sectionType: "other",
        }),
      });
      expect(res.status).toBe(500);
    });
  });

  describe("POST /api/sessions/:id/prd/apply", () => {
    it("非カスタム入力でテキストを置換すべき", async () => {
      insertSession("sprd-app", "PRDテーマ", TEST_USER_ID);
      insertAnalysis("sprd-app", "prd", {
        prd: { problemDefinition: "元のテキストです" },
      });

      const res = await authedRequest("/api/sessions/sprd-app/prd/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedText: "元の",
          newText: "新しい",
          context: "元のテキストです",
          sectionType: "other",
          isCustomInput: false,
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.applied).toBe(true);
      expect(data.updatedText).toBe("新しいテキストです");
    });

    it("カスタム入力で関連性ありの場合 applied=true を返すべき", async () => {
      insertSession("sprd-custom", "PRDテーマ", TEST_USER_ID);
      insertAnalysis("sprd-custom", "prd", {
        prd: { problemDefinition: "既存の問題定義" },
      });
      // First call: validation returns relevant=true
      // Second call: rewrite returns new text
      vi.mocked(extractText).mockReturnValueOnce('{"relevant": true}').mockReturnValueOnce("改善された問題定義");

      const res = await authedRequest("/api/sessions/sprd-custom/prd/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedText: "既存の",
          newText: "改善された",
          context: "既存の問題定義",
          sectionType: "other",
          isCustomInput: true,
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.applied).toBe(true);
    });

    it("カスタム入力で関連性なしの場合 applied=false を返すべき", async () => {
      insertSession("sprd-reject", "PRDテーマ", TEST_USER_ID);
      vi.mocked(extractText).mockReturnValueOnce('{"relevant": false, "reason": "関連性なし"}');

      const res = await authedRequest("/api/sessions/sprd-reject/prd/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedText: "テスト",
          newText: "無関係な内容",
          context: "テストコンテキスト",
          sectionType: "other",
          isCustomInput: true,
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.applied).toBe(false);
      expect(data.reason).toContain("関連性なし");
    });

    it("カスタム入力でバリデーション応答が解析不能な場合 applied=false を返すべき", async () => {
      insertSession("sprd-noparse", "PRDテーマ", TEST_USER_ID);
      vi.mocked(extractText).mockReturnValueOnce("解析できない応答");

      const res = await authedRequest("/api/sessions/sprd-noparse/prd/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedText: "テスト",
          newText: "新しい内容",
          context: "テストコンテキスト",
          sectionType: "other",
          isCustomInput: true,
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.applied).toBe(false);
    });

    it("PRDレコードが存在しない場合でもテキスト置換を返すべき", async () => {
      insertSession("sprd-noprd", "PRDテーマ", TEST_USER_ID);
      // No analysis_results for this session

      const res = await authedRequest("/api/sessions/sprd-noprd/prd/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedText: "元の",
          newText: "新しい",
          context: "元のテキストです",
          sectionType: "other",
          isCustomInput: false,
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.applied).toBe(true);
    });

    it("不正なPRD JSONの場合 fallback の文字列置換をすべき", async () => {
      insertSession("sprd-badjson", "PRDテーマ", TEST_USER_ID);
      // Insert invalid JSON as PRD data
      rawDb
        .prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)")
        .run("sprd-badjson", "prd", "not valid json {{{");

      const res = await authedRequest("/api/sessions/sprd-badjson/prd/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedText: "not",
          newText: "is",
          context: "not valid json",
          sectionType: "other",
          isCustomInput: false,
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.applied).toBe(true);
      expect(data.updatedText).toBe("is valid json");
    });
  });
});

// ---------------------------------------------------------------------------
// Feedback rate-limit edge case
// ---------------------------------------------------------------------------
describe("Feedback", () => {
  it("レートリミットが適用されるべき", async () => {
    const body = { type: "bug", message: "テストバグ報告" };
    const options = {
      method: "POST" as const,
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.10.10.10" },
      body: JSON.stringify(body),
    };

    const res1 = await app.request("/api/feedback", options);
    expect(res1.status).toBe(201);

    const res2 = await app.request("/api/feedback", options);
    expect(res2.status).toBe(429);
  });
});
