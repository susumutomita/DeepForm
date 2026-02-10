import { serve } from '@hono/node-server';
import { app } from './app.js';

const PORT = 8000;

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`DeepForm server running on http://localhost:${info.port}`);
});
