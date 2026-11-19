import { Hono } from 'hono';
import { LIMITS } from '@aminchat/shared';
import { z } from 'zod';
import { parseJson } from '../lib/validate';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { userLimit } from '../middleware/rate-limit';
import { deleteMessage, editMessage, votePoll } from '../services/messages';

export const messageRoutes = new Hono<AppEnv>();
messageRoutes.use('*', requireAuth, userLimit('api'));

messageRoutes.put('/:id', userLimit('send'), async (c) => {
  const body = await parseJson(
    c,
    z.object({
      body: z.string().min(1).max(LIMITS.messageMaxChars).optional(),
      cipher: z
        .object({ v: z.literal(1), iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/), ct: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(LIMITS.cipherMaxChars) })
        .optional(),
    }),
  );
  const message = await editMessage(c.env, c.get('user').id, c.req.param('id'), body);
  return c.json({ message });
});

messageRoutes.delete('/:id', async (c) => {
  await deleteMessage(c.env, c.get('user').id, c.req.param('id'));
  return c.json({ ok: true });
});

messageRoutes.post('/:id/vote', async (c) => {
  const body = await parseJson(c, z.object({ optionIds: z.array(z.string().max(16)).max(LIMITS.pollOptionsMax) }));
  const poll = await votePoll(c.env, c.get('user').id, c.req.param('id'), body.optionIds);
  return c.json({ poll });
});
