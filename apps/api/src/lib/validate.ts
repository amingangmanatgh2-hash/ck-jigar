import type { Context } from 'hono';
import type { z } from 'zod';
import { AppError, badRequest } from './errors';

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new AppError(400, 'VALIDATION_ERROR', `Invalid request: ${issues[0]?.path || 'body'} — ${issues[0]?.message ?? 'invalid'}`, issues);
  }
  return result.data as z.infer<S>;
}

export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Request body must be valid JSON', undefined, 'INVALID_JSON');
  }
  return parse(schema, raw);
}

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  return parse(schema, c.req.query());
}
