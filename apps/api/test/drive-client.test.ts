import { beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, DriveError, MULTIPART_MAX, md5Hex } from '../src/storage/drive';
import { bytesOf, google, resetGoogle, same, testDrive } from './google-helpers';

async function rejection(p: Promise<unknown>): Promise<DriveError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(DriveError);
    return err as DriveError;
  }
  throw new Error('expected the call to fail');
}

describe('Google Drive client (against the fake Google server)', () => {
  beforeEach(() => resetGoogle());

  it('creates its folder once and reuses a known one', async () => {
    const drive = testDrive();
    const folder = await drive.ensureFolder('AMIN CHAT');
    expect(await drive.ensureFolder('AMIN CHAT', folder)).toBe(folder);
    const lost = await drive.ensureFolder('AMIN CHAT', 'drv_does_not_exist');
    expect(lost).not.toBe('drv_does_not_exist'); // a folder that was deleted in Drive is simply created again
    const state = await google().state();
    expect(state.files.filter((f) => f.name === 'AMIN CHAT').length).toBe(2);
  });

  it('uploads small files in one multipart request and reads them back byte for byte', async () => {
    const drive = testDrive();
    const folder = await drive.ensureFolder('AMIN CHAT');
    const bytes = bytesOf(300_000, 7);
    const info = await drive.upload({ folderId: folder, name: 'نامه.pdf', mime: 'application/pdf', bytes, ownerKey: 'fil_a' });
    expect(info.size).toBe(bytes.length);
    expect(info.md5).toBe(await md5Hex(bytes));
    const state = await google().state();
    expect(state.files.find((f) => f.id === info.id)).toMatchObject({ name: 'نامه.pdf', mime: 'application/pdf', parents: [folder], appProperties: { fileId: 'fil_a' } });
    expect(state.log.filter((l) => l.startsWith('POST') && l.includes('uploadType=multipart'))).toHaveLength(1);
    const res = await drive.download(info.id);
    expect(res.headers.get('content-length')).toBe(String(bytes.length));
    expect(same(new Uint8Array(await res.arrayBuffer()), bytes)).toBe(true);
  });

  it('uses a resumable upload above 5 MB, in chunks Google accepts', async () => {
    const drive = testDrive();
    const folder = await drive.ensureFolder('AMIN CHAT');
    const bytes = bytesOf(CHUNK_SIZE * 2 + 123_457, 3); // 3 chunks, the last one not aligned
    expect(bytes.length).toBeGreaterThan(MULTIPART_MAX);
    const info = await drive.upload({ folderId: folder, name: 'big.zip', mime: 'application/zip', bytes, ownerKey: 'fil_big' });
    expect(info.size).toBe(bytes.length);
    expect(info.md5).toBe(await md5Hex(bytes));
    const state = await google().state();
    expect(state.log.filter((l) => l.startsWith('POST') && l.includes('uploadType=resumable'))).toHaveLength(1); // one session
    expect(state.log.filter((l) => l.startsWith('PUT') && l.includes('upload_id'))).toHaveLength(3); // three chunks
    expect(state.openSessions).toBe(0);
    expect(same(await google().fileBytes(info.id), bytes)).toBe(true);
  });

  it('is idempotent: uploading the same file again returns the first copy instead of duplicating', async () => {
    const drive = testDrive();
    const folder = await drive.ensureFolder('AMIN CHAT');
    const bytes = bytesOf(10_000, 9);
    const a = await drive.upload({ folderId: folder, name: 'x.txt', mime: 'text/plain', bytes, ownerKey: 'fil_same' });
    const b = await drive.upload({ folderId: folder, name: 'x.txt', mime: 'text/plain', bytes, ownerKey: 'fil_same' });
    expect(b.id).toBe(a.id);
    expect((await google().state()).files.filter((f) => f.name === 'x.txt')).toHaveLength(1);
  });

  it('refreshes the access token on 401 and caches it otherwise', async () => {
    const drive = testDrive();
    await drive.ensureFolder('AMIN CHAT');
    await drive.ensureFolder('AMIN CHAT');
    expect((await google().state()).counters.token).toBe(1); // cached
    await google().configure({ killTokensNow: true });
    const folder = await drive.ensureFolder('AMIN CHAT'); // 401 → new token → success
    expect(folder).toBeTruthy();
    expect((await google().state()).counters.token).toBe(2);
  });

  it('classifies a revoked or expired refresh token as an auth failure', async () => {
    await google().configure({ revoked: true });
    const err = await rejection(testDrive().ensureFolder('AMIN CHAT'));
    expect(err.kind).toBe('auth');
    expect(err.message).toMatch(/invalid_grant/);
    const wrongClient = await rejection(testDrive({ clientSecret: 'nope' }).ensureFolder('AMIN CHAT'));
    expect(wrongClient.kind).toBe('auth');
    expect(wrongClient.message).toMatch(/invalid_client/);
  });

  it('retries temporary Google errors with backoff, then gives up as transient', async () => {
    const drive = testDrive();
    const folder = await drive.ensureFolder('AMIN CHAT');
    await google().configure({ failNext: 2 });
    const info = await drive.upload({ folderId: folder, name: 'r.txt', mime: 'text/plain', bytes: bytesOf(500, 2), ownerKey: 'fil_retry' });
    expect(info.size).toBe(500);
    await google().configure({ failNext: 50 });
    const err = await rejection(drive.upload({ folderId: folder, name: 'r2.txt', mime: 'text/plain', bytes: bytesOf(500, 3), ownerKey: 'fil_retry2' }));
    expect(err.kind).toBe('transient');
  });

  it('reports a full Drive as a quota failure', async () => {
    const drive = testDrive();
    const folder = await drive.ensureFolder('AMIN CHAT');
    await google().configure({ quotaFull: true });
    const err = await rejection(drive.upload({ folderId: folder, name: 'q.txt', mime: 'text/plain', bytes: bytesOf(500, 4), ownerKey: 'fil_quota' }));
    expect(err.kind).toBe('quota');
  });

  it('resumes an interrupted resumable upload where Google left off', async () => {
    const drive = testDrive();
    const folder = await drive.ensureFolder('AMIN CHAT');
    const bytes = bytesOf(CHUNK_SIZE + 700_000, 5);
    await google().configure({ dropNextUploadChunks: 1 }); // the first chunk is stored, but the connection dies before the answer
    const info = await drive.upload({ folderId: folder, name: 'drop.zip', mime: 'application/zip', bytes, ownerKey: 'fil_drop' });
    expect(info.size).toBe(bytes.length);
    expect(same(await google().fileBytes(info.id), bytes)).toBe(true);
    const state = await google().state();
    expect(state.log.some((l) => l.startsWith('PUT') && l.includes('upload_id'))).toBe(true);
    expect(state.files.filter((f) => f.name === 'drop.zip')).toHaveLength(1);

    await google().configure({ failNextUploadChunks: 2 }); // plain 503s on chunks are retried too
    const again = await drive.upload({ folderId: folder, name: 'drop2.zip', mime: 'application/zip', bytes, ownerKey: 'fil_drop2' });
    expect(same(await google().fileBytes(again.id), bytes)).toBe(true);
  });

  it('treats missing files as missing, and deleting them as done', async () => {
    const drive = testDrive();
    expect(await drive.info('drv_nope')).toBeNull();
    expect((await rejection(drive.download('drv_nope'))).kind).toBe('not_found');
    await drive.remove('drv_nope'); // must not throw
    const folder = await drive.ensureFolder('AMIN CHAT');
    const info = await drive.upload({ folderId: folder, name: 'd.txt', mime: 'text/plain', bytes: bytesOf(100, 6), ownerKey: 'fil_del' });
    await drive.remove(info.id);
    expect(await drive.info(info.id)).toBeNull();
    expect(await drive.findByKey('fil_del')).toBeNull();
  });

  it('reads the storage quota of the account', async () => {
    expect(await testDrive().quota()).toEqual({ used: 123456, limit: 15 * 1024 ** 3 });
  });
});
