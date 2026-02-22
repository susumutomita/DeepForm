import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { analyticsMiddleware } from "./middleware/analytics.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { analyticsRoutes } from "./routes/analytics.ts";
import { authRoutes } from "./routes/auth.ts";
import { billingRoutes } from "./routes/billing.ts";
import { feedbackRoutes } from "./routes/feedback.ts";
import { prdEditRoutes } from "./routes/prd-edit.ts";
import { sessionRoutes } from "./routes/sessions/index.ts";

const app = new Hono();

// Security headers
app.use("*", secureHeaders());

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

// Analytics middleware — records page views after auth resolves user
app.use("*", analyticsMiddleware);

// Auth routes
app.route("/api/auth", authRoutes);

// Session routes
app.route("/api", sessionRoutes);

// Feedback routes
app.route("/api/feedback", feedbackRoutes);

// Billing routes (Stripe webhook + plan check)
app.route("/api/billing", billingRoutes);

// Admin analytics routes
app.route("/api/admin/analytics", analyticsRoutes);

// PRD inline edit routes
app.route("", prdEditRoutes);

// API docs (Swagger UI)
app.get("/api/docs", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>DeepForm API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"/>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui', deepLinking: true });</script>
</body>
</html>`);
});

// Static file serving
app.use("/*", serveStatic({ root: staticRoot }));

// SPA fallback — serve index.html for any unmatched route
app.get("/*", serveStatic({ root: staticRoot, path: "index.html" }));

export { app };
