import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ConfigError, clientAddress, clientResponseHeaders, createRelay, normalizeIp, parseConfig } from './relay.mjs';

/* ------------------------------------------------------------------------------------------------ fake Worker */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64');

function frame(opcode, payload, mask) {
  const len = payload.length;
  const lenBytes = len < 126 ? [len] : [126, len >> 8, len & 255];
  const head = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | lenBytes[0], ...lenBytes.slice(1)]);
  if (!mask) return Buffer.concat([head, payload]);
  const key = randomBytes(4);
  return Buffer.concat([head, key, Buffer.from(payload.map((b, i) => b ^ key[i % 4]))]);
}

function parseFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const opcode = buf[off] & 0x0f;
    const masked = (buf[off + 1] & 0x80) !== 0;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    }
    let key;
    if (masked) {
      if (buf.length - p < 4) break;
      key = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length - p < len) break;
    let payload = Buffer.from(buf.subarray(p, p + len));
    if (masked) payload = Buffer.from(payload.map((b, i) => b ^ key[i % 4]));
    frames.push({ opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** Stands in for the Worker: records what it receives and misbehaves on request. */
async function startUpstream() {
  const seen = [];
  const upgrades = [];
  const aborted = [];
  const wsClosed = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    try {
      for await (const c of req) chunks.push(c);
    } catch {
      return; // the relay cancelled this request (the client gave up, or the body was too large)
    }
    const url = new URL(req.url, 'http://x');
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, rawHeaders: [...req.rawHeaders], body: Buffer.concat(chunks) });
    res.on('close', () => {
      if (!res.writableEnded) aborted.push(url.pathname);
    });
    const origin = req.headers.origin;
    switch (url.pathname) {
      case '/api/health':
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Request-Id': 'req_upstream_1',
          'Cache-Control': 'no-store',
          ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'X-Request-Id,Retry-After', Vary: 'Origin' } : {}),
        });
        return void res.end(JSON.stringify({ ok: true, service: 'amin-chat' }));
      case '/echo':
        res.writeHead(200, { 'Content-Type': req.headers['content-type'] ?? 'application/octet-stream', 'X-Request-Id': 'req_echo' });
        return void res.end(Buffer.concat(chunks));
      case '/stream':
        res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Request-Id': 'req_stream' });
        res.write('first-');
        return void setTimeout(() => res.end('second'), 400);
      case '/hang':
        return;
      case '/drop':
        res.writeHead(200, { 'Content-Length': '1000', 'X-Request-Id': 'req_drop' });
        res.write('partial');
        return void setTimeout(() => res.socket.destroy(), 50);
      case '/big':
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Request-Id': 'req_big' });
        return void res.end(Buffer.alloc(3 * 1024 * 1024, 7));
      case '/headers':
        res.setHeader('Keep-Alive', 'timeout=5');
        res.setHeader('Proxy-Authenticate', 'Basic');
        res.setHeader('Connection', 'keep-alive, X-Hop-Only');
        res.setHeader('X-Hop-Only', 'secret');
        res.setHeader('Set-Cookie', ['a=1', 'b=2']);
        res.setHeader('X-Relay-Internal', 'nope');
        res.setHeader('X-Request-Id', 'req_headers');
        res.setHeader('X-Dup', ['one', 'two']);
        res.setHeader('Retry-After', '7');
        return void res.end('ok');
      default: {
        const m = /^\/status\/(\d{3})$/.exec(url.pathname);
        res.writeHead(m ? Number(m[1]) : 404, { 'X-Request-Id': 'req_status', 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ error: { code: 'FROM_UPSTREAM' } }));
      }
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('upgrade', (req, socket) => {
    upgrades.push({ url: req.url, headers: { ...req.headers } });
    sockets.add(socket);
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('ticket') !== 'good') {
      const body = JSON.stringify({ error: { code: 'BAD_TICKET' } });
      socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Request-Id: req_ws_no\r\nSet-Cookie: x=1\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    const head = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\nX-Request-Id: req_ws_ok\r\n\r\n`;
    // "hello" goes out in the same write as the handshake: the relay must not lose bytes that arrive with the 101
    if (url.searchParams.get('hello')) socket.write(Buffer.concat([Buffer.from(head), frame(1, Buffer.from('hello-from-worker'), false)]));
    else socket.write(head);
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const parsed = parseFrames(buf);
      buf = parsed.rest;
      for (const f of parsed.frames) {
        if (f.opcode === 8) socket.end(frame(8, f.payload, false));
        else socket.write(frame(f.opcode, f.payload, false));
      }
    });
    // A real WebSocket server closes its side when the peer hangs up. "stubborn" never does: it keeps writing instead, which is
    // accepted while the relay merely half-closed its side, and fails with a reset once the relay really cuts the connection off.
    if (!url.searchParams.get('stubborn')) socket.on('end', () => socket.end());
    else {
      socket.on('end', () => {
        const probe = setInterval(() => socket.write(frame(9, Buffer.alloc(0), false)), 40);
        socket.on('close', () => clearInterval(probe));
      });
    }
    socket.on('error', () => undefined);
    socket.on('close', () => wsClosed.push(req.url));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    seen,
    upgrades,
    aborted,
    wsClosed,
    last: () => seen[seen.length - 1],
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/* ------------------------------------------------------------------------------------------------ helpers */

const settings = (upstreamPort, over = {}) => ({ UPSTREAM: `http://127.0.0.1:${upstreamPort}`, PORT: '0', HOST: '127.0.0.1', LOG: '0', ...over });

async function startRelay(upstreamPort, over = {}) {
  const relay = createRelay(parseConfig(settings(upstreamPort, over)));
  const { port } = await relay.listen();
  return { port, relay, close: () => relay.close() };
}

function call(port, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on('aborted', () => reject(new Error('response aborted')));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const text = (r) => r.body.toString('utf8');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const eventually = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A WebSocket client by hand, so that the test can see exactly what the relay sends back. */
function openWs(port, { path: target = '/api/realtime/ws?ticket=good', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1');
    let head = Buffer.alloc(0);
    let state = 'handshake';
    let rest = Buffer.alloc(0);
    const messages = [];
    const waiters = [];
    let result = null;
    const lines = [`GET ${target} HTTP/1.1`, 'Host: relay.example', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);

    const deliver = () => {
      const parsed = parseFrames(rest);
      rest = parsed.rest;
      for (const f of parsed.frames) {
        messages.push(f);
        waiters.shift()?.(messages.shift());
      }
    };
    socket.on('data', (d) => {
      if (state === 'handshake') {
        head = Buffer.concat([head, d]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        const headText = head.subarray(0, end).toString('latin1');
        const after = head.subarray(end + 4);
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(headText)?.[1]);
        const hdrs = Object.fromEntries(headText.split('\r\n').slice(1).map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
        if (status !== 101) {
          state = 'refused';
          const chunks = [after];
          socket.on('data', (c) => chunks.push(c));
          socket.on('close', () => resolve({ status, headers: hdrs, body: Buffer.concat(chunks).toString('utf8') }));
          return;
        }
        state = 'open';
        rest = Buffer.from(after);
        result = {
          status,
          headers: hdrs,
          expectedAccept: acceptKey(key),
          send: (s) => socket.write(frame(1, Buffer.from(s), true)),
          next: (ms = 3000) =>
            new Promise((res, rej) => {
              if (messages.length) return res(messages.shift());
              const t = setTimeout(() => rej(new Error('no websocket frame in time')), ms);
              waiters.push((f) => {
                clearTimeout(t);
                res(f);
              });
            }),
          closeFromClient: () => socket.end(frame(8, Buffer.alloc(0), true)),
          destroy: () => socket.destroy(),
          closed: new Promise((res) => socket.on('close', res)),
        };
        deliver();
        resolve(result);
      } else if (state === 'open') {
        rest = Buffer.concat([rest, d]);
        deliver();
      }
    });
    socket.on('error', (e) => {
      if (state === 'handshake') reject(e);
    });
  });
}

/* ------------------------------------------------------------------------------------------------ configuration */

describe('parseConfig', () => {
  const problems = (env) => {
    try {
      parseConfig(env);
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      return e.problems;
    }
    return [];
  };

  it('needs an upstream address, and says how to give one', () => {
    assert.match(problems({}).join('\n'), /UPSTREAM is required.*workers\.dev/);
  });

  it('applies the defaults for an https upstream', () => {
    const cfg = parseConfig({ UPSTREAM: 'https://amin-chat.example.workers.dev/' });
    assert.equal(cfg.upstream.origin, 'https://amin-chat.example.workers.dev');
    assert.deepEqual([cfg.port, cfg.host, cfg.trustProxy, cfg.rewriteWsOrigin, cfg.log, cfg.secret, cfg.tls], [8080, '0.0.0.0', false, true, true, '', null]);
    assert.equal(cfg.maxBodyBytes, 64 * 1024 * 1024);
  });

  it('refuses addresses that cannot work, one clear message each', () => {
    for (const [value, expected] of [
      ['amin.example.com', /not a valid address/],
      ['ftp://amin.example.com', /must start with https/],
      ['https://user:pw@amin.example.com', /user name or password/],
      ['https://amin.example.com/api', /without a path/],
      ['https://amin.example.com/?x=1', /without a path/],
      ['http://amin.example.com', /plain http/],
    ]) assert.match(problems({ UPSTREAM: value }).join('\n'), expected, value);
  });

  it('allows plain http only for this machine, or when the operator says the link is private', () => {
    for (const ok of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) assert.deepEqual(problems({ UPSTREAM: ok }), [], ok);
    assert.deepEqual(problems({ UPSTREAM: 'http://10.0.0.5:8787', ALLOW_INSECURE_UPSTREAM: '1' }), []);
  });

  it('reports every problem at once', () => {
    const list = problems({ UPSTREAM: '', PORT: 'abc', MAX_BODY_MB: '0', TLS_CERT_FILE: '/nowhere/cert.pem', RELAY_SECRET: 'short' });
    assert.ok(list.length >= 5, list.join('\n'));
    assert.ok(list.some((p) => /PORT/.test(p)) && list.some((p) => /MAX_BODY_MB/.test(p)) && list.some((p) => /TLS_CERT_FILE and TLS_KEY_FILE/.test(p)) && list.some((p) => /RELAY_SECRET/.test(p)));
  });

  it('wants TLS files that exist, and a relay secret that is long enough to mean something', () => {
    assert.match(problems({ UPSTREAM: 'https://a.example', TLS_CERT_FILE: '/nowhere/c', TLS_KEY_FILE: '/nowhere/k' }).join('\n'), /file not found/);
    assert.deepEqual(problems({ UPSTREAM: 'https://a.example', RELAY_SECRET: 'x'.repeat(16) }), []);
  });
});

describe('client addresses', () => {
  it('normalises what sockets and proxies report, and refuses everything else', () => {
    assert.equal(normalizeIp('::ffff:10.1.2.3'), '10.1.2.3');
    assert.equal(normalizeIp('[2001:db8::1]:443'), '2001:db8::1');
    assert.equal(normalizeIp('1.2.3.4:5678'), '1.2.3.4');
    assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
    for (const bad of ['', undefined, null, 'evil, 1.2.3.4', '999.1.1.1', 'localhost', '1.2.3.4\r\nX-Evil: 1']) assert.equal(normalizeIp(bad), '', String(bad));
  });

  const req = (xff, peer = '::ffff:10.0.0.2') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: peer } });
  it('uses the connection peer, and ignores X-Forwarded-For that anyone could have sent', () => {
    assert.equal(clientAddress(req('6.6.6.6'), false), '10.0.0.2');
  });
  it('behind your own proxy it takes the entry THAT proxy added (the right-most), not what the client claimed', () => {
    assert.equal(clientAddress(req('6.6.6.6, 203.0.113.9'), true), '203.0.113.9');
    assert.equal(clientAddress(req('not-an-ip'), true), '10.0.0.2');
    assert.equal(clientAddress(req(undefined), true), '10.0.0.2');
  });
});

