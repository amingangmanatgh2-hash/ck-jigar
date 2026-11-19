import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { runScheduled } from '../src/cron';
import type { Env } from '../src/env';
import { readFileForAi } from '../src/services/file-text';
import { storeFile } from '../src/services/files';
import { DriveError, resetTokenCache, type DriveStore } from '../src/storage/drive';
import { FileStore } from '../src/storage/file-store';
import { alertAdminsIfNeeded } from '../src/storage/notify';
import { dropTombstones, hotUsage, offloadFiles, offloadPolicy, purgeDeleted, storageStatus, type OffloadPolicy } from '../src/storage/offload';
import { allState, setState } from '../src/storage/state';
import { api, directChat, getAdmin, json, registerUser, sendText, type TestUser } from './helpers';
import { bytesOf, google, resetGoogle, same, testDrive, withEnv } from './google-helpers';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const E = env as unknown as Env;
const policy = (over: Partial<OffloadPolicy> = {}): OffloadPolicy => ({ ...offloadPolicy(E), largeBytes: 1_000_000, ...over });

interface Row {
  id: string;
  tier: string;
  drive_id: string | null;
  deleted_at: number | null;
  purged_at: number | null;
  r2_key: string;
}
const row = (id: string) => env.DB.prepare('SELECT id, tier, drive_id, deleted_at, purged_at, r2_key FROM files WHERE id = ?').bind(id).first<Row>() as Promise<Row>;
const hasR2 = async (id: string) => (await env.FILES.get((await row(id)).r2_key)) !== null;
const age = (id: string, ms: number) => env.DB.prepare('UPDATE files SET created_at = ? WHERE id = ?').bind(Date.now() - ms, id).run();

async function newFile(owner: TestUser, name: string, bytes: Uint8Array, ageMs = 0) {
  const f = await storeFile(E, owner.id, name, bytes);
  if (ageMs) await age(f.id, ageMs);
  return f;
}
const text = (s: string) => new TextEncoder().encode(s);
const dl = (token: string, id: string) => api('GET', `/api/files/${id}`, { token });

async function reset() {
  await resetGoogle();
  resetTokenCache();
  // storage state and every file of earlier tests: the job looks at the whole table
  await env.DB.batch([env.DB.prepare('DELETE FROM storage_state'), env.DB.prepare('UPDATE files SET deleted_at = COALESCE(deleted_at, 1), purged_at = COALESCE(purged_at, 1)')]);
}

