/**
 * The panel's HTTP surface, against a real SQLite database (node:sqlite) behind a small D1-shaped adapter.
 * This is what the Worker sees at runtime, minus Cloudflare itself.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { before, test } from 'node:test';

import worker, { addTraffic, getSettings, saveSettings } from '../src/index.js';

const MIGRATION = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params.map((p) => (p === undefined ? null : p)));
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params), success: true };
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  }
}

class Database {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(MIGRATION);
  }
  prepare(sql) {
    return new Statement(this.db, sql);
  }
  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

const env = {};
let cookie = '';

const call = (path, init = {}) => worker.fetch(new Request(`https://panel.example.com${path}`, init), env);

before(() => {
  env.DB = new Database();
});

test('the panel page loads without a session', async () => {
  const res = await call('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  const body = await res.text();
  assert.match(body, /ZEUS LITE/);
  // no external resource: the page must work where a CDN is blocked
  assert.doesNotMatch(body, /<script[^>]+src=/);
  assert.doesNotMatch(body, /<link[^>]+href=/);
});

test('the API is closed without a session', async () => {
  for (const [path, init] of [
    ['/api/users', {}],
    ['/api/settings', {}],
    ['/api/overview', {}],
    ['/api/users', { method: 'POST', body: JSON.stringify({ name: 'x' }) }],
  ]) {
    const res = await call(path, init);
    assert.equal(res.status, 401, path);
  }
});

test('a wrong password is refused and the right one sets a cookie', async () => {
  const wrong = await call('/api/auth', { method: 'POST', body: JSON.stringify({ password: 'nope' }) });
  assert.equal(wrong.status, 401);

  const ok = await call('/api/auth', { method: 'POST', body: JSON.stringify({ password: 'amin_ck' }) });
  assert.equal(ok.status, 200);
  const set = ok.headers.get('Set-Cookie');
  assert.match(set, /zeus_session=/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  cookie = set.split(';')[0];

  const me = await call('/api/me', { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
});

test('a tampered cookie is refused', async () => {
  const [name, value] = cookie.split('=');
  const parts = value.split('.');
  parts[2] = parts[2].replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
  const res = await worker.fetch(new Request('https://panel.example.com/api/me', { headers: { Cookie: `${name}=${parts.join('.')}` } }), env);
  assert.equal(res.status, 401);
});

test('a user can be created, listed, edited and deleted', async () => {
  const created = await call('/api/users', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ name: 'ali', expiresAt: Date.now() + 86400000, trafficLimit: 10 * 1024 ** 3 }),
  });
  assert.equal(created.status, 201);
  const { user } = await created.json();
  assert.equal(user.name, 'ali');
  assert.match(user.uuid, /^[0-9a-f-]{36}$/);
  assert.match(user.token, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(user.traffic_used, 0);

  const list = await (await call('/api/users', { headers: { Cookie: cookie } })).json();
  assert.equal(list.users.length, 1);

  const search = await (await call('/api/users?q=al', { headers: { Cookie: cookie } })).json();
  assert.equal(search.users.length, 1);
  const miss = await (await call('/api/users?q=zz', { headers: { Cookie: cookie } })).json();
  assert.equal(miss.users.length, 0);

  const patched = await (await call(`/api/users/${user.id}`, {
    method: 'PATCH',
    headers: { Cookie: cookie },
    body: JSON.stringify({ enabled: false }),
  })).json();
  assert.equal(patched.user.enabled, 0);

  await call(`/api/users/${user.id}`, { method: 'PATCH', headers: { Cookie: cookie }, body: JSON.stringify({ enabled: true }) });

  const detail = await (await call(`/api/users/${user.id}`, { headers: { Cookie: cookie } })).json();
  assert.equal(detail.links.length, 1);
  assert.match(detail.links[0], /^vless:\/\//);
  assert.match(detail.links[0], /@panel\.example\.com:443\?/);
  assert.equal(detail.subUrl, `https://panel.example.com/sub/${user.token}`);

  const removed = await call(`/api/users/${user.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(removed.status, 200);
  const after = await (await call('/api/users', { headers: { Cookie: cookie } })).json();
  assert.equal(after.users.length, 0);
});

test('settings change what the links say, and clean IPs multiply them', async () => {
  const created = await (await call('/api/users', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ name: 'sara' }),
  })).json();

  const saved = await call('/api/settings', {
    method: 'PUT',
    headers: { Cookie: cookie },
    body: JSON.stringify({
      host: 'https://zeus.example.net:8443/',
      path: 'tunnel',
      port: 443,
      remarkPrefix: 'Z',
      cleanIps: '104.16.1.1\n104.17.2.2',
      fingerprint: 'firefox',
      alpn: 'h2',
      fragment: '1,40-100',
    }),
  });
  assert.equal(saved.status, 200);
  const settings = (await saved.json()).settings;
  assert.equal(settings.host, 'zeus.example.net');
  assert.equal(settings.path, '/tunnel');

  const detail = await (await call(`/api/users/${created.user.id}`, { headers: { Cookie: cookie } })).json();
  assert.equal(detail.links.length, 2);
  assert.ok(detail.links[0].includes('@104.16.1.1:443'));
  assert.ok(detail.links[1].includes('@104.17.2.2:443'));
  const url = new URL(detail.links[0]);
  assert.equal(url.searchParams.get('host'), 'zeus.example.net');
  assert.equal(url.searchParams.get('path'), '/tunnel');
  assert.equal(url.searchParams.get('fp'), 'firefox');
  assert.equal(url.searchParams.get('alpn'), 'h2');
  assert.equal(url.searchParams.get('fragment'), '1,40-100');

  // a bad port is refused, not saved
  const bad = await call('/api/settings', {
    method: 'PUT',
    headers: { Cookie: cookie },
    body: JSON.stringify({ port: 99999 }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await getSettings(env)).port, 443);

  // back to a single link for the rest of the tests
  await saveSettings(env, { cleanIps: '', host: '', path: '/ws', fragment: '', remarkPrefix: 'ZEUS', fingerprint: 'chrome', alpn: 'h2,http/1.1' });
  await call(`/api/users/${created.user.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
});

test('the subscription is base64 and carries the traffic headers', async () => {
  const { user } = await (await call('/api/users', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ name: 'reza', trafficLimit: 1024 ** 3 }),
  })).json();
  await addTraffic(env, user.uuid, 2048);

  const res = await call(`/sub/${user.token}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  const decoded = Buffer.from(body, 'base64').toString('utf8');
  assert.match(decoded, /^vless:\/\/[0-9a-f-]{36}@panel\.example\.com:443\?/);
  assert.match(decoded, /#ZEUS%20reza|#ZEUS reza/);
  assert.match(res.headers.get('Subscription-Userinfo'), /download=2048/);
  assert.match(res.headers.get('Subscription-Userinfo'), /total=1073741824/);

  const raw = await (await call(`/sub/${user.token}?raw=1`)).text();
  assert.match(raw, /^vless:\/\//);

  const missing = await call('/sub/aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(missing.status, 404);

  const page = await call(`/status/${user.token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /reza/);

  const noSuchPage = await call('/status/aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(noSuchPage.status, 404);

  const cfgs = await (await call(`/api/configs?user=${user.id}`, { headers: { Cookie: cookie } })).json();
  assert.equal(cfgs.xray.outbounds[0].protocol, 'vless');
  assert.equal(cfgs.singbox.inbounds[0].type, 'mixed');

  await call(`/api/users/${user.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
});

test('traffic is counted on the user it belongs to', async () => {
  const { user } = await (await call('/api/users', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ name: 'traffic' }),
  })).json();
  await addTraffic(env, user.uuid, 5000);
  await addTraffic(env, user.uuid, 1500);
  const detail = await (await call(`/api/users/${user.id}`, { headers: { Cookie: cookie } })).json();
  assert.equal(detail.user.traffic_used, 6500);

  const reset = await (await call(`/api/users/${user.id}`, {
    method: 'PATCH',
    headers: { Cookie: cookie },
    body: JSON.stringify({ resetTraffic: true }),
  })).json();
  assert.equal(reset.user.traffic_used, 0);

  await call(`/api/users/${user.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
});

test('the overview counts users and traffic', async () => {
  for (const name of ['one', 'two']) {
    await call('/api/users', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ name }) });
  }
  const overview = await (await call('/api/overview', { headers: { Cookie: cookie } })).json();
  assert.equal(overview.users, 2);
  assert.equal(overview.active, 2);
  assert.equal(overview.host, 'panel.example.com');
  assert.equal(overview.usingDefaultPassword, true);
});

test('the password can be changed, and the session dies with the old one', async () => {
  const refused = await call('/api/password', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ current: 'wrong', next: 'newpass123' }),
  });
  assert.equal(refused.status, 401);

  const short = await call('/api/password', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ current: 'amin_ck', next: '123' }),
  });
  assert.equal(short.status, 400);

  const ok = await call('/api/password', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ current: 'amin_ck', next: 'newpass123' }),
  });
  assert.equal(ok.status, 200);

  const oldSession = await call('/api/me', { headers: { Cookie: cookie } });
  assert.equal(oldSession.status, 401);

  const oldPassword = await call('/api/auth', { method: 'POST', body: JSON.stringify({ password: 'amin_ck' }) });
  assert.equal(oldPassword.status, 401);

  const newPassword = await call('/api/auth', { method: 'POST', body: JSON.stringify({ password: 'newpass123' }) });
  assert.equal(newPassword.status, 200);
  cookie = newPassword.headers.get('Set-Cookie').split(';')[0];

  const overview = await (await call('/api/overview', { headers: { Cookie: cookie } })).json();
  assert.equal(overview.usingDefaultPassword, false);
});

test('an upgrade request is routed to the VLESS endpoint', async () => {
  // Node cannot make a WebSocketPair, so the Worker answers 426 there; on Cloudflare the same branch returns 101.
  const res = await worker.fetch(new Request('https://panel.example.com/ws', { headers: { Upgrade: 'websocket' } }), env);
  assert.equal(res.status, 426);
});

test('unknown paths are 404', async () => {
  assert.equal((await call('/nope')).status, 404);
  const api = await call('/api/nope', { headers: { Cookie: cookie } });
  assert.equal(api.status, 404);
});
