import { Hono } from "hono";
import { sql } from "kysely";
import { ADMIN_EMAILS } from "../constants.ts";
import { daysAgo } from "../db/helpers.ts";
import { db } from "../db/index.ts";
import type { AppEnv } from "../types.ts";

export const analyticsRoutes = new Hono<AppEnv>();

// Admin check middleware
analyticsRoutes.use("/*", async (c, next) => {
  const user = c.get("user");
  if (!user || !ADMIN_EMAILS.includes(user.email)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return next();
});

// Overview stats
analyticsRoutes.get("/stats", async (c) => {
  const period = c.req.query("period") || "7d";
  const days = period === "24h" ? 1 : period === "30d" ? 30 : 7;

  const since = daysAgo(days);

  const totalViews = await db
    .selectFrom("page_views")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("created_at", ">=", since)
    .executeTakeFirstOrThrow();

  const uniqueVisitors = await db
    .selectFrom("page_views")
    .select((eb) => eb.fn.count(eb.ref("session_fingerprint")).distinct().as("count"))
    .where("created_at", ">=", since)
    .executeTakeFirstOrThrow();

  const uniqueUsers = await db
    .selectFrom("page_views")
    .select((eb) => eb.fn.count(eb.ref("user_id")).distinct().as("count"))
    .where("user_id", "is not", null)
    .where("created_at", ">=", since)
    .executeTakeFirstOrThrow();

  // Views by day
  const viewsByDay = await db
    .selectFrom("page_views")
    .select([sql<string>`date(created_at)`.as("day")])
    .select((eb) => [
      eb.fn.countAll().as("views"),
      eb.fn.count(eb.ref("session_fingerprint")).distinct().as("visitors"),
    ])
    .where("created_at", ">=", since)
    .groupBy(sql`date(created_at)`)
    .orderBy(sql`date(created_at)`)
    .execute();

  // Top pages
  const topPages = await db
    .selectFrom("page_views")
    .select(["path"])
    .select((eb) => [
      eb.fn.countAll().as("views"),
      eb.fn.count(eb.ref("session_fingerprint")).distinct().as("visitors"),
    ])
    .where("created_at", ">=", since)
    .groupBy("path")
    .orderBy("views", "desc")
    .limit(20)
    .execute();

  // Top referers
  const topReferers = await db
    .selectFrom("page_views")
    .select(["referer"])
    .select((eb) => eb.fn.countAll().as("count"))
    .where("referer", "is not", null)
    .where("referer", "!=", "")
    .where("created_at", ">=", since)
    .groupBy("referer")
    .orderBy("count", "desc")
    .limit(20)
    .execute();

  // UTM sources
  const utmSources = await db
    .selectFrom("page_views")
    .select(["utm_source", "utm_medium", "utm_campaign"])
    .select((eb) => [
      eb.fn.countAll().as("views"),
      eb.fn.count(eb.ref("session_fingerprint")).distinct().as("visitors"),
    ])
    .where("utm_source", "is not", null)
    .where("created_at", ">=", since)
    .groupBy(["utm_source", "utm_medium", "utm_campaign"])
    .orderBy("visitors", "desc")
    .limit(20)
    .execute();

  // Recent visitors (unique fingerprints)
  const recentVisitors = await db
    .selectFrom("page_views")
    .select(["session_fingerprint", "ip_address", "user_agent", "user_id"])
    .select((eb) => [eb.fn.max("created_at").as("last_seen"), eb.fn.countAll().as("page_views")])
    .where("created_at", ">=", since)
    .groupBy("session_fingerprint")
    .orderBy("last_seen", "desc")
    .limit(50)
    .execute();

  return c.json({
    period,
    totalViews: totalViews.count,
    uniqueVisitors: uniqueVisitors.count,
    uniqueUsers: uniqueUsers.count,
    viewsByDay,
    topPages,
    topReferers,
    utmSources,
    recentVisitors,
  });
});

// Raw access log
analyticsRoutes.get("/log", async (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 100, 500);
  const offset = Number(c.req.query("offset")) || 0;

  const rows = await db
    .selectFrom("page_views as pv")
    .leftJoin("users as u", "pv.user_id", "u.id")
    .selectAll("pv")
    .select(["u.display_name", "u.email as user_email"])
    .orderBy("pv.created_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();

  const total = await db
    .selectFrom("page_views")
    .select((eb) => eb.fn.countAll().as("count"))
    .executeTakeFirstOrThrow();

  return c.json({ rows, total: total.count, limit, offset });
});
