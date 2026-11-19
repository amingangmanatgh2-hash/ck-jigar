import { Hono } from 'hono';
import { LIMITS, SUPPORTED_LOCALES, type SessionDto } from '@aminchat/shared';
import { z } from 'zod';
import { RATE_LIMITS } from '../config/limits';
import { all, first } from '../db/helpers';
import { hashPassword, passwordIterations, verifyPassword } from '../lib/crypto';
import { notFound, unauthorized } from '../lib/errors';
import { parseJson } from '../lib/validate';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { ipLimit, userLimit } from '../middleware/rate-limit';
import { consume } from '../services/rate';
import { userToSelfDto, type UserRow } from '../services/dto';
import { getUserById, login, register } from '../services/users';

export const authRoutes = new Hono<AppEnv>();

const timezone = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');

const registerSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(LIMITS.passwordMin).max(LIMITS.passwordMax),
  displayName: z.string().trim().min(1).max(LIMITS.displayNameMax).optional(),
  locale: z.enum(SUPPORTED_LOCALES).optional(),
  timezone: timezone.optional(),
});

authRoutes.post('/register', ipLimit('auth-ip'), async (c) => {
  const body = await parseJson(c, registerSchema);
  const res = await register(c.env, body, c.req.header('User-Agent') ?? null);
  return c.json(res, 201);
});

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(LIMITS.passwordMax) });

authRoutes.post('/login', ipLimit('auth-ip'), async (c) => {
  const body = await parseJson(c, loginSchema);
  await consume(c.env, 'login-user', body.username.toLowerCase(), RATE_LIMITS.loginUser);
  return c.json(await login(c.env, body.username, body.password, c.req.header('User-Agent') ?? null));
});

authRoutes.use('*', requireAuth);
authRoutes.use('*', userLimit('api'));

authRoutes.post('/logout', async (c) => {
  await c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').bind(Date.now(), c.get('user').sessionId).run();
  return c.json({ ok: true });
});

authRoutes.get('/me', async (c) => {
  const row = await getUserById(c.env, c.get('user').id);
  if (!row) throw unauthorized();
  return c.json({ user: userToSelfDto(row) });
});

const profileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(LIMITS.displayNameMax),
    bio: z.string().trim().max(300).nullable(),
    locale: z.enum(SUPPORTED_LOCALES),
    timezone,
  })
  .partial();

authRoutes.patch('/me', async (c) => {
  const user = c.get('user');
  const p = await parseJson(c, profileSchema);
  await c.env.DB.prepare(
    `UPDATE users SET display_name = COALESCE(?, display_name), bio = CASE WHEN ? = 1 THEN ? ELSE bio END,
                      locale = COALESCE(?, locale), timezone = COALESCE(?, timezone) WHERE id = ?`,
  )
    .bind(p.displayName ?? null, p.bio !== undefined ? 1 : 0, p.bio ?? null, p.locale ?? null, p.timezone ?? null, user.id)
    .run();
  const row = (await getUserById(c.env, user.id))!;
  return c.json({ user: userToSelfDto(row) });
});

authRoutes.get('/sessions', async (c) => {
  const user = c.get('user');
  const rows = await all<{ id: string; created_at: number; last_used_at: number; expires_at: number; user_agent: string | null }>(
    c.env.DB.prepare(
      'SELECT id, created_at, last_used_at, expires_at, user_agent FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC',
    ).bind(user.id, Date.now()),
  );
  const sessions: SessionDto[] = rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    userAgent: r.user_agent,
    current: r.id === user.sessionId,
  }));
  return c.json({ sessions });
});

authRoutes.delete('/sessions/:id', async (c) => {
  const user = c.get('user');
  const res = await c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(Date.now(), c.req.param('id'), user.id)
    .run();
  if (!res.meta.changes) throw notFound('Session not found', 'SESSION_NOT_FOUND');
  return c.json({ ok: true });
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(LIMITS.passwordMax),
  newPassword: z.string().min(LIMITS.passwordMin).max(LIMITS.passwordMax),
});

authRoutes.post('/change-password', async (c) => {
  const user = c.get('user');
  const body = await parseJson(c, passwordSchema);
  await consume(c.env, 'login-user', user.username.toLowerCase(), RATE_LIMITS.loginUser);
  const row = await first<UserRow>(c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id));
  const iterations = passwordIterations(c.env);
  if (!row || !(await verifyPassword(body.currentPassword, row.password_hash, iterations))) throw unauthorized('Current password is incorrect', 'INVALID_CREDENTIALS');
  const hash = await hashPassword(body.newPassword, iterations);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, user.id),
    // Every other device must sign in again with the new password.
    c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL').bind(Date.now(), user.id, user.sessionId),
  ]);
  return c.json({ ok: true });
});