describe('cold file tier: offload from R2 to Google Drive', () => {
  let alice: TestUser;
  beforeEach(async () => {
    await reset();
    alice = await registerUser('cold');
  });

  it('moves old files to Drive, verifies them, and keeps serving them from the same URL', async () => {
    const content = bytesOf(40_000, 11);
    const old = await newFile(alice, 'report.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, ...content]), 8 * DAY);
    const fresh = await newFile(alice, 'today.txt', text('just uploaded'), 2 * HOUR);
    const brandNew = await newFile(alice, 'now.txt', text('seconds old'));

    const report = await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() });
    expect(report).toMatchObject({ skipped: null, moved: 1, failed: 0 });

    // the old file is in Drive only; the others are untouched
    const r = await row(old.id);
    expect(r.tier).toBe('drive');
    expect(r.drive_id).toBeTruthy();
    expect(await hasR2(old.id)).toBe(false);
    expect((await row(fresh.id)).tier).toBe('r2');
    expect((await row(brandNew.id)).tier).toBe('r2');

    // Drive holds exactly the bytes we uploaded, inside the app's own folder, tagged with our file id
    const state = await google().state();
    const copy = state.files.find((f) => f.id === r.drive_id)!;
    expect(copy).toMatchObject({ name: 'report.pdf', size: content.length + 4, appProperties: { fileId: old.id } });
    expect(state.files.find((f) => f.id === copy.parents[0])?.name).toBe('AMIN CHAT');
    expect(same(await google().fileBytes(r.drive_id!), new Uint8Array([0x25, 0x50, 0x44, 0x46, ...content]))).toBe(true);

    // the client still downloads it from the Worker URL, with the usual headers
    const res = await dl(alice.token, old.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Content-Length')).toBe(String(content.length + 4));
    expect(same(new Uint8Array(await res.arrayBuffer()), new Uint8Array([0x25, 0x50, 0x44, 0x46, ...content]))).toBe(true);
    // …and the file list is unchanged: clients never see the tier
    const listed = (await json(await api('GET', '/api/files', { token: alice.token }))).files.find((f: { id: string }) => f.id === old.id);
    expect(Object.keys(listed).sort()).not.toContain('tier');
    expect(Object.keys(listed).sort()).not.toContain('driveId');
  });

  it('moves large files early but never one that has not settled yet', async () => {
    const big = await newFile(alice, 'video.mp4', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...bytesOf(1_200_000, 5)]), 2 * HOUR);
    const bigNew = await newFile(alice, 'video2.mp4', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...bytesOf(1_200_000, 6)]), 5 * 60_000);
    const report = await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() });
    expect(report.moved).toBe(1);
    expect((await row(big.id)).tier).toBe('drive');
    expect((await row(bigNew.id)).tier).toBe('r2');
  });

  it('uses resumable uploads for big files and moves them intact', async () => {
    const content = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytesOf(9_000_000, 21)]); // > 8 MB: two chunks
    const f = await newFile(alice, 'archive.zip', content, 9 * DAY);
    const report = await offloadFiles(E, { force: true, drive: testDrive(), policy: policy({ largeBytes: 50_000_000 }) });
    expect(report).toMatchObject({ moved: 1, failed: 0 });
    const r = await row(f.id);
    expect(same(await google().fileBytes(r.drive_id!), content)).toBe(true);
    const res = await dl(alice.token, f.id);
    expect(same(new Uint8Array(await res.arrayBuffer()), content)).toBe(true);
  });

  it('keeps the R2 copy and leaves nothing behind in Drive when verification fails', async () => {
    const f = await newFile(alice, 'doc.txt', text('important'), 10 * DAY);
    await google().configure({ corruptNextUploads: 1 });
    const report = await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() });
    expect(report.moved).toBe(0);
    expect(report.failed).toBe(1);
    expect((await row(f.id)).tier).toBe('r2');
    expect(await hasR2(f.id)).toBe(true);
    expect((await google().state()).files.filter((x) => x.name === 'doc.txt')).toHaveLength(0); // the bad copy was removed again
    expect((await dl(alice.token, f.id)).status).toBe(200);
    // the next run simply tries again and succeeds
    expect((await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() })).moved).toBe(1);
  });

  it('refuses to move a file whose R2 copy no longer matches its checksum', async () => {
    const f = await newFile(alice, 'rot.txt', text('original'), 10 * DAY);
    await env.FILES.put((await row(f.id)).r2_key, text('tampered')); // same size, different content
    const report = await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() });
    expect(report.failed).toBe(1);
    expect((await row(f.id)).tier).toBe('r2');
    expect((await google().state()).files.filter((x) => x.name === 'rot.txt')).toHaveLength(0);
  });

  it('moves every file exactly once even when two job runs overlap', async () => {
    for (let i = 0; i < 5; i++) await newFile(alice, `n${i}.txt`, text(`file ${i}`), (10 + i) * DAY);
    const [a, b] = await Promise.all([offloadFiles(E, { force: true, drive: testDrive(), policy: policy() }), offloadFiles(E, { force: true, drive: testDrive(), policy: policy() })]);
    expect(a.moved + b.moved).toBe(5);
    const copies = (await google().state()).files.filter((f) => /^n\d\.txt$/.test(f.name));
    expect(copies).toHaveLength(5);
    expect(new Set(copies.map((c) => c.appProperties.fileId)).size).toBe(5);
  });

  it('does nothing without Google credentials (files simply stay in R2) and says so', async () => {
    const f = await newFile(alice, 'stay.txt', text('stay'), 30 * DAY);
    const bare = withEnv({ GOOGLE_REFRESH_TOKEN: undefined });
    expect(await offloadFiles(bare, { force: true, policy: policy() })).toMatchObject({ skipped: 'not_configured', moved: 0 });
    expect((await row(f.id)).tier).toBe('r2');
    const status = await storageStatus(bare);
    expect(status.cold).toMatchObject({ configured: false, health: 'not_configured' });
  });

  it('is throttled between runs and when there is nothing to do', async () => {
    expect((await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() })).skipped).toBe('nothing_to_do');
    expect((await offloadFiles(E, { drive: testDrive(), policy: policy() })).skipped).toBe('throttled');
    const later = await offloadFiles(E, { now: Date.now() + 11 * 60_000, drive: testDrive(), policy: policy() });
    expect(later.skipped).toBe('nothing_to_do');
  });

  it('frees the hot tier oldest-first when R2 grows past its soft limit', async () => {
    const files = [];
    for (let i = 0; i < 4; i++) files.push(await newFile(alice, `p${i}.txt`, text('x'.repeat(1000)), (5 - i) * HOUR)); // all young (< 7 days), 4 KB in total
    await setState(E, 'hot.at', null);
    const report = await offloadFiles(E, { force: true, drive: testDrive(), policy: policy({ r2SoftLimitBytes: 2_500, largeBytes: 50_000_000 }) });
    // 4000 B > 2500 B: move oldest files until the hot tier is at or below 90 % of the limit (2250 B)
    expect(report.moved).toBe(2);
    expect((await row(files[0]!.id)).tier).toBe('drive');
    expect((await row(files[1]!.id)).tier).toBe('drive');
    expect((await row(files[2]!.id)).tier).toBe('r2');
    expect((await row(files[3]!.id)).tier).toBe('r2');
  });

  it('puts a move that died half-way back into the hot tier', async () => {
    const f = await newFile(alice, 'half.txt', text('half way'), 10 * DAY);
    await env.DB.prepare(`UPDATE files SET tier = 'moving', tier_changed_at = ? WHERE id = ?`).bind(Date.now() - 20 * 60_000, f.id).run();
    const report = await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() });
    expect(report.moved).toBe(1); // reset to r2, then moved properly
    expect((await row(f.id)).tier).toBe('drive');
  });
});

