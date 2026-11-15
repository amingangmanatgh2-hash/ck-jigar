import { Hono } from 'hono';
import { z } from 'zod';
import { refreshHealth, modelsResponse } from '../ai/health';
import { effectiveQuota, usageSummary } from '../ai/usage';
import { all } from '../db/helpers';
import { notFound } from '../lib/errors';
import { parseJson, parseQuery } from '../lib/validate';
import { requireAdmin, requireAuth, type AppEnv } from '../middleware/auth';
import { userLimit } from '../middleware/rate-limit';
import { requireAiBackend } from '../services/ai-chat';

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('*', requireAuth, requireAdmin, userLimit('api'));

const audit = (c: { env: AppEnv['Bindings'] }, userId: string, action: string, targetId: string, meta: unknown) =>
  c.env.DB.prepare('INSERT INTO audit_log (user_id, action, target_type, target_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(userId, action, 'user', targetId, JSON.stringify(meta), Date.now())
    .run();

/** Overview: who uses how much of the Workers AI allocation, and how the models behave. */
adminRoutes.get('/overview', async (c) => {
  const q = parseQuery(c, z.object({ days: z.coerce.number().int().min(1).max(60).default(7) }));
  const since = new Date(Date.now() - q.days * 86_400_000).toISOString().slice(0, 10);
  const [byUser, byModel, runs] = await Promise.all([
    all<{ user_id: string; username: string; tokens: number; requests: number }>(
      c.env.DB.prepare(
        `SELECT u.id AS user_id, u.username, COALESCE(SUM(a.input_tokens + a.output_tokens), 0) AS tokens, COUNT(*) AS requests
         FROM ai_usage a JOIN users u ON u.id = a.user_id WHERE a.day >= ? AND a.status != 'error' GROUP BY u.id ORDER BY tokens DESC LIMIT 25`,
      ).bind(since),
    ),
    all<{ model_id: string; tokens: number; requests: number; errors: number; fallbacks: number }>(
      c.env.DB.prepare(
        `SELECT model_id, COALESCE(SUM(CASE WHEN status != 'error' THEN input_tokens + output_tokens END), 0) AS tokens,
                SUM(CASE WHEN status != 'error' THEN 1 ELSE 0 END) AS requests, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                SUM(CASE WHEN status = 'fallback' THEN 1 ELSE 0 END) AS fallbacks
         FROM ai_usage WHERE day >= ? GROUP BY model_id ORDER BY tokens DESC`,
      ).bind(since),
    ),
    all<{ status: string; n: number }>(c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM runs WHERE created_at >= ? GROUP BY status').bind(Date.now() - q.days * 86_400_000)),
  ]);
  return c.json({
    days: q.days,
    byUser: byUser.map((r) => ({ userId: r.user_id, username: r.username, tokens: r.tokens, requests: r.requests })),
    byModel: byModel.map((r) => ({ modelId: r.model_id, tokens: r.tokens, requests: r.requests, errors: r.errors, fallbacks: r.fallbacks })),
    runs: Object.fromEntries(runs.map((r) => [r.status, r.n])),
  });
});

adminRoutes.get('/users/:id/usage', async (c) => {
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare("SELECT 1 AS x FROM users WHERE id = ? AND kind = 'human'").bind(id).first();
  if (!exists) throw notFound('User not found', 'USER_NOT_FOUND');
  return c.json(await usageSummary(c.env, id));
});

/** Sets (or, with `null` fields, resets to the default) the AI quota of one user. */
adminRoutes.put('/users/:id/quota', async (c) => {
  const admin = c.get('user');
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare("SELECT 1 AS x FROM users WHERE id = ? AND kind = 'human'").bind(id).first();
  if (!exists) throw notFound('User not found', 'USER_NOT_FOUND');
  const limit = z.number().int().min(0).max(1_000_000_000).nullable();
  const body = await parseJson(c, z.object({ dailyTokens: limit, dailyRequests: limit, monthlyTokens: limit }));
  if (body.dailyTokens === null && body.dailyRequests === null && body.monthlyTokens === null) {
    await c.env.DB.prepare('DELETE FROM user_quotas WHERE user_id = ?').bind(id).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO user_quotas (user_id, daily_tokens, daily_requests, monthly_tokens, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET daily_tokens = excluded.daily_tokens, daily_requests = excluded.daily_requests,
         monthly_tokens = excluded.monthly_tokens, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
      .bind(id, body.dailyTokens, body.dailyRequests, body.monthlyTokens, admin.id, Date.now())
      .run();
  }
  await audit(c, admin.id, 'quota.set', id, body);
  return c.json({ quota: await effectiveQuota(c.env, id) });
});

adminRoutes.post('/models/refresh', userLimit('aiHeavy'), async (c) => {
  requireAiBackend(c.env);
  await refreshHealth(c.env);
  return c.json(await modelsResponse(c.env));
});
