import { useEffect, useState } from 'react';

/** Minimal hash router: "#/c/<conversationId>/t/<threadId>" → { path: ['c', id, 't', threadId] }. */
export interface Route {
  path: string[];
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [p, q = ''] = raw.split('?');
  return { path: (p ?? '').split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) };
}

export const href = (...parts: string[]): string => `#/${parts.map(encodeURIComponent).join('/')}`;

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const target = to.startsWith('#') ? to : `#${to}`;
  if (opts.replace) {
    history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

export function back(fallback = '#/'): void {
  if (history.length > 1) history.back();
  else navigate(fallback, { replace: true });
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    on();
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
