import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock static file serving
vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => await next(),
}));

// Test DB
vi.mock("../../db/index.ts", async () => {
  const { createTestDb } = await import("../helpers/test-db.ts");
  return { db: createTestDb() };
});

// Mock LLM
vi.mock("../../llm.ts", () => ({
  MODEL_FAST: "claude-sonnet-4-6",
  MODEL_SMART: "claude-opus-4-6",
  callClaude: vi.fn().mockResolvedValue({
    content: [
      {
        type: "text",
        text: '{"refinedPrompt": "refined prompt", "changesSummary": ["fix 1"], "topPriority": "fix usability"}',
      },
    ],
  }),
  extractText: vi
    .fn()
    .mockReturnValue(
      '{"refinedPrompt": "refined prompt", "changesSummary": ["fix 1"], "topPriority": "fix usability"}',
    ),
}));

import { app } from "../../app.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

const TEST_EXE_USER_ID = "exe-prf-001";
const TEST_EMAIL = "prf@example.com";

async function authedRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", TEST_EXE_USER_ID);
  headers.set("x-exedev-email", TEST_EMAIL);
  return await app.request(path, { ...options, headers });
}

function insertUser(id: string, exeUserId: string, email: string): void {
  rawDb.prepare("INSERT OR IGNORE INTO users (id, exe_user_id, email) VALUES (?, ?, ?)").run(id, exeUserId, email);
}

function insertSession(id: string, theme: string, userId: string): void {
  rawDb.prepare("INSERT INTO sessions (id, theme, user_id) VALUES (?, ?, ?)").run(id, theme, userId);
}

function insertAnalysis(sessionId: string, type: string, data: unknown): void {
  rawDb
    .prepare("INSERT OR REPLACE INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)")
    .run(sessionId, type, JSON.stringify(data));
}

beforeEach(() => {
  rawDb.exec(
    "DELETE FROM feedback; DELETE FROM analysis_results; DELETE FROM messages; DELETE FROM sessions; DELETE FROM users;",
  );
  insertUser("u-prf-1", TEST_EXE_USER_ID, TEST_EMAIL);
});

afterEach(() => {
  rawDb.exec(
    "DELETE FROM feedback; DELETE FROM analysis_results; DELETE FROM messages; DELETE FROM sessions; DELETE FROM users;",
  );
});

describe("ポストリリースフィードバック", () => {
  describe("GET /sessions/:id/post-release-feedback/questions", () => {
    it("フィードバック質問を返すべき", async () => {
      insertSession("s-prf-1", "テスト機能", "u-prf-1");
      const res = await app.request("/api/sessions/s-prf-1/post-release-feedback/questions");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.questions).toBeDefined();
      expect(data.questions.length).toBeGreaterThanOrEqual(5);
      expect(data.theme).toBe("テスト機能");

      // Verify question structure
      for (const q of data.questions) {
        expect(q.id).toBeDefined();
        expect(q.question).toBeDefined();
        expect(q.type).toBeDefined();
        expect(["multiple_choice", "scale", "text"]).toContain(q.type);
      }
    });

    it("存在しないセッションに対して 404 を返すべき", async () => {
      const res = await app.request("/api/sessions/nonexistent/post-release-feedback/questions");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /sessions/:id/post-release-feedback", () => {
    it("フィードバックを送信できるべき", async () => {
      insertSession("s-prf-2", "テスト", "u-prf-1");
      const res = await app.request("/api/sessions/s-prf-2/post-release-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: [
            { questionId: "usage", answer: "毎日使っている" },
            { questionId: "stuck_points", answer: "特に困っていない" },
          ],
          respondentName: "テスト太郎",
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.ok).toBe(true);

      // Verify stored in feedback table
      const row = rawDb
        .prepare("SELECT * FROM feedback WHERE type = 'post_release' AND page = '/session/s-prf-2'")
        .get() as any;
      expect(row).toBeDefined();
      expect(row.message).toContain("テスト太郎");
      expect(row.message).toContain("毎日使っている");
    });

    it("空のエントリは 400 を返すべき", async () => {
      insertSession("s-prf-3", "テスト", "u-prf-1");
      const res = await app.request("/api/sessions/s-prf-3/post-release-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: [] }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /sessions/:id/post-release-feedback", () => {
    it("オーナーがフィードバック一覧を取得できるべき", async () => {
      insertSession("s-prf-4", "テスト", "u-prf-1");
      // Insert test feedback
      rawDb
        .prepare("INSERT INTO feedback (type, message, page) VALUES (?, ?, ?)")
        .run("post_release", "test feedback", "/session/s-prf-4");

      const res = await authedRequest("/api/sessions/s-prf-4/post-release-feedback");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.feedbackCount).toBe(1);
      expect(data.feedback[0].message).toBe("test feedback");
    });
  });

  describe("POST /sessions/:id/post-release-feedback/refine", () => {
    it("フィードバックに基づいてプロンプトを改善すべき", async () => {
      insertSession("s-prf-5", "テスト", "u-prf-1");
      insertAnalysis("s-prf-5", "claude_code_prompt", {
        prompt: "original prompt",
        exportedAt: new Date().toISOString(),
      });
      // Insert feedback
      rawDb
        .prepare("INSERT INTO feedback (type, message, page) VALUES (?, ?, ?)")
        .run("post_release", "操作が分かりにくい", "/session/s-prf-5");

      const res = await authedRequest("/api/sessions/s-prf-5/post-release-feedback/refine", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.refinedPrompt).toBeDefined();
      expect(data.feedbackCount).toBe(1);
    });

    it("プロンプト未生成の場合は 400 を返すべき", async () => {
      insertSession("s-prf-6", "テスト", "u-prf-1");
      const res = await authedRequest("/api/sessions/s-prf-6/post-release-feedback/refine", {
        method: "POST",
      });
      expect(res.status).toBe(400);
    });

    it("フィードバックがない場合は 400 を返すべき", async () => {
      insertSession("s-prf-7", "テスト", "u-prf-1");
      insertAnalysis("s-prf-7", "claude_code_prompt", {
        prompt: "original prompt",
        exportedAt: new Date().toISOString(),
      });
      const res = await authedRequest("/api/sessions/s-prf-7/post-release-feedback/refine", {
        method: "POST",
      });
      expect(res.status).toBe(400);
    });
  });
});
