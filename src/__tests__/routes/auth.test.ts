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
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(responses: Array<{ ok: boolean; json: () => Promise<any>; status?: number }>) {
  let callIndex = 0;
  vi.spyOn(global, "fetch").mockImplementation(async () => {
    const response = responses[callIndex++];
    return response as unknown as Response;
  });
}

/**
 * Call GET /api/auth/github, extract the state value from the Set-Cookie
 * header and the redirect URL, and return both so the callback test can
 * present a matching cookie + query-param pair.
 */
async function getOAuthState(): Promise<{ state: string; cookie: string }> {
  const res = await app.request("/api/auth/github");
  const location = res.headers.get("Location") ?? "";
  const url = new URL(location);
  const state = url.searchParams.get("state") ?? "";

  // Build the cookie string from Set-Cookie header
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  // Extract just the cookie value part (e.g. "github_oauth_state=<uuid>")
  const match = setCookie.match(/github_oauth_state=([^;]+)/);
  const cookieValue = match ? match[1] : "";

  return { state, cookie: `github_oauth_state=${cookieValue}` };
}

function cleanTables(): void {
  rawDb.exec("DELETE FROM page_views");
  rawDb.exec("DELETE FROM auth_sessions");
  rawDb.exec("DELETE FROM analysis_results");
  rawDb.exec("DELETE FROM messages");
  rawDb.exec("DELETE FROM sessions");
  rawDb.exec("DELETE FROM feedback");
  rawDb.exec("DELETE FROM users");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Auth routes", () => {
  beforeEach(() => {
    cleanTables();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // GET /api/auth/github
  // =========================================================================
  describe("GET /api/auth/github", () => {
    it("returns 302 redirect to github.com/login/oauth/authorize", async () => {
      const res = await app.request("/api/auth/github");

      expect(res.status).toBe(302);
      const location = res.headers.get("Location") ?? "";
      expect(location).toContain("https://github.com/login/oauth/authorize");
    });

    it("redirect URL contains client_id and scope params", async () => {
      const res = await app.request("/api/auth/github");
      const location = res.headers.get("Location") ?? "";
      const url = new URL(location);

      expect(url.searchParams.has("client_id")).toBe(true);
      expect(url.searchParams.get("scope")).toBe("repo,read:user,user:email");
      expect(url.searchParams.has("state")).toBe(true);
      expect(url.searchParams.has("redirect_uri")).toBe(true);
    });

    it("sets github_oauth_state cookie", async () => {
      const res = await app.request("/api/auth/github");
      const setCookie = res.headers.get("Set-Cookie") ?? "";

      expect(setCookie).toContain("github_oauth_state=");
      expect(setCookie).toContain("HttpOnly");
    });
  });

  // =========================================================================
  // GET /api/auth/github/callback
  // =========================================================================
  describe("GET /api/auth/github/callback", () => {
    it("missing code param redirects to /?error=auth_failed", async () => {
      const res = await app.request("/api/auth/github/callback?state=abc");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=auth_failed");
    });

    it("missing state param redirects to /?error=auth_failed", async () => {
      const res = await app.request("/api/auth/github/callback?code=abc");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=auth_failed");
    });

    it("state mismatch (no cookie) redirects to /?error=auth_failed", async () => {
      const res = await app.request("/api/auth/github/callback?code=abc&state=mismatched");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=auth_failed");
    });

    it("successful flow creates new user, auth_session, sets cookie, and redirects to /", async () => {
      // 1. Get a valid state cookie
      const { state, cookie } = await getOAuthState();
      vi.restoreAllMocks();

      // 2. Mock fetch: token exchange + user info
      mockFetch([
        {
          ok: true,
          json: async () => ({ access_token: "fake-test-token-123" }),
        },
        {
          ok: true,
          json: async () => ({
            id: 12345,
            login: "testuser",
            email: "test@example.com",
            avatar_url: "https://avatars.githubusercontent.com/u/12345",
            name: "Test User",
          }),
        },
      ]);

      // 3. Call callback with matching state
      const res = await app.request(`/api/auth/github/callback?code=test_code&state=${state}`, {
        headers: { Cookie: cookie },
      });

      // Verify redirect to /
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");

      // Verify user was created in DB
      const user = rawDb.prepare("SELECT * FROM users WHERE github_id = ?").get(12345) as any;
      expect(user).toBeTruthy();
      expect(user.email).toBe("test@example.com");
      expect(user.display_name).toBe("Test User");
      expect(user.github_token).toBe("fake-test-token-123");
      expect(user.avatar_url).toBe("https://avatars.githubusercontent.com/u/12345");

      // Verify auth_session was created
      const session = rawDb.prepare("SELECT * FROM auth_sessions WHERE user_id = ?").get(user.id) as any;
      expect(session).toBeTruthy();
      expect(session.expires_at).toBeTruthy();

      // Verify deepform_session cookie is set
      const setCookieHeader = res.headers.get("Set-Cookie") ?? "";
      expect(setCookieHeader).toContain("deepform_session=");
    });

    it("successful flow with existing user by github_id updates token and avatar", async () => {
      // Pre-create a user with github_id
      rawDb
        .prepare(
          `INSERT INTO users (id, exe_user_id, email, display_name, github_id, github_token, avatar_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "existing-user-id",
          "github_12345",
          "old@example.com",
          "Old Name",
          12345,
          "old_token",
          "https://old-avatar.com",
        );

      const { state, cookie } = await getOAuthState();
      vi.restoreAllMocks();

      mockFetch([
        {
          ok: true,
          json: async () => ({ access_token: "fake-new-token-456" }),
        },
        {
          ok: true,
          json: async () => ({
            id: 12345,
            login: "testuser",
            email: "new@example.com",
            avatar_url: "https://new-avatar.com",
            name: "New Name",
          }),
        },
      ]);

      const res = await app.request(`/api/auth/github/callback?code=test_code&state=${state}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");

      // Verify user was updated (not duplicated)
      const users = rawDb.prepare("SELECT * FROM users WHERE github_id = ?").all(12345) as any[];
      expect(users).toHaveLength(1);
      expect(users[0].github_token).toBe("fake-new-token-456");
      expect(users[0].avatar_url).toBe("https://new-avatar.com");
      expect(users[0].email).toBe("new@example.com");
      expect(users[0].display_name).toBe("New Name");
    });

    it("links GitHub account to existing user found by email", async () => {
      // Pre-create a user with email but no github_id
      rawDb
        .prepare(
          `INSERT INTO users (id, exe_user_id, email, display_name)
         VALUES (?, ?, ?, ?)`,
        )
        .run("email-user-id", "exe-user-001", "shared@example.com", "Email User");

      const { state, cookie } = await getOAuthState();
      vi.restoreAllMocks();

      mockFetch([
        {
          ok: true,
          json: async () => ({ access_token: "fake-link-token" }),
        },
        {
          ok: true,
          json: async () => ({
            id: 99999,
            login: "githubuser",
            email: "shared@example.com",
            avatar_url: "https://avatar.example.com",
            name: "GitHub User",
          }),
        },
      ]);

      const res = await app.request(`/api/auth/github/callback?code=test_code&state=${state}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");

      // Verify existing user was linked (not a new user created)
      const allUsers = rawDb.prepare("SELECT * FROM users").all() as any[];
      // Only the original user should exist (no duplicate)
      const linkedUser = allUsers.find((u: any) => u.id === "email-user-id");
      expect(linkedUser).toBeTruthy();
      expect(linkedUser.github_id).toBe(99999);
      expect(linkedUser.github_token).toBe("fake-link-token");
      expect(linkedUser.avatar_url).toBe("https://avatar.example.com");
    });

    it("token exchange failure (no access_token) redirects to /?error=auth_failed", async () => {
      const { state, cookie } = await getOAuthState();
      vi.restoreAllMocks();

      mockFetch([
        {
          ok: true,
          json: async () => ({ error: "bad_verification_code" }),
        },
      ]);

      const res = await app.request(`/api/auth/github/callback?code=bad_code&state=${state}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=auth_failed");
    });

    it("user fetch failure (non-ok response) redirects to /?error=auth_failed", async () => {
      const { state, cookie } = await getOAuthState();
      vi.restoreAllMocks();

      mockFetch([
        {
          ok: true,
          json: async () => ({ access_token: "fake-valid-token" }),
        },
        {
          ok: false,
          status: 401,
          json: async () => ({ message: "Bad credentials" }),
        },
      ]);

      const res = await app.request(`/api/auth/github/callback?code=test_code&state=${state}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=auth_failed");
    });

    it("email fallback: fetches from /user/emails when user email is null", async () => {
      const { state, cookie } = await getOAuthState();
      vi.restoreAllMocks();

      mockFetch([
        {
          ok: true,
          json: async () => ({ access_token: "fake-noemail-token" }),
        },
        {
          ok: true,
          json: async () => ({
            id: 77777,
            login: "noemailuser",
            email: null,
            avatar_url: "https://avatar.example.com/77777",
            name: "No Email User",
          }),
        },
        {
          ok: true,
          json: async () => [
            { email: "secondary@example.com", primary: false, verified: true },
            { email: "primary@example.com", primary: true, verified: true },
          ],
        },
      ]);

      const res = await app.request(`/api/auth/github/callback?code=test_code&state=${state}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");

      // Verify user was created with the primary verified email
      const user = rawDb.prepare("SELECT * FROM users WHERE github_id = ?").get(77777) as any;
      expect(user).toBeTruthy();
      expect(user.email).toBe("primary@example.com");

      // Verify fetch was called 3 times (token + user + emails)
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // GET /api/auth/me
  // =========================================================================
  describe("GET /api/auth/me", () => {
    it("unauthenticated returns { user: null }", async () => {
      const res = await app.request("/api/auth/me");

      expect(res.status).toBe(200);
      const data = (await res.json()) as { user: null };
      expect(data.user).toBeNull();
    });

    it("authenticated via exe.dev headers returns user object", async () => {
      const res = await app.request("/api/auth/me", {
        headers: {
          "x-exedev-userid": "exe-me-001",
          "x-exedev-email": "me@example.com",
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        user: { id: string; email: string; displayName: string; avatarUrl: string | null };
      };
      expect(data.user).toBeTruthy();
      expect(data.user.id).toBeTruthy();
      expect(data.user.email).toBe("me@example.com");
      expect(data.user.displayName).toBeTruthy();
      expect(data.user.avatarUrl).toBeDefined();
    });

    it("does NOT include github_token in the response", async () => {
      // Pre-create a user with a github_token
      rawDb
        .prepare(
          `INSERT INTO users (id, exe_user_id, email, display_name, github_token)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run("token-user-id", "exe-token-001", "token@example.com", "Token User", "secret_github_token");

      const res = await app.request("/api/auth/me", {
        headers: {
          "x-exedev-userid": "exe-token-001",
          "x-exedev-email": "token@example.com",
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.user).toBeTruthy();
      // Ensure github_token is not exposed
      expect(data.user.github_token).toBeUndefined();
      expect(data.user.githubToken).toBeUndefined();
    });
  });

  // =========================================================================
  // POST /api/auth/logout
  // =========================================================================
  describe("POST /api/auth/logout", () => {
    it("with valid session cookie: deletes auth_session from DB and clears cookie", async () => {
      // Pre-create user and auth_session
      rawDb
        .prepare(
          `INSERT INTO users (id, exe_user_id, email, display_name)
         VALUES (?, ?, ?, ?)`,
        )
        .run("logout-user-id", "exe-logout-001", "logout@example.com", "Logout User");

      const sessionId = "test-session-id-to-delete";
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      rawDb
        .prepare(
          `INSERT INTO auth_sessions (id, user_id, expires_at)
         VALUES (?, ?, ?)`,
        )
        .run(sessionId, "logout-user-id", expiresAt);

      // Verify session exists before logout
      const beforeSession = rawDb.prepare("SELECT * FROM auth_sessions WHERE id = ?").get(sessionId);
      expect(beforeSession).toBeTruthy();

      const res = await app.request("/api/auth/logout", {
        method: "POST",
        headers: {
          Cookie: `deepform_session=${sessionId}`,
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(true);

      // Verify session was deleted from DB
      const afterSession = rawDb.prepare("SELECT * FROM auth_sessions WHERE id = ?").get(sessionId);
      expect(afterSession).toBeUndefined();

      // Verify cookie is cleared
      const setCookieHeader = res.headers.get("Set-Cookie") ?? "";
      expect(setCookieHeader).toContain("deepform_session=");
    });

    it("without session cookie returns { ok: true }", async () => {
      const res = await app.request("/api/auth/logout", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(true);
    });
  });
});
