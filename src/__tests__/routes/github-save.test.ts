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
  MODEL_FAST: "claude-sonnet-4-6",
  MODEL_SMART: "claude-opus-4-6",
  callClaude: vi.fn().mockResolvedValue({
    content: [
      {
        type: "text",
        text: "# テストプロジェクト\n\nこれはテスト用の README です。プロダクト概要をここに記述します。",
      },
    ],
  }),
  extractText: vi
    .fn()
    .mockReturnValue("# テストプロジェクト\n\nこれはテスト用の README です。プロダクト概要をここに記述します。"),
}));

// Mock GitHub helper
vi.mock("../../helpers/github.ts", () => ({
  saveToGitHub: vi.fn(),
}));

import { app } from "../../app.ts";
import { saveToGitHub } from "../../helpers/github.ts";
import { callClaude } from "../../llm.ts";
import { generateAgentMd, generatePlanMd } from "../../routes/sessions/github-save.ts";
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

const GITHUB_SAVE_SUCCESS = {
  repoUrl: "https://github.com/testuser/deepform-gh-save-s",
  commitSha: "abc123",
  filesCommitted: ["README.md", "PRD.md", "spec.json", "AGENT.md", "Plan.md"],
  isNewRepo: true,
};

function getCommittedFile(filePath: string): { path: string; content: string } | undefined {
  const args = mockSaveToGitHub.mock.calls[0][0];
  return args.files.find((f: { path: string }) => f.path === filePath);
}

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

  it("正常に GitHub に保存できるべき（5 ファイル）", async () => {
    mockSaveToGitHub.mockResolvedValueOnce(GITHUB_SAVE_SUCCESS);

    const res = await authedRequest(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repoUrl).toBe("https://github.com/testuser/deepform-gh-save-s");
    expect(body.commitSha).toBe("abc123");
    expect(body.filesCommitted).toEqual(["README.md", "PRD.md", "spec.json", "AGENT.md", "Plan.md"]);
    expect(body.isNewRepo).toBe(true);

    // saveToGitHub に正しい引数が渡されたか確認
    expect(mockSaveToGitHub).toHaveBeenCalledOnce();
    const args = mockSaveToGitHub.mock.calls[0][0];
    expect(args.token).toBe("ghp_test_token");
    expect(args.sessionId).toBe(SESSION_ID);
    expect(args.theme).toBe("テストテーマ");
    expect(args.files.length).toBe(5);
    expect(args.files.map((f: { path: string }) => f.path)).toEqual([
      "README.md",
      "PRD.md",
      "spec.json",
      "AGENT.md",
      "Plan.md",
    ]);
  });

  it("github_repo_url が DB に保存されるべき", async () => {
    mockSaveToGitHub.mockResolvedValueOnce(GITHUB_SAVE_SUCCESS);

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

    mockSaveToGitHub.mockResolvedValueOnce({ ...GITHUB_SAVE_SUCCESS, commitSha: "def456", isNewRepo: false });

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

  it("AGENT.md にプロジェクト概要とコア機能が含まれるべき", async () => {
    mockSaveToGitHub.mockResolvedValueOnce(GITHUB_SAVE_SUCCESS);

    await authedRequest(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    const agentMd = getCommittedFile("AGENT.md");
    expect(agentMd).toBeDefined();
    expect(agentMd?.content).toContain("AGENT.md");
    expect(agentMd?.content).toContain("テストテーマ");
    expect(agentMd?.content).toContain("NEVER use hardcoded/mock data");
  });

  it("Plan.md に実行計画が含まれるべき", async () => {
    mockSaveToGitHub.mockResolvedValueOnce(GITHUB_SAVE_SUCCESS);

    await authedRequest(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    const planMd = getCommittedFile("Plan.md");
    expect(planMd).toBeDefined();
    expect(planMd?.content).toContain("Plan.md");
    expect(planMd?.content).toContain("テストテーマ");
    expect(planMd?.content).toContain("Progress Log");
  });

  it("LLM 失敗時にフォールバック README を使うべき", async () => {
    // LLM を一時的に失敗させる
    vi.mocked(callClaude).mockRejectedValueOnce(new Error("LLM error"));
    mockSaveToGitHub.mockResolvedValueOnce(GITHUB_SAVE_SUCCESS);

    const res = await authedRequest(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    expect(res.status).toBe(200);

    // フォールバック README が使われていることを確認
    const readme = getCommittedFile("README.md");
    expect(readme).toBeDefined();
    expect(readme?.content).toContain("Generated by [DeepForm]");
    expect(readme?.content).toContain("Quick Start");
  });

  it("LLM が短すぎる応答を返した場合にフォールバック README を使うべき", async () => {
    // callClaude と extractText の両方をオーバーライドして短い応答をシミュレート
    vi.mocked(callClaude).mockResolvedValueOnce({
      content: [{ type: "text", text: "short" }],
    });
    const { extractText } = await import("../../llm.ts");
    vi.mocked(extractText).mockReturnValueOnce("short");
    mockSaveToGitHub.mockResolvedValueOnce(GITHUB_SAVE_SUCCESS);

    const res = await authedRequest(`/api/sessions/${SESSION_ID}/github-save`, {
      method: "POST",
    });

    expect(res.status).toBe(200);

    // フォールバックが使われる（短い応答は # で始まらないか 100 文字未満）
    const readme = getCommittedFile("README.md");
    expect(readme).toBeDefined();
    expect(readme?.content).toContain("Quick Start");
  });
});

// ---------------------------------------------------------------------------
// ヘルパー関数のユニットテスト
// ---------------------------------------------------------------------------
describe("generateAgentMd", () => {
  it("PRD のコア機能と Non-Goals を含めるべき", () => {
    const prd = {
      problemDefinition: "ユーザーがタスクを管理できない",
      targetUser: "フリーランスのエンジニア",
      coreFeatures: [
        { name: "タスク作成", description: "新しいタスクを作成する", priority: "P0" },
        { name: "タスク一覧", description: "タスクを一覧表示する", priority: "P1" },
      ],
      nonGoals: ["チーム管理機能", "課金システム"],
    };
    const spec = { spec: { raw: "# Tech Stack\n- Frontend: React" } };

    const result = generateAgentMd("タスク管理アプリ", prd, spec);

    expect(result).toContain("タスク管理アプリ");
    expect(result).toContain("ユーザーがタスクを管理できない");
    expect(result).toContain("フリーランスのエンジニア");
    expect(result).toContain("タスク作成");
    expect(result).toContain("タスク一覧");
    expect(result).toContain("チーム管理機能");
    expect(result).toContain("課金システム");
    expect(result).toContain("# Tech Stack");
  });

  it("PRD データが空でもエラーにならないべき", () => {
    const result = generateAgentMd("テスト", {}, {});
    expect(result).toContain("AGENT.md");
    expect(result).toContain("テスト");
  });
});

describe("generatePlanMd", () => {
  it("コア機能からタスクリストを生成すべき", () => {
    const prd = {
      problemDefinition: "問題の説明",
      targetUser: "ターゲットユーザー",
      jobsToBeDone: ["タスクを素早く作成したい", "進捗を可視化したい"],
      coreFeatures: [
        {
          name: "タスク CRUD",
          priority: "P0",
          acceptanceCriteria: ["タスクを作成できる", "タスクを削除できる"],
        },
      ],
      userFlows: [
        {
          name: "タスク作成フロー",
          steps: ["ホーム画面を開く", "新規作成ボタンをクリック", "タイトルを入力"],
        },
      ],
    };
    const spec = { spec: { raw: "# Spec content" } };

    const result = generatePlanMd("タスク管理アプリ", prd, spec);

    expect(result).toContain("タスク管理アプリ");
    expect(result).toContain("問題の説明");
    expect(result).toContain("タスクを素早く作成したい");
    expect(result).toContain("タスク CRUD");
    expect(result).toContain("タスクを作成できる");
    expect(result).toContain("タスク作成フロー");
    expect(result).toContain("ホーム画面を開く");
    expect(result).toContain("Progress Log");
  });

  it("PRD データが空でもエラーにならないべき", () => {
    const result = generatePlanMd("テスト", {}, {});
    expect(result).toContain("Plan.md");
    expect(result).toContain("テスト");
  });
});
