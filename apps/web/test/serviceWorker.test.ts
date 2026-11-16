import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { precacheList, renderServiceWorker, versionOf } from '../plugins/serviceWorker';
import { recoverFromStaleChunks, registerServiceWorker, type PwaDeps } from '../src/lib/pwa';

const TEMPLATE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../plugins/sw.template.js'), 'utf8');

/* ------------------------------------------------------------------------------------------------ build-time helpers */

describe('service worker build', () => {
  const emitted = ['index.html', 'assets/index-AAA.js', 'assets/index-BBB.css', 'assets/Vazirmatn-CCC.woff2', 'assets/index-AAA.js.map', 'sw.js'];
  const publicFiles = ['favicon.svg', 'manifest.webmanifest', 'icons/icon-192.png', 'robots.txt', 'secret/notes.txt', 'icons/readme.md'];

  it('precaches the page under its canonical address, every emitted asset and the shell’s public files — and nothing else', () => {
    expect(precacheList(emitted, publicFiles)).toEqual([
      '/', // never "/index.html": that is a redirect on Workers Assets and a redirected response cannot answer a navigation
      '/assets/Vazirmatn-CCC.woff2',
      '/assets/index-AAA.js',
      '/assets/index-BBB.css',
      '/favicon.svg',
      '/icons/icon-192.png',
      '/manifest.webmanifest',
    ]);
  });

  it('is stable and normalises Windows path separators', () => {
    const a = precacheList(['assets\\x-1.js', 'index.html'], ['icons\\icon-192.png']);
    expect(a).toEqual(['/', '/assets/x-1.js', '/icons/icon-192.png'].sort());
  });

  it('versions by content: the same build gives the same version, a changed asset gives another', () => {
    const a = precacheList(emitted, publicFiles);
    expect(versionOf(a)).toBe(versionOf([...a]));
    expect(versionOf(a)).toMatch(/^[0-9a-f]{12}$/);
    expect(versionOf(precacheList(emitted.map((f) => f.replace('AAA', 'ZZZ')), publicFiles))).not.toBe(versionOf(a));
    // the page can change without any file name changing (title, meta tags): that is an update too
    expect(versionOf(a, '<title>A</title>')).not.toBe(versionOf(a, '<title>B</title>'));
    expect(versionOf(a, '<title>A</title>')).toBe(versionOf([...a], '<title>A</title>'));
  });

  it('renders valid JavaScript with the list and version filled in, and refuses a broken template', () => {
    const paths = precacheList(emitted, publicFiles);
    const src = renderServiceWorker(TEMPLATE, paths);
    expect(src).not.toContain('__VERSION__');
    expect(src).not.toContain('__PRECACHE__');
    expect(src).toContain(versionOf(paths));
    expect(() => new Function('self', 'caches', 'fetch', 'Response', 'URL', src)).not.toThrow();
    expect(() => renderServiceWorker('nothing to replace', paths)).toThrow(/placeholders/);
  });
});

/* ------------------------------------------------------------------------------------------------ the worker itself */

class FakeCache {
  store = new Map<string, Response>();
  private key = (k: string | { url: string }) => (typeof k === 'string' ? k : new URL(k.url).pathname);
  async match(k: string | { url: string }) {
    return this.store.get(this.key(k))?.clone();
  }
  async put(k: string | { url: string }, res: Response) {
    this.store.set(this.key(k), res);
  }
}
class FakeCaches {
  map = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.map.has(name)) this.map.set(name, new FakeCache());
    return this.map.get(name)!;
  }
  async keys() {
    return [...this.map.keys()];
  }
  async delete(name: string) {
    return this.map.delete(name);
  }
  async match(k: string | { url: string }) {
    for (const cache of this.map.values()) {
      const hit = await cache.match(k);
      if (hit) return hit;
    }
    return undefined;
  }
}

type Listener = (event: Record<string, unknown>) => void;

