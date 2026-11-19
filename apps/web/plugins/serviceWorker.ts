import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** Public files that belong to the cached shell (everything else in /public is not precached). */
const PUBLIC_PRECACHE = [/^favicon\.svg$/, /^manifest\.webmanifest$/, /^icons\/.+\.png$/];

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'sw.template.js');

/** File-system path → URL path, whatever platform the build runs on. */
const toUrlPath = (file: string): string => file.replace(/\\/g, '/');

/** The URL paths to precache for a build: the shell (the page at "/"), every emitted asset, and the matching public files. */
export function precacheList(emitted: readonly string[], publicFiles: readonly string[]): string[] {
  const out = new Set<string>(['/']);
  for (const file of emitted) {
    if (file === 'index.html' || file === 'sw.js' || file.endsWith('.map')) continue;
    out.add('/' + toUrlPath(file));
  }
  for (const file of publicFiles) {
    const path = toUrlPath(file);
    if (PUBLIC_PRECACHE.some((re) => re.test(path))) out.add('/' + path);
  }
  return [...out].sort();
}

/**
 * Same files + same page → same version, so an unchanged build does not trigger an update. File names carry content hashes, which
 * covers the scripts and styles; `html` is the page itself, which can change without any file name changing (a title, a meta tag).
 */
export const versionOf = (paths: readonly string[], html = ''): string => createHash('sha256').update(paths.join('\n')).update('\0').update(html).digest('hex').slice(0, 12);

export function renderServiceWorker(template: string, paths: readonly string[], html = ''): string {
  if (!template.includes('__VERSION__') || !template.includes('__PRECACHE__')) throw new Error('service worker template is missing its placeholders');
  return template.replace('__VERSION__', versionOf(paths, html)).replace('__PRECACHE__', JSON.stringify(paths, null, 2));
}

/** Every file below `dir`, as paths relative to `dir` itself (at any depth: "icons/icon-192.png", not "icon-192.png"). */
export function listFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

/** Emits /sw.js next to the build output. */
export function serviceWorkerPlugin(publicDir = 'public'): Plugin {
  let root = process.cwd();
  return {
    name: 'amin-service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      let publicFiles: string[] = [];
      try {
        publicFiles = listFiles(join(root, publicDir));
      } catch {
        publicFiles = [];
      }
      const paths = precacheList(Object.keys(bundle), publicFiles);
      const page = bundle['index.html'];
      const html = page && page.type === 'asset' ? String(page.source) : '';
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: renderServiceWorker(readFileSync(TEMPLATE_PATH, 'utf8'), paths, html) });
    },
  };
}
