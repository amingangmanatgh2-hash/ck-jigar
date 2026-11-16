import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EndpointPool, type PoolDeps } from '../src/lib/endpointPool';
import { FakeNet, HEALTH } from './fakeNet';

const A = 'https://main.test';
const B = 'https://relay-b.test';
const C = 'https://relay-c.test';

function make(net: FakeNet, over: Partial<PoolDeps> = {}) {
  const mem = new Map<string, string>();
  const deps: PoolDeps = {
    storage: { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) },
    fetchFn: net.fetch as unknown as typeof fetch,
    now: () => Date.now(),
    primary: () => A,
    pageOrigin: () => 'https://page.test',
    probeTimeoutMs: 4000,
    recheckMs: 120_000,
    ...over,
  };
  return { pool: new EndpointPool(deps), mem, deps };
}

describe('EndpointPool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists primary first, then the user’s addresses, then learned ones, without duplicates', () => {
    const net = new FakeNet();
    const { pool } = make(net);
    expect(pool.addCustom('relay-b.test')).toBe('ok'); // scheme is optional, https assumed
    pool.learn([C, B, A, 'ftp://nope.test', 'not a url']);
    expect(pool.candidates()).toEqual([
      { base: A, source: 'primary' },
      { base: B, source: 'custom' },
      { base: C, source: 'learned' },
    ]);
    expect(pool.active()).toBe(A);
  });

  it('on the web the primary is "this origin", and the page’s own origin is never listed twice', () => {
    const net = new FakeNet();
    const { pool } = make(net, { primary: () => '', pageOrigin: () => 'https://chat.test' });
    pool.learn(['https://chat.test', B]);
    expect(pool.candidates()).toEqual([
      { base: '', source: 'primary' },
      { base: B, source: 'learned' },
    ]);
    expect(pool.addCustom('https://chat.test')).toBe('duplicate');
  });

  it('validates what the user adds', () => {
    const { pool } = make(new FakeNet());
    expect(pool.addCustom('')).toBe('invalid');
    expect(pool.addCustom('javascript:alert(1)')).toBe('invalid');
    expect(pool.addCustom('https://user:pw@evil.test')).toBe('invalid');
    expect(pool.addCustom(A)).toBe('duplicate');
    expect(pool.addCustom(B)).toBe('ok');
    expect(pool.addCustom('https://RELAY-B.test:443/other/path')).toBe('duplicate'); // same origin
    for (let i = 0; i < 7; i++) expect(pool.addCustom(`https://r${i}.test`)).toBe('ok');
    expect(pool.addCustom('https://one-too-many.test')).toBe('limit');
  });

  it('prefers the primary when it answers like our server, and learns what the server advertises', async () => {
    const net = new FakeNet().set(A, 'ok').set(B, 'ok');
    net.advertised = [B, C, 'file:///etc/passwd', 'x'.repeat(10)];
    const { pool, mem } = make(net);
    await pool.probeAll();
    expect(pool.active()).toBe(A);
    expect(pool.candidates().map((c) => c.base)).toEqual([A, B, C]);
    expect(JSON.parse(mem.get('aminchat.endpoints')!).learned).toEqual([B, C]);
    // what was just learned is checked right away: B answers, C does not exist
    expect(pool.state.get().endpoints.map((e) => [e.base, e.health])).toEqual([[A, 'ok'], [B, 'ok'], [C, 'down']]);
  });

  it('does not mistake a captive portal, a hijacked page or a CDN error for the service', async () => {
    const net = new FakeNet().set(A, 'portal').set(B, 'gateway').set(C, 'ok');
    const { pool } = make(net);
    pool.learn([B, C]);
    await pool.probeAll();
    const health = Object.fromEntries(pool.state.get().endpoints.map((e) => [e.base, e.health]));
    expect(health).toEqual({ [A]: 'down', [B]: 'down', [C]: 'ok' });
    expect(pool.active()).toBe(C);

    // a 200 JSON answer from something that is not our service is not enough either
    const impostor = new FakeNet();
    impostor.fetch.mockImplementation(async () => new Response(JSON.stringify({ ok: true, service: 'something-else' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { pool: p2 } = make(impostor);
    await p2.probeAll();
    expect(p2.state.get().endpoints[0]!.health).toBe('down');
  });

  it('picks the quickest working alternative when the primary is blocked, and keeps what it has when nothing works', async () => {
    const net = new FakeNet().set(A, 'down').set(B, 'ok').set(C, 'ok');
    net.latency.set(B, 300);
    net.latency.set(C, 50);
    const { pool } = make(net);
    pool.learn([B, C]);
    const probing = pool.probeAll();
    await vi.advanceTimersByTimeAsync(400);
    await probing;
    expect(pool.active()).toBe(C);
    expect(pool.state.get().usingFallback).toBe(true);

    net.set(B, 'down').set(C, 'down');
    const again = pool.probeAll();
    await vi.advanceTimersByTimeAsync(400);
    await again;
    expect(pool.active()).toBe(C); // nothing works: no pointless flip-flopping
  });

  it('times out a silent address instead of waiting for the browser’s own (very long) timeout', async () => {
    const net = new FakeNet().set(A, 'hang').set(B, 'ok');
    const { pool } = make(net);
    pool.learn([B]);
    const probing = pool.probeAll();
    await vi.advanceTimersByTimeAsync(4001);
    await probing;
    expect(pool.state.get().endpoints[0]).toMatchObject({ base: A, health: 'down' });
    expect(pool.active()).toBe(B);
  });

  it('fails over as soon as ONE alternative answers, and a second failure meanwhile joins the same run', async () => {
    const net = new FakeNet().set(A, 'down').set(B, 'hang').set(C, 'ok');
    net.latency.set(C, 80);
    const { pool } = make(net);
    pool.learn([B, C]);
    const seen: string[] = [];
    pool.onActiveChange((a) => seen.push(a));

    const first = pool.failover(A);
    const second = pool.failover(A);
    await vi.advanceTimersByTimeAsync(100); // C answered; B is still hanging
    expect(await first).toBe(C);
    expect(await second).toBe(C);
    expect(pool.active()).toBe(C);
    expect(seen).toEqual([C]); // announced once
    expect(net.log.filter((r) => r.base === C && r.path === '/api/health')).toHaveLength(1); // one shared probe, not two
    await vi.advanceTimersByTimeAsync(5000); // let the hanging probe finish
  });

  it('answers "nowhere to go" immediately for a few seconds after everything was down', async () => {
    const net = new FakeNet().set(A, 'down').set(B, 'down');
    const { pool } = make(net);
    pool.learn([B]);
    const run = pool.failover(A);
    await vi.advanceTimersByTimeAsync(10);
    expect(await run).toBeNull();
    const calls = net.fetch.mock.calls.length;
    expect(await pool.failover(A)).toBeNull();
    expect(net.fetch.mock.calls.length).toBe(calls); // no new probes: failing requests do not queue behind timeouts
    await vi.advanceTimersByTimeAsync(6000);
    net.set(B, 'ok');
    const later = pool.failover(A);
    await vi.advanceTimersByTimeAsync(10);
    expect(await later).toBe(B);
  });

  it('returns to the primary on its own once it works again', async () => {
    const net = new FakeNet().set(A, 'down').set(B, 'ok');
    const { pool } = make(net);
    pool.learn([B]);
    const switched: string[] = [];
    pool.onActiveChange((a) => switched.push(a));
    const f = pool.failover(A);
    await vi.advanceTimersByTimeAsync(10);
    await f;
    expect(pool.active()).toBe(B);

    pool.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(pool.active()).toBe(B); // primary still down
    net.set(A, 'ok');
    await vi.advanceTimersByTimeAsync(120_001); // the periodic re-check
    expect(pool.active()).toBe(A);
    expect(switched).toEqual([B, A]);
    pool.stop();
  });

  it('remembers its list and choice across restarts, and ignores a tampered store', () => {
    const net = new FakeNet().set(B, 'ok');
    const first = make(net);
    first.pool.addCustom(B);
    first.pool.learn([C]);
    void first.pool.failover(A);
    const second = new EndpointPool(first.deps);
    expect(second.candidates().map((c) => c.base)).toEqual([A, B, C]);

    first.mem.set('aminchat.endpoints', JSON.stringify({ custom: ['javascript:1', 'https://ok.test', 42], learned: 'nope', active: 7 }));
    const third = new EndpointPool(first.deps);
    expect(third.candidates().map((c) => c.base)).toEqual([A, 'https://ok.test']);
    first.mem.set('aminchat.endpoints', '{not json');
    expect(new EndpointPool(first.deps).candidates().map((c) => c.base)).toEqual([A]);
  });

  it('forgets an address the user removes (and stops using it)', async () => {
    const net = new FakeNet().set(A, 'down').set(B, 'ok');
    const { pool } = make(net);
    pool.addCustom(B);
    const f = pool.failover(A);
    await vi.advanceTimersByTimeAsync(10);
    await f;
    expect(pool.active()).toBe(B);
    pool.remove(B);
    expect(pool.active()).toBe(A);
    expect(pool.candidates().map((c) => c.base)).toEqual([A]);
  });
});

describe('health answer shape', () => {
  it('HEALTH fixture matches what the Worker returns', () => {
    expect(Object.keys(HEALTH()).sort()).toEqual(['endpoints', 'environment', 'ok', 'service', 'time']);
  });
});

describe('EndpointPool — built-in addresses (VITE_API_BASES)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('are listed after the primary and the user’s own addresses and before learned ones, without duplicates', () => {
    let shipped: string[] = [];
    const { pool } = make(new FakeNet(), { builtin: () => shipped });
    expect(pool.addCustom(B)).toBe('ok'); // the user added B before this app version shipped it
    shipped = [C, A, B, 'https://relay-d.test', C];
    pool.learn(['https://relay-d.test', 'https://relay-e.test']);
    expect(pool.candidates()).toEqual([
      { base: A, source: 'primary' },
      { base: B, source: 'custom' }, // the user's own choice wins over the same address shipped in the app
      { base: C, source: 'builtin' },
      { base: 'https://relay-d.test', source: 'builtin' },
      { base: 'https://relay-e.test', source: 'learned' },
    ]);
  });

  it('cannot be removed or re-added, and learning never duplicates them', () => {
    const { pool } = make(new FakeNet(), { builtin: () => [B] });
    expect(pool.addCustom(B)).toBe('duplicate');
    pool.learn([B]);
    pool.remove(B);
    expect(pool.candidates()).toEqual([
      { base: A, source: 'primary' },
      { base: B, source: 'builtin' },
    ]);
  });

  it('are what a first launch fails over to when its main address is blocked — before anything was ever learned', async () => {
    const net = new FakeNet();
    net.set(A, 'down').set(B, 'ok');
    net.advertised = [C];
    const { pool } = make(net, { builtin: () => [B] });
    const switched: string[] = [];
    pool.onActiveChange((a) => switched.push(a));
    const next = pool.failover(A);
    await vi.advanceTimersByTimeAsync(10);
    expect(await next).toBe(B);
    expect(pool.active()).toBe(B);
    expect(pool.state.get().usingFallback).toBe(true);
    expect(switched).toEqual([B]);
    expect(pool.candidates().map((c) => c.source)).toEqual(['primary', 'builtin', 'learned']); // and it learned C from B's answer
  });

  it('are checked like every other address (a blocked built-in is shown as down, not as ready)', async () => {
    const net = new FakeNet();
    net.set(A, 'ok').set(B, 'down');
    const { pool } = make(net, { builtin: () => [B] });
    const done = pool.probeAll();
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    const byBase = Object.fromEntries(pool.state.get().endpoints.map((e) => [e.base, e.health]));
    expect(byBase).toEqual({ [A]: 'ok', [B]: 'down' });
    expect(pool.active()).toBe(A);
  });
});

