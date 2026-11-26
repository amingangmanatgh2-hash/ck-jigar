#!/usr/bin/env node
/**
 * Bundles the Worker into one file with no imports at all, using the esbuild that comes with wrangler.
 *
 * One file means one module to evaluate at startup: no module graph, no dynamic import, nothing that can behave
 * differently on the edge than it does locally. `worker/dist/` is generated and not committed.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

await build({
  entryPoints: [`${root}worker/src/index.js`],
  outfile: `${root}worker/dist/worker.js`,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  // `cloudflare:sockets` is a runtime module: it must stay a reference, not be resolved now.
  external: ['cloudflare:sockets'],
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
});

console.log('worker/dist/worker.js written');
