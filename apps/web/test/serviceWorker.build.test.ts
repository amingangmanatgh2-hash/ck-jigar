// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listFiles } from '../plugins/serviceWorker';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('listFiles', () => {
  it('returns paths relative to the directory it was asked about, at any depth', () => {
    const dir = mkdtempSync(join(tmpdir(), 'amin-list-'));
    try {
      mkdirSync(join(dir, 'icons', 'deep'), { recursive: true });
      writeFileSync(join(dir, 'favicon.svg'), 'x');
      writeFileSync(join(dir, 'icons', 'icon-192.png'), 'x');
      writeFileSync(join(dir, 'icons', 'deep', 'a.png'), 'x');
      expect(listFiles(dir).map((p) => p.replace(/\\/g, '/')).sort()).toEqual(['favicon.svg', 'icons/deep/a.png', 'icons/icon-192.png']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Unit tests feed the plugin hand-written file lists; this one runs the REAL production build and checks that what the service
 * worker promises to keep offline is exactly what the page needs — a path that is wrong (a file in a sub-folder losing its folder,
 * a file that was never emitted) only shows up here.
 */
describe('the production build and its service worker', () => {
  const out = mkdtempSync(join(tmpdir(), 'amin-dist-'));
  let precache: string[] = [];
  let version = '';

  beforeAll(async () => {
    await build({ root: WEB_ROOT, configFile: join(WEB_ROOT, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true, write: true } });
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    precache = JSON.parse(/const PRECACHE = (\[[\s\S]*?\]);/.exec(sw)![1]!) as string[];
    version = /const VERSION = '([0-9a-f]+)'/.exec(sw)![1]!;
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  const filesIn = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? filesIn(join(dir, n)) : [relative(out, join(dir, n)).replace(/\\/g, '/')]));

  it('emits a versioned sw.js', () => {
    expect(existsSync(join(out, 'sw.js'))).toBe(true);
    expect(version).toMatch(/^[0-9a-f]{12}$/);
  });

  it('precaches the page at "/" and never through "/index.html"', () => {
    expect(precache).toContain('/');
    expect(precache).not.toContain('/index.html');
  });

  it('precaches every script, style, font, icon and the manifest that the page and the manifest refer to', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const referenced = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!).filter((p) => !p.startsWith('/api/'));
    expect(referenced.length).toBeGreaterThan(3);
    for (const path of referenced) expect(precache, `the page links ${path}`).toContain(path);

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8')) as { icons: { src: string }[]; start_url: string };
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of manifest.icons) expect(precache, `the manifest names ${icon.src}`).toContain(icon.src);
    expect(precache).toContain('/icons/icon-192.png'); // the apple-touch-icon
  });

  it('precaches every lazily loaded chunk, so every screen opens without a network', () => {
    const chunks = filesIn(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => '/' + f);
    expect(chunks.length).toBeGreaterThan(3); // the screens and the Markdown renderer are split out
    for (const chunk of chunks) expect(precache).toContain(chunk);
  });

  it('lists nothing that does not exist (an install with one 404 would never complete)', () => {
    for (const path of precache) if (path !== '/') expect(existsSync(join(out, path)), path).toBe(true);
  });

  it('does not precache anything outside the shell', () => {
    for (const path of precache) expect(path === '/' || /^\/(assets\/|icons\/|favicon\.svg$|manifest\.webmanifest$)/.test(path), path).toBe(true);
  });
});
