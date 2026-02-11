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

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
const TEST_EXE_USER_ID = "exe-test-export-001";
const TEST_EMAIL = "export-test@example.com";

async function authedRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", TEST_EXE_USER_ID);
  headers.set("x-exedev-email", TEST_EMAIL);
  return await app.request(path, { ...options, headers });
}

async function otherUserRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", "exe-other-user");
  headers.set("x-exedev-email", "other@example.com");
  return await app.request(path, { ...options, headers });
}

type SQLInputValue = null | number | bigint | string;

function getUserId(): string {
  const user = db.prepare("SELECT id FROM users WHERE exe_user_id = ?").get(TEST_EXE_USER_ID) as
    | { id: string }
    | undefined;
  return user?.id || "";
}

function insertSession(id: string, theme: string, userId: string, extra: Record<string, SQLInputValue> = {}): void {
  const cols = ["id", "theme", "user_id", ...Object.keys(extra)];
  const placeholders = cols.map(() => "?").join(", ");
  db.prepare(`INSERT INTO sessions (${cols.join(", ")}) VALUES (${placeholders})`).run(
    id,
    theme,
    userId,
    ...Object.values(extra),
  );
}

function insertAnalysis(sessionId: string, type: string, data: unknown): void {
  db.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)").run(
    sessionId,
    type,
    JSON.stringify(data),
  );
}

function setGitHubToken(userId: string, token: string): void {
  db.prepare("UPDATE users SET github_token = ? WHERE id = ?").run(token, userId);
}

