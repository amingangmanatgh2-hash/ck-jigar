import { Hono } from 'hono';
import { z } from 'zod';
import { all, escapeLike, first } from '../db/helpers';
import { notFound } from '../lib/errors';
import { parseJson, parseQuery } from '../lib/validate';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { userLimit } from '../middleware/rate-limit';
import { userToDto, type UserRow } from '../services/dto';

export const userRoutes = new Hono<AppEnv>();
userRoutes.use('*', requireAuth, userLimit('api'));

userRoutes.get('/search', async (c) => {
  const { q } = parseQuery(c, z.object({ q: z.string().trim().min(2).max(40) }));
  const like = `%${escapeLike(q)}%`;
  const rows = await all<UserRow>(
    c.env.DB.prepare(
      `SELECT * FROM users WHERE kind = 'human' AND disabled_at IS NULL AND id != ?
         AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
       ORDER BY CASE WHEN username LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, username LIMIT 20`,
    ).bind(c.get('user').id, like, like, `${escapeLike(q)}%`),
  );
  return c.json({ users: rows.map(userToDto) });
});

/** Public EC P-256 key (JWK) used for end-to-end encrypted chats. The private key never leaves the device. */
const jwkSchema = z.object({
  jwk: z
    .object({
      kty: z.literal('EC'),
      crv: z.literal('P-256'),
      x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .strict(),
});

userRoutes.put('/me/e2ee-key', async (c) => {
  const { jwk } = await parseJson(c, jwkSchema);
  await c.env.DB.prepare('UPDATE users SET e2ee_public_key = ? WHERE id = ?').bind(JSON.stringify(jwk), c.get('user').id).run();
  return c.json({ ok: true });
});

userRoutes.get('/:id/e2ee-key', async (c) => {
  const row = await first<{ e2ee_public_key: string | null }>(
    c.env.DB.prepare(`SELECT e2ee_public_key FROM users WHERE id = ? AND kind = 'human' AND disabled_at IS NULL`).bind(c.req.param('id')),
  );
  if (!row?.e2ee_public_key) throw notFound('No encryption key published for this user', 'E2EE_KEY_MISSING');
  return c.json({ jwk: JSON.parse(row.e2ee_public_key) });
});

userRoutes.get('/:id', async (c) => {
  const row = await first<UserRow>(c.env.DB.prepare('SELECT * FROM users WHERE id = ? AND disabled_at IS NULL').bind(c.req.param('id')));
  if (!row) throw notFound('User not found', 'USER_NOT_FOUND');
  return c.json({ user: userToDto(row) });
});
