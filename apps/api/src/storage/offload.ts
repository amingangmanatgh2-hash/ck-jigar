import type { DriveHealth, OffloadReportDto, StorageAttention, StorageStatusDto } from '@aminchat/shared';
import { all, first } from '../db/helpers';
import type { Env } from '../env';
import { sha256Hex } from '../lib/crypto';
import { clipForLog } from '../lib/text';
import { DriveError, driveConfig, driveFor, md5Hex, type DriveStore } from './drive';
import { FileStore, filesConnected, purgeBlobs, type StoredFile } from './file-store';
import { allState, credentialFingerprint, driveAllowed, getState, recordDriveFailure, recordDriveOk, setState } from './state';

const DAY = 86_400_000;
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};

export interface OffloadPolicy {
  /** Files older than this many days move to Drive. */
  afterDays: number;
  /** Files at least this big move to Drive as soon as they are `minAgeMs` old. */
  largeBytes: number;
  /** When the hot tier holds more than this, the oldest files move regardless of age or size. */
  r2SoftLimitBytes: number;
  /** A new upload is never moved before it has settled (it is probably being sent, shown or analysed right now). */
  minAgeMs: number;
  /** Work done per job run. */
  maxFiles: number;
  maxBytes: number;
  maxMillis: number;
}

export function offloadPolicy(env: Env): OffloadPolicy {
  return {
    afterDays: num(env.FILES_OFFLOAD_AFTER_DAYS, 7),
    largeBytes: num(env.FILES_OFFLOAD_LARGE_BYTES, 5 * 1024 * 1024),
    r2SoftLimitBytes: num(env.R2_SOFT_LIMIT_BYTES, 8 * 1024 ** 3), // R2's free tier is 10 GB
    minAgeMs: 60 * 60_000,
    maxFiles: 10,
    maxBytes: 60 * 1024 * 1024,
    maxMillis: 20_000,
  };
}

const RUN_INTERVAL_MS = 10 * 60_000;
const CLAIM_TTL_MS = 15 * 60_000;
const HOT_USAGE_TTL_MS = 60 * 60_000;
export const TOMBSTONE_MS = 7 * DAY;

interface CandidateRow extends StoredFile {
  owner_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string | null;
  created_at: number;
}

export type OffloadReport = OffloadReportDto;

const emptyReport = (skipped: OffloadReport['skipped']): OffloadReport => ({ skipped, moved: 0, bytes: 0, failed: 0, purged: 0 });

/** The folder the app created in the user's Drive. With `drive.file` the app can only see folders it made itself, so it makes its own. */
async function ensureFolder(env: Env, drive: DriveStore): Promise<string> {
  const known = env.DRIVE_FOLDER_ID?.trim() || (await getState(env, 'drive.folder_id'));
  const id = await drive.ensureFolder(env.DRIVE_FOLDER_NAME?.trim() || 'AMIN CHAT', known);
  if (id !== known) await setState(env, 'drive.folder_id', id);
  return id;
}