describe('cold file tier: reading, access control and AI', () => {
  let alice: TestUser;
  let bob: TestUser;
  beforeEach(async () => {
    await reset();
    alice = await registerUser('rd');
    bob = await registerUser('rd2');
  });

  const coldFile = async (owner: TestUser, name: string, content: Uint8Array) => {
    const f = await newFile(owner, name, content, 9 * DAY);
    await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() });
    expect((await row(f.id)).tier).toBe('drive');
    return f;
  };

  it('applies the same access rules to cold files', async () => {
    const eve = await registerUser('eve');
    const c = await directChat(alice, bob);
    const f = await newFile(alice, 'shared.txt', text('for bob'));
    await sendText(alice, c, 'here', { fileIds: [f.id] });
    await age(f.id, 9 * DAY);
    await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() });
    expect((await row(f.id)).tier).toBe('drive');
    expect((await dl(bob.token, f.id)).status).toBe(200);
    expect((await dl(alice.token, f.id)).status).toBe(200);
    expect((await dl(eve.token, f.id)).status).toBe(404);
    expect((await api('GET', `/api/files/${f.id}`)).status).toBe(401);
    // nothing is fetched from Google for a request that is refused
    const before = (await google().state()).counters.api;
    await dl(eve.token, f.id);
    expect((await google().state()).counters.api).toBe(before);
  });

  it('answers 503 FILE_STORAGE_UNAVAILABLE when a cold file cannot be fetched, and recovers by itself', async () => {
    const f = await coldFile(alice, 'later.txt', text('see you later'));
    await google().configure({ revoked: true });
    resetTokenCache();
    await google().expireAllTokens();
    const down = await dl(alice.token, f.id);
    expect(down.status).toBe(503);
    expect((await json(down)).error.code).toBe('FILE_STORAGE_UNAVAILABLE');
    expect((await storageStatus(E)).cold.health).toBe('auth_failed');
    // no hammering: while the credentials are unchanged, Google is not asked again
    const tokens = (await google().state()).counters.token;
    expect((await dl(alice.token, f.id)).status).toBe(503);
    expect((await google().state()).counters.token).toBe(tokens);
    // the admin fixes the token (the refresh token is replaced in the secrets): the same file works again
    await google().configure({ revoked: false, refreshToken: 'brand-new-token' });
    const fixed = withEnv({ GOOGLE_REFRESH_TOKEN: 'brand-new-token' });
    const bytes = await new FileStore(fixed).bytes((await row(f.id)) as never);
    expect(new TextDecoder().decode(bytes!)).toBe('see you later');
    expect((await storageStatus(fixed)).cold.health).toBe('ok');
  });

  it('serves a file whose Drive copy was deleted by hand as "content missing"', async () => {
    const f = await coldFile(alice, 'oops.txt', text('oops'));
    await testDrive().remove((await row(f.id)).drive_id!);
    const res = await dl(alice.token, f.id);
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('FILE_CONTENT_MISSING');
  });

  it('lets the assistant read cold files (text and images) like hot ones', async () => {
    const f = await coldFile(alice, 'notes.txt', text('خرید: نان، شیر، پنیر'));
    const full = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(f.id).first<never>();
    const read = await readFileForAi(E, null as never, alice.id, full as never);
    expect(read).toMatchObject({ type: 'text', text: 'خرید: نان، شیر، پنیر' });

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...bytesOf(500, 4)]);
    const img = await coldFile(alice, 'pic.png', png);
    const imgRow = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(img.id).first<never>();
    const seen = await readFileForAi(E, null as never, alice.id, imgRow as never);
    expect(seen.type).toBe('image');
  });

  it('tells the assistant honestly when a cold file is unreachable', async () => {
    const f = await coldFile(alice, 'locked.txt', text('secret'));
    await google().configure({ revoked: true });
    resetTokenCache();
    const full = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(f.id).first<never>();
    const read = await readFileForAi(E, null as never, alice.id, full as never);
    expect(read).toMatchObject({ type: 'unsupported' });
    expect((read as { reason: string }).reason).toMatch(/Google Drive/);
  });
});

