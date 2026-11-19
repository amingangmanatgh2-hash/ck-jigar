/**
 * TEST DOUBLE for Google's OAuth token endpoint and the Drive v3 API — used ONLY by the Vitest integration tests
 * (wired as the `GOOGLE_API` service binding in vitest.config.ts). It is never part of the Worker bundle and never
 * reachable from a deployed Worker: in production the binding does not exist and the real Google endpoints are used.
 *
 * It mimics the parts of Google's behaviour the cold-tier code depends on:
 *   - refresh-token grant incl. invalid_grant / invalid_client; access tokens that expire (401 → client must refresh)
 *   - folder creation, file search by appProperties, metadata, alt=media downloads, delete (204), about.storageQuota
 *   - multipart upload (≤ 5 MB) and RESUMABLE upload with Google's rules: chunks multiple of 256 KiB (except the last),
 *     contiguous offsets, 308 + Range while incomplete, "bytes * / total" status queries
 *   - failure injection: 5xx bursts, storageQuotaExceeded, revoked token, dropped connections, tokens that die mid-flight
 */
import { WorkerEntrypoint } from 'cloudflare:workers';

const CLIENT_ID = 'test-client';
const CLIENT_SECRET = 'test-secret';
const GRANULARITY = 256 * 1024;

const fresh = () => ({
  refreshToken: 'test-refresh',
  revoked: false,
  tokenTtlSeconds: 3600,
  quotaFull: false,
  failNext: 0, // answer the next N Drive API calls with 503
  failNextUploadChunks: 0, // answer the next N resumable chunks with 503
  dropNextUploadChunks: 0, // throw (connection reset) on the next N resumable chunks AFTER storing them
  corruptNextUploads: 0, // store the wrong size for the next N uploads
  killTokensNow: false, // the next Drive call answers 401 once, whatever the token
  accountUsage: 123456,
  accountLimit: 15 * 1024 ** 3,
});

let cfg = fresh();
let files = new Map(); // id -> { id, name, mime, parents, appProperties, bytes, trashed }
let sessions = new Map(); // upload id -> { meta, total, received (Uint8Array chunks), mime }
let validTokens = new Map(); // token -> expiresAt
let log = [];
let counters = { token: 0, api: 0, upload: 0 };
let seq = 0;

const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const gerr = (status, reason, message) => json({ error: { code: status, message, errors: [{ reason, message }] } }, status);