describe('response headers', () => {
  it('keeps the upstream’s own spelling and duplicates, drops connection-specific ones and cookies', () => {
    const raw = ['X-Request-Id', 'a', 'Connection', 'keep-alive, X-Hop', 'X-Hop', '1', 'Keep-Alive', 't=5', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'X-Dup', '1', 'X-Dup', '2', 'X-Relay-Foo', 'x', 'Transfer-Encoding', 'chunked'];
    assert.deepEqual(clientResponseHeaders(raw), ['X-Request-Id', 'a', 'X-Dup', '1', 'X-Dup', '2']);
    // an upgrade answer must keep Connection/Upgrade
    assert.deepEqual(clientResponseHeaders(['Upgrade', 'websocket', 'Connection', 'Upgrade', 'Set-Cookie', 'a=1'], { upgrade: true }), ['Upgrade', 'websocket', 'Connection', 'Upgrade']);
  });
});

/* ------------------------------------------------------------------------------------------------ the proxy */

describe('relay: plain requests', () => {
  let up;
  let relay;
  before(async () => {
    up = await startUpstream();
    relay = await startRelay(up.port, { RELAY_SECRET: 'a-long-shared-secret-1234' });
  });
  after(async () => {
    await relay.close();
    await up.close();
  });

  it('forwards a request and gives the answer back untouched: status, body, X-Request-Id, CORS headers, caching rules', async () => {
    const r = await call(relay.port, { path: '/api/health', headers: { Origin: 'https://localhost' } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(text(r)), { ok: true, service: 'amin-chat' });
    assert.equal(r.headers['x-request-id'], 'req_upstream_1'); // the apps decide "this is our server" by this header
    assert.equal(r.headers['access-control-allow-origin'], 'https://localhost');
    assert.equal(r.headers['access-control-expose-headers'], 'X-Request-Id,Retry-After');
    assert.equal(r.headers.vary, 'Origin');
    assert.equal(r.headers['cache-control'], 'no-store'); // never turned into something cacheable
  });

  it('relays the upstream’s refusals as they are (so the app can tell a refusal from a broken route)', async () => {
    for (const status of [401, 404, 429, 500]) {
      const r = await call(relay.port, { path: `/status/${status}` });
      assert.equal(r.status, status);
      assert.equal(JSON.parse(text(r)).error.code, 'FROM_UPSTREAM');
      assert.equal(r.headers['x-request-id'], 'req_status');
    }
  });

  it('sends the Worker the right Host, the real client, and the signing secret — and leaves Origin and the path alone', async () => {
    await call(relay.port, { path: '/api/conversations?limit=5', headers: { Origin: 'https://app.example', Authorization: 'Bearer tok', Host: 'relay.example.com', 'Accept-Encoding': 'gzip' } });
    const got = up.last();
    assert.equal(got.url, '/api/conversations?limit=5');
    assert.equal(got.headers.host, `127.0.0.1:${up.port}`);
    assert.equal(got.headers.origin, 'https://app.example'); // HTTP: untouched, so the Worker's CORS answer matches the page
    assert.equal(got.headers.authorization, 'Bearer tok');
    assert.equal(got.headers['accept-encoding'], 'gzip');
    assert.equal(got.headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(got.headers['x-relay-secret'], 'a-long-shared-secret-1234');
  });

  it('drops identity headers and cookies a client could forge, and never passes the secret back', async () => {
    const r = await call(relay.port, {
      path: '/api/health',
      headers: { 'X-Relay-Secret': 'guess', 'X-Forwarded-For': '6.6.6.6', Forwarded: 'for=6.6.6.6', 'X-Real-IP': '6.6.6.6', 'CF-Connecting-IP': '6.6.6.6', 'True-Client-IP': '6.6.6.6', 'X-Forwarded-Host': 'evil', Cookie: 'sid=1', Via: '1.1 evil' },
    });
    const got = up.last();
    assert.equal(got.headers['x-relay-secret'], 'a-long-shared-secret-1234'); // ours, not the guess
    assert.equal(got.headers['x-forwarded-for'], '127.0.0.1');
    for (const name of ['forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-forwarded-host', 'cookie', 'via']) assert.equal(got.headers[name], undefined, name);
    assert.equal(JSON.stringify(r.rawHeaders).includes('a-long-shared-secret'), false);
  });

  it('does not forward headers that describe only the client’s own connection', async () => {
    await call(relay.port, { path: '/api/health', headers: { Connection: 'close, X-Secret-Hop', 'X-Secret-Hop': '1', TE: 'trailers', 'Keep-Alive': 'timeout=9', 'Proxy-Authorization': 'Basic abc' } });
    const got = up.last();
    for (const name of ['x-secret-hop', 'te', 'keep-alive', 'proxy-authorization']) assert.equal(got.headers[name], undefined, name);
  });

  it('strips connection-specific and cookie headers from answers, keeps duplicates and Retry-After', async () => {
    const r = await call(relay.port, { path: '/headers' });
    assert.equal(r.status, 200);
    assert.equal(text(r), 'ok');
    for (const name of ['x-hop-only', 'proxy-authenticate', 'set-cookie', 'x-relay-internal']) assert.equal(r.headers[name], undefined, name);
    assert.equal(r.headers['x-request-id'], 'req_headers');
    assert.equal(r.headers['x-dup'], 'one, two');
    assert.equal(r.headers['retry-after'], '7'); // the outbox honours it
  });

  it('carries request bodies byte for byte, announced or chunked', async () => {
    const payload = randomBytes(3 * 1024 * 1024);
    const sized = await call(relay.port, { method: 'POST', path: '/echo', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length }, body: payload });
    assert.equal(sha(sized.body), sha(payload));
    const chunked = await call(relay.port, { method: 'POST', path: '/echo', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'سلام', clientId: 'abc12345' }) });
    assert.deepEqual(JSON.parse(text(chunked)), { body: 'سلام', clientId: 'abc12345' });
    assert.equal(up.last().headers['transfer-encoding'], 'chunked');
  });

  it('carries large answers completely', async () => {
    const r = await call(relay.port, { path: '/big' });
    assert.equal(r.body.length, 3 * 1024 * 1024);
    assert.ok(r.body.every((b) => b === 7));
  });

  it('streams: the first part reaches the client while the upstream is still answering', async () => {
    const times = await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const out = { first: 0, end: 0, body: '' };
      http
        .get({ host: '127.0.0.1', port: relay.port, path: '/stream', agent: false }, (res) => {
          res.on('data', (c) => {
            out.first ||= Date.now() - t0;
            out.body += c;
          });
          res.on('end', () => resolve({ ...out, end: Date.now() - t0 }));
        })
        .on('error', reject);
    });
    assert.equal(times.body, 'first-second');
    assert.ok(times.first < 300, `first chunk after ${times.first} ms`);
    assert.ok(times.end >= 380, `finished after ${times.end} ms`);
  });

  it('stops the upstream request when the client gives up', async () => {
    await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: relay.port, path: '/hang', agent: false });
      req.on('error', () => undefined);
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 150);
    });
    await eventually(() => up.aborted.includes('/hang'));
  });

  it('lets a truncated upstream answer look truncated instead of complete', async () => {
    await assert.rejects(call(relay.port, { path: '/drop' }), /abort|reset|socket|closed/i);
  });

  it('answers /__relay/health itself, without bothering the Worker', async () => {
    const before = up.seen.length;
    const r = await call(relay.port, { path: '/__relay/health' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(text(r)), { ok: true, relay: true });
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-request-id'], undefined);
    assert.equal(up.seen.length, before);
  });

  it('is not an open proxy: absolute-form requests and CONNECT are refused', async () => {
    const before = up.seen.length;
    const abs = await call(relay.port, { path: 'http://evil.example/steal' });
    assert.equal(abs.status, 400);
    assert.equal(JSON.parse(text(abs)).error.code, 'RELAY_BAD_REQUEST');
    const connect = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: relay.port, method: 'CONNECT', path: 'evil.example:443', agent: false });
      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      });
      req.on('response', (res) => resolve(res.statusCode));
      req.on('error', reject);
      req.end();
    });
    assert.equal(connect, 405);
    assert.equal(up.seen.length, before); // nothing reached the upstream
  });
});

