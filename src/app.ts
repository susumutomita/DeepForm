import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { authMiddleware } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { sessionRoutes } from './routes/sessions.js';

const app = new Hono();

// Body size limit (equivalent to Express's express.json({ limit: '10mb' }))
app.use('/api/*', bodyLimit({ maxSize: 10 * 1024 * 1024 }));

// Auth middleware (global) -- attach user info to context
app.use('*', authMiddleware);

// Auth routes
app.route('/api/auth', authRoutes);

// Session routes
app.route('/api', sessionRoutes);

// Static file serving for public/ directory
app.use('/*', serveStatic({ root: './public' }));

// SPA fallback — serve index.html for any unmatched route
app.get('/*', serveStatic({ root: './public', path: 'index.html' }));

export { app };
