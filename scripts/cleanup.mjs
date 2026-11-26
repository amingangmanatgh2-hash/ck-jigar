#!/usr/bin/env node
/**
 * Delete Workers by name, from a list in a file (`deploy/CLEANUP`), so the account is not littered with probes.
 *
 * The panel itself is never deleted: its name is refused even if it is listed by accident.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { credentials } from './env.mjs';

const KEEP = new Set(['zeus-panel']);
const listFile = process.argv[2] ?? 'deploy/CLEANUP';
const root = fileURLToPath(new URL('../', import.meta.url));

const names = readFileSync(`${root}${listFile}`, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

if (names.length === 0) {
  console.log('::notice title=Cleanup::nothing listed');
  process.exit(0);
}

const { accountId, token } = credentials();
if (!accountId || !token) {
  console.log('::error title=Cleanup::no Cloudflare credentials');
  process.exit(1);
}

for (const name of names) {
  if (KEEP.has(name)) {
    console.log(`::warning title=Cleanup::${name} is the panel, it is kept`);
    continue;
  }
  const result = spawnSync('npx', ['--no-install', 'wrangler', 'delete', '--name', name, '--force'], {
    cwd: `${root}worker/`,
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: 'false' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/).slice(-2).join(' | ');
  if (result.status === 0) console.log(`::notice title=Deleted::${name}`);
  else console.log(`::warning title=Cleanup failed for ${name}::${output.slice(0, 300)}`);
}
