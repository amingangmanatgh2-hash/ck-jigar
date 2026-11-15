#!/usr/bin/env node
/**
 * Local API for development:
 *   npm run dev:api            real Workers AI through your Cloudflare login (npx wrangler login)
 *   npm run dev:api:offline    same API without the AI binding (no login needed; AMIN AI reports "not connected")
 *
 * It applies the D1 migrations to the local database, starts `wrangler dev` on :8787 and — because `wrangler dev` does not run
 * cron triggers by itself — calls the scheduled handler every 30 s so reminders and task recovery behave like production.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const offline = process.argv.includes('--offline');
const port = process.env.API_PORT ?? '8787';
const apiDir = fileURLToPath(new URL('../apps/api/', import.meta.url));
let config = 'wrangler.dev.jsonc';
let generated = null;

if (offline) {
  const text = readFileSync(`${apiDir}${config}`, 'utf8');
  const stripped = text.replace(/^\s*"ai":\s*\{[^}]*\},?\s*$/m, '');
  if (stripped === text) throw new Error('could not remove the "ai" binding from wrangler.dev.jsonc');
  generated = '.wrangler.dev-offline.jsonc';
  writeFileSync(`${apiDir}${generated}`, stripped);
  config = generated;
  console.log('[dev-api] offline mode: the Workers AI binding is NOT configured, AMIN AI will say so.');
}

const run = (args) => spawnSync('npx', ['wrangler', ...args], { cwd: apiDir, stdio: 'inherit' });
const migrated = run(['d1', 'migrations', 'apply', 'DB', '--local', '--config', config]);
if (migrated.status !== 0) {
  console.error('[dev-api] applying the D1 migrations failed');
  process.exit(migrated.status ?? 1);
}

const child = spawn('npx', ['wrangler', 'dev', '--config', config, '--ip', '0.0.0.0', '--port', port, '--test-scheduled'], { cwd: apiDir, stdio: 'inherit' });
const timer = setInterval(() => {
  fetch(`http://127.0.0.1:${port}/cdn-cgi/handler/scheduled`).catch(() => undefined);
}, 30_000);
const stop = () => {
  clearInterval(timer);
  child.kill('SIGTERM');
  if (generated) rmSync(`${apiDir}${generated}`, { force: true });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => {
  clearInterval(timer);
  if (generated) rmSync(`${apiDir}${generated}`, { force: true });
  process.exit(code ?? 0);
});
