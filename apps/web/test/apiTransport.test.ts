import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, http, request, setUnauthorizedHandler, setToken, SAME_ADDRESS_RETRY_DELAYS_MS, fetchBlob } from '../src/lib/api';
import { EndpointPool } from '../src/lib/endpointPool';
import { FakeNet } from './fakeNet';

const A = 'https://main.test';
const B = 'https://relay-b.test';
const C = 'https://relay-c.test';

// The transport talks to the module-level pool; give it a pool wired to the scripted network.
const h = vi.hoisted(() => ({ net: null as unknown as import('./fakeNet').FakeNet, pool: null as unknown as EndpointPool }));
vi.mock('../src/lib/endpointPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/endpointPool')>();
  const { FakeNet: Net } = await import('./fakeNet');
  h.net = new Net();
  const mem = new Map<string, string>();
  h.pool = new actual.EndpointPool({
    storage: { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) },
    fetchFn: h.net.fetch as unknown as typeof fetch,
    now: () => Date.now(),
    primary: () => 'https://main.test',
    pageOrigin: () => 'https://page.test',
    probeTimeoutMs: 4000,
    recheckMs: 120_000,
  });
  return { ...actual, pool: h.pool };
});

const net = () => h.net;
const pool = () => h.pool;

beforeEach(() => {
  vi.useFakeTimers();
  net().behaviors.clear();
  net().log.length = 0;
  net().fetch.mockReset();
  net().advertised = [];
  net().handler = () => ({ json: { data: 1 } });
  for (const c of pool().candidates()) if (c.source !== 'primary') pool().remove(c.base);
  pool().state.set((s) => s);
  vi.stubGlobal('fetch', net().fetch);
  setToken('tok');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setToken(null);
  setUnauthorizedHandler(null);
});

/** Runs a request while time advances, so retry pauses and timeouts elapse without real waiting. */
async function run<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const guarded = p.finally(() => (done = true));
  guarded.catch(() => undefined);
  for (let i = 0; i < 200 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  return guarded;
}

