import { Hono } from 'hono';
import { adminRoutes } from './routes/admin';
import { aiRoutes } from './routes/ai';
import { authRoutes } from './routes/auth';
import { conversationRoutes } from './routes/conversations';
import { fileRoutes } from './routes/files';
import { messageRoutes } from './routes/messages';
import { realtimeRoutes } from './routes/realtime';
import { userRoutes } from './routes/users';
import { cors, onError, requestContext } from './middleware/common';
import type { AppEnv } from './middleware/auth';
import { notFound } from './lib/errors';

export function buildApp() {
  const app = new Hono<AppEnv>();
  app.use('*', requestContext);
  app.use('/api/*', cors);
  app.onError(onError);

  app.get('/api/health', (c) => c.json({ ok: true, service: 'amin-chat', time: Date.now(), environment: c.env.ENVIRONMENT }));

  app.route('/api/auth', authRoutes);
  app.route('/api/users', userRoutes);
  app.route('/api/conversations', conversationRoutes);
  app.route('/api/messages', messageRoutes);
  app.route('/api/files', fileRoutes);
  app.route('/api/realtime', realtimeRoutes);
  app.route('/api/ai', aiRoutes);
  app.route('/api/admin', adminRoutes);

  app.all('/api/*', () => {
    throw notFound('Unknown API route', 'ROUTE_NOT_FOUND');
  });
  app.notFound(async (c) => {
    // Non-API paths are normally served by the static-assets binding before reaching the Worker.
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  });
  return app;
}
