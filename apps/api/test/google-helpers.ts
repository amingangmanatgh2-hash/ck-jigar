import { env } from 'cloudflare:workers';
import type { Env } from '../src/env';
import { DriveClient, resetTokenCache } from '../src/storage/drive';

export interface FakeGoogleState {
  counters: { token: number; api: number; upload: number };
  log: string[];
  files: { id: string; name: string; mime: string; parents: string[]; appProperties: Record<string, string>; size: number; trashed: boolean }[];
  openSessions: number;
}

interface FakeGoogleStub {
  reset(patch?: Record<string, unknown>): Promise<boolean>;
  configure(patch: Record<string, unknown>): Promise<boolean>;
  state(): Promise<FakeGoogleState>;
  fileBytes(id: string): Promise<Uint8Array | null>;
  expireAllTokens(): Promise<boolean>;
}

/** The test-only fake of Google's OAuth + Drive v3 (see test/fake-google/worker.mjs). */
export const google = () => (env as unknown as { GOOGLE_API: FakeGoogleStub }).GOOGLE_API;

export const CREDENTIALS = { clientId: 'test-client', clientSecret: 'test-secret', refreshToken: 'test-refresh' };

export const noSleep = async () => {};

/** A real DriveClient talking to the fake Google, without waiting between retries. */
export const testDrive = (overrides: Partial<typeof CREDENTIALS> = {}) => new DriveClient({ ...CREDENTIALS, ...overrides }, (env as unknown as { GOOGLE_API: Fetcher }).GOOGLE_API, noSleep);

export async function resetGoogle(patch?: Record<string, unknown>) {
  resetTokenCache();
  await google().reset(patch);
}

/** The Worker's env with some bindings replaced (for calling services directly). */
export const withEnv = (over: Partial<Env>): Env => Object.assign(Object.create(Object.getPrototypeOf(env)), env, over) as Env;

/** Deterministic pseudo-random bytes (so a corrupted copy cannot pass by accident). */
export function bytesOf(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 255;
  }
  return out;
}

export const same = (a: Uint8Array | null, b: Uint8Array) => !!a && a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
