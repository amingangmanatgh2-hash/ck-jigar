import { z } from 'zod';

/** Idempotency token chosen by the client for one send (random, URL-safe). The same token twice never creates two messages. */
export const clientIdField = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'must be 8-64 URL-safe characters');
