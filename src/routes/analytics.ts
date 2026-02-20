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

  // Country breakdown (time-filtered)
  const byCountry = await db
    .selectFrom("page_views")
    .select(["country"])
    .select((eb) => [
      eb.fn.countAll().as("views"),
      eb.fn.count(eb.ref("session_fingerprint")).distinct().as("visitors"),
    ])
    .where("created_at", ">=", since)
    .where("country", "is not", null)
    .where("country", "!=", "")
    .groupBy("country")
    .orderBy("views", "desc")
    .limit(30)
    .execute();

  // Business KPIs (all-time, not filtered by period)
  const totalUsersResult = await db
    .selectFrom("users")
    .select((eb) => eb.fn.countAll().as("count"))
    .executeTakeFirstOrThrow();

  const proUsersResult = await db
    .selectFrom("users")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("plan", "=", "pro")
    .executeTakeFirstOrThrow();

  const totalSessionsResult = await db
    .selectFrom("sessions")
    .select((eb) => eb.fn.countAll().as("count"))
    .executeTakeFirstOrThrow();

  const completedSessionsResult = await db
    .selectFrom("sessions")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("status", "in", ["spec_generated", "readiness_checked"])
    .executeTakeFirstOrThrow();

  const totalMessagesResult = await db
    .selectFrom("messages")
    .select((eb) => eb.fn.countAll().as("count"))
    .executeTakeFirstOrThrow();

  const totalCampaignsResult = await db
    .selectFrom("campaigns")
    .select((eb) => eb.fn.countAll().as("count"))
    .executeTakeFirstOrThrow();

  const totalSessions = Number(totalSessionsResult.count);
  const completedSessions = Number(completedSessionsResult.count);
  const totalMessages = Number(totalMessagesResult.count);

  const businessKpis = {
    totalUsers: totalUsersResult.count,
    proUsers: proUsersResult.count,
    totalSessions: totalSessionsResult.count,
    completedSessions: completedSessionsResult.count,
    totalMessages: totalMessagesResult.count,
    totalCampaigns: totalCampaignsResult.count,
    conversionRate: totalSessions > 0 ? (completedSessions / totalSessions) * 100 : 0,
    avgMessagesPerSession: totalSessions > 0 ? totalMessages / totalSessions : 0,
  };

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
    byCountry,
    businessKpis,
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

// Business KPIs
analyticsRoutes.get("/kpis", async (c) => {
  const period = c.req.query("period") || "7d";
  const days = period === "24h" ? 1 : period === "30d" ? 30 : 7;
  const since = daysAgo(days);

  // Total users
  const totalUsers = await db
    .selectFrom("users")
    .select((eb) => eb.fn.countAll().as("count"))
    .executeTakeFirstOrThrow();

  const proUsers = await db
    .selectFrom("users")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("plan", "=", "pro")
    .executeTakeFirstOrThrow();

  // Sessions in period
  const sessionsInPeriod = await db
    .selectFrom("sessions")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("created_at", ">=", since)
    .executeTakeFirstOrThrow();

  // Sessions by status (all time)
  const sessionsByStatus = await db
    .selectFrom("sessions")
    .select(["status"])
    .select((eb) => eb.fn.countAll().as("count"))
    .groupBy("status")
    .execute();

  // Conversion funnel
  const totalSessions = await db
    .selectFrom("sessions")
    .select((eb) => eb.fn.countAll().as("count"))
    .executeTakeFirstOrThrow();

  // Sessions with 2+ messages (interview started)
  const interviewStarted = await sql<{ count: number }>`
    SELECT COUNT(*) as count FROM (
      SELECT session_id FROM messages GROUP BY session_id HAVING COUNT(*) >= 2
    )
  `.execute(db).then((r) => r.rows[0] ?? { count: 0 });

  const specReached = await db
    .selectFrom("sessions")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("status", "in", ["spec_generated", "readiness_checked"])
    .executeTakeFirstOrThrow();

  // Average messages per session
  const avgMessages = await db
    .selectFrom("messages")
    .select([
      sql<number>`count(*)`.as("total"),
      sql<number>`count(distinct session_id)`.as("sessions"),
    ])
    .executeTakeFirstOrThrow();

  // Country breakdown (from page_views)
  const countries = await db
    .selectFrom("page_views")
    .select(["country"])
    .select((eb) => [
      eb.fn.countAll().as("views"),
      eb.fn.count(eb.ref("session_fingerprint")).distinct().as("visitors"),
    ])
    .where("country", "is not", null)
    .where("created_at", ">=", since)
    .groupBy("country")
    .orderBy("visitors", "desc")
    .limit(20)
    .execute();

  // Guest vs logged-in sessions
  const guestSessions = await db
    .selectFrom("sessions")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("user_id", "is", null)
    .executeTakeFirstOrThrow();

  return c.json({
    period,
    users: {
      total: totalUsers.count,
      pro: proUsers.count,
    },
    sessions: {
      inPeriod: sessionsInPeriod.count,
      total: totalSessions.count,
      guest: guestSessions.count,
      byStatus: sessionsByStatus,
    },
    funnel: {
      pageViews: 0, // filled by frontend from stats
      sessionsCreated: totalSessions.count,
      interviewStarted: interviewStarted.count,
      specReached: specReached.count,
    },
    avgMessagesPerSession: avgMessages.sessions > 0
      ? Math.round((avgMessages.total / avgMessages.sessions) * 10) / 10
      : 0,
    countries,
  });
});
