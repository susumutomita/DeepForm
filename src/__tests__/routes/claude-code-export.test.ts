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
    content: [{ type: "text", text: "モック LLM レスポンス" }],
  }),
  extractText: vi.fn().mockReturnValue("モック LLM レスポンス"),
}));

import { app } from "../../app.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

const TEST_EXE_USER_ID = "exe-cc-test-001";
const TEST_EMAIL = "cctest@example.com";

async function authedRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", TEST_EXE_USER_ID);
  headers.set("x-exedev-email", TEST_EMAIL);
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

function insertUser(id: string, exeUserId: string, email: string): void {
  rawDb.prepare("INSERT OR IGNORE INTO users (id, exe_user_id, email) VALUES (?, ?, ?)").run(id, exeUserId, email);
}

function insertAnalysis(sessionId: string, type: string, data: unknown): void {
  rawDb
    .prepare("INSERT OR REPLACE INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)")
    .run(sessionId, type, JSON.stringify(data));
}

beforeEach(() => {
  rawDb.exec("DELETE FROM analysis_results; DELETE FROM messages; DELETE FROM sessions; DELETE FROM users;");
  insertUser("u-cc-1", TEST_EXE_USER_ID, TEST_EMAIL);
});

afterEach(() => {
  rawDb.exec(
    "DELETE FROM analysis_results; DELETE FROM messages; DELETE FROM sessions; DELETE FROM users; DELETE FROM feedback;",
  );
});

describe("Claude Code エクスポート", () => {
  it("分析結果がない場合は 400 を返すべき", async () => {
    insertSession("s-cc-1", "テスト機能", "u-cc-1");
    const res = await authedRequest("/api/sessions/s-cc-1/claude-code-export", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("ファクトと PRD がある場合にプロンプトを生成すべき", async () => {
    insertSession("s-cc-2", "社内タスク管理ツール", "u-cc-1");
    insertAnalysis("s-cc-2", "facts", {
      facts: [
        { id: "F1", type: "pain", content: "タスクの進捗が見えない", severity: "high", evidence: "" },
        { id: "F2", type: "workaround", content: "スプレッドシートで管理", severity: "medium", evidence: "" },
      ],
    });
    insertAnalysis("s-cc-2", "prd", {
      prd: {
        problemDefinition: "タスクの進捗管理ができていない",
        targetUser: "チームメンバー5名",
        jobsToBeDone: ["タスクの進捗を確認する"],
        coreFeatures: [
          {
            name: "タスクボード",
            description: "カンバン形式のタスクボード",
            priority: "must",
            acceptanceCriteria: ["タスクをドラッグ＆ドロップで移動できる"],
            edgeCases: ["同時編集時の競合"],
          },
        ],
        nonGoals: ["ガントチャート"],
      },
    });

    const res = await authedRequest("/api/sessions/s-cc-2/claude-code-export", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.prompt).toBeDefined();
    expect(data.prompt).toContain("社内タスク管理ツール");
    expect(data.prompt).toContain("タスクの進捗が見えない");
    expect(data.prompt).toContain("スプレッドシートで管理");
    expect(data.prompt).toContain("タスクボード");
    expect(data.prompt).toContain("デフォルト非機能要件");
    expect(data.prompt).toContain("モックデータ禁止");
    expect(data.sessionId).toBe("s-cc-2");
    expect(data.theme).toBe("社内タスク管理ツール");
    expect(data.exportedAt).toBeDefined();
  });

  it("生成したプロンプトを GET で取得できるべき", async () => {
    insertSession("s-cc-3", "テスト", "u-cc-1");
    insertAnalysis("s-cc-3", "facts", { facts: [{ id: "F1", type: "fact", content: "テスト", severity: "medium" }] });
    insertAnalysis("s-cc-3", "prd", { prd: { problemDefinition: "テスト問題", targetUser: "テストユーザー" } });

    // Generate
    const postRes = await authedRequest("/api/sessions/s-cc-3/claude-code-export", { method: "POST" });
    expect(postRes.status).toBe(200);

    // Retrieve
    const getRes = await authedRequest("/api/sessions/s-cc-3/claude-code-export");
    expect(getRes.status).toBe(200);
    const data = await getRes.json();
    expect(data.prompt).toBeDefined();
    expect(data.prompt).toContain("テスト問題");
  });

  it("プロンプト未生成の場合 GET は 404 を返すべき", async () => {
    insertSession("s-cc-4", "テスト", "u-cc-1");
    const res = await authedRequest("/api/sessions/s-cc-4/claude-code-export");
    expect(res.status).toBe(404);
  });
});

describe("セッション作成時の interview_style", () => {
  it("claude_code スタイルでセッションを作成できるべき", async () => {
    const res = await authedRequest("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "テスト", interview_style: "claude_code" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessionId).toBeDefined();

    // Verify the session has the correct interview_style
    const row = rawDb.prepare("SELECT interview_style FROM sessions WHERE id = ?").get(data.sessionId) as {
      interview_style: string;
    };
    expect(row.interview_style).toBe("claude_code");
  });

  it("デフォルトで depth スタイルになるべき", async () => {
    const res = await authedRequest("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "テスト" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    const row = rawDb.prepare("SELECT interview_style FROM sessions WHERE id = ?").get(data.sessionId) as {
      interview_style: string;
    };
    expect(row.interview_style).toBe("depth");
  });

  it("無効な interview_style は 400 を返すべき", async () => {
    const res = await authedRequest("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "テスト", interview_style: "invalid" }),
    });
    expect(res.status).toBe(400);
  });
});
