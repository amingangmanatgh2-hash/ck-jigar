import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, directChat, json, registerUser, sendText } from './helpers';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function upload(token: string, name: string, bytes: Uint8Array) {
  const form = new FormData();
  form.set('file', new File([bytes], name));
  return api('POST', '/api/files', { token, body: form });
}

describe('files', () => {
  it('stores validated uploads in R2 and serves them to the owner', async () => {
    const u = await registerUser('up');
    const res = await upload(u.token, 'photo.png', PNG);
    expect(res.status).toBe(201);
    const { file } = await json(res);
    expect(file).toMatchObject({ name: 'photo.png', mime: 'image/png', kind: 'image', size: PNG.length });
    const stored = await env.FILES.get(`u/${u.id}/${file.id}`);
    expect(stored).not.toBeNull();

    const dl = await api('GET', `/api/files/${file.id}`, { token: u.token });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('Content-Type')).toBe('image/png');
    expect(dl.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(dl.headers.get('Content-Disposition')).toContain('inline');
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PNG);
  });

  it('rejects disallowed types, mismatching content, empty files and invalid text', async () => {
    const u = await registerUser('bad');
    expect((await upload(u.token, 'run.exe', new Uint8Array([0x4d, 0x5a, 1, 2]))).status).toBe(415);
    expect((await upload(u.token, 'fake.png', new TextEncoder().encode('<script>alert(1)</script>'))).status).toBe(415);
    expect((await upload(u.token, 'empty.txt', new Uint8Array(0))).status).toBe(400);
    expect((await upload(u.token, 'bin.txt', new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0x80]))).status).toBe(415);
    const ok = await upload(u.token, 'نکات.txt', new TextEncoder().encode('متن فارسی'));
    expect(ok.status).toBe(201);
  });

  it('serves risky types (svg/html) only as downloads', async () => {
    const u = await registerUser('svg');
    const { file } = await json(await upload(u.token, 'x.svg', new TextEncoder().encode('<svg onload="alert(1)"/>')));
    expect(file.kind).toBe('text');
    const dl = await api('GET', `/api/files/${file.id}`, { token: u.token });
    expect(dl.headers.get('Content-Disposition')).toContain('attachment');
    expect(dl.headers.get('Content-Type')).toBe('text/plain');
  });

  it('keeps unattached files private and shares attached ones only with conversation members', async () => {
    const a = await registerUser('fa');
    const b = await registerUser('fb');
    const spy = await registerUser('fs');
    const c = await directChat(a, b);
    const { file } = await json(await upload(a.token, 'doc.txt', new TextEncoder().encode('hello')));
    expect((await api('GET', `/api/files/${file.id}`, { token: b.token })).status).toBe(404);

    const { message } = await sendText(a, c, 'see attachment', { fileIds: [file.id] });
    expect(message.attachments).toHaveLength(1);
    expect((await api('GET', `/api/files/${file.id}`, { token: b.token })).status).toBe(200);
    expect((await api('GET', `/api/files/${file.id}`, { token: spy.token })).status).toBe(404);

    // a file can only be attached once, and only by its owner
    const again = await api('POST', `/api/conversations/${c}/messages`, { token: a.token, json: { body: 'again', fileIds: [file.id] } });
    expect(again.status).toBe(400);
    const { file: other } = await json(await upload(b.token, 'b.txt', new TextEncoder().encode('b')));
    const steal = await api('POST', `/api/conversations/${c}/messages`, { token: a.token, json: { body: 'steal', fileIds: [other.id] } });
    expect(steal.status).toBe(400);
    expect((await json(steal)).error.code).toBe('INVALID_ATTACHMENT');
  });

  it('deletes content from R2 when a message with attachments is deleted', async () => {
    const a = await registerUser('fd');
    const b = await registerUser('fe');
    const c = await directChat(a, b);
    const { file } = await json(await upload(a.token, 'gone.txt', new TextEncoder().encode('bye')));
    const { message } = await sendText(a, c, 'file', { fileIds: [file.id] });
    await api('DELETE', `/api/messages/${message.id}`, { token: a.token });
    expect(await env.FILES.get(`u/${a.id}/${file.id}`)).toBeNull();
    expect((await api('GET', `/api/files/${file.id}`, { token: a.token })).status).toBe(404);
  });

  it('supports raw uploads with a URI-encoded file name and lists own files', async () => {
    const u = await registerUser('raw');
    const res = await api('POST', '/api/files', { token: u.token, body: new TextEncoder().encode('# عنوان'), headers: { 'X-File-Name': encodeURIComponent('یادداشت.md') } });
    expect(res.status).toBe(201);
    const list = await json(await api('GET', '/api/files?q=' + encodeURIComponent('یادداشت'), { token: u.token }));
    expect(list.files).toHaveLength(1);
    expect(list.files[0].name).toBe('یادداشت.md');
  });
});
