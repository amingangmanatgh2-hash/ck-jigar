import type { Env } from '../env';
import { rateLimited } from '../lib/errors';

export interface RateSpec {
  limit: number;
  windowSec: number;
}

/** Consumes one unit from the named bucket or throws a 429 AppError. Fails open only if the limiter itself is unreachable. */
export async function consume(env: Env, bucket: string, key: string, spec: RateSpec): Promise<void> {
  let result;
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${bucket}:${key}`));
    result = await stub.hit(spec.limit, spec.windowSec * 1000);
  } catch (err) {
    console.error('rate limiter unavailable', String((err as Error)?.message ?? err));
    return;
  }
  if (!result.allowed) {
    const retry = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    throw rateLimited(`Too many requests. Try again in ${retry}s.`, retry);
  }
}
