import crypto from "node:crypto";
import { createMiddleware } from "hono/factory";
import { db } from "../db.ts";

const STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)$/;

export const analyticsMiddleware = createMiddleware(async (c, next) => {
  await next();

  const path = new URL(c.req.url).pathname;

  // Skip static assets
  if (STATIC_EXTENSIONS.test(path)) return;

  try {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    const ua = c.req.header("user-agent") || "";
    const referer = c.req.header("referer") || null;
    const user = c.get("user") as { id: string } | null | undefined;
    const fingerprint = crypto.createHash("sha256").update(`${ip}:${ua}`).digest("hex").substring(0, 12);

    db.prepare(
      `INSERT INTO page_views (path, method, status_code, referer, user_agent, ip_address, user_id, session_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(path, c.req.method, c.res.status, referer, ua, ip, user?.id || null, fingerprint);
  } catch (e) {
    console.error("Analytics error:", e);
  }
});
