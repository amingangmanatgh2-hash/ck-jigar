import type { MiddlewareHandler } from 'hono';
import { RATE_LIMITS } from '../config/limits';
import { timingSafeEqualBytes } from '../lib/crypto';
import { consume, type RateSpec } from '../services/rate';
import type { AppEnv } from './auth';

const enc = new TextEncoder();

/**
 * The address rate limits are keyed on. Normally Cloudflare's CF-Connecting-IP. Behind one of the operator's relays that would
 * be the relay itself, so a request that proves it comes from a relay (X-Relay-Secret == RELAY_SECRET) is trusted to name the real
 * client in X-Forwarded-For. Anything else cannot influence it.
 */
export const clientIp = (c: { env?: { RELAY_SECRET?: string }; req: { header(name: string): string | undefined } }): string => {
  const secret = c.env?.RELAY_SECRET;
  const presented = c.req.header('X-Relay-Secret');
  if (secret && presented && timingSafeEqualBytes(enc.encode(secret), enc.encode(presented))) {
    const forwarded = c.req.header('X-Forwarded-For')?.split(',')[0]?.trim();
    if (forwarded && /^[0-9a-fA-F:.]{3,45}$/.test(forwarded)) return forwarded;
  }
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
};

/** Per-IP limiter for unauthenticated endpoints (register / login). */
export const ipLimit = (bucket: string, spec: RateSpec = RATE_LIMITS.authIp): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    await consume(c.env, bucket, clientIp(c), spec);
    await next();
  };

/** Per-user limiter for a named class of operations. Must run after requireAuth. */
export const userLimit = (bucket: keyof typeof RATE_LIMITS): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    await consume(c.env, bucket, c.get('user').id, RATE_LIMITS[bucket]);
    await next();
  };
