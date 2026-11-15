import type { ApiErrorBody } from '@aminchat/shared';
import { pool } from './endpointPool';
import { getServer, isNative, normalizeServerUrl, safeGet, setServer } from './server';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'aminchat.token';

export { getServer, isNative, normalizeServerUrl, setServer };

/** Base URL requests go to right now: the main address, or a working alternative when the main one is blocked (see endpointPool). */
export const activeBase = (): string => pool.active();

export const apiUrl = (path: string, base = activeBase()): string => `${base}${path}`;

export function wsUrl(path: string): string {
  const base = activeBase() || (typeof location !== 'undefined' ? location.origin : '');
  return base.replace(/^http/i, 'ws') + path;
}

export const getToken = (): string | null => safeGet(TOKEN_KEY);
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

export interface RequestOptions {
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  /**
   * May this request be sent again (on another address, or after a dropped connection) when we do not know whether it arrived?
   * GET/HEAD/PUT/DELETE always may. POST/PATCH only when the body carries an idempotency token (`clientId`), so a repeat can never
   * create a second message or a second AI run.
   */
  retry?: boolean;
  /** Give up on a connection that goes silent after this long (default 20 s; uploads and downloads get more). */
  timeoutMs?: number;
}

function buildPath(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const s = params.toString();
  return s ? `${path}?${s}` : path;
}

async function toError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    // not JSON
  }
  const retry = Number(res.headers.get('Retry-After') ?? '') || undefined;
  return new ApiError(res.status, body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message ?? res.statusText ?? 'Request failed', body?.error?.details, retry);
}

/* ---------------------------------------------------------------------------------------------------------------------
 * Transport. "The network failed" and "the server said no" must never be confused:
 *   • TransportError  → nothing usable came back (no connection, timeout, a relay's/CDN's own error page, a captive portal's HTML).
 *                       The endpoint pool looks for another address, and requests that are safe to repeat are repeated.
 *   • ApiError        → our Worker answered. Every answer of our Worker carries X-Request-Id, so an answer without it is not ours.
 * ------------------------------------------------------------------------------------------------------------------- */

const RETRY_SAFE = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const DEFAULT_TIMEOUT_MS = 20_000;
/** Pauses before repeating a safe request on the same address after a dropped connection. */
export const SAME_ADDRESS_RETRY_DELAYS_MS = [400, 1200];
const MAX_SWITCHES = 2;

export class TransportError extends Error {
  constructor(public readonly kind: 'network' | 'timeout' | 'foreign') {
    super(`transport failure: ${kind}`);
    this.name = 'TransportError';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function attempt<T>(base: string, method: string, path: string, init: { headers: Record<string, string>; body?: BodyInit }, opts: RequestOptions, parse: (res: Response) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const outer = opts.signal;
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(apiUrl(buildPath(path, opts.query), base), { method, headers: init.headers, body: init.body, signal: ctrl.signal });
    if (!res.headers.has('X-Request-Id')) throw new TransportError('foreign');
    if (!res.ok) throw await toError(res);
    return await parse(res);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (outer?.aborted) throw err; // the caller cancelled on purpose
    throw err instanceof TransportError ? err : new TransportError(timedOut ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

async function perform<T>(method: string, path: string, opts: RequestOptions, parse: (res: Response) => Promise<T>): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const safe = RETRY_SAFE.has(method) || opts.retry === true;
  let base = activeBase();
  let switches = 0;
  let sameAddress = 0;
  for (;;) {
    try {
      const out = await attempt(base, method, path, { headers, body }, opts, parse);
      pool.reportSuccess(base);
      return out;
    } catch (err) {
      if (!(err instanceof TransportError)) {
        if (err instanceof ApiError) {
          pool.reportSuccess(base); // the server is there; it just said no
          const authCall = path.startsWith('/api/auth/login') || path.startsWith('/api/auth/register');
          if (err.status === 401 && token && !authCall) onUnauthorized?.();
        }
        throw err;
      }
      const next = switches < MAX_SWITCHES ? await pool.failover(base) : null;
      if (next !== null && next !== base && safe) {
        base = next;
        switches++;
        continue;
      }
      const delay = SAME_ADDRESS_RETRY_DELAYS_MS[sameAddress];
      if (safe && err.kind !== 'timeout' && delay !== undefined && (next === null || next === base)) {
        sameAddress++;
        await sleep(delay);
        continue;
      }
      throw new ApiError(0, 'NETWORK', 'The server could not be reached');
    }
  }
}

export function request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  return perform<T>(method, path, opts, async (res) => {
    if (res.status === 204) return undefined as T;
    const type = res.headers.get('Content-Type') ?? '';
    return (type.includes('application/json') ? await res.json() : await res.text()) as T;
  });
}

export const http = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, json?: unknown, signal?: AbortSignal, extra: Pick<RequestOptions, 'retry' | 'timeoutMs'> = {}) => request<T>('POST', path, { json: json ?? {}, signal, ...extra }),
  put: <T>(path: string, json?: unknown) => request<T>('PUT', path, { json: json ?? {} }),
  patch: <T>(path: string, json?: unknown) => request<T>('PATCH', path, { json: json ?? {} }),
  del: <T>(path: string, json?: unknown) => request<T>('DELETE', path, json === undefined ? {} : { json }),
};

/** Authenticated download (files are private, so `<img src>` cannot be used directly). */
export function fetchBlob(path: string): Promise<Blob> {
  return perform('GET', path, { timeoutMs: 120_000 }, (res) => res.blob());
}

/**
 * Remembers the token of the last send that failed, so that pressing "send" again with the SAME content repeats that send
 * (the server then answers with the first turn when it had in fact arrived) instead of starting a second one.
 */
export function createSendTokens(): { next(fingerprint: string): string; done(): void } {
  let last: { fingerprint: string; clientId: string } | null = null;
  return {
    next(fingerprint) {
      if (!last || last.fingerprint !== fingerprint) last = { fingerprint, clientId: newClientId() };
      return last.clientId;
    },
    done() {
      last = null;
    },
  };
}

/** A fresh random token for one send. Keep it until the send succeeded, and every repeat of that send is recognised by the server. */
export function newClientId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