describe('cold file tier: deleting', () => {
  let alice: TestUser;
  beforeEach(async () => {
    await reset();
    alice = await registerUser('del');
  });

  const cold = async (name: string, content: Uint8Array) => {
    const f = await newFile(alice, name, content, 9 * DAY);
    await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() });
    return f;
  };

  it('removes the Drive copy when a user deletes a cold file', async () => {
    const f = await cold('gone.txt', text('bye'));
    const driveId = (await row(f.id)).drive_id!;
    const res = await api('DELETE', `/api/files/${f.id}`, { token: alice.token });
    expect(res.status).toBe(200);
    expect((await google().state()).files.some((x) => x.id === driveId)).toBe(false);
    const r = await row(f.id);
    expect(r.deleted_at).not.toBeNull();
    expect(r.purged_at).not.toBeNull();
    expect((await dl(alice.token, f.id)).status).toBe(404);
  });

  it('removes the Drive copy when the message carrying the file is deleted', async () => {
    const bob = await registerUser('del2');
    const c = await directChat(alice, bob);
    const f = await newFile(alice, 'msg.txt', text('in a message'));
    const { message } = await sendText(alice, c, 'file', { fileIds: [f.id] });
    await age(f.id, 9 * DAY);
    await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() });
    const driveId = (await row(f.id)).drive_id!;
    expect((await api('DELETE', `/api/messages/${message.id}`, { token: alice.token })).status).toBe(200);
    expect((await google().state()).files.some((x) => x.id === driveId)).toBe(false);
    expect((await row(f.id)).purged_at).not.toBeNull();
  });

  it('retries the removal later when Drive is unreachable at the time of the delete', async () => {
    const f = await cold('retry.txt', text('retry me'));
    const driveId = (await row(f.id)).drive_id!;
    await google().configure({ revoked: true });
    resetTokenCache();
    expect((await api('DELETE', `/api/files/${f.id}`, { token: alice.token })).status).toBe(200); // the user's delete succeeds regardless
    expect((await row(f.id)).purged_at).toBeNull(); // …but the bytes are still there
    expect((await dl(alice.token, f.id)).status).toBe(404); // and the file is already invisible
    expect((await google().state()).files.some((x) => x.id === driveId)).toBe(true);

    // later: new credentials; the sweep finishes the job
    await google().configure({ revoked: false, refreshToken: 'fixed' });
    const fixed = withEnv({ GOOGLE_REFRESH_TOKEN: 'fixed' });
    const drive = testDrive({ refreshToken: 'fixed' });
    expect(await purgeDeleted(fixed, Date.now(), new FileStore(fixed, drive))).toBe(1);
    expect((await google().state()).files.some((x) => x.id === driveId)).toBe(false);
    expect((await row(f.id)).purged_at).not.toBeNull();
  });

  it('deletes extracted text and transcripts of a deleted file immediately', async () => {
    const f = await newFile(alice, 'secret.txt', text('top secret'));
    await env.DB.prepare(`INSERT INTO file_derivatives (file_id, kind, content, model_id, created_at) VALUES (?, 'text', 'top secret', NULL, ?)`).bind(f.id, Date.now()).run();
    await api('DELETE', `/api/files/${f.id}`, { token: alice.token });
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM file_derivatives WHERE file_id = ?').bind(f.id).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it('cleans up the Drive copy of a file that was deleted while it was being moved', async () => {
    const f = await newFile(alice, 'race.txt', text('race'), 9 * DAY);
    // simulate a crash after the upload but before it was recorded: the copy exists in Drive, the row says "moving"
    const drive = testDrive();
    const folder = await drive.ensureFolder('AMIN CHAT');
    const orphan = await drive.upload({ folderId: folder, name: 'race.txt', mime: 'text/plain', bytes: text('race'), ownerKey: f.id });
    await env.DB.prepare(`UPDATE files SET tier = 'moving', tier_changed_at = ? WHERE id = ?`).bind(Date.now() - 30 * 60_000, f.id).run();
    expect((await api('DELETE', `/api/files/${f.id}`, { token: alice.token })).status).toBe(200);
    expect((await google().state()).files.some((x) => x.id === orphan.id)).toBe(false);
  });

  it('forgets bookkeeping rows a week after the bytes are gone', async () => {
    const f = await newFile(alice, 'old.txt', text('old'));
    await api('DELETE', `/api/files/${f.id}`, { token: alice.token });
    await env.DB.prepare('UPDATE files SET purged_at = ? WHERE id = ?').bind(Date.now() - 8 * DAY, f.id).run();
    await dropTombstones(E);
    expect(await env.DB.prepare('SELECT 1 AS x FROM files WHERE id = ?').bind(f.id).first()).toBeNull();
  });

  it('removes the Drive copies of an AI conversation that is deleted', async () => {
    const thread = (await json(await api('POST', '/api/ai/threads', { token: alice.token, json: {} }))).thread;
    const f = await newFile(alice, 'chatfile.txt', text('in the AI chat'));
    const conv = (await env.DB.prepare('SELECT conversation_id FROM ai_threads WHERE id = ?').bind(thread.id).first<{ conversation_id: string }>())!.conversation_id;
    const msgId = 'msg_attach_' + Date.now().toString(36);
    await env.DB.prepare(`INSERT INTO messages (id, conversation_id, thread_id, sender_id, kind, body, status, created_at) VALUES (?, ?, ?, ?, 'text', 'with file', 'sent', ?)`).bind(msgId, conv, thread.id, alice.id, Date.now()).run();
    await env.DB.prepare('UPDATE files SET message_id = ?, conversation_id = ?, created_at = ? WHERE id = ?').bind(msgId, conv, Date.now() - 9 * DAY, f.id).run();
    await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() });
    const driveId = (await row(f.id)).drive_id!;
    expect((await api('DELETE', `/api/ai/threads/${thread.id}`, { token: alice.token })).status).toBe(200);
    expect((await google().state()).files.some((x) => x.id === driveId)).toBe(false);
    expect((await row(f.id)).purged_at).not.toBeNull();
  });
});

