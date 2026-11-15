import { Capacitor } from '@capacitor/core';
import type { ApiErrorBody } from '@aminchat/shared';

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
const SERVER_KEY = 'aminchat.server';

export const isNative = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

/** Base URL of the API. Empty = same origin (web, dev proxy). The Android app stores the address of the deployed Worker. */
export function getServer(): string {
  const stored = safeGet(SERVER_KEY) ?? (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
  return stored.replace(/\/+$/, '');
}

export function normalizeServerUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function setServer(url: string): void {
  if (url) localStorage.setItem(SERVER_KEY, url);
  else localStorage.removeItem(SERVER_KEY);
}

export const apiUrl = (path: string): string => `${getServer()}${path}`;

export function wsUrl(path: string): string {
  const base = getServer() || (typeof location !== 'undefined' ? location.origin : '');
  return base.replace(/^http/i, 'ws') + path;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
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

export async function request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  let res: Response;
  try {
    res = await fetch(apiUrl(buildPath(path, opts.query)), { method, headers, body, signal: opts.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'The server could not be reached');
  }
  if (!res.ok) {
    const err = await toError(res);
    const authCall = path.startsWith('/api/auth/login') || path.startsWith('/api/auth/register');
    if (res.status === 401 && token && !authCall) onUnauthorized?.();
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('Content-Type') ?? '';
  return (type.includes('application/json') ? await res.json() : await res.text()) as T;
}

export const http = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, json?: unknown, signal?: AbortSignal) => request<T>('POST', path, { json: json ?? {}, signal }),
  put: <T>(path: string, json?: unknown) => request<T>('PUT', path, { json: json ?? {} }),
  patch: <T>(path: string, json?: unknown) => request<T>('PATCH', path, { json: json ?? {} }),
  del: <T>(path: string, json?: unknown) => request<T>('DELETE', path, json === undefined ? {} : { json }),
};

/** Authenticated download (files are private, so `<img src>` cannot be used directly). */
export async function fetchBlob(path: string): Promise<Blob> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError(0, 'NETWORK', 'The server could not be reached');
  }
  if (!res.ok) throw await toError(res);
  return res.blob();
}
