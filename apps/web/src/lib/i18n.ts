import { useMemo } from 'react';
import { en } from '../locales/en';
import { fa } from '../locales/fa';
import { createStore, useStore } from './store';

export type Locale = 'fa' | 'en';
export type Key = keyof typeof en;
export type Params = Record<string, string | number>;
export type TFn = (key: Key, params?: Params) => string;

const DICTS: Record<Locale, Record<Key, string>> = { en, fa };
const STORAGE_KEY = 'aminchat.locale';

export const dirOf = (l: Locale): 'rtl' | 'ltr' => (l === 'fa' ? 'rtl' : 'ltr');

export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'fa' || saved === 'en') return saved;
  } catch {
    // storage unavailable
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  // Persian is the default language of AMIN CHAT; English only when the device clearly asks for something else.
  return !nav || /^fa\b/i.test(nav) ? 'fa' : 'en';
}

export const localeStore = createStore<Locale>(detectLocale());

export function applyLocale(l: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = l;
  document.documentElement.dir = dirOf(l);
}

export function setLocale(l: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // ignore
  }
  localeStore.set(l);
  applyLocale(l);
}

export function translate(locale: Locale, key: Key, params?: Params): string {
  const raw = DICTS[locale][key] ?? en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => (name in params ? String(params[name]) : `{${name}}`));
}

export const t: TFn = (key, params) => translate(localeStore.get(), key, params);

export function useLocale(): Locale {
  return useStore(localeStore, (l) => l);
}

export function useT(): TFn {
  const locale = useLocale();
  return useMemo<TFn>(() => (key, params) => translate(locale, key, params), [locale]);
}

/** Localised text for a machine-readable code (API errors, run/step error codes). Falls back to `fallback`, then to a generic text. */
export function codeText(locale: Locale, code: string | null | undefined, fallback?: string | null): string {
  if (code) {
    const key = `err.${code}` as Key;
    if (key in en) return translate(locale, key);
  }
  return fallback && fallback.length < 220 ? fallback : translate(locale, 'err.generic');
}

/** Localised text for an error thrown by the API client. */
export function errorText(locale: Locale, err: unknown): string {
  const code = (err as { code?: string })?.code;
  if ((err as { status?: number })?.status === 0) return translate(locale, 'err.NETWORK');
  return codeText(locale, code, (err as { message?: string })?.message);
}

export function useErrorText(): (err: unknown) => string {
  const locale = useLocale();
  return useMemo(() => (err: unknown) => errorText(locale, err), [locale]);
}

export function useCodeText(): (code: string | null | undefined, fallback?: string | null) => string {
  const locale = useLocale();
  return useMemo(() => (code, fallback) => codeText(locale, code, fallback), [locale]);
}
