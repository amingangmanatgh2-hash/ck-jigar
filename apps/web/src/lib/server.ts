import { Capacitor } from '@capacitor/core';
import { normalizeEndpoint, parseEndpointList } from '@aminchat/shared';

export const SERVER_KEY = 'aminchat.server';

export const isNative = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The main address of the API. Empty = same origin (web, dev proxy). The Android app stores the address of the deployed Worker. */
export function getServer(): string {
  const stored = safeGet(SERVER_KEY) ?? (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
  return stored.replace(/\/+$/, '');
}

/**
 * Addresses compiled into this build (VITE_API_BASES, comma or space separated): relays and mirrors the maintainers run for people
 * whose direct route to the service is blocked. They are what a brand-new install can fail over to before it has ever reached the
 * server (learned addresses only arrive after one successful answer).
 */
export function getBuiltinEndpoints(): string[] {
  return parseEndpointList(import.meta.env.VITE_API_BASES as string | undefined);
}

/** "" = use this origin; null = not a usable address. */
export function normalizeServerUrl(input: string): string | null {
  if (!input.trim()) return '';
  return normalizeEndpoint(input);
}

export function setServer(url: string): void {
  if (url) localStorage.setItem(SERVER_KEY, url);
  else localStorage.removeItem(SERVER_KEY);
}