// Sample PRD data
const samplePRD = {
  prd: {
    problemDefinition: "テスト問題定義",
    targetUser: "テストユーザー",
    coreFeatures: [
      {
        name: "ユーザー認証",
        description: "メールとパスワードでログインする機能",
        priority: "must",
        acceptanceCriteria: ["メールアドレスでログインできる", "パスワードリセットができる"],
        edgeCases: ["無効なメールアドレスの場合エラーを表示"],
      },
      {
        name: "ダッシュボード",
        description: "ユーザーの活動を一覧表示する画面",
        priority: "should",
        acceptanceCriteria: ["直近7日間のアクティビティが表示される"],
        edgeCases: ["データがない場合は空メッセージを表示"],
      },
    ],
    nonGoals: ["モバイルアプリ対応"],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("GitHub Issues エクスポート API", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM analysis_results").run();
    db.prepare("DELETE FROM messages").run();
    db.prepare("DELETE FROM sessions").run();
    db.prepare("DELETE FROM campaigns").run();
    db.prepare("DELETE FROM auth_sessions").run();
    db.prepare("DELETE FROM users").run();
    vi.restoreAllMocks();
  });

  async function ensureUser(): Promise<string> {
    await authedRequest("/api/sessions");
    return getUserId();
  }

  async function ensureUserWithGitHub(): Promise<string> {
    const userId = await ensureUser();
    setGitHubToken(userId, "ghp_test_token");
    return userId;
  }

  describe("POST /api/sessions/:id/export-issues", () => {
    it("未ログイン時に 401 エラーを返すべき", async () => {
      const res = await app.request("/api/sessions/test-session/export-issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoOwner: "owner", repoName: "repo" }),
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain("ログイン");
    });

    it("存在しないセッション ID で 404 を返すべき", async () => {
      await ensureUserWithGitHub();
      const res = await authedRequest("/api/sessions/nonexistent/export-issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoOwner: "owner", repoName: "repo" }),
      });
      expect(res.status).toBe(404);
    });

    it("他ユーザーのセッションに対して 403 を返すべき", async () => {
      const userId = await ensureUserWithGitHub();
      insertSession("session-export-1", "テスト", userId);

      await otherUserRequest("/api/sessions");

      const res = await otherUserRequest("/api/sessions/session-export-1/export-issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoOwner: "owner", repoName: "repo" }),
      });
      expect(res.status).toBe(403);
    });

    it("バリデーションエラー: repoOwner が空の場合 400 を返すべき", async () => {
      const userId = await ensureUserWithGitHub();
      insertSession("session-val-1", "テスト", userId);

      const res = await authedRequest("/api/sessions/session-val-1/export-issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoOwner: "", repoName: "repo" }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("リポジトリオーナー");
    });

    it("バリデーションエラー: repoName が空の場合 400 を返すべき", async () => {
      const userId = await ensureUserWithGitHub();
      insertSession("session-val-2", "テスト", userId);

      const res = await authedRequest("/api/sessions/session-val-2/export-issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoOwner: "owner", repoName: "" }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("リポジトリ名");
    });

    it("GitHub トークン未連携時に 400 を返すべき", async () => {
      const userId = await ensureUser(); // no GitHub token
      insertSession("session-no-gh", "テスト", userId);

      const res = await authedRequest("/api/sessions/session-no-gh/export-issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoOwner: "owner", repoName: "repo" }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("GitHub");
    });

    it("PRD 未生成時に 400 エラーを返すべき", async () => {
      const userId = await ensureUserWithGitHub();
      insertSession("session-noprd", "テスト", userId);

      const res = await authedRequest("/api/sessions/session-noprd/export-issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoOwner: "owner", repoName: "repo" }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("PRD");
    });

    it("コア機能が空の PRD の場合 400 を返すべき", async () => {
      const userId = await ensureUserWithGitHub();
      insertSession("session-empty-prd", "テスト", userId);
      insertAnalysis("session-empty-prd", "prd", { prd: { coreFeatures: [] } });

      const res = await authedRequest("/api/sessions/session-empty-prd/export-issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoOwner: "owner", repoName: "repo" }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("コア機能");
    });

    it("正常に Issue を作成して結果を返すべき", async () => {
      const userId = await ensureUserWithGitHub();
      insertSession("session-ok", "テスト", userId);
      insertAnalysis("session-ok", "prd", samplePRD);

      let fetchCallCount = 0;
      const originalFetch = globalThis.fetch;
      // @ts-expect-error -- vitest mock
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        if (typeof url === "string" && url.includes("/labels")) {
          return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (typeof url === "string" && url.includes("/issues") && opts?.method === "POST") {
          fetchCallCount++;
          const body = JSON.parse(opts.body);
          return new Response(
            JSON.stringify({
              number: fetchCallCount,
              title: body.title,
              html_url: `https://github.com/testowner/testrepo/issues/${fetchCallCount}`,
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return originalFetch(url, opts);
      });

      try {
        const res = await authedRequest("/api/sessions/session-ok/export-issues", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoOwner: "testowner", repoName: "testrepo" }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.created).toHaveLength(2);
        expect(data.created[0].number).toBe(1);
        expect(data.created[0].title).toBe("ユーザー認証");
        expect(data.created[0].url).toContain("github.com");
        expect(data.created[1].number).toBe(2);
        expect(data.created[1].title).toBe("ダッシュボード");
        expect(data.errors).toHaveLength(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("GitHub API エラー時にエラー配列に記録して返すべき", async () => {
      const userId = await ensureUserWithGitHub();
      insertSession("session-gh-error", "テスト", userId);
      insertAnalysis("session-gh-error", "prd", samplePRD);

      const originalFetch = globalThis.fetch;
      // @ts-expect-error -- vitest mock
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        if (typeof url === "string" && url.includes("/labels")) {
          return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (typeof url === "string" && url.includes("/issues") && opts?.method === "POST") {
          return new Response(JSON.stringify({ message: "Validation Failed" }), {
            status: 422,
            headers: { "Content-Type": "application/json" },
          });
        }
        return originalFetch(url, opts);
      });

      try {
        const res = await authedRequest("/api/sessions/session-gh-error/export-issues", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoOwner: "testowner", repoName: "testrepo" }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.created).toHaveLength(0);
        expect(data.errors).toHaveLength(2);
        expect(data.errors[0].feature).toBe("ユーザー認証");
        expect(data.errors[0].error).toContain("Validation Failed");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("GitHub API で一部成功・一部失敗の場合に両方を返すべき", async () => {
      const userId = await ensureUserWithGitHub();
      insertSession("session-partial", "テスト", userId);
      insertAnalysis("session-partial", "prd", samplePRD);

      let callIndex = 0;
      const originalFetch = globalThis.fetch;
      // @ts-expect-error -- vitest mock
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        if (typeof url === "string" && url.includes("/labels")) {
          return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (typeof url === "string" && url.includes("/issues") && opts?.method === "POST") {
          callIndex++;
          if (callIndex === 1) {
            const body = JSON.parse(opts.body);
            return new Response(
              JSON.stringify({ number: 10, title: body.title, html_url: "https://github.com/o/r/issues/10" }),
              { status: 201, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return originalFetch(url, opts);
      });

      try {
        const res = await authedRequest("/api/sessions/session-partial/export-issues", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoOwner: "testowner", repoName: "testrepo" }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.created).toHaveLength(1);
        expect(data.created[0].title).toBe("ユーザー認証");
        expect(data.errors).toHaveLength(1);
        expect(data.errors[0].feature).toBe("ダッシュボード");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("Issue 本文に受け入れ基準とエッジケースが含まれるべき", async () => {
      const userId = await ensureUserWithGitHub();
      insertSession("session-body", "テスト", userId);
      insertAnalysis("session-body", "prd", samplePRD);

      let capturedBody = "";
      const originalFetch = globalThis.fetch;
      // @ts-expect-error -- vitest mock
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        if (typeof url === "string" && url.includes("/labels")) {
          return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (typeof url === "string" && url.includes("/issues") && opts?.method === "POST") {
          const parsed = JSON.parse(opts.body);
          if (!capturedBody) capturedBody = parsed.body;
          return new Response(
            JSON.stringify({ number: 1, title: parsed.title, html_url: "https://github.com/o/r/issues/1" }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return originalFetch(url, opts);
      });

      try {
        await authedRequest("/api/sessions/session-body/export-issues", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoOwner: "o", repoName: "r" }),
        });

        expect(capturedBody).toContain("## 概要");
        expect(capturedBody).toContain("メールとパスワードでログインする機能");
        expect(capturedBody).toContain("## 受け入れ基準");
        expect(capturedBody).toContain("メールアドレスでログインできる");
        expect(capturedBody).toContain("## エッジケース");
        expect(capturedBody).toContain("無効なメールアドレスの場合エラーを表示");
        expect(capturedBody).toContain("_Generated by DeepForm from PRD_");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("優先度ラベルが Issue に付与されるべき", async () => {
      const userId = await ensureUserWithGitHub();
      insertSession("session-labels", "テスト", userId);
      insertAnalysis("session-labels", "prd", samplePRD);

      const capturedLabels: string[][] = [];
      const originalFetch = globalThis.fetch;
      // @ts-expect-error -- vitest mock
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        if (typeof url === "string" && url.includes("/labels")) {
          return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (typeof url === "string" && url.includes("/issues") && opts?.method === "POST") {
          const parsed = JSON.parse(opts.body);
          capturedLabels.push(parsed.labels);
          return new Response(
            JSON.stringify({
              number: capturedLabels.length,
              title: parsed.title,
              html_url: "https://github.com/o/r/issues/1",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return originalFetch(url, opts);
      });

      try {
        await authedRequest("/api/sessions/session-labels/export-issues", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoOwner: "o", repoName: "r" }),
        });

        expect(capturedLabels[0]).toEqual(["priority: must"]);
        expect(capturedLabels[1]).toEqual(["priority: should"]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("Invalid JSON で 400 を返すべき", async () => {
      const userId = await ensureUserWithGitHub();
      insertSession("session-invalid-json", "テスト", userId);

      const res = await authedRequest("/api/sessions/session-invalid-json/export-issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });
  });
});
