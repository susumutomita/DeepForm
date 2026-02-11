import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { authMiddleware } from "./middleware/auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { feedbackRoutes } from "./routes/feedback.ts";
import { githubExportRoutes } from "./routes/github-export.ts";
import { prdEditRoutes } from "./routes/prd-edit.ts";
import { sessionRoutes } from "./routes/sessions.ts";

const app = new Hono();

// Determine static file root: prefer Vite build output, fall back to legacy public/
const distDir = path.resolve("public_dist");
const staticRoot = fs.existsSync(distDir) ? "./public_dist" : "./public";
console.info(`Serving static files from: ${staticRoot}`);

// Global error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err.message, err.stack);
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  return c.json({ error: "Internal Server Error" }, 500);
});

// Body size limit
app.use("/api/*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));

// Auth middleware (global) — exe.dev headers からユーザーを解決
app.use("*", authMiddleware);

// Auth routes
app.route("/api/auth", authRoutes);

// Session routes
app.route("/api", sessionRoutes);

// Feedback routes
app.route("/api/feedback", feedbackRoutes);

// GitHub export routes
app.route("/api", githubExportRoutes);

// PRD inline edit routes
app.route("", prdEditRoutes);

// Static file serving
app.use("/*", serveStatic({ root: staticRoot }));

// SPA fallback — serve index.html for any unmatched route
app.get("/*", serveStatic({ root: staticRoot, path: "index.html" }));

export { app };
