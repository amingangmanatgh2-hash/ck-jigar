/**
 * ZEUS LITE — a VLESS config panel that runs entirely on Cloudflare Workers + D1.
 *
 *   /                     the admin panel (single page)
 *   /api/auth             POST {password} → session cookie
 *   /api/users            the users (admin)
 *   /api/settings         panel settings (admin)
 *   /sub/:token           the subscription document (base64 of vless:// links)
 *   /status/:token        a small page for the user: traffic, expiry, links
 *   <ws path>             the VLESS-over-WebSocket endpoint
 *
 * Nothing here keeps the admin password: only its hash is compared, and the cookie is signed with it, so
 * changing the password logs every browser out.
 */

import {
  UUID_PATTERN,
  buildSubscription,
  buildVlessLink,
  buildXrayConfig,
  buildSingBoxConfig,
  base64UrlEncode,
  cleanRemark,
  hmacHex,
  newToken,
  newUuid,
  randomBytes,
  sameSecret,
  sha256Hex,
  splitCleanIps,
  normalizeHost,
  normalizePath,
  parseLink,
} from './links.js';
import { adminPage, statusPage } from './ui.js';
import { handleVless } from './vless.js';

const SESSION_COOKIE = 'zeus_session';
const SESSION_TTL_SECONDS = 7 * 24 * 3600;
/** The password every new deployment starts with, until it is changed in the panel. */
const DEFAULT_PASSWORD = 'amin_ck';
const PASSWORD_KEY = 'admin_password_hash';

/* ------------------------------------------------------------------ small helpers */

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(init.headers ?? {}) },
  });

const text = (body, init = {}) =>
  new Response(body, {
    ...init,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...(init.headers ?? {}) },
  });

const problem = (status, message) => json({ error: message }, { status });

function cookieHeader(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** A tiny per-isolate rate limiter for the login (Cloudflare's own rate limiting is a paid feature). */
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) ?? { count: 0, first: now };
  if (now - entry.first > 10 * 60_000) {
    attempts.set(ip, { count: 1, first: now });
    return false;
  }
  entry.count += 1;
  attempts.set(ip, entry);
  if (attempts.size > 5000) attempts.clear();
  return entry.count > 12;
}

/* ------------------------------------------------------------------ settings */

const DEFAULT_SETTINGS = {
  /** The address clients dial. Empty = the host of the request that asked for the panel. */
  host: '',
  /** The port in the link (Cloudflare listens on 443 and 80 through the CDN). */
  port: 443,
  /** The WebSocket path; must match what the Worker accepts. */
  path: '/ws',
  /** Added in front of every user's name in a link. */
  remarkPrefix: 'ZEUS',
  /** Extra addresses to build one link for each (clean IPs, so a censored host name is never dialled). */
  cleanIps: '',
  /** Xray's fragment parameter, e.g. "1,40-100" — helps against some deep-packet filters. Empty = off. */
  fragment: '',
  /** ECH config list (base64), for Cloudflare's Encrypted Client Hello. Empty = off. */
  ech: '',
  /** uTLS fingerprint. */
  fingerprint: 'chrome',
  /** ALPN list. */
  alpn: 'h2,http/1.1',
  /** Panel title shown in the browser and on the status page. */
  title: 'ZEUS LITE',
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

export async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows.results ?? []) {
    if (!SETTING_KEYS.includes(row.key)) continue;
    if (row.key === 'port') out.port = Number(row.value) || 443;
    else out[row.key] = row.value;
  }
  return out;
}

export async function saveSettings(env, patch) {
  const current = await getSettings(env);
  const next = { ...current };
  for (const key of SETTING_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (key === 'port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535');
      next.port = port;
    } else if (key === 'path') {
      next.path = normalizePath(value);
    } else if (key === 'host') {
      const host = normalizeHost(value);
      if (String(value ?? '').trim() && !host) throw new Error('host is not a valid address');
      next.host = host;
    } else {
      next[key] = String(value ?? '').slice(0, key === 'ech' ? 512 : 128);
    }
  }
  const statements = SETTING_KEYS.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k])).map((k) =>
    env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(k, String(next[k])),
  );
  if (statements.length > 0) await env.DB.batch(statements);
  return next;
}

/* ------------------------------------------------------------------ users */

