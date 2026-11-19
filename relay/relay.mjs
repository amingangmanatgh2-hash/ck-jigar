#!/usr/bin/env node
/**
 * AMIN CHAT relay — a small reverse proxy you can run on any server that people can reach, to carry AMIN CHAT traffic to your
 * Worker when the Worker's own address is blocked or throttled for them. It forwards EVERYTHING (the web app's files, the API,
 * the WebSocket), so opening the relay's address in a browser gives the whole app, and the apps can use it as an alternative
 * endpoint (see docs/connectivity.md).
 *
 * No dependencies: Node 20+ only. Configuration comes from environment variables (see parseConfig and relay/README.md).
 *
 * What it does, and deliberately does not do:
 *   • forwards HTTP and WebSocket upgrades to UPSTREAM, streaming both ways (nothing is buffered, nothing is cached);
 *   • sets Host to the upstream's, so the request reaches the right Worker;
 *   • tells the Worker who the real client is (X-Forwarded-For), signed with RELAY_SECRET, so the Worker's per-address rate limits
 *     apply to people instead of to the relay;
 *   • leaves Origin and every response header alone (X-Request-Id and the CORS headers are what the apps rely on), except that
 *     WebSocket upgrades get the upstream's Origin by default (they are authenticated by a one-time ticket, not by cookies);
 *   • drops what the client could forge (identity headers, cookies) and what describes a single connection (hop-by-hop headers);
 *   • is NOT an open proxy: it only ever talks to UPSTREAM, and refuses absolute-form requests and CONNECT;
 *   • logs no addresses and no query strings (tickets travel in them).
 *
 * A relay can read everything that passes through it except end-to-end encrypted chats. Only use a relay you run or trust.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const MiB = 1024 * 1024;

/** Headers that describe ONE connection (RFC 9110 §7.6.1) and must not be passed on. `expect` is answered by this server itself. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect']);

/** Who the client is and who relayed it: set by the relay alone, so whatever the client sent under these names is dropped. */
const IDENTITY = new Set(['x-relay-secret', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-server', 'forwarded', 'via', 'x-real-ip', 'x-client-ip', 'client-ip', 'true-client-ip']);

export class ConfigError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const truthy = (value, fallback) => (value === undefined || String(value).trim() === '' ? fallback : /^(1|true|yes|on)$/i.test(String(value).trim()));

const isLoopbackHost = (hostname) => hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname);

/** Reads and validates the environment. Throws ConfigError listing EVERY problem, so one run is enough to fix them all. */
export function parseConfig(env = process.env) {
  const problems = [];

  let upstream = null;
  const raw = String(env.UPSTREAM ?? '').trim();
  if (!raw) problems.push('UPSTREAM is required: the address of your AMIN CHAT Worker, for example https://amin-chat.example.workers.dev');
  else {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') problems.push('UPSTREAM must start with https://');
      else if (u.username || u.password) problems.push('UPSTREAM must not contain a user name or password');
      else if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) problems.push('UPSTREAM must be just an address (scheme, host and optional port), without a path');
      else if (u.protocol === 'http:' && !isLoopbackHost(u.hostname) && !truthy(env.ALLOW_INSECURE_UPSTREAM, false)) {
        problems.push('UPSTREAM uses plain http, which would send tokens and the relay secret unencrypted. Use https://, or set ALLOW_INSECURE_UPSTREAM=1 if the link is a private network');
      } else upstream = u;
    } catch {
      problems.push(`UPSTREAM is not a valid address: ${raw}`);
    }
  }

  const integer = (name, fallback, min, max, unit = '') => {
    const text = env[name];
    if (text === undefined || String(text).trim() === '') return fallback;
    const n = Number(text);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be a whole number between ${min} and ${max}${unit}`);
      return fallback;
    }
    return n;
  };

  const port = integer('PORT', 8080, 0, 65535);
  const maxBodyMb = integer('MAX_BODY_MB', 64, 1, 2048, ' (megabytes)');
  const connectTimeoutMs = integer('CONNECT_TIMEOUT_MS', 10_000, 100, 120_000, ' (milliseconds)');
  const idleTimeoutMs = integer('UPSTREAM_IDLE_TIMEOUT_MS', 120_000, 1000, 900_000, ' (milliseconds)');
  const lingerMs = integer('WS_LINGER_MS', 10_000, 50, 600_000, ' (milliseconds)');

  const cert = String(env.TLS_CERT_FILE ?? '').trim();
  const key = String(env.TLS_KEY_FILE ?? '').trim();
  if (Boolean(cert) !== Boolean(key)) problems.push('TLS_CERT_FILE and TLS_KEY_FILE must be set together');
  else if (cert) {
    for (const [name, file] of [['TLS_CERT_FILE', cert], ['TLS_KEY_FILE', key]]) if (!fs.existsSync(file)) problems.push(`${name}: file not found: ${file}`);
  }

  const secret = String(env.RELAY_SECRET ?? '');
  if (secret && secret.length < 16) problems.push('RELAY_SECRET is too short: use at least 16 random characters (it is the key that makes the Worker believe the client addresses this relay reports)');

  if (problems.length) throw new ConfigError(problems);
  return {
    upstream,
    host: String(env.HOST ?? '').trim() || '0.0.0.0',
    port,
    secret,
    trustProxy: truthy(env.TRUST_PROXY, false),
    rewriteWsOrigin: truthy(env.REWRITE_WS_ORIGIN, true),
    maxBodyBytes: maxBodyMb * MiB,
    connectTimeoutMs,
    idleTimeoutMs,
    lingerMs,
    tls: cert ? { cert, key } : null,
    log: truthy(env.LOG, true),
  };
}

/* ------------------------------------------------------------------------------------------------ small helpers */

const isOriginForm = (url) => typeof url === 'string' && url.startsWith('/');

/** `::ffff:1.2.3.4` → `1.2.3.4`; anything that is not an IP address → ''. */
export function normalizeIp(value) {
  let v = String(value ?? '').trim();
  if (v.startsWith('[') && v.includes(']')) v = v.slice(1, v.indexOf(']'));
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(':'));
  v = v.replace(/%.*$/, '');
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(v)) v = v.slice(7);
  return net.isIP(v) ? v : '';
}

/**
 * The address of the person on the other end. Behind a reverse proxy you run yourself (nginx, Caddy; TRUST_PROXY=1) that is the
 * right-most X-Forwarded-For entry — the one THAT proxy appended; entries further left are whatever the client claimed.
 * Otherwise it is simply the peer of the connection, and X-Forwarded-For is ignored because anybody can send it.
 */
export function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const entries = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const last = entries.length ? normalizeIp(entries[entries.length - 1]) : '';
    if (last) return last;
  }
  return normalizeIp(req.socket.remoteAddress);
}

/** The request headers to send upstream. */
export function upstreamRequestHeaders(req, cfg, ip, { upgrade = false } = {}) {
  const named = new Set(String(req.headers.connection ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (name === 'host' || name === 'cookie' || name.startsWith('cf-') || IDENTITY.has(name) || HOP_BY_HOP.has(name) || named.has(name)) continue;
    out[name] = value;
  }
  out.host = cfg.upstream.host;
  if (ip) out['x-forwarded-for'] = ip;
  if (cfg.secret) out['x-relay-secret'] = cfg.secret;
  if (upgrade) {
    out.connection = 'Upgrade';
    out.upgrade = 'websocket';
    if (cfg.rewriteWsOrigin && out.origin) out.origin = cfg.upstream.origin;
  }
  return out;
}

/** The response headers to send back, as a flat [name, value, …] list that keeps duplicates and the upstream's spelling. */
export function clientResponseHeaders(rawHeaders, { upgrade = false } = {}) {
  const named = new Set();
  for (let i = 0; i < rawHeaders.length; i += 2) if (String(rawHeaders[i]).toLowerCase() === 'connection') for (const t of String(rawHeaders[i + 1]).toLowerCase().split(',')) named.add(t.trim());
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const lower = String(rawHeaders[i]).toLowerCase();
    if (lower === 'set-cookie' || lower.startsWith('x-relay-')) continue; // the app does not use cookies; never let one be set for the relay's domain
    if (!upgrade && (HOP_BY_HOP.has(lower) || named.has(lower))) continue;
    out.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  return out;
}

const JSON_ERROR = (code, message) => JSON.stringify({ error: { code, message } });

/** An answer the relay itself gives. It has no X-Request-Id on purpose: that header means "the Worker answered". */
function sendError(res, status, code, message, { close = false } = {}) {
  if (res.headersSent) return void res.destroy();
  const body = JSON_ERROR(code, message);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(close ? { Connection: 'close' } : {}),
  });
  res.end(body);
}

const STATUS_TEXT = { 400: 'Bad Request', 405: 'Method Not Allowed', 413: 'Content Too Large', 502: 'Bad Gateway', 504: 'Gateway Timeout' };

/** The same for a connection that was handed over for an upgrade (raw socket: the HTTP text is written by hand). */
function rawError(socket, status, code, message) {
  const body = JSON_ERROR(code, message);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${body}`,
  );
}

