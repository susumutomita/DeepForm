import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { db } from "./db/index.ts";

const PORT = 8000;

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`DeepForm server running on http://localhost:${info.port}`);
});

// Graceful shutdown — close DB connections on SIGINT / SIGTERM
function shutdown() {
  console.log("Shutting down...");
  server.close();
  db.destroy().then(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
