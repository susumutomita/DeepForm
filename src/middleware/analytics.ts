import crypto from "node:crypto";
import { createMiddleware } from "hono/factory";
import { db } from "../db.ts";

const STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)$/;
const API_PREFIX = /^\/api\//;

// In-memory dedup: fingerprint+path -> last timestamp
const recentHits = new Map<string, number>();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentHits) {
    if (now - ts > DEDUP_WINDOW_MS) recentHits.delete(key);
  }
}, 60_000);

export const analyticsMiddleware = createMiddleware(async (c, next) => {
  await next();

  const url = new URL(c.req.url);
  const path = url.pathname;

  // Skip static assets and API calls
  if (STATIC_EXTENSIONS.test(path)) return;
  if (API_PREFIX.test(path)) return;

  try {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    const ua = c.req.header("user-agent") || "";
    const referer = c.req.header("referer") || null;
    const user = c.get("user") as { id: string } | null | undefined;
    const fingerprint = crypto.createHash("sha256").update(`${ip}:${ua}`).digest("hex").substring(0, 12);

    // Dedup: skip if same fingerprint+path within 5 minutes
    const dedupKey = `${fingerprint}:${path}`;
    const now = Date.now();
    const lastHit = recentHits.get(dedupKey);
    if (lastHit && now - lastHit < DEDUP_WINDOW_MS) return;
    recentHits.set(dedupKey, now);

    // Extract UTM parameters
    const utmSource = url.searchParams.get("utm_source") || null;
    const utmMedium = url.searchParams.get("utm_medium") || null;
    const utmCampaign = url.searchParams.get("utm_campaign") || null;

    db.prepare(
      `INSERT INTO page_views (path, method, status_code, referer, user_agent, ip_address, user_id, session_fingerprint, utm_source, utm_medium, utm_campaign, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      path,
      c.req.method,
      c.res.status,
      referer,
      ua,
      ip,
      user?.id || null,
      fingerprint,
      utmSource,
      utmMedium,
      utmCampaign,
    );
  } catch (e) {
    console.error("Analytics error:", e);
  }
});
