import { Hono } from 'hono';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { isAllowedOrigin } from '../middleware/common';
import { userLimit } from '../middleware/rate-limit';
import { ipLimit } from '../middleware/rate-limit';
import { badRequest, forbidden } from '../lib/errors';

export const realtimeRoutes = new Hono<AppEnv>();

/** Step 1 — authenticated: obtain a short-lived, single-use WebSocket ticket (the bearer token never appears in a URL). */
realtimeRoutes.post('/ticket', requireAuth, userLimit('api'), async (c) => {
  const user = c.get('user');
  const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(user.id));
  const ticket = await stub.issueTicket(user.id);
  return c.json({ ticket, expiresInSec: 60 });
});

/** Step 2 — WebSocket upgrade, authenticated by the ticket. Browsers must come from an allowed origin. */
realtimeRoutes.get('/ws', ipLimit('ws-ip', { limit: 60, windowSec: 60 }), async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return c.text('Expected a WebSocket upgrade', 426);
  const origin = c.req.header('Origin');
  if (origin && !isAllowedOrigin(c.env, origin, new URL(c.req.url).origin)) throw forbidden('Origin not allowed', 'ORIGIN_NOT_ALLOWED');
  const ticket = c.req.query('ticket') ?? '';
  const userId = ticket.split('.')[0] ?? '';
  if (!/^usr_[0-9a-z]{20}$/.test(userId)) throw badRequest('Invalid ticket', undefined, 'INVALID_TICKET');
  const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(userId));
  return stub.fetch(c.req.raw);
});