describe('cold file tier: Google Drive connection problems', () => {
  let alice: TestUser;
  let admin: TestUser;
  beforeEach(async () => {
    await reset();
    alice = await registerUser('conn');
    admin = await getAdmin();
  });

  const adminNotices = async () =>
    (
      await env.DB.prepare(`SELECT m.body FROM messages m JOIN ai_threads t ON t.id = m.thread_id WHERE t.user_id = ? AND t.kind = 'reminders' AND m.sender_id = 'usr_amin_ai' AND m.body LIKE '%Google Drive%' ORDER BY m.created_at`).bind(admin.id).all<{ body: string }>()
    ).results;

  it('on invalid_grant: falls back to R2, stops hammering Google, warns the admin once, recovers with new credentials', async () => {
    const f = await newFile(alice, 'queued.txt', text('queued'), 10 * DAY);
    await google().configure({ revoked: true });

    const first = await offloadFiles(E, { force: true, policy: policy() });
    expect(first.moved).toBe(0);
    expect((await row(f.id)).tier).toBe('r2'); // fallback: the file is still safe in R2
    expect((await dl(alice.token, f.id)).status).toBe(200);
    const status = await storageStatus(E);
    expect(status.cold.health).toBe('auth_failed');
    expect(status.cold.error).toMatch(/invalid_grant/);
    expect(status.attention).toBe('drive_auth_failed');

    // further runs do not call Google at all
    const tokens = (await google().state()).counters.token;
    expect((await offloadFiles(E, { force: true, policy: policy() })).skipped).toBe('auth_failed');
    expect((await google().state()).counters.token).toBe(tokens);

    // the admin is warned — exactly once, in their language, as a normal message from AMIN AI
    expect(await alertAdminsIfNeeded(E)).toBeGreaterThanOrEqual(1);
    expect(await alertAdminsIfNeeded(E)).toBe(0);
    const notices = await adminNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toMatch(/Google Drive/);
    expect(notices[0]!.body).toMatch(/GOOGLE_REFRESH_TOKEN/);

    // new credentials are noticed without any manual reset
    await google().configure({ revoked: false, refreshToken: 'rotated' });
    const rotated = withEnv({ GOOGLE_REFRESH_TOKEN: 'rotated' });
    expect((await storageStatus(rotated)).cold.health).toBe('ok');
    const again = await offloadFiles(rotated, { force: true, drive: testDrive({ refreshToken: 'rotated' }), policy: policy() });
    expect(again.moved).toBe(1);
    expect((await row(f.id)).tier).toBe('drive');
    // a later failure alerts again
    expect((await allState(E))['drive.health']).toBe('ok');
  });

  it('on a full Drive: keeps files in R2, retries only every six hours, and still serves and deletes cold files', async () => {
    const cold = await newFile(alice, 'cold.txt', text('already cold'), 10 * DAY);
    await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() });
    expect((await row(cold.id)).tier).toBe('drive');
    const f = await newFile(alice, 'more.txt', text('one more'), 10 * DAY);
    await google().configure({ quotaFull: true });

    expect((await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() })).moved).toBe(0);
    expect((await row(f.id)).tier).toBe('r2');
    expect((await storageStatus(E)).attention).toBe('drive_full');
    // reading a cold file still works, and does not clear the "full" warning
    expect((await dl(alice.token, cold.id)).status).toBe(200);
    expect((await storageStatus(E)).cold.health).toBe('quota_full');
    // no new attempt within six hours …
    const uploads = (await google().state()).counters.upload;
    expect((await offloadFiles(E, { force: true, policy: policy() })).skipped).toBe('quota_full');
    expect((await google().state()).counters.upload).toBe(uploads);
    // … then it tries again, and succeeds once space is free
    await google().configure({ quotaFull: false });
    const later = await offloadFiles(E, { force: true, now: Date.now() + 7 * HOUR, drive: testDrive(), policy: policy() });
    expect(later.moved).toBe(1);
    expect((await storageStatus(E)).cold.health).toBe('ok');
    // freeing space works while full: deleting a cold file removes its copy
    expect((await api('DELETE', `/api/files/${cold.id}`, { token: alice.token })).status).toBe(200);
  });

  it('degrades after repeated temporary failures and recovers on the next success', async () => {
    for (let i = 0; i < 4; i++) await newFile(alice, `t${i}.txt`, text(`t${i}`), (10 + i) * DAY);
    await google().configure({ failNext: 1000 });
    const drive: DriveStore = testDrive();
    for (let i = 0; i < 3; i++) await offloadFiles(E, { force: true, drive, policy: policy() });
    expect((await storageStatus(E)).cold.health).toBe('degraded');
    await google().configure({ failNext: 0 });
    expect((await offloadFiles(E, { force: true, drive, policy: policy() })).moved).toBe(4);
    expect((await storageStatus(E)).cold.health).toBe('ok');
  });

  it('"Test connection" really calls Google and reports the account quota', async () => {
    const status = await storageStatus(E, { check: true, drive: testDrive() });
    expect(status.cold).toMatchObject({ configured: true, health: 'ok', account: { used: 123456, limit: 15 * 1024 ** 3 } });
    expect(status.cold.folderId).toBeTruthy();
    await google().configure({ accountUsage: 15 * 1024 ** 3 });
    expect((await storageStatus(E, { check: true, drive: testDrive() })).cold.health).toBe('quota_full');
  });

  it('warns about a filling R2 bucket when Drive is not configured', async () => {
    const bare = withEnv({ GOOGLE_REFRESH_TOKEN: undefined, R2_SOFT_LIMIT_BYTES: '1000' });
    await newFile(alice, 'fill.txt', text('y'.repeat(900)));
    const status = await storageStatus(bare, { check: true });
    expect(status.hot.bytes).toBeGreaterThanOrEqual(900);
    expect(status.attention).toBe('r2_filling_without_drive');
  });

  it('caches the hot-tier size (a full count is a table scan) and refreshes it on demand', async () => {
    await newFile(alice, 'c1.txt', text('1'.repeat(100)));
    const a = await hotUsage(E, { fresh: true });
    await newFile(alice, 'c2.txt', text('2'.repeat(100)));
    expect((await hotUsage(E)).bytes).toBe(a.bytes); // cached
    expect((await hotUsage(E, { fresh: true })).bytes).toBe(a.bytes + 100);
    expect((await hotUsage(E, { now: Date.now() + 2 * HOUR })).bytes).toBe(a.bytes + 100); // expired → recomputed
  });
});