/** Moves one file from R2 to Drive. The R2 copy is deleted only after the Drive copy has been verified AND recorded. */
async function moveToDrive(env: Env, drive: DriveStore, folderId: string, row: CandidateRow): Promise<'moved' | 'skipped'> {
  const bucket = env.FILES;
  if (!bucket) return 'skipped'; // no hot tier here, so nothing to move out of it (offloadFiles does not even get this far)
  const claim = await env.DB.prepare(`UPDATE files SET tier = 'moving', tier_changed_at = ? WHERE id = ? AND tier = 'r2' AND deleted_at IS NULL`).bind(Date.now(), row.id).run();
  if (!claim.meta.changes) return 'skipped'; // another run took it, or it was deleted
  let uploadedId: string | null = null;
  try {
    const obj = await bucket.get(row.r2_key);
    if (!obj) {
      console.error('offload: the R2 object is missing', row.id);
      await env.DB.prepare(`UPDATE files SET tier = 'r2', tier_changed_at = NULL WHERE id = ? AND tier = 'moving'`).bind(row.id).run();
      return 'skipped';
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.byteLength !== row.size || (row.sha256 && (await sha256Hex(bytes)) !== row.sha256)) throw new DriveError('failed', `The R2 copy of ${row.id} does not match its record; not moving it`);
    const info = await drive.upload({ folderId, name: row.name, mime: row.mime, bytes, ownerKey: row.id });
    uploadedId = info.id;
    if (info.size !== bytes.byteLength) throw new DriveError('failed', `Drive stored ${info.size} bytes for ${row.id}, expected ${bytes.byteLength}`);
    if (info.md5 && info.md5 !== (await md5Hex(bytes))) throw new DriveError('failed', `Drive's checksum of ${row.id} does not match`);
    const done = await env.DB.prepare(`UPDATE files SET tier = 'drive', drive_id = ?, tier_changed_at = ? WHERE id = ? AND tier = 'moving' AND deleted_at IS NULL`).bind(info.id, Date.now(), row.id).run();
    if (!done.meta.changes) throw new DriveError('failed', `${row.id} changed while it was being moved`); // deleted meanwhile: the copy below is removed again
    uploadedId = null; // recorded: from here on the purge sweep owns the Drive copy
    await bucket.delete(row.r2_key).catch((err) => console.error('offload: R2 delete failed', row.id, clipForLog(err)));
    return 'moved';
  } catch (err) {
    await env.DB.prepare(`UPDATE files SET tier = 'r2', tier_changed_at = NULL WHERE id = ? AND tier = 'moving' AND deleted_at IS NULL`).bind(row.id).run().catch(() => undefined);
    if (uploadedId) await drive.remove(uploadedId).catch(() => undefined); // do not leave an unrecorded copy behind
    throw err;
  }
}

/** Soft-deleted files whose bytes are still stored (a delete that failed half-way, or one that needed Drive) are cleaned up here. */
export async function purgeDeleted(env: Env, now = Date.now(), store: FileStore = new FileStore(env)): Promise<number> {
  const rows = await all<StoredFile>(
    env.DB.prepare(`SELECT id, r2_key, tier, drive_id FROM files WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND (tier != 'moving' OR tier_changed_at < ?) LIMIT 50`).bind(now - CLAIM_TTL_MS),
  );
  return purgeBlobs(env, rows, store);
}

/** Hourly: drop the bookkeeping rows of files whose bytes have been gone for a week. */
export async function dropTombstones(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM files WHERE purged_at IS NOT NULL AND purged_at < ?').bind(now - TOMBSTONE_MS).run();
}

/**
 * How much the hot tier holds. A full count is a table scan, so it is cached for an hour (and corrected by the job
 * whenever it moves files); `fresh` forces the real number (admin "Test connection").
 */
