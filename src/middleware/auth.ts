import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import crypto from 'node:crypto';
import { db } from '../db.js';
import type { User } from '../types.js';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const COOKIE_NAME = 'deepform_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function sign(value: string): string {
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
  return `${value}.${signature}`;
}

function unsign(signed: string): string | null {
  const lastDot = signed.lastIndexOf('.');
  if (lastDot === -1) return null;
  const value = signed.substring(0, lastDot);
  const expected = sign(value);
  if (signed !== expected) return null;
  return value;
}

export function setSessionCookie(c: any, userId: string): void {
  const expiry = Date.now() + MAX_AGE * 1000;
  const payload = JSON.stringify({ userId, expiry });
  setCookie(c, COOKIE_NAME, sign(payload), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: MAX_AGE,
    path: '/',
  });
}

export function clearSessionCookie(c: any): void {
  deleteCookie(c, COOKIE_NAME, { path: '/' });
}

// Middleware: attach user info to Context (not required)
export const authMiddleware = createMiddleware<{
  Variables: { user: User | null };
}>(async (c, next) => {
  const cookie = getCookie(c, COOKIE_NAME);
  if (!cookie) {
    c.set('user', null);
    return next();
  }

  const payload = unsign(cookie);
  if (!payload) {
    c.set('user', null);
    return next();
  }

  try {
    const { userId, expiry } = JSON.parse(payload) as { userId: string; expiry: number };
    if (Date.now() > expiry) {
      c.set('user', null);
      return next();
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;
    c.set('user', user ?? null);
  } catch {
    c.set('user', null);
  }

  return next();
});

// Middleware: require authentication
export const requireAuth = createMiddleware<{
  Variables: { user: User };
}>(async (c, next) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'ログインが必要です' }, 401);
  }
  return next();
});
