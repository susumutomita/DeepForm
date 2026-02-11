import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { authMiddleware } from "./middleware/auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { sessionRoutes } from "./routes/sessions.ts";

const app = new Hono();

// Global error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err.message, err.stack);
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  return c.json({ error: "Internal Server Error" }, 500);
});

// Body size limit (equivalent to Express's express.json({ limit: '10mb' }))
app.use("/api/*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));

// Auth middleware (global) -- attach user info to context
app.use("*", authMiddleware);

// Auth routes
app.route("/api/auth", authRoutes);

// Session routes
app.route("/api", sessionRoutes);

// Static file serving for public/ directory
app.use("/*", serveStatic({ root: "./public" }));

// SPA fallback — serve index.html for any unmatched route
app.get("/*", serveStatic({ root: "./public", path: "index.html" }));

export { app };
