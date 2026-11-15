import type { Context, MiddlewareHandler } from 'hono';
import type { Locale } from '@aminchat/shared';
import type { Env } from '../env';
import { sha256Hex } from '../lib/crypto';
import { forbidden, unauthorized } from '../lib/errors';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: 'user' | 'admin';
  locale: Locale;
  timezone: string;
  sessionId: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: AuthUser; requestId: string } };
export type AppContext = Context<AppEnv>;

interface SessionRow {
  session_id: string;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number;
  id: string;
  username: string;
  display_name: string;
  role: 'user' | 'admin';
  locale: string;
  timezone: string;
  disabled_at: number | null;
  kind: string;
}

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function extractBearer(c: Context): string | null {
  const header = c.req.header('Authorization');
  const m = header?.match(/^Bearer\s+([A-Za-z0-9_-]{20,200})$/);
  return m ? m[1]! : null;
}

export async function authenticate(env: Env, token: string): Promise<AuthUser | null> {
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at, s.revoked_at, s.last_used_at,
            u.id, u.username, u.display_name, u.role, u.locale, u.timezone, u.disabled_at, u.kind
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  )
    .bind(hash)
    .first<SessionRow>();
  const now = Date.now();
  if (!row || row.revoked_at || row.expires_at < now || row.disabled_at || row.kind !== 'human') return null;
  if (now - row.last_used_at > TOUCH_INTERVAL_MS) {
    await env.DB.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').bind(now, row.session_id).run();
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    locale: row.locale === 'en' ? 'en' : 'fa',
    timezone: row.timezone || 'UTC',
    sessionId: row.session_id,
  };
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = extractBearer(c);
  if (!token) throw unauthorized();
  const user = await authenticate(c.env, token);
  if (!user) throw unauthorized('Session expired or invalid', 'SESSION_INVALID');
  c.set('user', user);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user').role !== 'admin') throw forbidden('Administrator access required', 'ADMIN_ONLY');
  await next();
};