describe('getBuiltinEndpoints', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads VITE_API_BASES: comma or space separated, validated, de-duplicated; empty when unset', async () => {
    const { getBuiltinEndpoints } = await import('../src/lib/server');
    vi.stubEnv('VITE_API_BASES', '');
    expect(getBuiltinEndpoints()).toEqual([]);
    vi.stubEnv('VITE_API_BASES', 'https://one.example, two.example:8443/ignored  ftp://no.example javascript:alert(1) https://one.example');
    expect(getBuiltinEndpoints()).toEqual(['https://one.example', 'https://two.example:8443']);
  });
});

describe('EndpointPool — after a bad connection (found by a real browser run: the app stayed on a relay after the signal came back)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
  });
  const tick = (ms = 10) => vi.advanceTimersByTimeAsync(ms);
  const healthChecksOf = (net: FakeNet, base: string) => net.log.filter((r) => r.base === base && r.path === '/api/health').length;

  async function onTheRelay(over: Partial<PoolDeps> = {}) {
    const net = new FakeNet().set(A, 'down').set(B, 'ok');
    const made = make(net, over);
    made.pool.learn([B]);
    made.pool.start();
    await tick();
    expect(made.pool.active()).toBe(B); // the primary did not answer, the relay did
    return { net, ...made };
  }

  it('blames no address while the device itself has no network, and contacts nobody', async () => {
    const net = new FakeNet().set(A, 'ok').set(B, 'ok');
    const { pool } = make(net, { isOnline: () => false });
    pool.learn([B]);
    expect(await pool.failover(A)).toBeNull();
    expect(net.fetch).not.toHaveBeenCalled(); // nothing could answer, and a relay need not learn that this device exists
    expect(pool.state.get().endpoints.find((e) => e.base === A)?.health).toBe('unknown'); // not condemned
    expect(pool.active()).toBe(A);
  });

  it('only an explicit "offline" counts: an unknown or "online" device is treated as before', async () => {
    const net = new FakeNet().set(A, 'down').set(B, 'ok');
    const { pool } = make(net, { isOnline: () => true });
    pool.learn([B]);
    const run = pool.failover(A);
    await tick();
    expect(await run).toBe(B);
  });

  it('looks at the primary again soon after switching to a relay, then less and less often, up to the limit', async () => {
    const { pool, net } = await onTheRelay();
    const base = healthChecksOf(net, A);
    await tick(15_000);
    expect(healthChecksOf(net, A)).toBe(base + 1); // after 15 s
    await tick(30_000);
    expect(healthChecksOf(net, A)).toBe(base + 2); // 30 s later
    await tick(60_000);
    expect(healthChecksOf(net, A)).toBe(base + 3); // 60 s later
    await tick(120_000);
    expect(healthChecksOf(net, A)).toBe(base + 4); // 120 s later: the limit …
    await tick(120_000);
    expect(healthChecksOf(net, A)).toBe(base + 5); // … which then stays
    expect(pool.active()).toBe(B);
    pool.stop();
  });

  it('is back on the primary within 15 seconds of it working again — not after two minutes', async () => {
    const { pool, net } = await onTheRelay();
    net.set(A, 'ok');
    await tick(14_000);
    expect(pool.active()).toBe(B); // not yet looked at
    await tick(1_100);
    expect(pool.active()).toBe(A);
    pool.stop();
  });

  it('does not keep re-checking when it is on the primary (nothing to come back to)', async () => {
    const net = new FakeNet().set(A, 'ok').set(B, 'ok');
    const { pool } = make(net);
    pool.learn([B]);
    pool.start();
    await tick();
    const calls = net.fetch.mock.calls.length;
    await tick(600_000);
    expect(net.fetch.mock.calls.length).toBe(calls); // not one request in ten minutes
    pool.stop();
  });

  it('goes back to the primary the moment the network returns (the browser’s "online" event)', async () => {
    const { pool, net } = await onTheRelay();
    net.set(A, 'ok');
    window.dispatchEvent(new Event('online'));
    await tick();
    expect(pool.active()).toBe(A);
    pool.stop();
  });

  it('ignores "online" while the device still reports no network', async () => {
    let online = false;
    const { pool, net } = await onTheRelay({ isOnline: () => online });
    net.set(A, 'ok');
    window.dispatchEvent(new Event('online'));
    await tick();
    expect(pool.active()).toBe(B);
    online = true;
    window.dispatchEvent(new Event('online'));
    await tick();
    expect(pool.active()).toBe(A);
    pool.stop();
  });

  it('forgets "everything was down a moment ago" when the network returns', async () => {
    const net = new FakeNet().set(A, 'down').set(B, 'down');
    const { pool } = make(net);
    pool.learn([B]);
    pool.start();
    await tick();
    const run = pool.failover(A);
    await tick();
    expect(await run).toBeNull(); // the 5 s "nowhere to go" window opens
    net.set(B, 'ok'); // only the relay is reachable now
    window.dispatchEvent(new Event('online'));
    await tick();
    expect(pool.active()).toBe(B); // found at once, not after waiting out the window
    pool.stop();
  });

  it('also looks when the app is brought back to the front — but not while hidden, and not more than every 10 s', async () => {
    const { pool, net } = await onTheRelay();
    net.set(A, 'ok');
    const visibility = (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    visibility('hidden');
    await tick();
    expect(pool.active()).toBe(B); // hidden: nothing happens
    visibility('visible');
    await tick();
    expect(pool.active()).toBe(B); // the app has just looked (it started a moment ago): throttled
    await tick(10_000);
    visibility('visible');
    await tick();
    expect(pool.active()).toBe(A);
    pool.stop();
  });

  it('stops listening and checking when it is stopped', async () => {
    const { pool, net } = await onTheRelay();
    pool.stop();
    const calls = net.fetch.mock.calls.length;
    window.dispatchEvent(new Event('online'));
    await tick(600_000);
    expect(net.fetch.mock.calls.length).toBe(calls);
  });
});