describe('relay: who the client is', () => {
  let up;
  before(async () => {
    up = await startUpstream();
  });
  after(() => up.close());

  it('behind your own proxy (TRUST_PROXY=1) reports the address that proxy saw', async () => {
    const r = await startRelay(up.port, { TRUST_PROXY: '1' });
    try {
      await call(r.port, { path: '/api/health', headers: { 'X-Forwarded-For': '6.6.6.6, 203.0.113.77' } });
      assert.equal(up.last().headers['x-forwarded-for'], '203.0.113.77');
    } finally {
      await r.close();
    }
  });

  it('without a secret it still works, and sends none', async () => {
    const r = await startRelay(up.port);
    try {
      await call(r.port, { path: '/api/health', headers: { 'X-Relay-Secret': 'guess' } });
      assert.equal(up.last().headers['x-relay-secret'], undefined);
    } finally {
      await r.close();
    }
  });
});

describe('relay: limits and failures', () => {
  let up;
  before(async () => {
    up = await startUpstream();
  });
  after(() => up.close());

  it('refuses a request that announces more than MAX_BODY_MB, before reading it', async () => {
    const r = await startRelay(up.port, { MAX_BODY_MB: '1' });
    try {
      const before = up.seen.length;
      const res = await call(r.port, { method: 'POST', path: '/echo', headers: { 'Content-Length': 1024 * 1024 + 1, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(1024 * 1024 + 1) });
      assert.equal(res.status, 413);
      assert.equal(JSON.parse(text(res)).error.code, 'RELAY_BODY_TOO_LARGE');
      assert.equal(res.headers['x-request-id'], undefined);
      assert.equal(up.seen.length, before);
    } finally {
      await r.close();
    }
  });

  it('also stops a chunked upload that grows past the limit', async () => {
    const r = await startRelay(up.port, { MAX_BODY_MB: '1' });
    try {
      const res = await call(r.port, { method: 'POST', path: '/echo', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(2 * 1024 * 1024 + 5) });
      assert.equal(res.status, 413);
    } finally {
      await r.close();
    }
  });

  it('says 502 — without X-Request-Id, so the apps know it was not the Worker — when the Worker cannot be reached', async () => {
    const r = await startRelay(1); // nothing listens on port 1
    try {
      const res = await call(r.port, { path: '/api/health' });
      assert.equal(res.status, 502);
      assert.equal(JSON.parse(text(res)).error.code, 'RELAY_UPSTREAM_UNREACHABLE');
      assert.equal(res.headers['x-request-id'], undefined);
      assert.equal(res.headers['cache-control'], 'no-store');
    } finally {
      await r.close();
    }
  });

  it('says 504 when the Worker stops answering', async () => {
    const r = await startRelay(up.port, { UPSTREAM_IDLE_TIMEOUT_MS: '1000' });
    try {
      const t0 = Date.now();
      const res = await call(r.port, { path: '/hang' });
      assert.equal(res.status, 504);
      assert.equal(JSON.parse(text(res)).error.code, 'RELAY_UPSTREAM_TIMEOUT');
      assert.ok(Date.now() - t0 < 4000);
    } finally {
      await r.close();
    }
  });

  it('gives up on a connection that never completes its TLS handshake (a black-holed route)', async () => {
    const hole = net.createServer((s) => s.on('data', () => undefined)); // accepts, never answers
    await new Promise((resolve) => hole.listen(0, '127.0.0.1', resolve));
    const r = await startRelay(hole.address().port, { UPSTREAM: `https://127.0.0.1:${hole.address().port}`, CONNECT_TIMEOUT_MS: '300' });
    try {
      const t0 = Date.now();
      const res = await call(r.port, { path: '/api/health' });
      assert.equal(res.status, 504);
      assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
    } finally {
      await r.close();
      hole.close();
      hole.closeAllConnections?.();
    }
  });
});

describe('relay: WebSocket', () => {
  let up;
  let relay;
  before(async () => {
    up = await startUpstream();
    relay = await startRelay(up.port, { RELAY_SECRET: 'a-long-shared-secret-1234' });
  });
  after(async () => {
    await relay.close();
    await up.close();
  });

  it('completes the handshake with the Worker and carries messages both ways', async () => {
    const ws = await openWs(relay.port, { headers: { Origin: 'https://relay.example' } });
    assert.equal(ws.status, 101);
    assert.equal(ws.headers['sec-websocket-accept'], ws.expectedAccept);
    assert.equal(ws.headers['x-request-id'], 'req_ws_ok');
    ws.send('ping 1');
    assert.equal((await ws.next()).payload.toString(), 'ping 1');
    const big = 'ب'.repeat(2500); // > 125 bytes: extended frame length
    ws.send(big);
    assert.equal((await ws.next()).payload.toString(), big);
    ws.closeFromClient();
    await ws.closed;
  });

  it('does not lose what the Worker sends in the same packet as its handshake answer', async () => {
    const ws = await openWs(relay.port, { path: '/api/realtime/ws?ticket=good&hello=1' });
    assert.equal(ws.status, 101);
    assert.equal((await ws.next()).payload.toString(), 'hello-from-worker');
    ws.destroy();
  });

  it('tells the Worker the real client, signs it, and presents the Worker’s own origin (the ticket is the credential, not the origin)', async () => {
    const ws = await openWs(relay.port, { headers: { Origin: 'https://relay.example', 'X-Forwarded-For': '6.6.6.6', 'X-Relay-Secret': 'guess', Cookie: 'x=1' } });
    const got = up.upgrades[up.upgrades.length - 1];
    assert.equal(got.headers.origin, `http://127.0.0.1:${up.port}`);
    assert.equal(got.headers.host, `127.0.0.1:${up.port}`);
    assert.equal(got.headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(got.headers['x-relay-secret'], 'a-long-shared-secret-1234');
    assert.equal(got.headers.cookie, undefined);
    assert.equal(got.headers.upgrade, 'websocket');
    assert.ok(got.headers['sec-websocket-key']);
    assert.equal(got.url, '/api/realtime/ws?ticket=good');
    ws.destroy();
  });

  it('leaves Origin alone when REWRITE_WS_ORIGIN=0 (the relay is listed in PUBLIC_ENDPOINTS)', async () => {
    const r = await startRelay(up.port, { REWRITE_WS_ORIGIN: '0' });
    try {
      const ws = await openWs(r.port, { headers: { Origin: 'https://relay.example' } });
      assert.equal(up.upgrades[up.upgrades.length - 1].headers.origin, 'https://relay.example');
      ws.destroy();
    } finally {
      await r.close();
    }
  });

  it('hands the Worker’s refusal to the client as it is (bad ticket → 403 with the Worker’s error)', async () => {
    const res = await openWs(relay.port, { path: '/api/realtime/ws?ticket=nope' });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).error.code, 'BAD_TICKET');
    assert.equal(res.headers['x-request-id'], 'req_ws_no');
    assert.equal(res.headers['set-cookie'], undefined);
  });

  it('when the client goes away the Worker side is closed too — no connection is left behind', async () => {
    const before = up.wsClosed.length;
    const a = await openWs(relay.port);
    a.send('x');
    await a.next();
    a.destroy(); // the client vanishes (a phone losing signal)
    await eventually(() => up.wsClosed.length > before);
  });

  it('when the Worker closes, the client is closed too', async () => {
    const b = await openWs(relay.port);
    b.send('y');
    await b.next();
    b.closeFromClient(); // Close frame + FIN: the fake Worker echoes the Close frame and hangs up
    await b.closed;
  });

  it('cuts off a peer that hangs up but never closes its side, after the grace period', async () => {
    const r = await startRelay(up.port, { WS_LINGER_MS: '300' });
    try {
      const before = up.wsClosed.length;
      const stubborn = await openWs(r.port, { path: '/api/realtime/ws?ticket=good&stubborn=1' });
      stubborn.send('z');
      await stubborn.next();
      stubborn.destroy();
      await eventually(() => up.wsClosed.length > before, 4000);
    } finally {
      await r.close();
    }
  });

  it('closes every open tunnel when the relay shuts down (it must not hang on them)', async () => {
    const r = await startRelay(up.port);
    const ws = await openWs(r.port);
    ws.send('still here');
    await ws.next();
    const t0 = Date.now();
    await r.close();
    assert.ok(Date.now() - t0 < 2000, `shutdown took ${Date.now() - t0} ms`);
    await ws.closed;
  });

  it('refuses an upgrade to anything but WebSocket, and says 502 when the Worker is unreachable', async () => {
    const res = await new Promise((resolve, reject) => {
      const socket = net.connect(relay.port, '127.0.0.1');
      let buf = '';
      socket.write('GET /x HTTP/1.1\r\nHost: r\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n');
      socket.on('data', (d) => (buf += d));
      socket.on('close', () => resolve(buf));
      socket.on('error', reject);
    });
    assert.match(res, /^HTTP\/1\.1 400 /);
    assert.match(res, /RELAY_BAD_REQUEST/);

    const dead = await startRelay(1);
    try {
      const refused = await openWs(dead.port);
      assert.equal(refused.status, 502);
      assert.equal(JSON.parse(refused.body).error.code, 'RELAY_UPSTREAM_UNREACHABLE');
    } finally {
      await dead.close();
    }
  });
});