const USER_COLUMNS = 'id, name, uuid, token, enabled, expires_at, traffic_limit, traffic_used, created_at';

export async function listUsers(env, query = '') {
  const q = String(query ?? '').trim();
  const rows = q
    ? await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE name LIKE ? ORDER BY id DESC LIMIT 500`).bind(`%${q}%`).all()
    : await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY id DESC LIMIT 500`).all();
  return rows.results ?? [];
}

export async function createUser(env, { name, expiresAt = null, trafficLimit = 0 }) {
  const clean = cleanRemark(name).slice(0, 40);
  if (!clean) throw new Error('a name is required');
  const uuid = newUuid();
  const token = newToken();
  const now = Date.now();
  const result = await env.DB.prepare(
    'INSERT INTO users (name, uuid, token, enabled, expires_at, traffic_limit, traffic_used, created_at) VALUES (?, ?, ?, 1, ?, ?, 0, ?)',
  )
    .bind(clean, uuid, token, expiresAt, Math.max(0, Number(trafficLimit) || 0), now)
    .run();
  return env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(result.meta.last_row_id).first();
}

export async function updateUser(env, id, patch) {
  const row = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first();
  if (!row) return null;
  const next = {
    name: patch.name !== undefined ? cleanRemark(patch.name).slice(0, 40) : row.name,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled,
    expires_at: patch.expiresAt !== undefined ? (patch.expiresAt === null ? null : Number(patch.expiresAt)) : row.expires_at,
    traffic_limit: patch.trafficLimit !== undefined ? Math.max(0, Number(patch.trafficLimit) || 0) : row.traffic_limit,
    traffic_used: patch.resetTraffic ? 0 : row.traffic_used,
  };
  await env.DB.prepare('UPDATE users SET name = ?, enabled = ?, expires_at = ?, traffic_limit = ?, traffic_used = ? WHERE id = ?')
    .bind(next.name || row.name, next.enabled, next.expires_at, next.traffic_limit, next.traffic_used, id)
    .run();
  return env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first();
}

export const deleteUser = (env, id) => env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();

/**
 * Is this UUID allowed to connect right now? Cached for 30 seconds per isolate: with a WebSocket per client a
 * D1 read per connection would be the busiest query of the whole service.
 */
const uuidCache = new Map();
export async function uuidAllowed(env, uuid) {
  if (!UUID_PATTERN.test(uuid)) return null;
  const now = Date.now();
  const hit = uuidCache.get(uuid);
  if (hit && hit.until > now) return hit.allowed ? hit.user : null;
  const row = await env.DB.prepare('SELECT id, uuid, enabled, expires_at, traffic_limit, traffic_used FROM users WHERE uuid = ?').bind(uuid).first();
  const allowed = !!row && row.enabled === 1 && (!row.expires_at || row.expires_at > now) && (!row.traffic_limit || row.traffic_used < row.traffic_limit);
  if (uuidCache.size > 2000) uuidCache.delete(uuidCache.keys().next().value);
  uuidCache.set(uuid, { allowed, user: row, until: now + 30_000 });
  return allowed ? row : null;
}

export async function addTraffic(env, uuid, bytes) {
  if (!bytes || bytes <= 0) return;
  await env.DB.prepare('UPDATE users SET traffic_used = traffic_used + ? WHERE uuid = ?').bind(Math.round(bytes), uuid).run();
}

/* ------------------------------------------------------------------ links for a user */

/** The links of one user: one per clean IP (or the panel host), for the panel, the subscription and the status page. */
export function linksFor(user, settings, hostHeader) {
  const host = normalizeHost(settings.host) || normalizeHost(hostHeader);
  const base = {
    uuid: user.uuid,
    host,
    port: settings.port,
    path: settings.path,
    security: settings.port === 80 ? 'none' : 'tls',
    fingerprint: settings.fingerprint,
    alpn: settings.alpn,
    fragment: settings.fragment,
    ech: settings.ech,
    remark: `${settings.remarkPrefix ? `${settings.remarkPrefix} ` : ''}${user.name}`,
  };
  const addresses = splitCleanIps(settings.cleanIps);
  if (addresses.length === 0) return [{ address: host, link: buildVlessLink(base) }];
  return addresses.map((address) => ({
    address,
    link: buildVlessLink({ ...base, address, remark: `${base.remark} ${address}`.slice(0, 60) }),
  }));
}