async function md5(bytes) {
  const d = await crypto.subtle.digest('MD5', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const view = async (f) => ({ id: f.id, name: f.name, size: String(f.reportedSize ?? f.bytes.byteLength), md5Checksum: await md5(f.bytes), trashed: f.trashed, mimeType: f.mime });

function indexOfBytes(hay, needle, from = 0) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Splits a multipart/related body into [metadata JSON, media bytes]. */
function parseRelated(contentType, body) {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)?.[2];
  if (!boundary) throw new Error('no boundary');
  const enc = new TextEncoder();
  const delim = enc.encode(`--${boundary}`);
  const crlf2 = enc.encode('\r\n\r\n');
  const parts = [];
  let pos = indexOfBytes(body, delim);
  while (pos >= 0) {
    const next = indexOfBytes(body, delim, pos + delim.length);
    if (next < 0) break;
    const start = pos + delim.length + 2; // skip CRLF after the delimiter
    const headerEnd = indexOfBytes(body, crlf2, start);
    const headers = new TextDecoder().decode(body.subarray(start, headerEnd));
    parts.push({ headers, body: body.subarray(headerEnd + 4, next - 2) }); // strip the CRLF before the next delimiter
    pos = next;
  }
  if (parts.length !== 2) throw new Error(`expected 2 parts, got ${parts.length}`);
  return { metadata: JSON.parse(new TextDecoder().decode(parts[0].body)), media: parts[1].body, mediaType: /content-type:\s*([^\r\n]+)/i.exec(parts[1].headers)?.[1] ?? '' };
}

async function createFile(meta, bytes, mime) {
  const id = `drv_${++seq}_${Math.random().toString(36).slice(2, 8)}`;
  const file = { id, name: meta.name, mime: meta.mimeType ?? mime, parents: meta.parents ?? [], appProperties: meta.appProperties ?? {}, bytes, trashed: false };
  if (cfg.corruptNextUploads > 0) {
    cfg.corruptNextUploads--;
    file.reportedSize = bytes.byteLength - 1;
  }
  files.set(id, file);
  return file;
}

export class FakeGoogle extends WorkerEntrypoint {
  /* ---- control (RPC from the tests) */
  async reset(patch) {
    cfg = { ...fresh(), ...(patch ?? {}) };
    files = new Map();
    sessions = new Map();
    validTokens = new Map();
    log = [];
    counters = { token: 0, api: 0, upload: 0 };
    return true;
  }
  async configure(patch) {
    cfg = { ...cfg, ...patch };
    return true;
  }
  async state() {
    return {
      counters,
      log,
      files: [...files.values()].map((f) => ({ id: f.id, name: f.name, mime: f.mime, parents: f.parents, appProperties: f.appProperties, size: f.bytes.byteLength, trashed: f.trashed })),
      openSessions: sessions.size,
    };
  }
  async fileBytes(id) {
    const f = files.get(id);
    return f ? f.bytes : null;
  }
  async expireAllTokens() {
    validTokens = new Map();
    return true;
  }

  /* ---- the HTTP surface the Worker talks to */
  async fetch(request) {
    const url = new URL(request.url);
    const entry = `${request.method} ${url.host}${url.pathname}`;
    log.push(entry + (url.search ? '?' + url.search.slice(1, 60) : ''));

    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') return this.token(request);

    // resumable session URLs carry their own authorisation (the upload_id), like Google's
    if (url.pathname === '/upload/drive/v3/files' && url.searchParams.has('upload_id')) return this.sessionPut(request, url);

    // every other call needs a live bearer token
    counters.api++;
    const auth = request.headers.get('authorization') ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const exp = validTokens.get(token);
    if (cfg.killTokensNow) {
      cfg.killTokensNow = false;
      validTokens = new Map();
      return gerr(401, 'authError', 'Invalid Credentials');
    }
    if (!exp || exp < Date.now()) return gerr(401, 'authError', 'Invalid Credentials');
    if (cfg.failNext > 0) {
      cfg.failNext--;
      return gerr(503, 'backendError', 'Backend Error');
    }

    const path = url.pathname;
    if (path === '/drive/v3/about') return json({ storageQuota: { usage: String(cfg.accountUsage), limit: String(cfg.accountLimit) } });

    if (path === '/drive/v3/files' && request.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const m = /appProperties has \{ key='fileId' and value='([^']*)' \}/.exec(q);
      const hits = [...files.values()].filter((f) => !f.trashed && (!m || f.appProperties.fileId === m[1]));
      return json({ files: await Promise.all(hits.slice(0, Number(url.searchParams.get('pageSize') ?? 100)).map(view)) });
    }
    if (path === '/drive/v3/files' && request.method === 'POST') {
      const meta = await request.json();
      const id = `drv_${++seq}_${Math.random().toString(36).slice(2, 8)}`;
      files.set(id, { id, name: meta.name, mime: meta.mimeType, parents: [], appProperties: {}, bytes: new Uint8Array(0), trashed: false });
      return json({ id });
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (one) {
      const f = files.get(decodeURIComponent(one[1]));
      if (request.method === 'DELETE') {
        if (!f) return gerr(404, 'notFound', 'File not found');
        files.delete(f.id);
        return new Response(null, { status: 204 });
      }
      if (!f) return gerr(404, 'notFound', 'File not found: ' + one[1]);
      if (url.searchParams.get('alt') === 'media') {
        return new Response(f.bytes, { status: 200, headers: { 'content-type': f.mime, 'content-length': String(f.bytes.byteLength) } });
      }
      return json(await view(f));
    }

    if (path === '/upload/drive/v3/files' && request.method === 'POST') {
      const type = url.searchParams.get('uploadType');
      counters.upload++;
      if (cfg.quotaFull) return gerr(403, 'storageQuotaExceeded', 'The user\'s Drive storage quota has been exceeded.');
      if (type === 'multipart') {
        const body = new Uint8Array(await request.arrayBuffer());
        if (body.byteLength > 5 * 1024 * 1024 + 4096) return gerr(400, 'badRequest', 'multipart uploads are limited to 5 MB');
        const { metadata, media, mediaType } = parseRelated(request.headers.get('content-type') ?? '', body);
        const f = await createFile(metadata, new Uint8Array(media), mediaType);
        return json(await view(f), 200);
      }
      if (type === 'resumable') {
        const meta = await request.json();
        const total = Number(request.headers.get('x-upload-content-length'));
        if (!Number.isFinite(total) || total <= 0) return gerr(400, 'badRequest', 'X-Upload-Content-Length is required');
        const id = `up_${++seq}_${Math.random().toString(36).slice(2, 10)}`;
        sessions.set(id, { meta, total, mime: request.headers.get('x-upload-content-type') ?? 'application/octet-stream', received: 0, data: new Uint8Array(total) });
        return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` } });
      }
      return gerr(400, 'badRequest', 'unsupported uploadType');
    }
    return gerr(404, 'notFound', `no route for ${entry}`);
  }

  async token(request) {
    counters.token++;
    const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
    if (form.get('grant_type') !== 'refresh_token') return json({ error: 'unsupported_grant_type' }, 400);
    if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) return json({ error: 'invalid_client', error_description: 'The OAuth client was not found.' }, 401);
    if (cfg.revoked || form.get('refresh_token') !== cfg.refreshToken) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
    const token = `ya29.fake-${++seq}`;
    validTokens.set(token, Date.now() + cfg.tokenTtlSeconds * 1000);
    return json({ access_token: token, expires_in: cfg.tokenTtlSeconds, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/drive.file' });
  }

  async sessionPut(request, url) {
    const s = sessions.get(url.searchParams.get('upload_id'));
    if (!s) return gerr(404, 'notFound', 'Upload session not found');
    const range = request.headers.get('content-range') ?? '';
    const rangeHeader = () => (s.received > 0 ? { Range: `bytes=0-${s.received - 1}` } : {});
    const status = /^bytes \*\/(\d+)$/.exec(range);
    if (status) {
      if (Number(status[1]) !== s.total) return gerr(400, 'badRequest', 'total mismatch');
      if (s.received >= s.total) return json(await view(await this.finish(url.searchParams.get('upload_id'), s)), 200);
      return new Response(null, { status: 308, headers: rangeHeader() });
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!m) return gerr(400, 'badRequest', 'bad Content-Range: ' + range);
    const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (total !== s.total) return gerr(400, 'badRequest', 'total mismatch');
    const chunk = new Uint8Array(await request.arrayBuffer());
    if (chunk.byteLength !== end - start + 1) return gerr(400, 'badRequest', 'Content-Range does not match the body');
    const isLast = end + 1 === total;
    if (!isLast && chunk.byteLength % GRANULARITY !== 0) return gerr(400, 'badRequest', 'chunk size must be a multiple of 256 KiB');
    if (cfg.failNextUploadChunks > 0) {
      cfg.failNextUploadChunks--;
      return gerr(503, 'backendError', 'Backend Error');
    }
    if (start > s.received) return new Response(null, { status: 308, headers: rangeHeader() }); // gap: tell the client where we are
    if (start < s.received) {
      // overlap: keep what we have, accept the rest (Google does the same)
    }
    s.data.set(chunk, start);
    s.received = Math.max(s.received, end + 1);
    if (cfg.dropNextUploadChunks > 0) {
      cfg.dropNextUploadChunks--;
      throw new Error('connection reset by peer');
    }
    if (s.received < total) return new Response(null, { status: 308, headers: rangeHeader() });
    const f = await this.finish(url.searchParams.get('upload_id'), s);
    return json(await view(f), 200);
  }

  async finish(id, s) {
    const f = await createFile(s.meta, s.data, s.mime);
    sessions.delete(id);
    return f;
  }
}

export default {
  fetch() {
    return new Response('use the FakeGoogle entrypoint', { status: 500 });
  },
};
