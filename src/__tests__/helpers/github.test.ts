import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveToGitHub } from "../../helpers/github.ts";

// --- fetch モック ---
const mockFetch = vi.fn() as unknown as ReturnType<typeof vi.fn> & typeof fetch;
global.fetch = mockFetch;

const TOKEN = "ghp_test_token_123";
const SESSION_ID = "abcdef12-3456-7890-abcd-ef1234567890";
const THEME = "テスト用テーマ";

function mockGhResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub ヘルパー", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("saveToGitHub", () => {
    const files = [
      { path: "PRD.md", content: "# PRD" },
      { path: "spec.json", content: '{"spec":{}}' },
      { path: "README.md", content: "# README" },
    ];

    it("新規リポジトリを作成してファイルをコミットすべき", async () => {
      // 1. GET /user
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { login: "testuser" }));
      // 2. POST /user/repos (create repo)
      mockFetch.mockResolvedValueOnce(
        mockGhResponse(201, {
          full_name: "testuser/deepform-abcdef12",
          html_url: "https://github.com/testuser/deepform-abcdef12",
          default_branch: "main",
        }),
      );
      // 3. GET /repos/.../git/ref/heads/main (waitForRepoReady)
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { object: { sha: "base-sha-001" } }));
      // 4. GET /repos/.../git/ref/heads/main (commitFiles)
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { object: { sha: "base-sha-001" } }));
      // 5-7. POST /repos/.../git/blobs (3 files)
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "blob-sha-1" }));
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "blob-sha-2" }));
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "blob-sha-3" }));
      // 8. POST /repos/.../git/trees
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "tree-sha-001" }));
      // 9. POST /repos/.../git/commits
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "commit-sha-001" }));
      // 10. PATCH /repos/.../git/refs/heads/main
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { object: { sha: "commit-sha-001" } }));

      const result = await saveToGitHub({
        token: TOKEN,
        sessionId: SESSION_ID,
        theme: THEME,
        files,
      });

      expect(result.repoUrl).toBe("https://github.com/testuser/deepform-abcdef12");
      expect(result.commitSha).toBe("commit-sha-001");
      expect(result.filesCommitted).toEqual(["PRD.md", "spec.json", "README.md"]);
      expect(result.isNewRepo).toBe(true);

      // リポジトリ作成リクエストの確認
      const createRepoCall = mockFetch.mock.calls[1];
      expect(createRepoCall[0]).toBe("https://api.github.com/user/repos");
      const createBody = JSON.parse(createRepoCall[1].body);
      expect(createBody.name).toBe("deepform-abcdef12");
      expect(createBody.description).toBe(`DeepForm: ${THEME}`);
    });

    it("既存リポジトリ URL がある場合は更新コミットすべき", async () => {
      // 1. GET /user
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { login: "testuser" }));
      // 2. GET /repos/.../repo (get repo info)
      mockFetch.mockResolvedValueOnce(
        mockGhResponse(200, {
          full_name: "testuser/deepform-abcdef12",
          html_url: "https://github.com/testuser/deepform-abcdef12",
          default_branch: "main",
        }),
      );
      // 3. GET ref
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { object: { sha: "base-sha-002" } }));
      // 4-6. blobs
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "blob-sha-4" }));
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "blob-sha-5" }));
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "blob-sha-6" }));
      // 7. tree
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "tree-sha-002" }));
      // 8. commit
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "commit-sha-002" }));
      // 9. update ref
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { object: { sha: "commit-sha-002" } }));

      const result = await saveToGitHub({
        token: TOKEN,
        sessionId: SESSION_ID,
        theme: THEME,
        files,
        existingRepoUrl: "https://github.com/testuser/deepform-abcdef12",
      });

      expect(result.isNewRepo).toBe(false);
      expect(result.commitSha).toBe("commit-sha-002");
    });

    it("リポジトリ名が衝突した場合は既存リポジトリを使用すべき", async () => {
      // 1. GET /user
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { login: "testuser" }));
      // 2. POST /user/repos → 422 (already exists)
      mockFetch.mockResolvedValueOnce(mockGhResponse(422, { message: "Repository creation failed." }));
      // 3. GET /repos/... (fallback: get existing repo)
      mockFetch.mockResolvedValueOnce(
        mockGhResponse(200, {
          full_name: "testuser/deepform-abcdef12",
          html_url: "https://github.com/testuser/deepform-abcdef12",
          default_branch: "main",
        }),
      );
      // 4. GET ref
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { object: { sha: "base-sha-003" } }));
      // 5-7. blobs
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "blob-sha-7" }));
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "blob-sha-8" }));
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "blob-sha-9" }));
      // 8. tree
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "tree-sha-003" }));
      // 9. commit
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "commit-sha-003" }));
      // 10. update ref
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { object: { sha: "commit-sha-003" } }));

      const result = await saveToGitHub({
        token: TOKEN,
        sessionId: SESSION_ID,
        theme: THEME,
        files,
      });

      expect(result.isNewRepo).toBe(false);
      expect(result.repoUrl).toBe("https://github.com/testuser/deepform-abcdef12");
    });

    it("認証エラーの場合はエラーをスローすべき", async () => {
      // 1. GET /user → 401
      mockFetch.mockResolvedValueOnce(mockGhResponse(401, { message: "Bad credentials" }));

      await expect(
        saveToGitHub({
          token: "invalid-token",
          sessionId: SESSION_ID,
          theme: THEME,
          files,
        }),
      ).rejects.toThrow("GitHub API error 401");
    });

    it("リポジトリ名はセッション ID の先頭 8 文字を使用すべき", async () => {
      // 1. GET /user
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { login: "testuser" }));
      // 2. POST /user/repos
      mockFetch.mockResolvedValueOnce(
        mockGhResponse(201, {
          full_name: "testuser/deepform-abcdef12",
          html_url: "https://github.com/testuser/deepform-abcdef12",
          default_branch: "main",
        }),
      );
      // 3. GET ref (waitForRepoReady)
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { object: { sha: "sha" } }));
      // remaining calls for commit
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { object: { sha: "sha" } }));
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "b1" }));
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "t1" }));
      mockFetch.mockResolvedValueOnce(mockGhResponse(201, { sha: "c1" }));
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { object: { sha: "c1" } }));

      await saveToGitHub({
        token: TOKEN,
        sessionId: SESSION_ID,
        theme: THEME,
        files: [{ path: "test.txt", content: "hello" }],
      });

      const createCall = mockFetch.mock.calls[1];
      const body = JSON.parse(createCall[1].body);
      expect(body.name).toBe("deepform-abcdef12");
    });

    it("新規リポジトリの auto_init が完了しない場合はエラーをスローすべき", async () => {
      vi.useFakeTimers();
      try {
        // 1. GET /user
        mockFetch.mockResolvedValueOnce(mockGhResponse(200, { login: "testuser" }));
        // 2. POST /user/repos (create repo)
        mockFetch.mockResolvedValueOnce(
          mockGhResponse(201, {
            full_name: "testuser/deepform-abcdef12",
            html_url: "https://github.com/testuser/deepform-abcdef12",
            default_branch: "main",
          }),
        );
        // 3-7. GET ref (waitForRepoReady) — 5 回すべて 404
        for (let i = 0; i < 5; i++) {
          mockFetch.mockResolvedValueOnce(mockGhResponse(404, { message: "Not Found" }));
        }

        const promise = saveToGitHub({
          token: TOKEN,
          sessionId: SESSION_ID,
          theme: THEME,
          files: [{ path: "test.txt", content: "hello" }],
        });
        // unhandled rejection を抑制しつつ後で検証する
        let caughtError: Error | undefined;
        promise.catch((e: Error) => {
          caughtError = e;
        });

        // 5 回分のリトライ待機を進める
        await vi.advanceTimersByTimeAsync(5000);

        expect(caughtError).toBeDefined();
        expect(caughtError?.message).toContain("not ready after 5 attempts");
      } finally {
        vi.useRealTimers();
      }
    });

    it("Authorization ヘッダーにトークンを含めるべき", async () => {
      mockFetch.mockResolvedValueOnce(mockGhResponse(200, { login: "testuser" }));

      // 残りの呼び出しでエラーを投げて早期終了
      mockFetch.mockResolvedValueOnce(mockGhResponse(500, { message: "test" }));

      await expect(
        saveToGitHub({
          token: TOKEN,
          sessionId: SESSION_ID,
          theme: THEME,
          files,
        }),
      ).rejects.toThrow();

      const firstCall = mockFetch.mock.calls[0];
      expect(firstCall[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });
  });
});