/* ------------------------------------------------------------------ auth */

/**
 * What the panel compares a password against, and signs sessions with.
 *
 * Order: the `ADMIN_PASSWORD` secret (set with `wrangler secret put`), then the hash stored in D1 when the
 * password was changed in the panel, then the built-in default. Only hashes are compared and only hashes are
 * stored, so the panel never holds a plain password after the request that set it.
 */
async function authMaterial(env) {
  if (env.ADMIN_PASSWORD) return { secret: `secret:${await sha256Hex(String(env.ADMIN_PASSWORD))}`, isDefault: false };
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(PASSWORD_KEY).first();
  if (row?.value) return { secret: `stored:${row.value}`, isDefault: false };
  return { secret: `default:${await sha256Hex(DEFAULT_PASSWORD)}`, isDefault: true };
}

async function passwordMatches(env, password) {
  const material = await authMaterial(env);
  const hash = await sha256Hex(String(password ?? ''));
  return { ok: sameSecret(hash, material.secret.slice(material.secret.indexOf(':') + 1)), isDefault: material.isDefault };
}

async function makeSession(env) {
  const material = await authMaterial(env);
  const payload = base64UrlEncode(randomBytes(9));
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const sig = await hmacHex(material.secret, `${payload}.${expires}`);
  return `${payload}.${expires}.${sig}`;
}

async function checkSession(env, request) {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return false;
  const [payload, expires, sig] = raw.split('.');
  if (!payload || !expires || !sig) return false;
  if (Number(expires) < Math.floor(Date.now() / 1000)) return false;
  const material = await authMaterial(env);
  const expected = await hmacHex(material.secret, `${payload}.${expires}`);
  return sameSecret(sig, expected);
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/* ------------------------------------------------------------------ routes */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const clientHost = url.hostname;

    // WebSocket upgrade → VLESS
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return handleUpgrade(request, env);
    }

    if (path === '/' || path === '/index.html') {
      if (await checkSession(env, request)) return html(adminPage({ title: (await getSettings(env)).title }));
      return html(adminPage({ title: 'ZEUS LITE' }));
    }

    if (path === '/api/auth' && request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (tooManyAttempts(ip)) return problem(429, 'too many attempts, wait a few minutes');
      const body = await readJson(request);
      const result = await passwordMatches(env, body?.password);
      if (!result.ok) return problem(401, 'wrong password');
      const session = await makeSession(env);
      return json({ ok: true }, { headers: { 'Set-Cookie': cookieHeader(SESSION_COOKIE, session, SESSION_TTL_SECONDS) } });
    }

    if (path === '/api/logout' && request.method === 'POST') {
      return json({ ok: true }, { headers: { 'Set-Cookie': cookieHeader(SESSION_COOKIE, '', 0) } });
    }

    // Public: subscription and status page
    const sub = /^\/sub\/([A-Za-z0-9_-]{16,64})$/.exec(path);
    if (sub) {
      const user = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE token = ?`).bind(sub[1]).first();
      if (!user) return text('not found', { status: 404 });
      const settings = await getSettings(env);
      const links = linksFor(user, settings, clientHost);
      const body = buildSubscription(links.map((l) => l.link), { base64: url.searchParams.get('raw') !== '1' });
      return text(body, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          // clients show this in their list
          'Profile-Title': encodeURIComponent(`${settings.remarkPrefix} ${user.name}`.trim()),
          'Subscription-Userinfo': `upload=0; download=${user.traffic_used}; total=${user.traffic_limit || 0}; expire=${user.expires_at ? Math.floor(user.expires_at / 1000) : 0}`,
        },
      });
    }

    const status = /^\/status\/([A-Za-z0-9_-]{16,64})$/.exec(path);
    if (status) {
      const user = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE token = ?`).bind(status[1]).first();
      if (!user) return html(statusPage({ missing: true, title: 'ZEUS LITE' }), 404);
      const settings = await getSettings(env);
      const subUrl = `${url.origin}/sub/${user.token}`;
      return html(
        statusPage({
          title: settings.title,
          user,
          links: linksFor(user, settings, clientHost).map((l) => l.link),
          subUrl,
        }),
      );
    }

    // Everything below is the admin API
    if (path.startsWith('/api/')) {
      if (!(await checkSession(env, request))) return problem(401, 'sign in first');
      return adminApi(request, env, url, clientHost);
    }

    return new Response('Not found', { status: 404 });
  },
};

