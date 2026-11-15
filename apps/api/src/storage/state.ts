import type { DriveHealth } from '@aminchat/shared';
import { first } from '../db/helpers';
import type { Env } from '../env';
import { sha256Hex } from '../lib/crypto';
import { DriveError, driveConfig } from './drive';

const KEYS = [
  'drive.folder_id',
  'drive.health',
  'drive.error',
  'drive.error_at',
  'drive.ok_at',
  'drive.failed_fp',
  'drive.failures',
  'drive.notified',
  'offload.last_run_at',
  'hot.files',
  'hot.bytes',
  'hot.at',
] as const;
type Key = (typeof KEYS)[number];

/**
 * Health of the connection to Google Drive is kept in D1 (table storage_state) so every isolate and the admin UI agree.
 *
 *   not_configured  no Google secrets: everything stays in R2
 *   ok              last call worked
 *   degraded        temporary trouble (3+ failures in a row); the job keeps trying
 *   auth_failed     the refresh token is dead (revoked/expired/"Testing" consent screen …). The job stops until a human
 *                   fixes it: new secrets are noticed automatically, or the admin presses "Test connection".
 *   quota_full      the Google account is full. Writes are retried every 6 hours; reads and deletes keep working.
 */
export type { DriveHealth };

export async function getState(env: Env, key: Key): Promise<string | null> {
  const row = await first<{ value: string }>(env.DB.prepare('SELECT value FROM storage_state WHERE key = ?').bind(key));
  return row?.value ?? null;
}

export async function setState(env: Env, key: Key, value: string | null): Promise<void> {
  if (value === null) {
    await env.DB.prepare('DELETE FROM storage_state WHERE key = ?').bind(key).run();
    return;
  }
  await env.DB.prepare('INSERT INTO storage_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3').bind(key, value, Date.now()).run();
}

export async function allState(env: Env): Promise<Record<Key, string | null>> {
  const rows = (await env.DB.prepare(`SELECT key, value FROM storage_state WHERE key IN (${KEYS.map(() => '?').join(',')})`).bind(...KEYS).all<{ key: Key; value: string }>()).results ?? [];
  const out = Object.fromEntries(KEYS.map((k) => [k, null])) as Record<Key, string | null>;
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Identifies the credentials without storing them: when the secrets change, a failed connection is retried at once. */
export async function credentialFingerprint(env: Env): Promise<string | null> {
  const cfg = driveConfig(env);
  return cfg ? (await sha256Hex(new TextEncoder().encode(`${cfg.clientId}|${cfg.clientSecret}|${cfg.refreshToken}`))).slice(0, 16) : null;
}

/**
 * A call to Google worked. A successful READ proves the credentials are good but says nothing about free space, so it
 * must not clear a "Drive is full" state (`keepQuotaFull`); only a successful upload or an explicit check does.
 */
export async function recordDriveOk(env: Env, opts: { keepQuotaFull?: boolean } = {}): Promise<void> {
  const state = await allState(env);
  if (opts.keepQuotaFull && state['drive.health'] === 'quota_full') return;
  if (state['drive.health'] === 'ok' && !state['drive.error']) {
    await setState(env, 'drive.ok_at', String(Date.now()));
    return;
  }
  await Promise.all([setState(env, 'drive.health', 'ok'), setState(env, 'drive.error', null), setState(env, 'drive.error_at', null), setState(env, 'drive.failed_fp', null), setState(env, 'drive.failures', '0'), setState(env, 'drive.ok_at', String(Date.now()))]);
}

export async function recordDriveFailure(env: Env, err: unknown): Promise<void> {
  const e = err instanceof DriveError ? err : new DriveError('failed', String((err as Error)?.message ?? err));
  if (e.kind === 'not_found') return; // a missing file is not a connection problem
  const now = String(Date.now());
  console.error('google drive', e.kind, e.message);
  if (e.kind === 'auth' || e.kind === 'quota') {
    await Promise.all([
      setState(env, 'drive.health', e.kind === 'auth' ? 'auth_failed' : 'quota_full'),
      setState(env, 'drive.error', e.message.slice(0, 300)),
      setState(env, 'drive.error_at', now),
      setState(env, 'drive.failed_fp', await credentialFingerprint(env)),
    ]);
    return;
  }
  const failures = Number((await getState(env, 'drive.failures')) ?? '0') + 1;
  await Promise.all([setState(env, 'drive.failures', String(failures)), setState(env, 'drive.error', e.message.slice(0, 300)), setState(env, 'drive.error_at', now)]);
  if (failures >= 3) await setState(env, 'drive.health', 'degraded');
}

const QUOTA_RETRY_MS = 6 * 3_600_000;

/**
 * Whether Drive may be used right now. A dead connection is not hammered: it waits for new credentials or a manual check.
 * A full account only blocks WRITES (retried every 6 hours); reading and deleting still work and are exactly what frees space.
 */
export async function driveAllowed(env: Env, now = Date.now(), purpose: 'write' | 'read' = 'write'): Promise<{ allowed: true } | { allowed: false; health: DriveHealth }> {
  if (!driveConfig(env)) return { allowed: false, health: 'not_configured' };
  const state = await allState(env);
  const health = (state['drive.health'] as DriveHealth | null) ?? 'ok';
  if (health === 'auth_failed' || health === 'quota_full') {
    const changed = state['drive.failed_fp'] !== (await credentialFingerprint(env));
    if (changed) return { allowed: true }; // someone put in new secrets
    if (health === 'quota_full' && (purpose === 'read' || now - Number(state['drive.error_at'] ?? 0) > QUOTA_RETRY_MS)) return { allowed: true };
    return { allowed: false, health };
  }
  return { allowed: true };
}
