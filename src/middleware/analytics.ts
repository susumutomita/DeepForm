import crypto from "node:crypto";
import { createMiddleware } from "hono/factory";
import { now } from "../db/helpers.ts";
import { db } from "../db/index.ts";

const STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)$/;
const API_PREFIX = /^\/api\//;

// In-memory dedup: fingerprint+path -> last timestamp
const recentHits = new Map<string, number>();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Cleanup old entries periodically
setInterval(() => {
  const ts = Date.now();
  for (const [key, hitTs] of recentHits) {
    if (ts - hitTs > DEDUP_WINDOW_MS) recentHits.delete(key);
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
    const ts = Date.now();
    const lastHit = recentHits.get(dedupKey);
    if (lastHit && ts - lastHit < DEDUP_WINDOW_MS) return;
    recentHits.set(dedupKey, ts);

    // Extract UTM parameters
    const utmSource = url.searchParams.get("utm_source") || null;
    const utmMedium = url.searchParams.get("utm_medium") || null;
    const utmCampaign = url.searchParams.get("utm_campaign") || null;

    await db
      .insertInto("page_views")
      .values({
        path,
        method: c.req.method,
        status_code: c.res.status,
        referer,
        user_agent: ua,
        ip_address: ip,
        user_id: user?.id || null,
        session_fingerprint: fingerprint,
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        created_at: now(),
      })
      .execute();
  } catch (e) {
    console.error("Analytics error:", e);
  }
});
