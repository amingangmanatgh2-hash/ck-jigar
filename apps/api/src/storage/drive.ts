import type { Env } from '../env';

/**
 * Minimal Google Drive v3 client for the cold file tier.
 *
 * Auth: the OAuth refresh token of a HUMAN Google account (service accounts have no Drive storage quota). Scope
 * `drive.file` only: the app can see and touch just the files it created itself — never the rest of the user's Drive.
 *
 *   • ≤ 5 MiB   → one multipart request
 *   • > 5 MiB   → resumable upload in 8 MiB chunks (a multiple of 256 KiB, as the API requires)
 *
 * Every request goes through `env.GOOGLE_API` when it is bound (tests only) and through `fetch` otherwise.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const MULTIPART_MAX = 5 * 1024 * 1024;
export const CHUNK_SIZE = 8 * 1024 * 1024; // 32 × 256 KiB
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export type DriveErrorKind =
  /** The refresh token is dead (revoked, expired, "Testing" consent screen, password change, 6 months unused). Needs a human. */
  | 'auth'
  /** The Drive of the connected account is full. Needs a human. */
  | 'quota'
  /** The file/folder does not exist (any more). */
  | 'not_found'
  /** Rate limit or a temporary Google error: try again later. */
  | 'transient'
  /** Anything else (bad request, unexpected response). */
  | 'failed';

export class DriveError extends Error {
  constructor(
    public readonly kind: DriveErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

export interface DriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function driveConfig(env: Env): DriveConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = env.GOOGLE_REFRESH_TOKEN?.trim();
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
}

export interface DriveFileInfo {
  id: string;
  size: number;
  md5: string | null;
  trashed: boolean;
}

/** What the rest of the app needs from the cold tier. The tests use the real client against a fake Google server. */
export interface DriveStore {
  ensureFolder(name: string, knownId?: string | null): Promise<string>;
  /** Idempotent: when a file for `ownerKey` was already uploaded (a retry after a crash), that one is returned. */
  upload(args: { folderId: string; name: string; mime: string; bytes: Uint8Array; ownerKey: string }): Promise<DriveFileInfo>;
  /** The file uploaded for `ownerKey`, if any (used to clean up a copy whose upload was never recorded). */
  findByKey(ownerKey: string): Promise<DriveFileInfo | null>;
  download(id: string): Promise<Response>;
  info(id: string): Promise<DriveFileInfo | null>;
  remove(id: string): Promise<void>;
  /** Used / total bytes of the connected account, when Google tells. */
  quota(): Promise<{ used: number; limit: number | null } | null>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface TokenCache {
  fingerprint: string;
  token: string;
  expiresAt: number;
}
let tokenCache: TokenCache | null = null;
export const resetTokenCache = () => {
  tokenCache = null;
};

export class DriveClient implements DriveStore {
  private readonly http: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(
    private readonly cfg: DriveConfig,
    fetcher?: Fetcher,
    private readonly sleepFn: (ms: number) => Promise<void> = sleep,
  ) {
    this.http = fetcher ? (input, init) => fetcher.fetch(input, init) : (input, init) => fetch(input, init);
  }

  /* --------------------------------------------------------------------------------------------- auth */

