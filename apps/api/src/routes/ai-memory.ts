import { Hono } from 'hono';
import { MEMORY_KINDS, LIMITS } from '@aminchat/shared';
import { z } from 'zod';
import { badRequest } from '../lib/errors';
import { parseJson } from '../lib/validate';
import type { AppEnv } from '../middleware/auth';
import {
  createMemory,
  decideSuggestion,
  deleteAllMemory,
  deleteMemory,
  getMemorySettings,
  listMemories,
  listSuggestions,
  updateMemory,
  updateMemorySettings,
} from '../services/memory';

/**
 * Permanent memory, strictly per user: every query is scoped by the authenticated user id.
 * The temporary memory of a conversation is simply its message history (see services/context.ts) and is never copied here
 * unless the user approves a suggestion.
 */
export const aiMemoryRoutes = new Hono<AppEnv>();

const kind = z.enum(MEMORY_KINDS);
const content = z.string().trim().min(1).max(LIMITS.memoryItemMaxChars);
const project = z.string().trim().max(60).nullish();

aiMemoryRoutes.get('/', async (c) => {
  const userId = c.get('user').id;
  const [settings, items, suggestions] = await Promise.all([getMemorySettings(c.env, userId), listMemories(c.env, userId), listSuggestions(c.env, userId)]);
  return c.json({ settings, items, suggestions });
});

aiMemoryRoutes.patch('/settings', async (c) => {
  const body = await parseJson(c, z.object({ enabled: z.boolean().optional(), autoSuggest: z.boolean().optional(), allowHistoryRecall: z.boolean().optional() }).strict());
  return c.json({ settings: await updateMemorySettings(c.env, c.get('user').id, body) });
});

aiMemoryRoutes.post('/items', async (c) => {
  const body = await parseJson(c, z.object({ kind: kind.default('fact'), content, project }));
  const item = await createMemory(c.env, c.get('user').id, { kind: body.kind, content: body.content, project: body.project, source: 'user' });
  return c.json({ item }, 201);
});

aiMemoryRoutes.patch('/items/:id', async (c) => {
  const body = await parseJson(c, z.object({ kind: kind.optional(), content: content.optional(), project }));
  return c.json({ item: await updateMemory(c.env, c.get('user').id, c.req.param('id'), body) });
});

aiMemoryRoutes.delete('/items/:id', async (c) => {
  await deleteMemory(c.env, c.get('user').id, c.req.param('id'));
  return c.json({ ok: true });
});

/** "Delete everything AMIN AI remembers about me". Needs an explicit confirmation flag so it cannot happen by accident. */
aiMemoryRoutes.delete('/', async (c) => {
  const body = await parseJson(c, z.object({ confirm: z.literal(true) })).catch(() => {
    throw badRequest('Confirm the deletion with {"confirm": true}', undefined, 'CONFIRMATION_REQUIRED');
  });
  void body;
  return c.json({ ok: true, deleted: await deleteAllMemory(c.env, c.get('user').id) });
});

aiMemoryRoutes.post('/suggestions/:id/decision', async (c) => {
  const body = await parseJson(c, z.object({ decision: z.enum(['approve', 'reject']), content: content.optional(), kind: kind.optional(), project }));
  const result = await decideSuggestion(c.env, c.get('user').id, c.req.param('id'), body.decision, { content: body.content, kind: body.kind, project: body.project });
  return c.json(result);
});