async function adminApi(request, env, url, clientHost) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/me') return json({ ok: true });

  if (path === '/api/password' && method === 'POST') {
    const body = await readJson(request);
    if (!body?.current || !body?.next) return problem(400, 'current and next are required');
    if (String(body.next).length < 6) return problem(400, 'the new password must be at least 6 characters');
    if (!(await passwordMatches(env, body.current)).ok) return problem(401, 'the current password is wrong');
    const hash = await sha256Hex(String(body.next));
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .bind(PASSWORD_KEY, hash)
      .run();
    // the old session cannot stay valid: it was signed with the old password
    return json({ ok: true, needsSignIn: true }, { headers: { 'Set-Cookie': cookieHeader(SESSION_COOKIE, '', 0) } });
  }

  if (path === '/api/overview') {
    const [users, traffic, settings] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS active FROM users').first(),
      env.DB.prepare('SELECT COALESCE(SUM(traffic_used), 0) AS bytes FROM users').first(),
      getSettings(env),
    ]);
    const auth = await authMaterial(env);
    return json({
      users: users?.total ?? 0,
      active: users?.active ?? 0,
      traffic: traffic?.bytes ?? 0,
      host: normalizeHost(settings.host) || clientHost,
      usingDefaultPassword: auth.isDefault,
      hasSecret: !!env.ADMIN_PASSWORD,
    });
  }

  if (path === '/api/users' && method === 'GET') {
    return json({ users: await listUsers(env, url.searchParams.get('q') ?? '') });
  }

  if (path === '/api/users' && method === 'POST') {
    const body = await readJson(request);
    if (!body?.name) return problem(400, 'a name is required');
    const user = await createUser(env, { name: body.name, expiresAt: body.expiresAt ?? null, trafficLimit: body.trafficLimit ?? 0 });
    return json({ user }, { status: 201 });
  }

  const one = /^\/api\/users\/(\d+)$/.exec(path);
  if (one) {
    const id = Number(one[1]);
    if (method === 'PATCH') {
      const user = await updateUser(env, id, (await readJson(request)) ?? {});
      return user ? json({ user }) : problem(404, 'no such user');
    }
    if (method === 'DELETE') {
      await deleteUser(env, id);
      return json({ ok: true });
    }
    if (method === 'GET') {
      const user = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first();
      if (!user) return problem(404, 'no such user');
      const settings = await getSettings(env);
      const links = linksFor(user, settings, clientHost);
      return json({ user, links: links.map((l) => l.link), subUrl: `${url.origin}/sub/${user.token}` });
    }
  }

  if (path === '/api/settings' && method === 'GET') {
    return json({ settings: await getSettings(env), defaults: DEFAULT_SETTINGS });
  }

  if (path === '/api/settings' && method === 'PUT') {
    try {
      return json({ settings: await saveSettings(env, (await readJson(request)) ?? {}) });
    } catch (err) {
      return problem(400, String(err?.message ?? err));
    }
  }

  /** The client configs for one user, for copying into any app. */
  if (path === '/api/configs' && method === 'GET') {
    const id = Number(url.searchParams.get('user'));
    const user = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first();
    if (!user) return problem(404, 'no such user');
    const settings = await getSettings(env);
    const link = linksFor(user, settings, clientHost)[0].link;
    const parsed = parseLink(link);
    if (!parsed) return problem(500, 'could not read back the link');
    return json({ link, xray: buildXrayConfig(parsed), singbox: buildSingBoxConfig(parsed) });
  }

  return problem(404, 'unknown endpoint');
}

/* ------------------------------------------------------------------ websocket + helpers */

function handleUpgrade(request, env) {
  // workerd always has this; the Node test runner does not, and a plain 426 is a truthful answer there.
  if (typeof WebSocketPair === 'undefined') return text('this endpoint needs a WebSocket-capable runtime', { status: 426 });
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  const ok = handleVless(
    server,
    async (uuid) => !!(await uuidAllowed(env, uuid)),
    (uuid, bytes) => addTraffic(env, uuid, bytes),
  ).catch(() => {
    try {
      server.close(1011);
    } catch {
      /* already gone */
    }
  });
  void ok;
  return new Response(null, { status: 101, webSocket: client });
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
    },
  });
}
