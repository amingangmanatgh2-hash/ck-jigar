import { env } from 'cloudflare:workers';
import type { HealthDto, StorageStatusDto } from '@aminchat/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { imageGenerateTool } from '../src/agents/tools/files';
import { buildApp } from '../src/app';
import type { Env } from '../src/env';
import { AppError } from '../src/lib/errors';
import { storeFile } from '../src/services/files';
import { FileStore, filesConnected, NOT_CONNECTED_MESSAGE, purgeBlobs, requireFileStorage } from '../src/storage/file-store';
import { offloadFiles, offloadPolicy, purgeDeleted, storageStatus } from '../src/storage/offload';
import { bytesOf, resetGoogle, same, testDrive, withEnv } from './google-helpers';
import { api, freshIp, getAdmin, json, registerUser, type TestUser } from './helpers';

/**
 * A deployment without the R2 bucket: an account that has not switched R2 on (it needs a payment method) is published without it.
 * Everything but files must keep working, and everything about files must say so plainly instead of failing in some other way.
 */
const E = env as unknown as Env;
const NO_FILES = withEnv({ FILES: undefined });
const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
const DAY = 86_400_000;
const text = (s: string) => new TextEncoder().encode(s);

/** The same Worker code, run with the environment of a deployment that has no bucket (same database, same everything else). */
const app = buildApp();
async function noFiles(method: string, path: string, opts: { token?: string; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'CF-Connecting-IP': freshIp(), ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return app.fetch(new Request(`https://amin.test${path}`, { method, headers, body: opts.body }), NO_FILES, CTX);
}
const filesOf = (ownerId: string) => env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE owner_id = ?').bind(ownerId).first<{ n: number }>().then((r) => r!.n);
const row = (id: string) => env.DB.prepare('SELECT id, tier, drive_id, deleted_at, purged_at, r2_key FROM files WHERE id = ?').bind(id).first<{ id: string; tier: string; drive_id: string | null; deleted_at: number | null; purged_at: number | null; r2_key: string }>();

describe('a deployment without file storage', () => {
  let alice: TestUser;
  beforeEach(async () => {
    alice = await registerUser('nofiles');
  });

  it('the test environment really is without a bucket, and the real one is not', () => {
    expect(filesConnected(E)).toBe(true);
    expect(filesConnected(NO_FILES)).toBe(false);
    expect(NO_FILES.FILES).toBeUndefined();
    expect(NO_FILES.DB).toBeDefined(); // everything else is still there
    expect(NO_FILES.USER_HUB).toBeDefined();
    expect(() => requireFileStorage(E)).not.toThrow();
    try {
      requireFileStorage(NO_FILES);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ status: 503, code: 'FILE_STORAGE_NOT_CONNECTED', message: NOT_CONNECTED_MESSAGE });
    }
  });

  it('the public health document says so (and says yes where there is a bucket), without touching the rest of it', async () => {
    const withBucket = await json<HealthDto>(await api('GET', '/api/health'));
    expect(withBucket.storage).toEqual({ files: true });
    const without = await json<HealthDto>(await noFiles('GET', '/api/health'));
    expect(without.storage).toEqual({ files: false });
    expect(without).toMatchObject({ ok: true, service: 'amin-chat', environment: withBucket.environment, endpoints: withBucket.endpoints, ai: withBucket.ai });
    expect(Object.keys(without).sort()).toEqual(['ai', 'endpoints', 'environment', 'ok', 'service', 'storage', 'time']);
  });

  it('an upload is refused at once with a clear reason — before the file is even looked at — and nothing is stored', async () => {
    // an unsupported type would be a 415 where there is a bucket; here the question "can files be kept at all?" comes first
    const raw = await noFiles('POST', '/api/files', { token: alice.token, body: text('MZ not allowed'), headers: { 'X-File-Name': 'tool.exe', 'Content-Type': 'application/octet-stream' } });
    expect(raw.status).toBe(503);
    expect(await json(raw)).toMatchObject({ error: { code: 'FILE_STORAGE_NOT_CONNECTED', message: NOT_CONNECTED_MESSAGE } });
    const form = new FormData();
    form.set('file', new File(['hello'], 'note.txt', { type: 'text/plain' }));
    const multipart = await noFiles('POST', '/api/files', { token: alice.token, body: form });
    expect(multipart.status).toBe(503);
    expect((await json(multipart)).error.code).toBe('FILE_STORAGE_NOT_CONNECTED');
    expect(await filesOf(alice.id)).toBe(0);
    // "before the body is read": a body that cannot even be parsed gets the same answer (with a bucket it is a client error from the parser)
    const garbage = await noFiles('POST', '/api/files', { token: alice.token, body: 'this is not multipart at all', headers: { 'Content-Type': 'multipart/form-data; boundary=zzz' } });
    expect(garbage.status).toBe(503);
    expect((await json(garbage)).error.code).toBe('FILE_STORAGE_NOT_CONNECTED');
    const garbageWithBucket = await api('POST', '/api/files', { token: alice.token, body: 'this is not multipart at all', headers: { 'Content-Type': 'multipart/form-data; boundary=zzz' } });
    expect(garbageWithBucket.status).toBe(400); // a malformed upload is a client error with a code the app translates, never a 500
    expect((await json(garbageWithBucket)).error.code).toBe('INVALID_UPLOAD');
    // the control: with a bucket the same unsupported upload is the 415 it always was
    const control = await api('POST', '/api/files', { token: alice.token, body: text('MZ not allowed'), headers: { 'X-File-Name': 'tool.exe' } });
    expect(control.status).toBe(415);
    // it still needs a signed-in user: the refusal is not an open door for anonymous callers
    const anonymous = await noFiles('POST', '/api/files', { body: text('x'), headers: { 'X-File-Name': 'a.txt' } });
    expect(anonymous.status).toBe(401);
  });

  it('storeFile refuses at once, for people and for the AI alike, before it validates, hashes or writes anything', async () => {
    for (const opts of [{}, { source: 'ai' as const, forceMime: 'image/png', kind: 'image' as const }]) {
      await expect(storeFile(NO_FILES, alice.id, 'tool.exe', text('MZ'), opts)).rejects.toMatchObject({ status: 503, code: 'FILE_STORAGE_NOT_CONNECTED' });
    }
    expect(await filesOf(alice.id)).toBe(0);
    await expect(new FileStore(NO_FILES).put('u/x/y', text('x'), { mime: 'text/plain', owner: alice.id })).rejects.toMatchObject({ code: 'FILE_STORAGE_NOT_CONNECTED' });
  });

  it('files that already exist stay listed; their bytes cannot be read now; a delete is accepted but the bytes are NOT claimed to be gone', async () => {
    const stored = await storeFile(E, alice.id, 'kept.txt', text('hello'));
    const list = await json(await noFiles('GET', '/api/files', { token: alice.token }));
    expect(list.files.map((f: { id: string }) => f.id)).toEqual([stored.id]);
    const read = await noFiles('GET', `/api/files/${stored.id}`, { token: alice.token });
    expect(read.status).toBe(503);
    expect((await json(read)).error.code).toBe('FILE_STORAGE_NOT_CONNECTED');
    const del = await noFiles('DELETE', `/api/files/${stored.id}`, { token: alice.token });
    expect(del.status).toBe(200);
    const after = (await row(stored.id))!;
    expect(after.deleted_at).not.toBeNull();
    expect(after.purged_at).toBeNull(); // the bytes may still exist, so the sweep keeps the row until it can really delete them
    expect(await env.FILES!.get(after.r2_key)).not.toBeNull();
    // once there is a bucket again the sweep finishes the job
    expect(await purgeDeleted(E, Date.now() + 1000)).toBeGreaterThanOrEqual(1);
    expect((await row(stored.id))!.purged_at).not.toBeNull();
    expect(await env.FILES!.get(after.r2_key)).toBeNull();
  });

  it('exists() and remove() are honest without a bucket: nothing is claimed to be there, nothing is claimed to be deleted', async () => {
    const stored = await storeFile(E, alice.id, 'x.txt', text('x'));
    const store = new FileStore(NO_FILES);
    expect(await store.exists({ id: stored.id, r2_key: stored.r2_key, tier: 'r2', drive_id: null })).toBe(false);
    expect(await store.remove({ id: stored.id, r2_key: stored.r2_key, tier: 'r2', drive_id: null })).toBe(false);
    expect(await env.FILES!.get(stored.r2_key)).not.toBeNull(); // nothing was touched
    expect(await purgeBlobs(NO_FILES, [{ id: stored.id, r2_key: stored.r2_key, tier: 'r2', drive_id: null }])).toBe(0);
    expect((await row(stored.id))!.purged_at).toBeNull();
    // and with a bucket the very same calls work
    const real = new FileStore(E);
    expect(await real.exists({ id: stored.id, r2_key: stored.r2_key, tier: 'r2', drive_id: null })).toBe(true);
    expect(await real.remove({ id: stored.id, r2_key: stored.r2_key, tier: 'r2', drive_id: null })).toBe(true);
  });

  it('a file that was already moved to Google Drive is still readable without a bucket (it never needed one)', async () => {
    await resetGoogle();
    const content = new Uint8Array([0x25, 0x50, 0x44, 0x46, ...bytesOf(30_000, 7)]);
    const stored = await storeFile(E, alice.id, 'old.pdf', content);
    await env.DB.prepare('UPDATE files SET created_at = ? WHERE id = ?').bind(Date.now() - 8 * DAY, stored.id).run();
    const report = await offloadFiles(E, { force: true, drive: testDrive(), policy: { ...offloadPolicy(E), largeBytes: 1_000_000 } });
    expect(report.moved).toBeGreaterThanOrEqual(1);
    const moved = (await row(stored.id))!;
    expect(moved.tier).toBe('drive');
    const opened = await new FileStore(NO_FILES, testDrive()).open({ id: moved.id, r2_key: moved.r2_key, tier: 'drive', drive_id: moved.drive_id });
    expect(opened).not.toBeNull();
    expect(same(new Uint8Array(await new Response(opened!.body).arrayBuffer()), content)).toBe(true);
  });

  it('the administrator is told, first of all, that the bucket is missing — and the job that moves files does nothing instead of failing', async () => {
    const status = await storageStatus(NO_FILES);
    expect(status.hot.connected).toBe(false);
    expect(status.attention).toBe('r2_not_connected');
    const normal = await storageStatus(E);
    expect(normal.hot.connected).toBe(true);
    expect(normal.attention).not.toBe('r2_not_connected');
    // through the real route, as the administrator's page asks for it
    const admin: TestUser = await getAdmin();
    const viaRoute = await json<StorageStatusDto>(await noFiles('GET', '/api/admin/storage', { token: admin.token }));
    expect(viaRoute.hot.connected).toBe(false);
    expect(viaRoute.attention).toBe('r2_not_connected');
    // no bucket → no hot tier to move anything out of: the job reports "nothing to do", even with a file that is due, and leaves it alone
    await resetGoogle();
    const due = await storeFile(E, alice.id, 'due.txt', text('old enough to be moved'));
    await env.DB.prepare('UPDATE files SET created_at = ? WHERE id = ?').bind(Date.now() - 8 * DAY, due.id).run();
    const report = await offloadFiles(NO_FILES, { force: true, drive: testDrive(), policy: { ...offloadPolicy(NO_FILES), largeBytes: 1 } });
    expect(report).toMatchObject({ skipped: 'nothing_to_do', moved: 0, failed: 0 });
    expect((await row(due.id))!.tier).toBe('r2');
    expect(await env.FILES!.get(due.r2_key)).not.toBeNull();
  });

  it('the AI is not offered a job whose result could not be kept: no image is generated (and paid for) without file storage', async () => {
    const without = await imageGenerateTool.available!(NO_FILES, alice.id);
    expect(without.ok).toBe(false);
    expect(without.ok === false && without.reason).toMatch(/File storage is not connected, so a generated image could not be kept/);
    const withBucket = await imageGenerateTool.available!(E, alice.id);
    expect(withBucket.ok === false ? withBucket.reason : '').not.toMatch(/File storage/);
  });

  it('everything that is not about files keeps working: sign-in, the profile, conversations and the list of agents', async () => {
    const me = await noFiles('GET', '/api/auth/me', { token: alice.token });
    expect(me.status).toBe(200);
    expect((await json(me)).user.id).toBe(alice.id);
    const convs = await noFiles('GET', '/api/conversations', { token: alice.token });
    expect(convs.status).toBe(200);
    const agents = await noFiles('GET', '/api/ai/agents', { token: alice.token });
    expect(agents.status).toBe(200);
    expect((await json(agents)).agents.length).toBeGreaterThan(0);
    const login = await noFiles('POST', '/api/auth/login', { body: JSON.stringify({ username: alice.username, password: 'correct-horse-battery' }), headers: { 'Content-Type': 'application/json' } });
    expect(login.status).toBe(200);
  });

  it('the English text of the refusal names the way out, and its code is the one the web app translates', () => {
    expect(NOT_CONNECTED_MESSAGE).toMatch(/not connected/);
    expect(NOT_CONNECTED_MESSAGE).toMatch(/administrator can switch it on/);
  });
});

