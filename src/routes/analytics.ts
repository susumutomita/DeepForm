import { Hono } from "hono";
import { db } from "../db.ts";

const ADMIN_EMAILS = ["oyster880@gmail.com"];

export const analyticsRoutes = new Hono();

// Admin check middleware
analyticsRoutes.use("/*", async (c, next) => {
  const user = c.get("user") as { email: string } | null;
  if (!user || !ADMIN_EMAILS.includes(user.email)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return next();
});

// Overview stats
analyticsRoutes.get("/stats", (c) => {
  const period = c.req.query("period") || "7d";
  const days = period === "24h" ? 1 : period === "30d" ? 30 : 7;

  const since = `datetime('now', '-${days} days')`;

  const totalViews = db
    .prepare(
      `SELECT COUNT(*) as count FROM page_views WHERE created_at >= ${since}`,
    )
    .get() as { count: number };

  const uniqueVisitors = db
    .prepare(
      `SELECT COUNT(DISTINCT session_fingerprint) as count FROM page_views WHERE created_at >= ${since}`,
    )
    .get() as { count: number };

  const uniqueUsers = db
    .prepare(
      `SELECT COUNT(DISTINCT user_id) as count FROM page_views WHERE user_id IS NOT NULL AND created_at >= ${since}`,
    )
    .get() as { count: number };

  // Views by day
  const viewsByDay = db
    .prepare(
      `SELECT date(created_at) as day, COUNT(*) as views, COUNT(DISTINCT session_fingerprint) as visitors
     FROM page_views WHERE created_at >= ${since}
     GROUP BY day ORDER BY day`,
    )
    .all();

  // Top pages
  const topPages = db
    .prepare(
      `SELECT path, COUNT(*) as views, COUNT(DISTINCT session_fingerprint) as visitors
     FROM page_views WHERE created_at >= ${since}
     GROUP BY path ORDER BY views DESC LIMIT 20`,
    )
    .all();

  // Top referers
  const topReferers = db
    .prepare(
      `SELECT referer, COUNT(*) as count
     FROM page_views WHERE referer IS NOT NULL AND referer != '' AND created_at >= ${since}
     GROUP BY referer ORDER BY count DESC LIMIT 20`,
    )
    .all();

  // Recent visitors (unique fingerprints)
  const recentVisitors = db
    .prepare(
      `SELECT session_fingerprint, ip_address, user_agent, user_id, MAX(created_at) as last_seen, COUNT(*) as page_views
     FROM page_views WHERE created_at >= ${since}
     GROUP BY session_fingerprint ORDER BY last_seen DESC LIMIT 50`,
    )
    .all();

  return c.json({
    period,
    totalViews: totalViews.count,
    uniqueVisitors: uniqueVisitors.count,
    uniqueUsers: uniqueUsers.count,
    viewsByDay,
    topPages,
    topReferers,
    recentVisitors,
  });
});

// Raw access log
analyticsRoutes.get("/log", (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 100, 500);
  const offset = Number(c.req.query("offset")) || 0;

  const rows = db
    .prepare(
      `SELECT pv.*, u.display_name, u.email as user_email
     FROM page_views pv
     LEFT JOIN users u ON pv.user_id = u.id
     ORDER BY pv.created_at DESC
     LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);

  const total = db
    .prepare("SELECT COUNT(*) as count FROM page_views")
    .get() as { count: number };

  return c.json({ rows, total: total.count, limit, offset });
});
