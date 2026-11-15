import type { MiddlewareHandler } from 'hono';
import { RATE_LIMITS } from '../config/limits';
import { consume, type RateSpec } from '../services/rate';
import type { AppEnv } from './auth';

export const clientIp = (c: { req: { header(name: string): string | undefined } }) =>
  c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';

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
