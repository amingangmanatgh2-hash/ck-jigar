import { isNative } from './server';

export interface PwaDeps {
  prod: boolean;
  protocol: string;
  hostname: string;
  isNative: boolean;
  serviceWorker: Pick<ServiceWorkerContainer, 'register'> | null;
  onLoad: (fn: () => void) => void;
}

const defaults = (): PwaDeps => ({
  prod: import.meta.env.PROD,
  protocol: location.protocol,
  hostname: location.hostname,
  isNative: isNative(),
  serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : null,
  onLoad: (fn) => (document.readyState === 'complete' ? fn() : window.addEventListener('load', fn, { once: true })),
});

/**
 * Registers the service worker that keeps the app shell available offline (see plugins/sw.template.js).
 * Not in development (it would cache stale code), not in the Android app (the shell is bundled in the APK), and only where the
 * browser allows it (https, or localhost). Returns whether registration was started.
 */
export function registerServiceWorker(deps: PwaDeps = defaults()): boolean {
  if (!deps.prod || deps.isNative || !deps.serviceWorker) return false;
  if (deps.protocol !== 'https:' && deps.hostname !== 'localhost' && deps.hostname !== '127.0.0.1') return false;
  const sw = deps.serviceWorker;
  deps.onLoad(() => {
    void sw.register('/sw.js', { scope: '/' }).catch(() => undefined); // no worker is not an error: the app just needs the network
  });
  return true;
}

const RELOAD_KEY = 'aminchat.preloadReload';
const RELOAD_GAP_MS = 30_000;

/**
 * After a new version was deployed, a page that is still open can ask for a code chunk that no longer exists. Vite reports that as
 * `vite:preloadError`; reloading fetches the new version. At most once per 30 s, so a genuinely broken deployment cannot loop.
 */
export function recoverFromStaleChunks(target: Pick<Window, 'addEventListener'> = window, reload: () => void = () => location.reload(), now: () => number = Date.now): () => void {
  const handler = (event: Event) => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    } catch {
      last = 0;
    }
    if (now() - last < RELOAD_GAP_MS) return; // we just reloaded and it still fails: let the error show instead of looping
    event.preventDefault();
    try {
      sessionStorage.setItem(RELOAD_KEY, String(now()));
    } catch {
      // without storage we cannot rate-limit; reload once anyway
    }
    reload();
  };
  target.addEventListener('vite:preloadError', handler);
  return () => (target as Window).removeEventListener?.('vite:preloadError', handler);
}
