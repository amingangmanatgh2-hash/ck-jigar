import type { ErrorHandler, MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import type { AppEnv } from './auth';

export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = newId('req').slice(0, 20);
  c.set('requestId', id);
  await next();
  c.header('X-Request-Id', id);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store');
};

function allowedOrigins(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** Same-origin, ALLOWED_ORIGINS, Capacitor's origins (and localhost outside production) are trusted. Never a wildcard. */
export function isAllowedOrigin(env: Env, origin: string | null | undefined, selfOrigin: string): boolean {
  if (!origin) return false;
  if (origin === selfOrigin) return true;
  const allowed = allowedOrigins(env.ALLOWED_ORIGINS);
  allowed.add('https://localhost');
  allowed.add('http://localhost');
  allowed.add('capacitor://localhost');
  if (allowed.has(origin)) return true;
  return env.ENVIRONMENT !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('Origin');
  const ok = isAllowedOrigin(c.env, origin, new URL(c.req.url).origin);
  if (c.req.method === 'OPTIONS') {
    if (!ok) return c.body(null, 403);
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': origin!,
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-File-Name,X-Request-Id',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
  }
  await next();
  if (ok) {
    c.header('Access-Control-Allow-Origin', origin!);
    c.header('Access-Control-Expose-Headers', 'X-Request-Id,Retry-After,Content-Disposition');
    c.header('Vary', 'Origin');
  }
};

export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId');
  if (err instanceof AppError) {
    const headers: Record<string, string> = {};
    if (err.status === 429 && (err.details as { retryAfterSec?: number } | undefined)?.retryAfterSec) {
      headers['Retry-After'] = String((err.details as { retryAfterSec: number }).retryAfterSec);
    }
    return c.json({ error: { code: err.code, message: err.message, details: err.details, requestId } }, err.status as 400, headers);
  }
  // Hono's own HTTPException (e.g. malformed JSON in some helpers)
  const status = (err as { status?: number }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return c.json({ error: { code: 'BAD_REQUEST', message: err.message, requestId } }, status as 400);
  }
  console.error(JSON.stringify({ level: 'error', requestId, message: String(err?.message ?? err), stack: String((err as Error)?.stack ?? '').slice(0, 1500) }));
  return c.json({ error: { code: 'INTERNAL', message: 'Internal server error', requestId } }, 500);
};