describe('cold file tier: admin API and cron', () => {
  let alice: TestUser;
  let admin: TestUser;
  beforeEach(async () => {
    await reset();
    alice = await registerUser('adm');
    admin = await getAdmin();
  });

  it('is restricted to administrators', async () => {
    for (const [method, path] of [['GET', '/api/admin/storage'], ['POST', '/api/admin/storage/check'], ['POST', '/api/admin/storage/offload']] as const) {
      expect((await api(method, path)).status).toBe(401);
      expect((await api(method, path, { token: alice.token })).status).toBe(403);
    }
  });

  it('reports the storage state, tests the connection and offloads on demand', async () => {
    const f = await newFile(alice, 'now.txt', text('move me now'), 9 * DAY);
    const before = await json(await api('GET', '/api/admin/storage', { token: admin.token }));
    expect(before).toMatchObject({ cold: { configured: true }, policy: { afterDays: 7 } });
    expect(before.hot.files).toBeGreaterThanOrEqual(0);

    const check = await json(await api('POST', '/api/admin/storage/check', { token: admin.token }));
    expect(check.cold).toMatchObject({ health: 'ok', account: { used: 123456 } });

    const run = await json(await api('POST', '/api/admin/storage/offload', { token: admin.token }));
    expect(run.report).toMatchObject({ moved: 1, failed: 0 });
    expect(run.status.cold.files).toBeGreaterThanOrEqual(1);
    expect((await row(f.id)).tier).toBe('drive');

    const audit = await env.DB.prepare(`SELECT action FROM audit_log WHERE user_id = ? AND action LIKE 'storage.%' ORDER BY id`).bind(admin.id).all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(['storage.check', 'storage.offload']);
  });

  it('runs inside the minute cron, together with the other jobs', async () => {
    const f = await newFile(alice, 'cron.txt', text('by cron'), 9 * DAY);
    await setState(E, 'offload.last_run_at', '0');
    const report = await runScheduled(E);
    expect(report.offloaded).toBeGreaterThanOrEqual(1);
    expect((await row(f.id)).tier).toBe('drive');
  });
});