/* ------------------------------------------------------------------------------------------------ command line */

describe('command line', () => {
  const script = new URL('./relay.mjs', import.meta.url).pathname;

  it('refuses to start with a bad configuration, lists every problem, and exits with code 2', () => {
    const run = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, PORT: 'abc' }, encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /cannot start/);
    assert.match(run.stderr, /UPSTREAM is required/);
    assert.match(run.stderr, /PORT must be/);
    assert.equal(run.stdout, '');
  });

  it('starts, relays, warns that signing is off, and stops cleanly on SIGTERM', async () => {
    const up = await startUpstream();
    const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, UPSTREAM: `http://127.0.0.1:${up.port}`, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    try {
      await eventually(() => /"relay":"listening"/.test(out), 5000);
      const started = JSON.parse(out.split('\n').find((l) => l.includes('listening')));
      assert.equal(started.upstream, `http://127.0.0.1:${up.port}`);
      assert.equal(started.signing, false);
      assert.match(err, /RELAY_SECRET is not set/);
      const r = await call(started.port, { path: '/api/health' });
      assert.equal(r.status, 200);
      await eventually(() => /"p":"\/api\/health"/.test(out)); // requests are logged ...
      const requestLines = out.split('\n').filter((l) => l.includes('"m":'));
      assert.ok(requestLines.length >= 1);
      for (const line of requestLines) assert.doesNotMatch(line, /\d+\.\d+\.\d+\.\d+|::1|"ip"|"addr"/, line); // ... without any address
      const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
      child.kill('SIGTERM');
      assert.deepEqual(await exited, { code: 0, signal: null });
    } finally {
      child.kill('SIGKILL');
      await up.close();
    }
  });

  it('never writes query strings (WebSocket tickets travel in them) to the log', async () => {
    const up = await startUpstream();
    const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, UPSTREAM: `http://127.0.0.1:${up.port}`, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    try {
      await eventually(() => /"relay":"listening"/.test(out), 5000);
      const { port } = JSON.parse(out.split('\n').find((l) => l.includes('listening')));
      await call(port, { path: '/api/health?ticket=SECRET-TICKET-VALUE' });
      const ws = await openWs(port, { path: '/api/realtime/ws?ticket=good' });
      ws.destroy();
      await eventually(() => out.includes('"ws":true'));
      assert.doesNotMatch(out, /SECRET-TICKET-VALUE|ticket=/);
    } finally {
      child.kill('SIGKILL');
      await up.close();
    }
  });
});

/* ------------------------------------------------------------------------------------------------ TLS */

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
describe('relay: serving TLS itself (no nginx/Caddy in front)', { skip: hasOpenssl ? false : 'openssl is not installed' }, () => {
  let dir;
  let up;
  let relay;
  let cert;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-tls-'));
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
    assert.equal(made.status, 0, String(made.stderr));
    cert = fs.readFileSync(path.join(dir, 'cert.pem'));
    up = await startUpstream();
    relay = await startRelay(up.port, { TLS_CERT_FILE: path.join(dir, 'cert.pem'), TLS_KEY_FILE: path.join(dir, 'key.pem') });
  });
  after(async () => {
    await relay.close();
    await up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers over https and forwards through to the Worker', async () => {
    const get = (p) =>
      new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', port: relay.port, path: p, ca: cert, servername: 'localhost', agent: false }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        }).on('error', reject);
      });
    const health = await get('/__relay/health');
    assert.equal(health.status, 200);
    const api = await get('/api/health');
    assert.equal(api.status, 200);
    assert.equal(api.headers['x-request-id'], 'req_upstream_1');
  });
});
