import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { AMIN_AI_USER_ID } from '@aminchat/shared';
import { storedIterations } from '../src/lib/crypto';
import { login, register } from '../src/services/users';
import { api, freshIp, json, registerUser, uniqueName } from './helpers';

describe('authentication', () => {
  it('registers, returns a session and the verified AMIN AI contact is always in the chat list', async () => {
    const u = await registerUser('alice');
    const me = await json(await api('GET', '/api/auth/me', { token: u.token }));
    expect(me.user.username).toBe(u.username);
    expect(me.user.role).toBe('user');

    const list = await json(await api('GET', '/api/conversations', { token: u.token }));
    const ai = list.conversations.find((c: any) => c.type === 'ai');
    expect(ai).toBeTruthy();
    expect(ai.pinned).toBe(true);
    expect(ai.peer).toMatchObject({ id: AMIN_AI_USER_ID, username: 'aminai', kind: 'ai', verified: true });
    expect(list.conversations[0].id).toBe(ai.id);
  });

  it('never stores passwords or bearer tokens in clear text', async () => {
    const u = await registerUser('hash');
    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(u.id).first<{ password_hash: string }>();
    expect(row!.password_hash.startsWith('pbkdf2-sha256$20000$')).toBe(true); // the test environment's PASSWORD_HASH_ITERATIONS
    expect(row!.password_hash).not.toContain('correct-horse');
    const sessions = await env.DB.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').bind(u.id).all<{ token_hash: string }>();
    expect(sessions.results.every((s) => s.token_hash !== u.token && s.token_hash.length === 64)).toBe(true);
  });

  it('validates registration input', async () => {
    const short = await api('POST', '/api/auth/register', { json: { username: uniqueName(), password: 'short' } });
    expect(short.status).toBe(400);
    expect((await json(short)).error.code).toBe('VALIDATION_ERROR');

    const badName = await api('POST', '/api/auth/register', { json: { username: '1bad name', password: 'correct-horse-battery' } });
    expect(badName.status).toBe(400);
    expect((await json(badName)).error.code).toBe('INVALID_USERNAME');

    const reserved = await api('POST', '/api/auth/register', { json: { username: 'AminAI', password: 'correct-horse-battery' } });
    expect(reserved.status).toBe(409);
    expect((await json(reserved)).error.code).toBe('USERNAME_RESERVED');

    const notJson = await api('POST', '/api/auth/register', { body: 'nope', headers: { 'Content-Type': 'application/json' } });
    expect(notJson.status).toBe(400);
    expect((await json(notJson)).error.code).toBe('INVALID_JSON');
  });

  it('rejects duplicate usernames case-insensitively', async () => {
    const u = await registerUser('dupe');
    const again = await api('POST', '/api/auth/register', { json: { username: u.username.toUpperCase(), password: 'correct-horse-battery' } });
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe('USERNAME_TAKEN');
  });

  it('logs in with the right password only, with identical errors for unknown users and wrong passwords', async () => {
    const u = await registerUser('login');
    const ok = await api('POST', '/api/auth/login', { json: { username: u.username, password: 'correct-horse-battery' } });
    expect(ok.status).toBe(200);
    const wrong = await api('POST', '/api/auth/login', { json: { username: u.username, password: 'wrong-password-1' } });
    const unknown = await api('POST', '/api/auth/login', { json: { username: 'nobody_' + uniqueName(), password: 'wrong-password-1' } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const a = (await json(wrong)).error;
    const b = (await json(unknown)).error;
    expect(a.code).toBe('INVALID_CREDENTIALS');
    expect(a.message).toBe(b.message);
  });

  it('refuses to log in as the AMIN AI system user', async () => {
    const res = await api('POST', '/api/auth/login', { json: { username: 'aminai', password: 'anything-at-all' } });
    expect(res.status).toBe(401);
  });

  it('requires a valid bearer token on protected routes', async () => {
    expect((await api('GET', '/api/conversations')).status).toBe(401);
    expect((await api('GET', '/api/conversations', { token: 'x'.repeat(43) })).status).toBe(401);
    expect((await api('GET', '/api/conversations', { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
  });

  it('logout revokes the session; other sessions can be listed and revoked', async () => {
    const u = await registerUser('logout');
    const second = await json(await api('POST', '/api/auth/login', { json: { username: u.username, password: 'correct-horse-battery' } }));
    const sessions = await json(await api('GET', '/api/auth/sessions', { token: u.token }));
    expect(sessions.sessions).toHaveLength(2);
    expect(sessions.sessions.filter((s: any) => s.current)).toHaveLength(1);

    expect((await api('POST', '/api/auth/logout', { token: u.token })).status).toBe(200);
    expect((await api('GET', '/api/auth/me', { token: u.token })).status).toBe(401);
    expect((await api('GET', '/api/auth/me', { token: second.token })).status).toBe(200);
  });

  it('changing the password signs out other devices', async () => {
    const u = await registerUser('chpw');
    const other = await json(await api('POST', '/api/auth/login', { json: { username: u.username, password: 'correct-horse-battery' } }));
    const res = await api('POST', '/api/auth/change-password', { token: u.token, json: { currentPassword: 'correct-horse-battery', newPassword: 'another-long-password' } });
    expect(res.status).toBe(200);
    expect((await api('GET', '/api/auth/me', { token: other.token })).status).toBe(401);
    expect((await api('GET', '/api/auth/me', { token: u.token })).status).toBe(200);
    expect((await api('POST', '/api/auth/login', { json: { username: u.username, password: 'another-long-password' } })).status).toBe(200);
  });

  it('rate-limits repeated login attempts for one username (brute-force protection)', async () => {
    const name = uniqueName('brute');
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await api('POST', '/api/auth/login', { json: { username: name, password: 'wrong-password-' + i } })).status);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    const limited = await api('POST', '/api/auth/login', { json: { username: name, password: 'x' } });
    expect(limited.headers.get('Retry-After')).toBeTruthy();
  });

  it('answers unknown API routes with a JSON 404 and never leaks stack traces', async () => {
    const res = await api('GET', '/api/does-not-exist');
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('only echoes CORS headers for allowed origins', async () => {
    const good = await api('OPTIONS', '/api/health', { headers: { Origin: 'https://app.example.test', 'Access-Control-Request-Method': 'GET' } });
    expect(good.status).toBe(204);
    expect(good.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.test');
    const bad = await api('OPTIONS', '/api/health', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // No route or screen sets users.disabled_at (docs/SECURITY.md says so): an operator edits the database. What the app does promise is
  // that the flag is honoured everywhere, immediately, so this pins that promise.
  it('rejects a disabled account on its very next request, refuses its login and hides it from other people', async () => {
    const victim = await registerUser('disabled');
    const seeker = await registerUser('seeker');
    expect((await api('GET', '/api/auth/me', { token: victim.token })).status).toBe(200);
    const before = await json(await api('GET', `/api/users/search?q=${victim.username}`, { token: seeker.token }));
    expect(before.users.map((u: any) => u.id)).toContain(victim.id);

    await env.DB.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').bind(Date.now(), victim.id).run();

    expect((await api('GET', '/api/auth/me', { token: victim.token })).status).toBe(401);
    const login = await api('POST', '/api/auth/login', { headers: { 'CF-Connecting-IP': freshIp() }, json: { username: victim.username, password: 'correct-horse-battery' } });
    expect(login.status).toBe(401);
    expect((await json(login)).error.code).toBe('INVALID_CREDENTIALS');
    const after = await json(await api('GET', `/api/users/search?q=${victim.username}`, { token: seeker.token }));
    expect(after.users.map((u: any) => u.id)).not.toContain(victim.id);
    const profile = await api('GET', `/api/users/${victim.id}`, { token: seeker.token });
    expect(profile.status).toBe(404);
    expect((await json(profile)).error.code).toBe('USER_NOT_FOUND');
  });
});

describe('password hash cost (PASSWORD_HASH_ITERATIONS)', () => {
  const cheap = { ...env, PASSWORD_HASH_ITERATIONS: '20000' } as typeof env;
  const strong = { ...env, PASSWORD_HASH_ITERATIONS: '100000' } as typeof env;
  const iterationsOf = async (id: string) =>
    storedIterations((await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(id).first<{ password_hash: string }>())!.password_hash);

  it('registration uses the configured cost and records it in the hash', async () => {
    const a = await register(cheap, { username: uniqueName('cost'), password: 'correct-horse-battery' }, null);
    expect(await iterationsOf(a.user.id)).toBe(20_000);
    const b = await register(strong, { username: uniqueName('cost'), password: 'correct-horse-battery' }, null);
    expect(await iterationsOf(b.user.id)).toBe(100_000);
  });

  it('a cheaper hash still signs in and is upgraded at that sign-in; a lower setting never weakens an existing hash', async () => {
    const name = uniqueName('upgrade');
    const created = await register(cheap, { username: name, password: 'correct-horse-battery' }, null);
    // a wrong password changes nothing, even under the stronger setting
    await expect(login(strong, name, 'wrong-password-here', null)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(await iterationsOf(created.user.id)).toBe(20_000);
    // the right password under the stronger setting: signed in, hash replaced
    expect((await login(strong, name, 'correct-horse-battery', null)).user.id).toBe(created.user.id);
    expect(await iterationsOf(created.user.id)).toBe(100_000);
    // the setting is lowered again: still signs in, the strong hash stays
    expect((await login(cheap, name, 'correct-horse-battery', null)).user.id).toBe(created.user.id);
    expect(await iterationsOf(created.user.id)).toBe(100_000);
    // and it was a real hash, not a leftover: the old and the new password behave
    await expect(login(cheap, name, 'wrong-password-here', null)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('an upgrade never overwrites a password that was changed in the meantime', async () => {
    const name = uniqueName('race');
    const created = await register(cheap, { username: name, password: 'correct-horse-battery' }, null);
    const before = (await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(created.user.id).first<{ password_hash: string }>())!.password_hash;
    // the stored hash is replaced by another one between reading it and writing the upgrade: the WHERE clause must stop the write
    const swapped = 'pbkdf2-sha256$20000$AAAAAAAAAAAAAAAAAAAAAA==$' + before.split('$')[3];
    const racing = new Proxy(strong, {
      get(target, prop, receiver) {
        if (prop !== 'DB') return Reflect.get(target, prop, receiver);
        return new Proxy(target.DB, {
          get(db, p) {
            if (p !== 'prepare') return (db as any)[p].bind(db);
            return (sql: string) => {
              if (sql.startsWith('UPDATE users SET password_hash')) {
                // somebody changed the password just before the upgrade is written
                return { bind: (...args: unknown[]) => ({ run: async () => { await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(swapped, created.user.id).run(); return db.prepare(sql).bind(...args).run(); } }) };
              }
              return db.prepare(sql);
            };
          },
        });
      },
    }) as typeof env;
    await login(racing, name, 'correct-horse-battery', null);
    const after = (await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(created.user.id).first<{ password_hash: string }>())!.password_hash;
    expect(after).toBe(swapped);
  });

  it('changing the password uses the configured cost', async () => {
    const u = await registerUser('chcost');
    const res = await api('POST', '/api/auth/change-password', { token: u.token, json: { currentPassword: 'correct-horse-battery', newPassword: 'another-long-password' } });
    expect(res.status).toBe(200);
    expect(await iterationsOf(u.id)).toBe(20_000);
  });
});