/** Runs a rendered worker against fakes of everything a worker is given. */
function startWorker(paths: string[], network: (path: string, init?: RequestInit) => Response | Promise<Response>, caches = new FakeCaches()) {
  const listeners: Record<string, Listener[]> = {};
  const self = {
    location: { origin: 'https://app.test' },
    addEventListener: (type: string, fn: Listener) => void (listeners[type] ??= []).push(fn),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  const fetched: { path: string; init?: RequestInit }[] = [];
  const fetchFn = vi.fn(async (input: string | { url: string }, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : new URL(input.url).pathname;
    fetched.push({ path, init });
    return network(path, init);
  });
  new Function('self', 'caches', 'fetch', 'Response', 'URL', renderServiceWorker(TEMPLATE, paths))(self, caches, fetchFn, Response, URL);

  async function lifecycle(type: 'install' | 'activate') {
    const waits: Promise<unknown>[] = [];
    for (const l of listeners[type] ?? []) l({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  async function request(url: string, init: { method?: string; mode?: string } = {}): Promise<{ intercepted: boolean; response?: Response }> {
    let responded: Promise<Response> | null = null;
    const event = { request: { method: init.method ?? 'GET', url, mode: init.mode ?? 'no-cors' }, respondWith: (p: Promise<Response>) => (responded = p) };
    for (const l of listeners.fetch ?? []) l(event);
    return responded ? { intercepted: true, response: await responded } : { intercepted: false };
  }
  return { self, caches, fetched, fetchFn, install: () => lifecycle('install'), activate: () => lifecycle('activate'), request };
}

const PATHS = ['/', '/assets/app-1.js', '/assets/app-1.css', '/favicon.svg'];
const ok = (body: string) => new Response(body, { status: 200 });
const online = (path: string) => ok(`network:${path}`);
const offline = () => {
  throw new TypeError('Failed to fetch');
};

describe('service worker', () => {
  it('installs by downloading the whole shell fresh (not from the HTTP cache) and only then takes over', async () => {
    const sw = startWorker(PATHS, online);
    await sw.install();
    expect(sw.fetched.map((f) => f.path).sort()).toEqual([...PATHS].sort());
    for (const f of sw.fetched) expect(f.init).toMatchObject({ cache: 'reload' });
    const cache = [...sw.caches.map.entries()].find(([n]) => n.startsWith('amin-shell-'))![1];
    expect([...cache.store.keys()].sort()).toEqual([...PATHS].sort());
    expect(sw.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('never stores a response that came through a redirect: browsers refuse those for navigations', async () => {
    const redirected = (body: string) => {
      const res = new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
      Object.defineProperty(res, 'redirected', { value: true }); // what fetch() reports after following a 307
      return res;
    };
    const sw = startWorker(PATHS, (path) => (path === '/' ? redirected('<html>shell</html>') : ok(path)));
    await sw.install();
    const cache = [...sw.caches.map.entries()].find(([n]) => n.startsWith('amin-shell-'))![1];
    const stored = cache.store.get('/')!;
    expect(stored.redirected).toBe(false);
    expect(await stored.text()).toBe('<html>shell</html>');
    expect(stored.headers.get('Content-Type')).toBe('text/html');
  });

  it('refuses to install an incomplete update, so the previous version keeps serving', async () => {
    const sw = startWorker(PATHS, (path) => (path === '/assets/app-1.js' ? new Response('gone', { status: 404 }) : ok(path)));
    await expect(sw.install()).rejects.toThrow(/precache failed: \/assets\/app-1.js 404/);
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    const flaky = startWorker(PATHS, (path) => (path === '/favicon.svg' ? offline() : ok(path)));
    await expect(flaky.install()).rejects.toThrow();
    expect(flaky.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('on activation keeps the current and the previous version and deletes older ones, and claims the open pages', async () => {
    const caches = new FakeCaches();
    const meta = await caches.open('amin-meta');
    await meta.put('/__versions', new Response(JSON.stringify(['amin-shell-v1', 'amin-shell-v2'])));
    for (const n of ['amin-shell-v1', 'amin-shell-v2', 'unrelated-cache']) await caches.open(n);
    const sw = startWorker(PATHS, online, caches);
    await sw.install();
    await sw.activate();
    const names = await caches.keys();
    const current = names.find((n) => n.startsWith('amin-shell-') && !['amin-shell-v1', 'amin-shell-v2'].includes(n))!;
    expect(names.filter((n) => n.startsWith('amin-shell-')).sort()).toEqual(['amin-shell-v2', current].sort()); // v1 is gone
    expect(names).toContain('unrelated-cache'); // not ours: untouched
    expect(JSON.parse(await (await meta.match('/__versions'))!.text())).toEqual(['amin-shell-v2', current]);
    expect(sw.self.clients.claim).toHaveBeenCalledTimes(1);
  });

  it('opens the app from the cache with no network at all', async () => {
    let up = true;
    const sw = startWorker(PATHS, (p) => (up ? ok(`network:${p}`) : offline()));
    await sw.install();
    await sw.activate();
    up = false;
    const page = await sw.request('https://app.test/', { mode: 'navigate' });
    expect(page.intercepted).toBe(true);
    expect(await page.response!.text()).toBe('network:/');
    const deep = await sw.request('https://app.test/some/deep/link', { mode: 'navigate' });
    expect(await deep.response!.text()).toBe('network:/'); // single-page app: every navigation starts from the shell
    const withQuery = await sw.request('https://app.test/?invite=abc', { mode: 'navigate' });
    expect(await withQuery.response!.text()).toBe('network:/');
    const asset = await sw.request('https://app.test/assets/app-1.js');
    expect(await asset.response!.text()).toBe('network:/assets/app-1.js');
  });

  it('serves cached files without touching the network at all (fast on a throttled link)', async () => {
    const sw = startWorker(PATHS, online);
    await sw.install();
    await sw.activate();
    sw.fetchFn.mockClear();
    await sw.request('https://app.test/assets/app-1.css');
    await sw.request('https://app.test/', { mode: 'navigate' });
    expect(sw.fetchFn).not.toHaveBeenCalled();
  });

  it('never intercepts the API, other origins, non-GET requests or files it does not own', async () => {
    const sw = startWorker(PATHS, online);
    await sw.install();
    await sw.activate();
    for (const [url, init] of [
      ['https://app.test/api/conversations', {}],
      ['https://app.test/api/realtime/poll?wait=20', {}],
      ['https://app.test/api/realtime/ws?ticket=x', {}],
      ['https://app.test/api/files/f1?download=1', {}],
      ['https://app.test/api/health', {}],
      ['https://relay.example.com/api/health', {}],
      ['https://cdn.example.com/assets/app-1.js', {}],
      ['https://app.test/', { method: 'POST', mode: 'navigate' }],
      ['https://app.test/assets/app-1.js', { method: 'POST' }],
      ['https://app.test/not-in-the-shell.png', {}],
      ['https://app.test/robots.txt', {}],
    ] as const) {
      expect((await sw.request(url, init)).intercepted, `${init && 'method' in init ? init.method : 'GET'} ${url}`).toBe(false);
    }
    // an API *navigation* (opening a link to /api/… in the address bar) is not the app shell either
    expect((await sw.request('https://app.test/api/files/f1', { mode: 'navigate' })).intercepted).toBe(false);
  });

  it('falls back to the network for something that is not cached yet (and fails honestly when offline)', async () => {
    const sw = startWorker(PATHS, online, new FakeCaches()); // installed nothing
    const page = await sw.request('https://app.test/', { mode: 'navigate' });
    expect(await page.response!.text()).toBe('network:/');
    const dead = startWorker(PATHS, offline, new FakeCaches());
    await expect(dead.request('https://app.test/', { mode: 'navigate' })).rejects.toThrow(/Failed to fetch/);
  });

  it('after an update a page that is still open can load the previous build’s chunks', async () => {
    const caches = new FakeCaches();
    const v1 = startWorker(['/', '/assets/chunk-old.js'], (p) => ok(`v1:${p}`), caches);
    await v1.install();
    await v1.activate();
    const v2 = startWorker(['/', '/assets/chunk-new.js'], (p) => ok(`v2:${p}`), caches);
    await v2.install();
    await v2.activate();
    const old = await v2.request('https://app.test/assets/chunk-old.js'); // not in v2's list, still in the kept v1 cache
    expect(old.intercepted).toBe(false); // …the worker only answers files of its own build,
    expect(await (await caches.match('/assets/chunk-old.js'))!.text()).toBe('v1:/assets/chunk-old.js'); // while the cache still holds it
    const shell = await v2.request('https://app.test/', { mode: 'navigate' });
    expect(await shell.response!.text()).toBe('v2:/'); // new loads get the new shell
  });
});

/* ------------------------------------------------------------------------------------------------ registration */

describe('registerServiceWorker', () => {
  const base = (over: Partial<PwaDeps> = {}) => {
    const register = vi.fn(async () => ({}) as ServiceWorkerRegistration);
    const deps: PwaDeps = { prod: true, protocol: 'https:', hostname: 'chat.example.com', isNative: false, serviceWorker: { register }, onLoad: (fn) => fn(), ...over };
    return { deps, register };
  };

  it('registers in production over https', () => {
    const { deps, register } = base();
    expect(registerServiceWorker(deps)).toBe(true);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it.each([
    ['development (it would cache stale code)', { prod: false }],
    ['the Android app (the shell is inside the APK)', { isNative: true }],
    ['a browser without service workers', { serviceWorker: null }],
    ['plain http on a real host (browsers refuse)', { protocol: 'http:' }],
  ] as const)('does nothing in %s', (_name, over) => {
    const { deps, register } = base(over as Partial<PwaDeps>);
    expect(registerServiceWorker(deps)).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it('works on localhost over http, waits for the page to finish loading, and survives a failing registration', async () => {
    let load: () => void = () => undefined;
    const register = vi.fn(async () => {
      throw new Error('SecurityError');
    });
    const { deps } = base({ protocol: 'http:', hostname: 'localhost', serviceWorker: { register }, onLoad: (fn) => (load = fn) });
    expect(registerServiceWorker(deps)).toBe(true);
    expect(register).not.toHaveBeenCalled();
    load();
    expect(register).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });
});

describe('recoverFromStaleChunks', () => {
  function setup(now = 1_000_000) {
    const handlers: Record<string, (e: Event) => void> = {};
    const target = { addEventListener: (t: string, fn: (e: Event) => void) => void (handlers[t] = fn), removeEventListener: vi.fn() } as unknown as Window;
    const reload = vi.fn();
    const clock = { now };
    recoverFromStaleChunks(target, reload, () => clock.now);
    const fire = () => {
      const event = { preventDefault: vi.fn() } as unknown as Event;
      handlers['vite:preloadError']!(event);
      return event;
    };
    return { fire, reload, clock };
  }

  it('reloads once when a chunk of an old build is gone, but never in a loop', () => {
    sessionStorage.clear();
    const { fire, reload, clock } = setup();
    const first = fire();
    expect(first.preventDefault).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
    clock.now += 5_000;
    fire(); // it failed again right after the reload: do not loop
    expect(reload).toHaveBeenCalledTimes(1);
    clock.now += 31_000;
    fire(); // much later (another deployment): allowed again
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
