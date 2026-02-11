import { serve } from "@hono/node-server";
import { app } from "./app.ts";

const PORT = 8000;

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`DeepForm server running on http://localhost:${info.port}`);
});
