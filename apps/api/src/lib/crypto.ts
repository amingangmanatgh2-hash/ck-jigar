const enc = new TextEncoder();

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToB64Url(buf);
}

export async function sha256Hex(input: string | Uint8Array | ArrayBuffer): Promise<string> {
  const data = typeof input === 'string' ? enc.encode(input) : input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Password hashing: PBKDF2-HMAC-SHA256.
 * Cloudflare Workers caps PBKDF2 at 100,000 iterations, so that is what we use (documented in docs/SECURITY.md).
 */
export const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${bytesToB64(salt)}$${bytesToB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Always do the same amount of work, even for unknown users (stored === null), to avoid user enumeration by timing.
  const parts = (stored ?? '').split('$');
  const valid = parts.length === 4 && parts[0] === 'pbkdf2-sha256';
  const iterations = valid ? Number(parts[1]) : PBKDF2_ITERATIONS;
  const salt = valid ? b64ToBytes(parts[2]!) : new Uint8Array(16);
  const expected = valid ? b64ToBytes(parts[3]!) : new Uint8Array(32);
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > 100_000) return false;
  const actual = await pbkdf2(password, salt, iterations);
  return valid && timingSafeEqualBytes(actual, expected);
}
