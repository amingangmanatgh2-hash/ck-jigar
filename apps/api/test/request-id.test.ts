import { env, exports } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { notFound } from '../src/lib/errors';
import type { AppEnv } from '../src/middleware/auth';
import { cors, onError, requestContext } from '../src/middleware/common';
import { api, freshIp, json, registerUser } from './helpers';

/**
 * The browser app decides "is this really our server?" by looking for X-Request-Id: a captive portal, a CDN error page or a
 * censor's block page never has it, so a response without it makes the client switch to another address. That only works if the
 * Worker sets it on EVERY answer it gives — including errors — and, for the cross-origin Android app, exposes it over CORS.
 */

const id = (res: Response) => res.headers.get('X-Request-Id');

describe('X-Request-Id is on every response the Worker gives', () => {
  it('successes, refusals, validation errors, unknown routes and rate limits', async () => {
    const user = await registerUser('rid');
    const ip = freshIp();
    const seen: Array<[string, Response]> = [];
    const hit = async (label: string, p: Promise<Response>) => {
      const res = await p;
      seen.push([label, res]);
      return res;
    };

    expect((await hit('health', api('GET', '/api/health'))).status).toBe(200);
    expect((await hit('authenticated read', api('GET', '/api/conversations', { token: user.token }))).status).toBe(200);
    expect((await hit('no token', api('GET', '/api/auth/me'))).status).toBe(401);
    expect((await hit('bad token', api('GET', '/api/auth/me', { token: 'not-a-token' }))).status).toBe(401);
    expect((await hit('unknown route', api('GET', '/api/definitely-not-a-route'))).status).toBe(404);
    expect((await hit('unknown route, POST', api('POST', '/api/definitely/not', { json: {} }))).status).toBe(404);
    expect((await hit('invalid body', api('POST', '/api/auth/login', { headers: { 'CF-Connecting-IP': ip }, json: {} }))).status).toBe(400);
    expect((await hit('malformed JSON', api('POST', '/api/auth/login', { headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' }, body: '{nope' }))).status).toBe(400);
    expect((await hit('unknown file', api('GET', '/api/files/file_does_not_exist', { token: user.token }))).status).toBe(404);
    expect((await hit('poll, no token', api('GET', '/api/realtime/poll'))).status).toBe(401);
    expect((await hit('poll', api('GET', '/api/realtime/poll?wait=0', { token: user.token }))).status).toBe(200);

    let limited: Response | null = null;
    for (let i = 0; i < 40 && !limited; i++) {
      const res = await api('POST', '/api/auth/login', { headers: { 'CF-Connecting-IP': ip }, json: {} });
      seen.push([`login #${i}`, res]);
      if (res.status === 429) limited = res;
    }
    expect(limited, 'the per-IP limiter must eventually refuse').not.toBeNull();
    expect((await json(limited!)).error.code).toBe('RATE_LIMITED');

    for (const [label, res] of seen) expect(id(res), `${label} (${res.status})`).toMatch(/^req_?[A-Za-z0-9_-]{6,}$/);
    const ids = seen.map(([, res]) => id(res));
    expect(new Set(ids).size, 'every request gets its own id').toBe(ids.length);
  });

  it('an error body carries the same id, so a user can quote it to the operator', async () => {
    const res = await api('GET', '/api/definitely-not-a-route');
    const body = await json(res);
    expect(body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(body.error.requestId).toBe(id(res));
  });

  it('an unexpected crash is a clean 500 that still carries the id (and leaks nothing)', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', requestContext);
    app.use('/api/*', cors);
    app.onError(onError);
    app.get('/api/boom', () => {
      throw new Error('database password is hunter2');
    });
    app.get('/api/missing', () => {
      throw notFound('nope', 'THING_NOT_FOUND');
    });
    const res = await app.request('/api/boom', { headers: { Origin: 'https://localhost' } }, env);
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(id(res)).toBeTruthy();
    expect(body.error.requestId).toBe(id(res));
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-Id'); // even a crash must be readable by the app
    expect(id(await app.request('/api/missing', {}, env))).toBeTruthy();
  });

  it('the realtime WebSocket upgrade, too', async () => {
    const user = await registerUser('rid_ws');
    const t = await json(await api('POST', '/api/realtime/ticket', { token: user.token }));
    const res = await exports.default.fetch(`https://amin.test/api/realtime/ws?ticket=${encodeURIComponent(t.ticket)}`, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close(1000, 'done');
    expect(id(res)).toBeTruthy();
    const refused = await exports.default.fetch('https://amin.test/api/realtime/ws?ticket=bogus', { headers: { Upgrade: 'websocket' } });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(id(refused)).toBeTruthy();
  });
});

describe('X-Request-Id can be read by the cross-origin apps we trust — and only by them', () => {
  const trusted = [
    ['the Android app (Capacitor, https scheme)', 'https://localhost'],
    ['the Android app (Capacitor, custom scheme)', 'capacitor://localhost'],
    ['a configured origin (ALLOWED_ORIGINS)', 'https://app.example.test'],
    ['one of our own relays (PUBLIC_ENDPOINTS)', 'https://relay-a.example.test'],
  ] as const;

  it.each(trusted)('%s', async (_name, origin) => {
    const res = await api('GET', '/api/health', { headers: { Origin: origin } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-Id');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After'); // the outbox honours it
    expect(res.headers.get('Vary')).toContain('Origin');
    expect(id(res)).toBeTruthy();

    // A refusal must be readable too, otherwise the app would treat our own 401/429 as a foreign page and start switching servers.
    const refusal = await api('GET', '/api/auth/me', { headers: { Origin: origin } });
    expect(refusal.status).toBe(401);
    expect(refusal.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(refusal.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-Id');

    const pre = await api('OPTIONS', '/api/conversations', { headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    const allowedHeaders = (pre.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase();
    expect(allowedHeaders).toContain('authorization');
    expect(allowedHeaders).toContain('content-type');
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) expect(pre.headers.get('Access-Control-Allow-Methods')).toContain(method);
    expect(id(pre)).toBeTruthy();
  });

  it('any other website gets no CORS access at all (never a wildcard)', async () => {
    for (const origin of ['https://evil.example', 'https://app.example.test.evil.example', 'http://app.example.test', 'null']) {
      const res = await api('GET', '/api/health', { headers: { Origin: origin } });
      expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBeNull();
      expect(res.headers.get('Access-Control-Expose-Headers'), origin).toBeNull();
      const pre = await api('OPTIONS', '/api/conversations', { headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
      expect(pre.status, origin).toBe(403);
      expect(pre.headers.get('Access-Control-Allow-Origin'), origin).toBeNull();
    }
  });
});
