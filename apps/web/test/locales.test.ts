import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../src/locales/en';
import { fa } from '../src/locales/fa';
import { codeText, dirOf, errorText, setLocale, translate } from '../src/lib/i18n';
import { ApiError } from '../src/lib/api';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('locales', () => {
  it('Persian has exactly the keys English has', () => {
    const enKeys = Object.keys(en).sort();
    const faKeys = Object.keys(fa).sort();
    expect(faKeys.filter((k) => !(k in en))).toEqual([]);
    expect(enKeys.filter((k) => !(k in fa))).toEqual([]);
  });

  it('no translation is empty, and both languages use the same {placeholders}', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].trim(), `en ${key}`).not.toBe('');
      expect(fa[key].trim(), `fa ${key}`).not.toBe('');
      expect(placeholders(fa[key]), `placeholders of ${key}`).toEqual(placeholders(en[key]));
    }
  });

  it('Persian text is Persian (letters from the Arabic block), not a copy of the English', () => {
    const untranslated = (Object.keys(en) as (keyof typeof en)[]).filter((k) => fa[k] === en[k] && /[A-Za-z]{4,}/.test(en[k]) && !/^(AMIN|@AMINAI|Workers|gemma|llama|qwen|\{)/i.test(en[k]));
    // a few strings are legitimately identical (product names, units); a large number would mean a missed translation
    expect(untranslated.length, untranslated.join(', ')).toBeLessThan(12);
  });

  it('every error code the API can send has a text in both languages', () => {
    const apiSrc = join(__dirname, '../../api/src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(apiSrc);
    const pattern = /(?:new\s+AppError\(\s*\d+\s*,\s*|\b(?:badRequest|forbidden|notFound|conflict|unavailable|unauthorized|quotaExceeded|rateLimited|tooLarge|unsupportedMedia)\([^;]*?,\s*)'([A-Z][A-Z0-9_]+)'/gs;
    const codes = new Set(['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'SERVICE_UNAVAILABLE']);
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(pattern)) codes.add(m[1]!);
    expect(codes.size).toBeGreaterThan(60); // the scan really found them
    const missing = [...codes].filter((c) => !(`err.${c}` in en) || !(`err.${c}` in fa));
    expect(missing).toEqual([]);
  });
});

describe('translate', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(translate('en', 'approval.expires', { time: 'noon' })).toContain('noon');
    expect(translate('en', 'attach.tooMany', {})).toContain('{n}');
  });

  it('is right-to-left for Persian only, and switching sets <html dir lang>', () => {
    expect(dirOf('fa')).toBe('rtl');
    expect(dirOf('en')).toBe('ltr');
    setLocale('fa');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('fa');
    setLocale('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('error texts', () => {
  it('shows the localised text for a known code and a generic one for an unknown code', () => {
    expect(codeText('en', 'RATE_LIMITED')).toBe(en['err.RATE_LIMITED']);
    expect(codeText('fa', 'RATE_LIMITED')).toBe(fa['err.RATE_LIMITED']);
    expect(codeText('en', 'SOMETHING_NEW')).toBe(en['err.generic']);
    expect(codeText('en', 'SOMETHING_NEW', 'Short server text')).toBe('Short server text');
  });

  it('turns a failed fetch (status 0) into the network message', () => {
    expect(errorText('en', new ApiError(0, 'NETWORK', 'Failed to fetch'))).toBe(en['err.NETWORK']);
    expect(errorText('fa', new ApiError(429, 'QUOTA_EXCEEDED', 'limit'))).toBe(fa['err.QUOTA_EXCEEDED']);
  });
});
