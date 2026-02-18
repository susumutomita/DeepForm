import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock static file serving to avoid filesystem access in tests
vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: unknown, next: () => Promise<void>) => await next(),
}));

// node:sqlite でテスト用 DB を作成
vi.mock("../../db/index.ts", async () => {
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

// Mock GitHub helper
vi.mock("../../helpers/github.ts", () => ({
  saveToGitHub: vi.fn(),
}));

import { app } from "../../app.ts";
import { saveToGitHub } from "../../helpers/github.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();
const mockSaveToGitHub = vi.mocked(saveToGitHub);

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
const TEST_USER_ID = "test-user-gh-001";
const TEST_EXE_USER_ID = "exe-gh-001";
const TEST_EMAIL = "ghuser@example.com";
const OTHER_EXE_USER_ID = "exe-gh-002";
const OTHER_EMAIL = "other@example.com";

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

const SESSION_ID = "gh-save-session-001";
const PRD_DATA = {
  prd: {
    problemDefinition: "テスト問題",
    targetUser: "テストユーザー",
    jobsToBeDone: [],
    coreFeatures: [],
    nonGoals: [],
    userFlows: [],
    metrics: [],
  },
};
const SPEC_DATA = { spec: { raw: "# Spec" } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("GitHub 保存 API", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // テーブルをクリーンアップ
    rawDb.exec("DELETE FROM analysis_results");
    rawDb.exec("DELETE FROM messages");
    rawDb.exec("DELETE FROM sessions");
    rawDb.exec("DELETE FROM auth_sessions");
    rawDb.exec("DELETE FROM users");

    // テストユーザーを作成（GitHub トークン付き）
    rawDb
      .prepare("INSERT INTO users (id, exe_user_id, email, github_id, github_token) VALUES (?, ?, ?, ?, ?)")
      .run(TEST_USER_ID, TEST_EXE_USER_ID, TEST_EMAIL, 12345, "ghp_test_token");

    // テストセッションを作成
    rawDb
      .prepare("INSERT INTO sessions (id, theme, user_id, status) VALUES (?, ?, ?, ?)")
      .run(SESSION_ID, "テストテーマ", TEST_USER_ID, "spec_generated");

    // PRD と Spec を登録
    rawDb
      .prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)")
      .run(SESSION_ID, "prd", JSON.stringify(PRD_DATA));
    rawDb
      .prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)")
      .run(SESSION_ID, "spec", JSON.stringify(SPEC_DATA));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("正常に GitHub に保存できるべき", async () => {
    mockSaveToGitHub.mockResolvedValueOnce({
      repoUrl: "https://github.com/testuser/deepform-gh-save-s",
      commitSha: "abc123",
      filesCommitted: ["PRD.md", "spec.json", "README.md"],
      isNewRepo: true,
    });

    const res = await authedRequest(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repoUrl).toBe("https://github.com/testuser/deepform-gh-save-s");
    expect(body.commitSha).toBe("abc123");
    expect(body.filesCommitted).toEqual(["PRD.md", "spec.json", "README.md"]);
    expect(body.isNewRepo).toBe(true);

    // saveToGitHub に正しい引数が渡されたか確認
    expect(mockSaveToGitHub).toHaveBeenCalledOnce();
    const args = mockSaveToGitHub.mock.calls[0][0];
    expect(args.token).toBe("ghp_test_token");
    expect(args.sessionId).toBe(SESSION_ID);
    expect(args.theme).toBe("テストテーマ");
    expect(args.files.length).toBe(3);
    expect(args.files[0].path).toBe("PRD.md");
    expect(args.files[1].path).toBe("spec.json");
    expect(args.files[2].path).toBe("README.md");
  });

  it("github_repo_url が DB に保存されるべき", async () => {
    mockSaveToGitHub.mockResolvedValueOnce({
      repoUrl: "https://github.com/testuser/deepform-gh-save-s",
      commitSha: "abc123",
      filesCommitted: ["PRD.md", "spec.json", "README.md"],
      isNewRepo: true,
    });

    await authedRequest(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    const row = rawDb.prepare("SELECT github_repo_url FROM sessions WHERE id = ?").get(SESSION_ID) as {
      github_repo_url: string;
    };
    expect(row.github_repo_url).toBe("https://github.com/testuser/deepform-gh-save-s");
  });

  it("既存の github_repo_url がある場合は更新コミットすべき", async () => {
    // github_repo_url を設定
    rawDb
      .prepare("UPDATE sessions SET github_repo_url = ? WHERE id = ?")
      .run("https://github.com/testuser/deepform-gh-save-s", SESSION_ID);

    mockSaveToGitHub.mockResolvedValueOnce({
      repoUrl: "https://github.com/testuser/deepform-gh-save-s",
      commitSha: "def456",
      filesCommitted: ["PRD.md", "spec.json", "README.md"],
      isNewRepo: false,
    });

    const res = await authedRequest(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isNewRepo).toBe(false);

    // existingRepoUrl が渡されていることを確認
    const args = mockSaveToGitHub.mock.calls[0][0];
    expect(args.existingRepoUrl).toBe("https://github.com/testuser/deepform-gh-save-s");
  });

  it("未ログインの場合は 401 を返すべき", async () => {
    const res = await app.request(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("ログイン");
  });

  it("GitHub 未連携の場合は 400 を返すべき", async () => {
    // GitHub トークンなしのユーザーに更新
    rawDb.prepare("UPDATE users SET github_token = NULL WHERE id = ?").run(TEST_USER_ID);

    const res = await authedRequest(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("GitHub 連携");
  });

  it("他人のセッションにはアクセスできないべき", async () => {
    // 別のユーザーを作成（GitHub トークン付き）
    rawDb
      .prepare("INSERT INTO users (id, exe_user_id, email, github_id, github_token) VALUES (?, ?, ?, ?, ?)")
      .run("other-user", OTHER_EXE_USER_ID, OTHER_EMAIL, 99999, "ghp_other_token");

    const res = await otherUserRequest(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    expect(res.status).toBe(403);
  });

  it("存在しないセッションには 404 を返すべき", async () => {
    const res = await authedRequest("/api/sessions/nonexistent-session/github-save", {
      method: "POST",
    });

    expect(res.status).toBe(404);
  });

  it("PRD 未生成の場合は 400 を返すべき", async () => {
    // 分析結果を削除
    rawDb.exec("DELETE FROM analysis_results");

    const res = await authedRequest(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("PRD");
  });

  it("saveToGitHub がエラーを投げた場合は 500 を返すべき", async () => {
    mockSaveToGitHub.mockRejectedValueOnce(new Error("GitHub API error 500: Internal"));

    const res = await authedRequest(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    expect(res.status).toBe(500);
  });

  it("トークン期限切れの場合は 401 を返すべき", async () => {
    mockSaveToGitHub.mockRejectedValueOnce(new Error("GitHub API error 401: Bad credentials"));

    const res = await authedRequest(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("トークン");
  });
});