  private async accessToken(force = false): Promise<string> {
    const fingerprint = `${this.cfg.clientId}:${this.cfg.refreshToken.slice(-12)}`;
    if (!force && tokenCache && tokenCache.fingerprint === fingerprint && tokenCache.expiresAt - 60_000 > Date.now()) return tokenCache.token;
    const res = await this.send(() =>
      this.http(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: this.cfg.refreshToken, grant_type: 'refresh_token' }),
      }),
    );
    const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!body?.access_token) throw new DriveError('failed', 'Google did not return an access token', res.status);
    tokenCache = { fingerprint, token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  /** Authenticated request with one token refresh on 401 and bounded retries on 429/5xx. */
  private async call(make: (token: string) => Promise<Response>, tolerate: number[] = []): Promise<Response> {
    let token = await this.accessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await make(token);
      if (res.ok || tolerate.includes(res.status)) return res;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        token = await this.accessToken(true);
        continue;
      }
      const transient = res.status === 429 || res.status >= 500;
      if (transient && attempt < 3) {
        await this.sleepFn(Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
        continue;
      }
      throw await this.toError(res);
    }
  }

  /** Unauthenticated request (the token endpoint) with bounded retries on network errors, 429 and 5xx. */
  private async send(make: () => Promise<Response>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await make();
      } catch (err) {
        if (attempt < 3) {
          await this.sleepFn(500 * 2 ** attempt);
          continue;
        }
        throw new DriveError('transient', `Google could not be reached: ${String((err as Error)?.message ?? err)}`);
      }
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await this.sleepFn(500 * 2 ** attempt);
        continue;
      }
      throw await this.toError(res);
    }
  }

  private async toError(res: Response): Promise<DriveError> {
    const text = await res.text().catch(() => '');
    let code = '';
    let reason = '';
    let message = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: string | { message?: string; errors?: { reason?: string }[] }; error_description?: string };
      if (typeof j.error === 'string') {
        code = j.error;
        message = j.error_description ?? j.error;
      } else if (j.error) {
        reason = j.error.errors?.[0]?.reason ?? '';
        message = j.error.message ?? message;
      }
    } catch {
      // not JSON
    }
    if (code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client') return new DriveError('auth', `Google rejected the credentials (${code}): ${message}`, res.status);
    if (res.status === 401) return new DriveError('auth', `Google rejected the access token: ${message}`, res.status);
    if (reason === 'storageQuotaExceeded' || reason === 'quotaExceeded') return new DriveError('quota', `The Google Drive account is full: ${message}`, res.status);
    if (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|sharingRateLimitExceeded/.test(reason)) return new DriveError('transient', `Google rate limit: ${message}`, res.status);
    if (res.status === 404) return new DriveError('not_found', message || 'Not found', res.status);
    if (res.status === 429 || res.status >= 500) return new DriveError('transient', `Google is temporarily unavailable (${res.status})`, res.status);
    return new DriveError('failed', `Google Drive answered ${res.status}: ${message}`, res.status);
  }

  /* --------------------------------------------------------------------------------------------- folder */

  async ensureFolder(name: string, knownId?: string | null): Promise<string> {
    if (knownId) {
      const info = await this.info(knownId);
      if (info && !info.trashed) return info.id;
    }
    const res = await this.call((token) =>
      this.http(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
      }),
    );
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new DriveError('failed', 'Google did not return the id of the new folder');
    return body.id;
  }

  /* --------------------------------------------------------------------------------------------- upload */

  async upload(args: { folderId: string; name: string; mime: string; bytes: Uint8Array; ownerKey: string }): Promise<DriveFileInfo> {
    // A previous attempt may have uploaded the file and crashed before saving the result: reuse it instead of duplicating.
    const existing = await this.findByKey(args.ownerKey);
    if (existing && existing.size === args.bytes.byteLength) return existing;
    const metadata = { name: args.name, parents: [args.folderId], mimeType: args.mime, appProperties: { aminchat: '1', fileId: args.ownerKey } };
    return args.bytes.byteLength <= MULTIPART_MAX ? this.uploadMultipart(metadata, args) : this.uploadResumable(metadata, args);
  }

  private parseInfo(j: { id?: string; size?: string; md5Checksum?: string; trashed?: boolean }): DriveFileInfo {
    if (!j.id) throw new DriveError('failed', 'Google did not return a file id');
    return { id: j.id, size: Number(j.size ?? 0), md5: j.md5Checksum ?? null, trashed: !!j.trashed };
  }

  private async uploadMultipart(metadata: object, args: { mime: string; bytes: Uint8Array }): Promise<DriveFileInfo> {
    const boundary = `aminchat-${crypto.randomUUID()}`;
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${args.mime}\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + args.bytes.length + tail.length);
    body.set(head, 0);
    body.set(args.bytes, head.length);
    body.set(tail, head.length + args.bytes.length);
    const res = await this.call((token) =>
      this.http(`${UPLOAD}/files?uploadType=multipart&fields=id,size,md5Checksum,trashed`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      }),
    );
    return this.parseInfo((await res.json()) as never);
  }

  private async uploadResumable(metadata: object, args: { mime: string; bytes: Uint8Array }): Promise<DriveFileInfo> {
    const total = args.bytes.byteLength;
    const start = await this.call((token) =>
      this.http(`${UPLOAD}/files?uploadType=resumable&fields=id,size,md5Checksum,trashed`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': args.mime,
          'X-Upload-Content-Length': String(total),
        },
        body: JSON.stringify(metadata),
      }),
    );
    const session = start.headers.get('Location');
    if (!session) throw new DriveError('failed', 'Google did not return an upload session');
    let offset = 0;
    let stalls = 0;
    while (offset < total) {
      const end = Math.min(offset + CHUNK_SIZE, total); // exclusive
      const chunk = args.bytes.subarray(offset, end);
      let res: Response;
      try {
        // the session URL carries its own authorisation; the chunk is a plain PUT
        // "308 Resume Incomplete" is an answer, not a redirect: never follow it
        res = await this.http(session, { method: 'PUT', redirect: 'manual', headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${total}` }, body: chunk });
      } catch (err) {
        if (++stalls > 4) throw new DriveError('transient', `The upload was interrupted: ${String((err as Error)?.message ?? err)}`);
        await this.sleepFn(500 * 2 ** stalls);
        offset = await this.resumeOffset(session, total, offset);
        continue;
      }
      if (res.status === 308) {
        const range = res.headers.get('Range'); // "bytes=0-8388607": what Google has stored so far
        const last = range ? Number(/-(\d+)$/.exec(range)?.[1] ?? NaN) : NaN;
        offset = Number.isFinite(last) ? last + 1 : 0;
        stalls = 0;
        continue;
      }
      if (res.ok) return this.parseInfo((await res.json()) as never);
      if ((res.status === 429 || res.status >= 500) && ++stalls <= 4) {
        await this.sleepFn(500 * 2 ** stalls);
        offset = await this.resumeOffset(session, total, offset);
        continue;
      }
      throw await this.toError(res);
    }
    throw new DriveError('failed', 'The upload finished without a result from Google');
  }

  /** Asks Google how many bytes of the session it already has. */
  private async resumeOffset(session: string, total: number, fallback: number): Promise<number> {
    try {
      const res = await this.http(session, { method: 'PUT', redirect: 'manual', headers: { 'Content-Range': `bytes */${total}` }, body: new Uint8Array(0) });
      if (res.status === 308) {
        const last = Number(/-(\d+)$/.exec(res.headers.get('Range') ?? '')?.[1] ?? NaN);
        return Number.isFinite(last) ? last + 1 : 0;
      }
    } catch {
      // keep the old offset: the chunk is simply sent again
    }
    return fallback;
  }

  async findByKey(ownerKey: string): Promise<DriveFileInfo | null> {
    const q = `appProperties has { key='fileId' and value='${ownerKey.replace(/['\\]/g, '')}' } and trashed = false`;
    const res = await this.call((token) => this.http(`${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,size,md5Checksum,trashed)')}&pageSize=2`, { headers: { Authorization: `Bearer ${token}` } }));
    const body = (await res.json()) as { files?: { id?: string; size?: string; md5Checksum?: string; trashed?: boolean }[] };
    const f = body.files?.[0];
    return f ? this.parseInfo(f) : null;
  }

  /* --------------------------------------------------------------------------------------------- read / delete */

  async download(id: string): Promise<Response> {
    return this.call((token) => this.http(`${API}/files/${encodeURIComponent(id)}?alt=media`, { headers: { Authorization: `Bearer ${token}` } }));
  }

  async info(id: string): Promise<DriveFileInfo | null> {
    const res = await this.call((token) => this.http(`${API}/files/${encodeURIComponent(id)}?fields=id,size,md5Checksum,trashed`, { headers: { Authorization: `Bearer ${token}` } }), [404]);
    if (res.status === 404) return null;
    return this.parseInfo((await res.json()) as never);
  }

  async remove(id: string): Promise<void> {
    await this.call((token) => this.http(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }), [404]);
  }

  async quota(): Promise<{ used: number; limit: number | null } | null> {
    try {
      const res = await this.call((token) => this.http(`${API}/about?fields=storageQuota`, { headers: { Authorization: `Bearer ${token}` } }));
      const j = (await res.json()) as { storageQuota?: { usage?: string; limit?: string } };
      if (!j.storageQuota) return null;
      return { used: Number(j.storageQuota.usage ?? 0), limit: j.storageQuota.limit ? Number(j.storageQuota.limit) : null };
    } catch (err) {
      if (err instanceof DriveError && err.kind === 'auth') throw err;
      return null;
    }
  }
}

/** The Drive client for this environment, or null when Drive is not configured (everything then stays in R2). */
export function driveFor(env: Env): DriveStore | null {
  const cfg = driveConfig(env);
  return cfg ? new DriveClient(cfg, env.GOOGLE_API) : null;
}

export async function md5Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('MD5', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