/* ------------------------------------------------------------------------------------------------ the relay */

export function createRelay(cfg) {
  const secure = cfg.upstream.protocol === 'https:';
  const client = secure ? https : http;
  const agent = new client.Agent({ keepAlive: true, maxSockets: 512, maxFreeSockets: 32, timeout: 30_000 });
  const upstreamPort = Number(cfg.upstream.port) || (secure ? 443 : 80);
  const upstreamHost = cfg.upstream.hostname.replace(/^\[|\]$/g, '');
  /** Live WebSocket tunnels. The HTTP server forgets a connection once it was upgraded, so they are tracked here (for shutdown). */
  const tunnels = new Set();
  const log = (entry) => {
    if (cfg.log) process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
  };

  const baseOptions = (req, headers, extra = {}) => ({
    host: upstreamHost,
    port: upstreamPort,
    method: req.method,
    path: req.url,
    headers,
    servername: net.isIP(upstreamHost) ? undefined : upstreamHost,
    timeout: cfg.idleTimeoutMs,
    ...extra,
  });

  /** Fails the request if the connection is not established in time (a black-holed route would otherwise just hang). */
  function guardConnect(upReq) {
    const timer = setTimeout(() => upReq.destroy(Object.assign(new Error('connect timeout'), { code: 'RELAY_CONNECT_TIMEOUT' })), cfg.connectTimeoutMs);
    upReq.on('socket', (socket) => {
      if (upReq.reusedSocket) clearTimeout(timer);
      else socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(timer));
    });
    upReq.on('close', () => clearTimeout(timer));
    upReq.on('timeout', () => upReq.destroy(Object.assign(new Error('upstream timeout'), { code: 'RELAY_UPSTREAM_TIMEOUT' })));
  }

  const failureOf = (err) => (err?.code === 'RELAY_UPSTREAM_TIMEOUT' || err?.code === 'RELAY_CONNECT_TIMEOUT' ? [504, 'RELAY_UPSTREAM_TIMEOUT', 'The server did not answer in time'] : [502, 'RELAY_UPSTREAM_UNREACHABLE', 'The server could not be reached from the relay']);

  function onRequest(req, res) {
    const started = Date.now();
    if (!isOriginForm(req.url)) return sendError(res, 400, 'RELAY_BAD_REQUEST', 'Only plain paths are relayed', { close: true });

    const path = req.url.split('?')[0];
    if (path === '/__relay/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return void res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, relay: true }));
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > cfg.maxBodyBytes) {
      req.resume();
      return sendError(res, 413, 'RELAY_BODY_TOO_LARGE', 'The request is larger than this relay accepts', { close: true });
    }

    const upReq = client.request(baseOptions(req, upstreamRequestHeaders(req, cfg, clientAddress(req, cfg.trustProxy)), { agent }));
    guardConnect(upReq);

    let seen = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      seen += chunk.length;
      if (seen > cfg.maxBodyBytes && !tooLarge) {
        tooLarge = true;
        req.unpipe(upReq);
        upReq.destroy();
        sendError(res, 413, 'RELAY_BODY_TOO_LARGE', 'The request is larger than this relay accepts', { close: true });
        req.resume();
      }
    });
    req.on('error', () => upReq.destroy());
    res.on('close', () => {
      if (!res.writableEnded) upReq.destroy(); // the client went away: stop the upstream request too
    });

    upReq.on('response', (up) => {
      res.writeHead(up.statusCode, up.statusMessage, clientResponseHeaders(up.rawHeaders));
      up.on('error', () => res.destroy());
      up.on('aborted', () => res.destroy()); // an incomplete answer must look incomplete, not like a short one
      up.pipe(res);
      up.on('end', () => log({ m: req.method, p: path, s: up.statusCode, ms: Date.now() - started }));
    });
    upReq.on('error', (err) => {
      if (tooLarge) return;
      const [status, code, message] = failureOf(err);
      log({ m: req.method, p: path, s: status, ms: Date.now() - started, err: err?.code ?? 'ERR' });
      sendError(res, status, code, message);
    });
    req.pipe(upReq);
  }

  function onUpgrade(req, socket, head) {
    const started = Date.now();
    const path = isOriginForm(req.url) ? req.url.split('?')[0] : '';
    if (!path || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return rawError(socket, 400, 'RELAY_BAD_REQUEST', 'Only WebSocket upgrades are relayed');

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.on('error', () => socket.destroy());

    const upReq = client.request(baseOptions(req, upstreamRequestHeaders(req, cfg, clientAddress(req, cfg.trustProxy), { upgrade: true }), { agent: false }));
    guardConnect(upReq);

    upReq.on('upgrade', (up, upSocket, upHead) => {
      if (socket.destroyed) return void upSocket.destroy(); // the client left while the handshake was under way
      upSocket.setNoDelay(true);
      upSocket.setKeepAlive(true, 30_000);
      upSocket.setTimeout(0); // a chat connection is idle most of the time
      let lines = `HTTP/1.1 101 ${up.statusMessage || 'Switching Protocols'}\r\n`;
      const headers = clientResponseHeaders(up.rawHeaders, { upgrade: true });
      for (let i = 0; i < headers.length; i += 2) lines += `${headers[i]}: ${headers[i + 1]}\r\n`;
      socket.write(`${lines}\r\n`);
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);

      // Node's HTTP sockets tolerate half-closed connections, so a side that hangs up (FIN) would otherwise leave the pair open for
      // ever: pipe() passes the FIN on, and nobody emits 'close'. A properly behaved peer closes in answer; one that does not is cut
      // off after a short grace period, so a phone that lost its signal can never leak an upstream connection.
      const tunnel = { socket, upSocket };
      tunnels.add(tunnel);
      let linger = null;
      const closeBoth = () => {
        clearTimeout(linger);
        tunnels.delete(tunnel);
        socket.destroy();
        upSocket.destroy();
      };
      const finished = () => {
        linger ??= setTimeout(closeBoth, cfg.lingerMs);
        linger.unref?.();
      };
      socket.on('end', finished);
      upSocket.on('end', finished);
      socket.on('close', closeBoth);
      upSocket.on('close', closeBoth);
      upSocket.on('error', closeBoth);
      log({ ws: true, p: path, s: 101, ms: Date.now() - started });
    });

    // The Worker answered with an ordinary response instead of upgrading (bad ticket, origin not allowed …): hand it to the client as is.
    upReq.on('response', (up) => {
      let lines = `HTTP/1.1 ${up.statusCode} ${up.statusMessage || ''}\r\n`;
      const headers = clientResponseHeaders(up.rawHeaders);
      for (let i = 0; i < headers.length; i += 2) lines += `${headers[i]}: ${headers[i + 1]}\r\n`;
      socket.write(`${lines}Connection: close\r\n\r\n`);
      up.pipe(socket);
      log({ ws: true, p: path, s: up.statusCode, ms: Date.now() - started });
    });
    upReq.on('error', (err) => {
      const [status, code, message] = failureOf(err);
      log({ ws: true, p: path, s: status, ms: Date.now() - started, err: err?.code ?? 'ERR' });
      rawError(socket, status, code, message);
    });
    socket.on('close', () => upReq.destroy());
    upReq.end();
  }

  const handler = onRequest;
  const server = cfg.tls
    ? https.createServer({ cert: fs.readFileSync(cfg.tls.cert), key: fs.readFileSync(cfg.tls.key) }, handler)
    : http.createServer(handler);
  server.on('upgrade', onUpgrade);
  server.on('connect', (_req, socket) => rawError(socket, 405, 'RELAY_BAD_REQUEST', 'This relay is not a general proxy'));
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  server.requestTimeout = 15 * 60_000; // slow uploads over a throttled link must be able to finish
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  return {
    server,
    agent,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => resolve(server.address()));
      }),
    /** Stops accepting connections; WebSocket tunnels end now (the apps reconnect), requests in flight get 5 s to finish. */
    close: () =>
      new Promise((resolve) => {
        agent.destroy();
        server.close(() => resolve());
        server.closeIdleConnections?.();
        for (const { socket, upSocket } of tunnels) {
          socket.destroy();
          upSocket.destroy();
        }
        setTimeout(() => server.closeAllConnections?.(), 5000).unref();
      }),
  };
}

/* ------------------------------------------------------------------------------------------------ command line */

async function main() {
  let cfg;
  try {
    cfg = parseConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`amin-chat relay: cannot start\n${err.problems.map((p) => `  - ${p}`).join('\n')}\n\nSee relay/README.md\n`);
    process.exit(2);
  }
  const relay = createRelay(cfg);
  const address = await relay.listen();
  process.stdout.write(
    `${JSON.stringify({ t: new Date().toISOString(), relay: 'listening', port: address.port, upstream: cfg.upstream.origin, tls: Boolean(cfg.tls), signing: Boolean(cfg.secret), trustProxy: cfg.trustProxy })}\n`,
  );
  if (!cfg.secret) process.stderr.write('note: RELAY_SECRET is not set, so the Worker will see every user as coming from this relay\'s address (shared rate limits). See relay/README.md\n');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void relay.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
