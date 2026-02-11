import { Hono } from 'hono';
import { githubAuth } from '@hono/oauth-providers/github';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { setSessionCookie, clearSessionCookie } from '../middleware/auth.js';
import type { User } from '../types.js';

const auth = new Hono<{ Variables: { user: User | null } }>();

// GitHub OAuth -- handles both redirect and callback on the same route
auth.use(
  '/github',
  githubAuth({
    client_id: process.env.GITHUB_CLIENT_ID,
    client_secret: process.env.GITHUB_CLIENT_SECRET,
    scope: ['read:user', 'user:email'],
    oauthApp: true,
  })
);

auth.get('/github', async (c) => {
  const githubUser = c.get('user-github');
  if (!githubUser || !githubUser.id || !githubUser.login) {
    return c.json({ error: 'GitHub \u8a8d\u8a3c\u306b\u5931\u6557\u3057\u307e\u3057\u305f' }, 401);
  }

  // Upsert user in database
  const existingUser = db
    .prepare('SELECT * FROM users WHERE github_id = ?')
    .get(githubUser.id) as User | undefined;

  let userId: string;
  if (existingUser) {
    userId = existingUser.id;
    db.prepare(
      'UPDATE users SET github_login = ?, avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(githubUser.login, githubUser.avatar_url ?? null, existingUser.id);
  } else {
    userId = crypto.randomUUID();
    db.prepare(
      'INSERT INTO users (id, github_id, github_login, avatar_url) VALUES (?, ?, ?, ?)'
    ).run(userId, githubUser.id, githubUser.login, githubUser.avatar_url ?? null);
  }

  // Set session cookie
  setSessionCookie(c, userId);

  // Redirect to home page
  return c.redirect('/');
});

// Get current user info
auth.get('/me', (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ user: null });
  }
  return c.json({
    user: {
      id: user.id,
      githubLogin: user.github_login,
      avatarUrl: user.avatar_url,
    },
  });
});

// Logout
auth.post('/logout', (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

export { auth as authRoutes };
