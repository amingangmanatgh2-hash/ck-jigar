import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { isAllowedOrigin } from '../middleware/common';
import { userLimit } from '../middleware/rate-limit';
import { ipLimit } from '../middleware/rate-limit';
import { badRequest, forbidden } from '../lib/errors';
import { parseQuery } from '../lib/validate';

export const realtimeRoutes = new Hono<AppEnv>();

/** Step 1 — authenticated: obtain a short-lived, single-use WebSocket ticket (the bearer token never appears in a URL). */
realtimeRoutes.post('/ticket', requireAuth, userLimit('api'), async (c) => {
  const user = c.get('user');
  const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(user.id));
  const ticket = await stub.issueTicket(user.id);
  return c.json({ ticket, expiresInSec: 60 });
});

/**
 * Fallback for networks where WebSockets do not work: long polling over plain HTTPS GET.
 * `GET /api/realtime/poll` (no cursor) → the starting cursor; then `?epoch=…&seq=…` → events since then (waits up to `wait` s).
 * Authenticated with the normal bearer token, so no ticket is needed.
 */
realtimeRoutes.get('/poll', requireAuth, userLimit('poll'), async (c) => {
  const q = parseQuery(
    c,
    z.object({
      epoch: z.string().regex(/^[A-Za-z0-9_-]{4,40}$/).optional(),
      seq: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      wait: z.coerce.number().int().min(0).max(25).default(20),
    }),
  );
  const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(c.get('user').id));
  const cursor = q.epoch !== undefined && q.seq !== undefined ? { epoch: q.epoch, seq: q.seq } : null;
  return c.json(await stub.poll(cursor, q.wait * 1000));
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
