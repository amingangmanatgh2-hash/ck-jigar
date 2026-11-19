import { sha256Hex } from '../lib/crypto';

/** Stable JSON (sorted keys) so the same arguments always hash identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Fingerprint of the exact arguments the user approved. Execution refuses to run if the stored payload no longer matches. */
export const payloadHash = (args: unknown) => sha256Hex(canonicalJson(args));

/** Splits a stored approval payload into the executable arguments and the read-only context shown on the card. */
export function splitPayload(payload: Record<string, unknown>): { args: Record<string, unknown>; context: Record<string, unknown> } {
  const { _context, ...args } = payload;
  return { args, context: (_context as Record<string, unknown>) ?? {} };
}