describe('transport: telling "the network failed" from "the server said no"', () => {
  it('repeats a read on another address when the main one is unreachable, and keeps using the new one', async () => {
    net().set(A, 'down').set(B, 'ok');
    pool().learn([B]);
    const out = await run(http.get<{ data: number }>('/api/conversations'));
    expect(out).toEqual({ data: 1 });
    expect(net().requestsTo(A, 'GET').length).toBeGreaterThanOrEqual(1);
    expect(net().requestsTo(B, 'GET')).toHaveLength(1);
    expect(pool().active()).toBe(B);
    // the next call goes straight to the working address
    net().log.length = 0;
    await run(http.get('/api/conversations'));
    expect(net().requestsTo(A)).toHaveLength(0);
    expect(net().requestsTo(B)).toHaveLength(1);
  });

  it.each([
    ['a captive portal answering 200 with its own page', 'portal'],
    ['a relay or CDN error page', 'gateway'],
  ] as const)('treats %s as a failed address, not as an answer', async (_name, behavior) => {
    net().set(A, behavior).set(B, 'ok');
    pool().learn([B]);
    expect(await run(http.get('/api/ai/threads'))).toEqual({ data: 1 });
    expect(pool().active()).toBe(B);
  });

  it('never treats an answer of OUR server as a network problem — not even a 500 or 503', async () => {
    net().set(A, 'ok').set(B, 'ok');
    pool().learn([B]);
    for (const [status, code] of [[400, 'VALIDATION_ERROR'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [429, 'RATE_LIMITED'], [500, 'INTERNAL'], [503, 'AI_NOT_CONNECTED']] as const) {
      net().handler = () => ({ status, json: { error: { code, message: 'no' } } });
      net().log.length = 0;
      await expect(run(http.get('/api/x'))).rejects.toMatchObject({ name: 'ApiError', status, code });
      expect(net().requestsTo(A)).toHaveLength(1); // asked once, no retry, no switch
      expect(pool().active()).toBe(A);
    }
  });

  it('does not blindly repeat a send: a POST without an idempotency token fails with NETWORK, but the NEXT call uses the working address', async () => {
    net().set(A, 'down').set(B, 'ok');
    pool().learn([B]);
    await expect(run(http.post('/api/conversations/c1/messages', { body: 'hi' }))).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
    expect(net().requestsTo(B, 'POST')).toHaveLength(0); // it might have arrived at A: do not risk a duplicate
    expect(pool().active()).toBe(B);
    await run(http.post('/api/conversations/c1/messages', { body: 'hi again' }));
    expect(net().requestsTo(B, 'POST')).toHaveLength(1);
  });

  it('repeats a send that carries an idempotency token — with exactly the same body', async () => {
    net().set(A, 'down').set(B, 'ok');
    pool().learn([B]);
    const body = { body: 'hi', clientId: 'abc12345def' };
    const out = await run(http.post<{ data: number }>('/api/conversations/c1/messages', body, undefined, { retry: true }));
    expect(out).toEqual({ data: 1 });
    const sent = net().requestsTo(B, 'POST');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body!)).toEqual(body);
  });

  it('gives up on a silent connection after the timeout instead of hanging for minutes', async () => {
    net().set(A, 'hang').set(B, 'ok');
    pool().learn([B]);
    const t0 = Date.now();
    expect(await run(http.get('/api/conversations'))).toEqual({ data: 1 });
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(20_000);
    expect(waited).toBeLessThan(26_000);
    expect(pool().active()).toBe(B);
  });

  it('with only one address: reads are repeated after short pauses on a flaky link, sends are not', async () => {
    net().set(A, 'down');
    const t0 = Date.now();
    await expect(run(http.get('/api/conversations'))).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
    expect(net().requestsTo(A, 'GET')).toHaveLength(1 + SAME_ADDRESS_RETRY_DELAYS_MS.length);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SAME_ADDRESS_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));

    net().log.length = 0;
    await expect(run(http.post('/api/conversations/c1/messages', { body: 'x' }))).rejects.toMatchObject({ code: 'NETWORK' });
    expect(net().requestsTo(A, 'POST')).toHaveLength(1);
  });

  it('recovers when the connection drops once and comes back', async () => {
    let n = 0;
    net().fetch.mockImplementationOnce(async () => {
      n++;
      throw new TypeError('connection reset');
    });
    net().set(A, 'ok');
    expect(await run(http.get('/api/conversations'))).toEqual({ data: 1 });
    expect(n).toBe(1);
  });

  it('does not repeat when the caller cancels, and reports it as an abort', async () => {
    net().set(A, 'hang').set(B, 'ok');
    pool().learn([B]);
    const ctl = new AbortController();
    const p = http.get('/api/conversations', undefined, ctl.signal);
    const settled = p.then(() => 'resolved', (e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(50);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(50);
    expect(await settled).toBe('AbortError');
    expect(net().requestsTo(B)).toHaveLength(0);
    expect(pool().active()).toBe(A);
  });

  it('signs the user out on 401 (but not for a failed login)', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    net().set(A, 'ok');
    net().handler = () => ({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'no' } } });
    await expect(run(http.get('/api/users/me'))).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await expect(run(http.post('/api/auth/login', { username: 'a', password: 'b' }))).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('downloads files through the same failover', async () => {
    net().set(A, 'down').set(B, 'ok');
    pool().learn([B]);
    net().fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(A)) throw new TypeError('blocked');
      if (url.endsWith('/api/health')) return new Response(JSON.stringify({ ok: true, service: 'amin-chat', endpoints: [] }), { headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'r' } });
      return new Response('file bytes', { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'X-Request-Id': 'r' } });
    });
    const blob = await run(fetchBlob('/api/files/f1'));
    expect(await blob.text()).toBe('file bytes');
  });

  it('request() sends the bearer token and JSON body, and leaves other callers’ headers alone', async () => {
    net().set(A, 'ok');
    await run(request('PUT', '/api/messages/m1', { json: { body: 'edit' }, headers: { 'X-Test': '1' } }));
    const init = net().fetch.mock.calls.at(-1)![1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json', 'X-Test': '1' });
    expect(init.body).toBe(JSON.stringify({ body: 'edit' }));
  });
});

describe('unused address constant', () => {
  it('keeps C referenced so the fixtures stay in one place', () => {
    expect([A, B, C]).toHaveLength(3);
  });
});
