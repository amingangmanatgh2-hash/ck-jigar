import type { Env } from '../env';
import { unavailable } from '../lib/errors';
import { first } from '../db/helpers';
import { DriveError, driveFor, type DriveStore } from './drive';
import { driveAllowed, recordDriveFailure, recordDriveOk } from './state';

/** The columns of a files row that decide where its bytes are. */
export interface StoredFile {
  id: string;
  r2_key: string;
  tier: 'r2' | 'moving' | 'drive';
  drive_id: string | null;
}

export interface OpenedFile {
  body: ReadableStream<Uint8Array>;
  size: number;
}

/**
 * One place that knows where file bytes live.
 *   hot  tier: R2 (every upload lands here)
 *   cold tier: Google Drive (the offload job moves old or large files there)
 * Callers hold a files row and never ask which tier it is in: reads of cold files are proxied through the Worker, so the
 * usual access checks apply and clients never learn (or need) a Drive URL.
 */
export class FileStore {
  constructor(
    private readonly env: Env,
    private readonly driveOverride?: DriveStore | null,
  ) {}

  private drive(): DriveStore | null {
    return this.driveOverride === undefined ? driveFor(this.env) : this.driveOverride;
  }

  async put(key: string, bytes: Uint8Array, meta: { mime: string; owner: string }): Promise<void> {
    await this.env.FILES.put(key, bytes, { httpMetadata: { contentType: meta.mime }, customMetadata: { owner: meta.owner } });
  }

  /** Streams the content. null = the bytes are gone. Throws FILE_STORAGE_UNAVAILABLE when a cold file cannot be fetched right now. */
  async open(f: StoredFile): Promise<OpenedFile | null> {
    if (f.tier !== 'drive') {
      const obj = await this.env.FILES.get(f.r2_key);
      if (obj) return { body: obj.body, size: obj.size };
      // The offload job may have finished between our read of the row and now: look again before giving up.
      const fresh = await first<StoredFile>(this.env.DB.prepare('SELECT id, r2_key, tier, drive_id FROM files WHERE id = ?').bind(f.id));
      if (!fresh || fresh.tier !== 'drive') return null;
      return this.openCold(fresh);
    }
    return this.openCold(f);
  }

  private async openCold(f: StoredFile): Promise<OpenedFile | null> {
    if (!f.drive_id) return null;
    const drive = this.drive();
    const allowed = await driveAllowed(this.env, Date.now(), 'read');
    if (!drive || !allowed.allowed) throw unavailable('This file is kept in Google Drive, which cannot be reached right now. Please try again later.', 'FILE_STORAGE_UNAVAILABLE');
    try {
      const res = await drive.download(f.drive_id);
      await recordDriveOk(this.env, { keepQuotaFull: true });
      if (!res.body) return null;
      const length = Number(res.headers.get('Content-Length'));
      return { body: res.body, size: Number.isFinite(length) && length > 0 ? length : -1 };
    } catch (err) {
      if (err instanceof DriveError && err.kind === 'not_found') return null;
      await recordDriveFailure(this.env, err);
      throw unavailable('This file is kept in Google Drive, which cannot be reached right now. Please try again later.', 'FILE_STORAGE_UNAVAILABLE');
    }
  }

  /** The whole content in memory (AI processing; callers check the size limit first). */
  async bytes(f: StoredFile): Promise<Uint8Array | null> {
    const opened = await this.open(f);
    return opened ? new Uint8Array(await new Response(opened.body).arrayBuffer()) : null;
  }

  async exists(f: StoredFile): Promise<boolean> {
    if (f.tier !== 'drive') {
      if (await this.env.FILES.head(f.r2_key)) return true;
      const fresh = await first<StoredFile>(this.env.DB.prepare('SELECT id, r2_key, tier, drive_id FROM files WHERE id = ?').bind(f.id));
      if (!fresh || fresh.tier !== 'drive') return false;
      f = fresh;
    }
    const drive = this.drive();
    if (!drive || !f.drive_id) return false;
    try {
      const info = await drive.info(f.drive_id);
      return !!info && !info.trashed;
    } catch (err) {
      await recordDriveFailure(this.env, err);
      return false;
    }
  }

  /** Deletes the bytes wherever they are. Resolves true when nothing is left behind, false when a retry is needed. */
  async remove(f: StoredFile): Promise<boolean> {
    let clean = true;
    try {
      await this.env.FILES.delete(f.r2_key);
    } catch (err) {
      console.error('r2 delete failed', f.id, String((err as Error)?.message ?? err));
      clean = false;
    }
    // A file caught half-way through a move may own a Drive copy that was never recorded: look it up by its key.
    if (f.drive_id || f.tier === 'moving') {
      const drive = this.drive();
      if (!drive || !(await driveAllowed(this.env, Date.now(), 'read')).allowed) return f.drive_id ? false : clean;
      try {
        const driveId = f.drive_id ?? (await drive.findByKey(f.id))?.id ?? null;
        if (driveId) await drive.remove(driveId);
      } catch (err) {
        await recordDriveFailure(this.env, err);
        clean = false;
      }
    }
    return clean;
  }
}

export const fileStore = (env: Env) => new FileStore(env);

/** Deletes the stored bytes of rows that are already marked deleted, and records which ones are really gone (the sweep retries the rest). */
export async function purgeBlobs(env: Env, rows: StoredFile[], store: FileStore = fileStore(env)): Promise<number> {
  if (rows.length === 0) return 0;
  // What the AI extracted from a deleted file (document text, transcript) is personal data too: it goes right away.
  for (let i = 0; i < rows.length; i += 50) {
    const ids = rows.slice(i, i + 50).map((r) => r.id);
    await env.DB.prepare(`DELETE FROM file_derivatives WHERE file_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  }
  let purged = 0;
  for (const row of rows) {
    if (await store.remove(row).catch(() => false)) {
      await env.DB.prepare('UPDATE files SET purged_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
      purged++;
    }
  }
  return purged;
}
