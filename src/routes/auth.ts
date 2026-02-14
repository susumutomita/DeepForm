import crypto from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { now } from "../db/helpers.ts";
import { db } from "../db/index.ts";
import type { User } from "../types.ts";

const auth = new Hono<{ Variables: { user: User | null } }>();

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? "";
const SESSION_MAX_AGE_DAYS = 30;

/**
 * GET /api/auth/github — Redirect to GitHub OAuth authorization
 */
auth.get("/github", (c) => {
  const state = crypto.randomUUID();
  const proto = c.req.header("x-forwarded-proto") || "http";
  const host = c.req.header("x-forwarded-host") || c.req.header("host") || "localhost:8000";
  // Strip port for standard HTTPS (GitHub callback URL must match exactly)
  const cleanHost = proto === "https" ? host.replace(/:443$/, "") : host.replace(/:80$/, "");
  const callbackUrl = `${proto}://${cleanHost}/api/auth/github/callback`;

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: callbackUrl,
    scope: "repo,read:user,user:email",
    state,
  });

  setCookie(c, "github_oauth_state", state, {
    httpOnly: true,
    secure: !host.includes("localhost"),
    sameSite: "Lax",
    maxAge: 600,
    path: "/",
  });

  return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

/**
 * GET /api/auth/github/callback — Handle GitHub OAuth callback
 */
auth.get("/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const savedState = getCookie(c, "github_oauth_state");

  deleteCookie(c, "github_oauth_state", { path: "/" });

  if (!code || !state || state !== savedState) {
    return c.redirect("/?error=auth_failed");
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      console.error("GitHub token exchange failed:", tokenData);
      return c.redirect("/?error=auth_failed");
    }

    const accessToken = tokenData.access_token;

    // Get user info from GitHub
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!userRes.ok) {
      console.error("GitHub user fetch failed:", userRes.status);
      return c.redirect("/?error=auth_failed");
    }

    const ghUser = (await userRes.json()) as {
      id: number;
      login: string;
      email: string | null;
      avatar_url: string;
      name: string | null;
    };

    // If email is not public, fetch from /user/emails
    let email = ghUser.email;
    if (!email) {
      const emailRes = await fetch("https://api.github.com/user/emails", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (emailRes.ok) {
        const emails = (await emailRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
        const primary = emails.find((e) => e.primary && e.verified);
        email = primary?.email ?? emails[0]?.email ?? `${ghUser.login}@users.noreply.github.com`;
      } else {
        email = `${ghUser.login}@users.noreply.github.com`;
      }
    }

    const displayName = ghUser.name || ghUser.login;

    // Upsert user by github_id
    let user = (await db
      .selectFrom("users")
      .selectAll()
      .where("github_id", "=", ghUser.id)
      .executeTakeFirst()) as unknown as User | undefined;

    if (user) {
      await db
        .updateTable("users")
        .set({
          github_token: accessToken,
          avatar_url: ghUser.avatar_url,
          email,
          display_name: displayName,
          updated_at: now(),
        })
        .where("id", "=", user.id)
        .execute();
      user = (await db.selectFrom("users").selectAll().where("id", "=", user.id).executeTakeFirst()) as unknown as User;
    } else {
      // Check if user exists by email (link GitHub to existing exe.dev account)
      const existingByEmail = (await db
        .selectFrom("users")
        .selectAll()
        .where("email", "=", email)
        .executeTakeFirst()) as unknown as User | undefined;

      if (existingByEmail) {
        await db
          .updateTable("users")
          .set({
            github_id: ghUser.id,
            github_token: accessToken,
            avatar_url: ghUser.avatar_url,
            display_name: displayName,
            updated_at: now(),
          })
          .where("id", "=", existingByEmail.id)
          .execute();
        user = (await db
          .selectFrom("users")
          .selectAll()
          .where("id", "=", existingByEmail.id)
          .executeTakeFirst()) as unknown as User;
      } else {
        // Create new user
        const id = crypto.randomUUID();
        const exeUserId = `github_${ghUser.id}`;
        await db
          .insertInto("users")
          .values({
            id,
            exe_user_id: exeUserId,
            email,
            display_name: displayName,
            github_id: ghUser.id,
            github_token: accessToken,
            avatar_url: ghUser.avatar_url,
          })
          .execute();
        user = (await db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst()) as unknown as User;
      }
    }

    if (!user) {
      return c.redirect("/?error=auth_failed");
    }

    // Create auth session
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await db
      .insertInto("auth_sessions")
      .values({
        id: sessionId,
        user_id: user.id,
        expires_at: expiresAt,
      })
      .execute();

    // Clean up expired sessions
    try {
      await db.deleteFrom("auth_sessions").where("expires_at", "<", new Date().toISOString()).execute();
    } catch {
      /* ignore */
    }

    // Set session cookie
    const host = c.req.header("host") || "localhost:3000";
    setCookie(c, "deepform_session", sessionId, {
      httpOnly: true,
      secure: !host.includes("localhost"),
      sameSite: "Lax",
      maxAge: SESSION_MAX_AGE_DAYS * 24 * 60 * 60,
      path: "/",
    });

    return c.redirect("/");
  } catch (e) {
    console.error("GitHub OAuth error:", e);
    return c.redirect("/?error=auth_failed");
  }
});

/**
 * GET /api/auth/me — Return current user info
 */
auth.get("/me", (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ user: null });
  }
  // Never send github_token to frontend
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url ?? null,
    },
  });
});

/**
 * POST /api/auth/logout — Clear session cookie and delete session
 */
auth.post("/logout", async (c) => {
  const sessionId = getCookie(c, "deepform_session");
  if (sessionId) {
    try {
      await db.deleteFrom("auth_sessions").where("id", "=", sessionId).execute();
    } catch {
      /* ignore */
    }
  }
  deleteCookie(c, "deepform_session", { path: "/" });
  return c.json({ ok: true });
});

export { auth as authRoutes };
