/*
 * AMIN CHAT service worker — built from this template by plugins/serviceWorker.ts (placeholders: version, precache list).
 *
 * Its only job: the app opens instantly and WITHOUT a connection, so that on a blocked or throttled network the user still
 * reaches the screens where an alternative address can be added, and unsent messages stay visible. It never touches data:
 *   • /api/*            → never intercepted (realtime, files, authentication are always live)
 *   • other origins     → never intercepted (relays, anything else)
 *   • non-GET requests  → never intercepted
 * Only the app shell (the page at "/" + the hashed JS/CSS/fonts/icons of this exact build) is cached. It is fetched in full at install;
 * if any file fails the install fails and the previous version keeps serving, so a half-downloaded update can never be activated.
 */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
/** The page is cached under its canonical address. "/index.html" is a redirect to "/" on Workers Assets, and a redirected response
 *  must not be used to answer a navigation (browsers refuse it), so the shell is never fetched through that address. */
const SHELL = '/';
const PREFIX = 'amin-shell-';
const CACHE = PREFIX + VERSION;
const META = 'amin-meta';
const VERSIONS_KEY = '/__versions';
/** Current + previous: a page opened before an update can still load its lazily loaded chunks. */
const KEEP = 2;

const precached = new Set(PRECACHE);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        PRECACHE.map(async (path) => {
          const res = await fetch(path, { cache: 'reload', credentials: 'same-origin' });
          if (!res.ok) throw new Error('precache failed: ' + path + ' ' + res.status);
          await cache.put(path, await withoutRedirectFlag(res));
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const meta = await caches.open(META);
      const stored = await meta.match(VERSIONS_KEY);
      let known = [];
      try {
        known = stored ? await stored.json() : [];
      } catch (e) {
        known = [];
      }
      const keep = [...known.filter((n) => n !== CACHE), CACHE].slice(-KEEP);
      await meta.put(VERSIONS_KEY, new Response(JSON.stringify(keep), { headers: { 'Content-Type': 'application/json' } }));
      for (const name of await caches.keys()) {
        if (name.startsWith(PREFIX) && !keep.includes(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/** A response that came through a redirect cannot answer a navigation (browsers refuse it): keep a plain copy of it instead. */
async function withoutRedirectFlag(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function fromCaches(path) {
  const current = await caches.open(CACHE);
  const hit = await current.match(path);
  if (hit) return hit;
  return caches.match(path); // an older build that is still kept
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    // The shell is a single-page app: every page load starts from the same index.html. Cache first = instant, works offline.
    event.respondWith(fromCaches(SHELL).then((hit) => hit || fetch(req)));
    return;
  }
  if (precached.has(url.pathname)) {
    event.respondWith(fromCaches(url.pathname).then((hit) => hit || fetch(req)));
  }
});