describe('FileStore internals', () => {
  beforeEach(reset);

  it('knows nothing about Drive for hot files and survives a move that happens between its read of the row and the R2 read', async () => {
    const u = await registerUser('race');
    const f = await newFile(u, 'moved.txt', text('moved under your feet'), 9 * DAY);
    const stale = await row(f.id); // the caller read the row while it was still in R2 …
    await offloadFiles(E, { force: true, drive: testDrive(), policy: policy() }); // … and the job moves the file before it gets to the bytes
    expect(await hasR2(f.id)).toBe(false);
    const bytes = await new FileStore(E, testDrive()).bytes(stale as never);
    expect(new TextDecoder().decode(bytes!)).toBe('moved under your feet');
  });

  it('reports a missing blob as missing, not as an error', async () => {
    const u = await registerUser('miss');
    const f = await newFile(u, 'lost.txt', text('lost'));
    await env.FILES.delete((await row(f.id)).r2_key);
    expect(await new FileStore(E, testDrive()).bytes((await row(f.id)) as never)).toBeNull();
    expect(await new FileStore(E, testDrive()).exists((await row(f.id)) as never)).toBe(false);
  });

  it('classifies Google errors (used by the state machine)', () => {
    expect(new DriveError('auth', 'x').kind).toBe('auth');
  });
});