export async function hotUsage(env: Env, opts: { now?: number; fresh?: boolean } = {}): Promise<{ files: number; bytes: number }> {
  const now = opts.now ?? Date.now();
  const st = await allState(env);
  const at = Number(st['hot.at'] ?? 0);
  if (!opts.fresh && at && now - at < HOT_USAGE_TTL_MS && st['hot.bytes'] !== null) return { files: Number(st['hot.files']), bytes: Number(st['hot.bytes']) };
  const r = await first<{ n: number; b: number }>(env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM files WHERE tier IN ('r2', 'moving') AND deleted_at IS NULL`));
  const usage = { files: r?.n ?? 0, bytes: r?.b ?? 0 };
  await Promise.all([setState(env, 'hot.files', String(usage.files)), setState(env, 'hot.bytes', String(usage.bytes)), setState(env, 'hot.at', String(now))]);
  return usage;
}

async function adjustHotUsage(env: Env, files: number, bytes: number): Promise<void> {
  const st = await allState(env);
  if (st['hot.bytes'] === null) return;
  await Promise.all([setState(env, 'hot.files', String(Math.max(0, Number(st['hot.files']) - files))), setState(env, 'hot.bytes', String(Math.max(0, Number(st['hot.bytes']) - bytes)))]);
}

const COLUMNS = 'id, owner_id, r2_key, tier, drive_id, name, mime, size, sha256, created_at';

/** The oldest files that are due to move. Three index-friendly queries (old / large / under pressure), merged and de-duplicated. */
async function findCandidates(env: Env, policy: OffloadPolicy, now: number, pressure: boolean): Promise<CandidateRow[]> {
  const settled = now - policy.minAgeMs;
  const old = now - policy.afterDays * DAY;
  const limit = policy.maxFiles;
  const [aged, large, squeezed] = await Promise.all([
    all<CandidateRow>(env.DB.prepare(`SELECT ${COLUMNS} FROM files WHERE tier = 'r2' AND deleted_at IS NULL AND created_at <= ?1 ORDER BY created_at LIMIT ?2`).bind(Math.min(old, settled), limit)),
    all<CandidateRow>(env.DB.prepare(`SELECT ${COLUMNS} FROM files WHERE tier = 'r2' AND deleted_at IS NULL AND size >= ?1 AND created_at <= ?2 ORDER BY size DESC LIMIT ?3`).bind(policy.largeBytes, settled, limit)),
    pressure ? all<CandidateRow>(env.DB.prepare(`SELECT ${COLUMNS} FROM files WHERE tier = 'r2' AND deleted_at IS NULL AND created_at <= ?1 ORDER BY created_at LIMIT ?2`).bind(settled, limit)) : Promise.resolve([]),
  ]);
  const byId = new Map<string, CandidateRow>();
  for (const r of [...aged, ...large, ...squeezed]) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at).slice(0, limit);
}

/**
 * One run of the offload job (called by the cron trigger every minute, but works at most every 10 minutes unless forced).
 * Does nothing at all without Google credentials: the bucket then simply fills as before — the admin UI says so.
 */
export async function offloadFiles(env: Env, opts: { now?: number; force?: boolean; drive?: DriveStore | null; policy?: OffloadPolicy } = {}): Promise<OffloadReport> {
  const now = opts.now ?? Date.now();
  const policy = opts.policy ?? offloadPolicy(env);
  const store = new FileStore(env, opts.drive);
  const purged = await purgeDeleted(env, now, store).catch((err) => (console.error('purge failed', clipForLog(err)), 0));

  // no bucket: there is no hot tier to move anything out of
  if (!filesConnected(env)) return { ...emptyReport('nothing_to_do'), purged };
  if (!driveConfig(env) && !opts.drive) return { ...emptyReport('not_configured'), purged };
  const allowed = await driveAllowed(env, now);
  if (!allowed.allowed && !opts.drive) return { ...emptyReport(allowed.health === 'quota_full' ? 'quota_full' : 'auth_failed'), purged };
  const last = Number((await getState(env, 'offload.last_run_at')) ?? '0');
  if (!opts.force && now - last < RUN_INTERVAL_MS) return { ...emptyReport('throttled'), purged };
  await setState(env, 'offload.last_run_at', String(now));

  // a move that died half-way (the isolate was killed) goes back to the hot tier
  await env.DB.prepare(`UPDATE files SET tier = 'r2', tier_changed_at = NULL WHERE tier = 'moving' AND deleted_at IS NULL AND tier_changed_at < ?`).bind(now - CLAIM_TTL_MS).run();

  const hot = await hotUsage(env, { now });
  const pressure = hot.bytes > policy.r2SoftLimitBytes;
  const target = Math.floor(policy.r2SoftLimitBytes * 0.9); // under pressure, free down to 90 %
  const candidates = await findCandidates(env, policy, now, pressure);
  if (candidates.length === 0) return { ...emptyReport('nothing_to_do'), purged };

  const drive = opts.drive ?? driveFor(env);
  if (!drive) return { ...emptyReport('not_configured'), purged };
  const report: OffloadReport = { skipped: null, moved: 0, bytes: 0, failed: 0, purged };
  const started = Date.now();
  const due = (r: CandidateRow) => r.created_at <= now - policy.afterDays * DAY || r.size >= policy.largeBytes;
  try {
    const folderId = await ensureFolder(env, drive);
    for (const row of candidates) {
      if (report.bytes + row.size > policy.maxBytes && report.moved > 0) break;
      if (Date.now() - started > policy.maxMillis) break;
      // not due by age or size: only moved while the hot tier is still above its target
      if (!due(row) && !(pressure && hot.bytes - report.bytes > target)) continue;
      try {
        if ((await moveToDrive(env, drive, folderId, row)) === 'moved') {
          report.moved++;
          report.bytes += row.size;
        }
      } catch (err) {
        report.failed++;
        console.error('offload failed', row.id, clipForLog(err));
        if (err instanceof DriveError && ['auth', 'quota', 'transient'].includes(err.kind)) throw err; // pointless to go on
      }
    }
    if (report.moved > 0) await adjustHotUsage(env, report.moved, report.bytes);
    if (report.moved > 0 || report.failed === 0) await recordDriveOk(env);
  } catch (err) {
    await recordDriveFailure(env, err);
  }
  return report;
}

/* ------------------------------------------------------------------------------------------------ admin view */

export type { StorageAttention, StorageStatusDto as StorageStatus };

export async function storageStatus(env: Env, opts: { check?: boolean; drive?: DriveStore | null } = {}): Promise<StorageStatusDto> {
  const policy = offloadPolicy(env);
  const configured = !!driveConfig(env) || !!opts.drive;
  let account: StorageStatusDto['cold']['account'] = null;
  if (opts.check && configured) {
    // "Test connection": really talk to Google, and let the result reset (or confirm) the health state.
    const drive = opts.drive ?? driveFor(env)!;
    try {
      await ensureFolder(env, drive);
      account = await drive.quota();
      // a full account is a failure even though every call "worked"
      if (account && account.limit !== null && account.used >= account.limit) await recordDriveFailure(env, new DriveError('quota', 'The Google Drive account is full'));
      else await recordDriveOk(env);
    } catch (err) {
      await recordDriveFailure(env, err);
    }
  }
  const [hot, cold, state] = await Promise.all([
    hotUsage(env, { fresh: !!opts.check }),
    first<{ n: number; b: number }>(env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM files WHERE tier = 'drive' AND deleted_at IS NULL`)),
    allState(env),
  ]);
  const health: DriveHealth = !configured ? 'not_configured' : ((state['drive.health'] as DriveHealth | null) ?? 'ok');
  // new credentials after a failure: the stored failure is about the OLD ones
  const stale = (health === 'auth_failed' || health === 'quota_full') && state['drive.failed_fp'] !== (await credentialFingerprint(env));
  const effective: DriveHealth = stale ? 'ok' : health;
  const overLimit = hot.bytes > policy.r2SoftLimitBytes;
  const attention: StorageAttention =
    !filesConnected(env) ? 'r2_not_connected' : effective === 'auth_failed' ? 'drive_auth_failed' : effective === 'quota_full' ? 'drive_full' : effective === 'degraded' ? 'drive_degraded' : !configured && hot.bytes > policy.r2SoftLimitBytes * 0.8 ? 'r2_filling_without_drive' : null;
  return {
    hot: { files: hot.files, bytes: hot.bytes, softLimitBytes: policy.r2SoftLimitBytes, overLimit, connected: filesConnected(env) },
    cold: {
      configured,
      health: effective,
      error: stale ? null : state['drive.error'],
      errorAt: stale || !state['drive.error_at'] ? null : Number(state['drive.error_at']),
      okAt: state['drive.ok_at'] ? Number(state['drive.ok_at']) : null,
      folderId: state['drive.folder_id'],
      files: cold?.n ?? 0,
      bytes: cold?.b ?? 0,
      account,
    },
    policy: { afterDays: policy.afterDays, largeBytes: policy.largeBytes, minAgeMinutes: Math.round(policy.minAgeMs / 60_000) },
    lastRunAt: state['offload.last_run_at'] ? Number(state['offload.last_run_at']) : null,
    attention,
  };
}
