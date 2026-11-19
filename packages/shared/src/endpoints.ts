/**
 * Server addresses ("endpoints") a client may talk to: the main Worker plus any reverse-proxy relays the operator runs
 * (see docs/connectivity.md). Used by the Worker (PUBLIC_ENDPOINTS) and by the apps (their saved list), so both sides
 * agree on what a valid address is.
 */
export const MAX_ENDPOINTS = 8;

/** "https://Host:443/path?x" → "https://host" (origin only). `null` when it is not an http(s) address. */
export function normalizeEndpoint(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname) return null;
    if (url.username || url.password) return null; // credentials in a URL would end up in logs
    // a real address has a dot (domain, IPv4), is an IPv6 literal, or is localhost: a bare word such as "x" is a typo, not a server
    if (!url.hostname.includes('.') && !url.hostname.startsWith('[') && url.hostname !== 'localhost') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Distinct valid origins from already-split entries, in order, at most MAX_ENDPOINTS. Invalid entries are dropped. */
export function cleanEndpoints(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    const origin = typeof item === 'string' ? normalizeEndpoint(item) : null;
    if (origin && !out.includes(origin)) out.push(origin);
    if (out.length >= MAX_ENDPOINTS) break;
  }
  return out;
}

/** Comma / whitespace separated text (an environment variable) → distinct valid origins. */
export function parseEndpointList(raw: string | null | undefined): string[] {
  return cleanEndpoints((raw ?? '').split(/[\s,]+/));
}
